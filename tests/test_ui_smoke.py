"""Rauchtest der Oberfläche (offscreen): Import, Analyse, Vorschau, Undo, Export."""
import time

import numpy as np
import pytest
import tifffile

from filmlab.imaging.synthetic import make_negative

QtWidgets = pytest.importorskip("PySide6.QtWidgets")


@pytest.fixture(scope="module")
def app():
    try:
        a = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    except Exception as exc:  # fehlende System-Bibliotheken
        pytest.skip(f"Qt nicht verfügbar: {exc}")
    return a


def _wait(app, cond, timeout=20.0):
    t = time.time()
    while time.time() - t < timeout:
        app.processEvents()
        if cond():
            return True
        time.sleep(0.01)
    return False


def test_main_window_end_to_end(app, tmp_path):
    from filmlab.ui.main_window import MainWindow

    f = tmp_path / "neg.tif"
    tifffile.imwrite(f, np.round(make_negative(300, 450, sprockets=True).negative * 65535).astype(np.uint16),
                     photometric="rgb")
    w = MainWindow(restore_session=False)
    w.show()
    w.add_files([str(f)])
    assert _wait(app, lambda: w.loaded is not None and w.cur.analysis.base_rgb is not None)
    assert w.cur.analysis.base_source == "border"
    assert _wait(app, lambda: w.viewer._after is not None)

    w.on_param("contrast", 25.0)
    assert w.cur.contrast == 25.0
    w.undo()
    assert w.cur.contrast == 0.0
    w.redo()
    assert w.cur.contrast == 25.0

    w.on_preset("flat")
    assert w.cur.preset_id == "flat" and w.cur.contrast < 0

    w._set_tool("crop")
    w.on_crop_edited([0.1, 0.1, 0.9, 0.9])
    w._set_tool("none")
    assert w.cur.geometry.crop == [0.1, 0.1, 0.9, 0.9]

    w.right.out_dir.setText(str(tmp_path / "out"))
    w.export_current()
    assert _wait(app, lambda: any((tmp_path / "out").glob("*.tif")) if (tmp_path / "out").exists() else False)
    w._do_autosave()
    w.close()
