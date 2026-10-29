"""Einstellungen, Profile, Projekte, Undo/Redo, Stapelverarbeitung, RAW-Import."""
import json

import numpy as np
import pytest
import tifffile

from filmlab.core.profiles import Library
from filmlab.core.project import History, Project, ProjectImage, load_session, save_session
from filmlab.core.settings import EditSettings, sync_settings
from filmlab.imaging import batch, pipeline
from filmlab.imaging.export import ExportOptions
from filmlab.imaging.loader import ImageLoadError, load_image
from filmlab.imaging.synthetic import ScanModel, make_negative, write_dng


def _write_linear_tiff(path, img):
    tifffile.imwrite(path, np.round(np.clip(img, 0, 1) * 65535).astype(np.uint16), photometric="rgb")


def test_settings_roundtrip_and_forward_compat():
    s = EditSettings(contrast=12.5, film_type="bw_negative")
    s.curves["r"] = [[0, 0], [0.5, 0.6], [1, 1]]
    s.geometry.crop = [0.1, 0.1, 0.9, 0.9]
    d = json.loads(json.dumps(s.to_dict()))
    d["unknown_future_field"] = 1
    d["geometry"]["also_unknown"] = True
    s2 = EditSettings.from_dict(d)
    assert s2.to_dict() == s.to_dict()
    assert EditSettings.from_dict({}).to_dict() == EditSettings().to_dict()


def test_analysis_key_changes_only_with_relevant_inputs():
    s = EditSettings()
    k = s.analysis_key("x")
    s.contrast = 50
    s.base.offset = [0.1, 0, 0]
    assert s.analysis_key("x") == k
    s.geometry.crop = [0, 0, 0.5, 0.5]
    assert s.analysis_key("x") != k


def test_profiles_and_presets_load_and_combine():
    lib = Library()
    for pid in ("kodak_portra_160", "kodak_portra_400", "kodak_gold_200", "kodak_ektar_100", "fujifilm_superia_400",
                "fujifilm_c200", "ilford_hp5_plus", "ilford_fp4_plus", "kodak_tri_x_400"):
        assert pid in lib.profiles
        assert "NICHT" in lib.profiles[pid].basis or "nicht gemessen" in lib.profiles[pid].basis
    assert {"neutral", "classic_film", "portrait", "landscape", "flat"} <= set(lib.presets)
    s = lib.apply(EditSettings(), "kodak_ektar_100", "landscape")
    assert s.contrast == lib.presets["landscape"].look["contrast"] + lib.profiles["kodak_ektar_100"].look_delta["contrast"]
    bw = lib.apply(EditSettings(), "kodak_tri_x_400", "neutral")
    assert bw.film_type == "bw_negative"


def test_user_preset_overrides_and_persists(isolated_home):
    lib = Library()
    s = EditSettings(contrast=33, saturation=-12)
    lib.save_user_preset("user_test", "Test", s)
    lib2 = Library()
    assert lib2.presets["user_test"].look["contrast"] == 33
    assert not lib2.presets["user_test"].builtin


def test_history_undo_redo_and_grouping():
    h = History()
    s = EditSettings()
    for v in (10, 20, 30):          # ein Reglerzug -> ein Undo-Schritt
        h.record(s, "Kontrast", group="contrast")
        s = s.copy()
        s.contrast = v
    h.record(s, "Sättigung", group="saturation")
    s2 = s.copy()
    s2.saturation = 40
    u1 = h.undo(s2)
    assert u1.saturation == 0 and u1.contrast == 30
    u2 = h.undo(u1)
    assert u2.contrast == 0
    assert h.undo(u2) is None
    r = h.redo(u2)
    assert r.contrast == 30


