import os
import sys
from pathlib import Path

import numpy as np
import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from filmlab.core.settings import EditSettings  # noqa: E402
from filmlab.imaging import pipeline  # noqa: E402
from filmlab.imaging.synthetic import FilmModel, ScanModel, make_negative  # noqa: E402


@pytest.fixture(autouse=True)
def isolated_home(tmp_path, monkeypatch):
    """Benutzerverzeichnis (~/.filmlab) pro Test isolieren."""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: home))
    return home


@pytest.fixture
def negative():
    return make_negative(300, 450, sprockets=True)


def gray_patches(neg, lin):
    """Mittelwerte der 12 Graustufenfelder (Szene: 0.02 .. 0.9)."""
    x0, y0, x1, y1 = neg.frame
    fh, fw = y1 - y0, x1 - x0
    bh = fh // 5
    out = []
    for i in range(12):
        xa = x0 + i * fw // 12 + 3
        xb = x0 + (i + 1) * fw // 12 - 3
        out.append(lin[y0 + 3:y0 + bh - 3, xa:xb].reshape(-1, 3).mean(axis=0))
    return np.array(out)


def analyzed(neg_img, **kw) -> EditSettings:
    """Analysiert ein Negativ. Für pixelgenaue Prüfungen standardmäßig ohne
    automatischen Zuschnitt, Auto-Balance und Auto-Belichtung."""
    kw.setdefault("auto_crop", False)
    kw.setdefault("auto_color", 0.0)
    kw.setdefault("auto_exposure", False)
    s = EditSettings(**kw)
    s.analysis = pipeline.analyze(pipeline.analysis_proxy(neg_img), s)
    return s