def test_project_save_load_relative_paths(tmp_path):
    img = tmp_path / "film" / "a.tif"
    img.parent.mkdir()
    _write_linear_tiff(img, make_negative(60, 90).negative)
    p = Project([ProjectImage(str(img), EditSettings(exposure=0.5))], current=0)
    p.save(tmp_path / "proj" / "x.filmlab")
    loaded = Project.load(tmp_path / "proj" / "x.filmlab")
    assert loaded.images[0].settings.exposure == 0.5
    assert loaded.images[0].path == str(img.resolve())
    data = json.loads((tmp_path / "proj" / "x.filmlab").read_text())
    assert data["images"][0]["relpath"].replace("\\", "/") == "../film/a.tif"


def test_session_restore(tmp_path):
    img = tmp_path / "a.tif"
    _write_linear_tiff(img, make_negative(60, 90).negative)
    save_session(Project([ProjectImage(str(img), EditSettings(contrast=7))], current=0))
    proj = load_session()
    assert proj and proj.images[0].settings.contrast == 7


def test_sync_settings_keeps_geometry_and_analysis():
    a = EditSettings(contrast=40, saturation=10)
    a.geometry.crop = [0.1, 0.1, 0.9, 0.9]
    b = EditSettings()
    b.geometry.rotation = 90
    b.analysis.key = "bkey"
    out = sync_settings(a, b)
    assert out.contrast == 40 and out.geometry.rotation == 90 and out.geometry.crop is None
    assert out.analysis.key == "bkey"
    assert sync_settings(a, b, include_geometry=True).geometry.crop == [0.1, 0.1, 0.9, 0.9]


def test_batch_reproducible_and_error_isolation(tmp_path):
    files = []
    for i, light in enumerate([(1.5, 1.6, 1.7), (1.2, 1.4, 1.8)]):
        f = tmp_path / f"neg{i}.tif"
        _write_linear_tiff(f, make_negative(120, 180, scan=ScanModel(light=light, noise=0.003, seed=i)).negative)
        files.append(f)
    bad = tmp_path / "kaputt.tif"
    bad.write_bytes(b"not a tiff")
    s = EditSettings(input_encoding="linear")
    items = [batch.BatchItem(str(f), s.copy()) for f in (files[0], bad, files[1])]
    r1 = batch.run_batch(items, tmp_path / "out1", ExportOptions(), "{index:02d}_{name}")
    r2 = batch.run_batch(items, tmp_path / "out2", ExportOptions(), "{index:02d}_{name}")
    assert [r.ok for r in r1] == [True, False, True]
    assert "kaputt" in r1[1].path and r1[1].error
    for a, b in zip(r1, r2):
        if a.ok:
            np.testing.assert_array_equal(tifffile.imread(a.output), tifffile.imread(b.output))
    assert (tmp_path / "out1" / "01_neg0_positiv.tif").exists() is False
    assert (tmp_path / "out1" / "01_neg0.tif").exists()


def test_batch_cancel(tmp_path):
    f = tmp_path / "n.tif"
    _write_linear_tiff(f, make_negative(60, 90).negative)
    items = [batch.BatchItem(str(f), EditSettings(input_encoding="linear"))] * 3
    res = batch.run_batch(items, tmp_path / "o", ExportOptions(), cancelled=lambda: True)
    assert res == []


def test_filename_template_sanitizes():
    s = EditSettings(profile_id="kodak_portra_400")
    name = batch.format_filename("{name}/{profile}:{index:03d}", "/x/scan 1.dng", 7, s, "jpeg")
    assert name == "scan 1_kodak_portra_400_007.jpg"


def test_roll_analysis_gives_consistent_development():
    """Gleiches Motiv, unterschiedliche Belichtung im Film: nach der
    Filmstreifen-Analyse bleiben Farbbalance gleich und Belichtungsunterschiede
    erhalten; Einzelanalyse würde sie wegnormieren."""
    ref = make_negative(160, 240)
    frames = [make_negative(160, 240, scene=_scene_crop(ref, gain)) for gain in (1.0, 0.5)]
    proxies = [f.negative for f in frames]
    settings = [EditSettings(), EditSettings()]
    new = batch.roll_analysis(proxies, settings, ["a", "b"])
    assert all(s.lock_analysis for s in new)
    assert new[0].analysis.d_lo == new[1].analysis.d_lo
    np.testing.assert_allclose(new[0].base.rgb, new[1].base.rgb, rtol=1e-4)
    outs = [pipeline.render(f.negative, s, output_space="linear_rec2020") for f, s in zip(frames, new)]
    x0, y0, x1, y1 = frames[0].frame
    m0 = outs[0][y0:y1, x0:x1].mean()
    m1 = outs[1][y0:y1, x0:x1].mean()
    assert m1 < m0 * 0.9, "Belichtungsunterschied muss erhalten bleiben"
    # ensure_analysis respektiert die Sperre
    locked = pipeline.ensure_analysis(proxies[0], new[0].copy(), "other-id")
    assert locked.analysis.d_lo == new[0].analysis.d_lo


def test_roll_analysis_robust_to_varying_scan_conditions():
    """Gleiches Motiv, aber je Bild andere Scan-Belichtung/Weißabgleich
    (z.B. Kamera-Automatik): nach der Filmstreifen-Analyse identische Positive."""
    lights = [(1.5, 1.6, 1.7), (1.1, 1.4, 1.9), (0.8, 0.8, 0.8)]
    frames = [make_negative(160, 240, scan=ScanModel(light=l)) for l in lights]
    new = batch.roll_analysis([f.negative for f in frames], [EditSettings() for _ in frames], ["a", "b", "c"])
    outs = [pipeline.render(f.negative, s, output_space="linear_rec2020") for f, s in zip(frames, new)]
    x0, y0, x1, y1 = frames[0].frame
    for o in outs[1:]:
        np.testing.assert_allclose(o[y0:y1, x0:x1], outs[0][y0:y1, x0:x1], atol=1e-3)
    assert any("variieren" in n for n in new[0].analysis.notes)


def _scene_crop(neg, gain):
    x0, y0, x1, y1 = neg.frame
    return np.clip(neg.scene[y0:y1, x0:x1] * gain, 0.005, 1.0)


def test_raw_dng_import_matches_linear_tiff(tmp_path):
    neg = make_negative(200, 300, sprockets=True)
    dng = tmp_path / "scan.dng"
    write_dng(dng, neg.negative)
    tif = tmp_path / "scan.tif"
    _write_linear_tiff(tif, neg.negative)
    raw = load_image(dng)
    lin = load_image(tif, "linear")
    assert raw.kind == "raw" and raw.bit_depth == 16
    ra = pipeline.analyze(pipeline.analysis_proxy(raw.data), EditSettings(), raw.source_id)
    ta = pipeline.analyze(pipeline.analysis_proxy(lin.data), EditSettings(), lin.source_id)
    assert ra.base_source == "border"
    np.testing.assert_allclose(ra.base_rgb, ta.base_rgb, rtol=2e-3)


def test_load_errors_are_clean(tmp_path):
    with pytest.raises(ImageLoadError):
        load_image(tmp_path / "missing.dng")
    bad = tmp_path / "x.nef"
    bad.write_bytes(b"\0" * 100)
    with pytest.raises(ImageLoadError):
        load_image(bad)


def test_8bit_and_16bit_sources_are_float_without_8bit_intermediate(tmp_path):
    grad = np.linspace(0, 1, 1024, dtype=np.float64)[None, :, None].repeat(4, 0).repeat(3, 2)
    p16 = tmp_path / "g16.tif"
    tifffile.imwrite(p16, np.round(grad * 65535).astype(np.uint16), photometric="rgb")
    src = load_image(p16, "linear")
    assert src.bit_depth == 16 and src.data.dtype == np.float32
    assert len(np.unique(src.data[0, :, 1])) == 1024
