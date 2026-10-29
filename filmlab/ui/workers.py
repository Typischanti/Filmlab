"""Hintergrundverarbeitung.

* ``LatestOnlyRunner``: genau ein Rendering gleichzeitig; neue Anfragen
  ersetzen wartende (keine Warteschlange beim schnellen Ziehen von Reglern).
* ``Task``: allgemeiner QRunnable mit Signalen für Ergebnis/Fehler/Fortschritt.

Rechenfunktionen laufen ohne Qt-Widgets; QImage darf im Worker-Thread erzeugt
werden, QPixmap nur im GUI-Thread (geschieht im Viewer).
"""
from __future__ import annotations

import threading
import traceback
from dataclasses import dataclass, field
from typing import Any, Callable

import numpy as np
from PySide6.QtCore import QObject, QRunnable, QThreadPool, QTimer, Signal
from PySide6.QtGui import QImage

from ..core.settings import Analysis, EditSettings
from ..imaging import pipeline
from ..imaging.loader import SourceImage, load_image, make_proxy

PREVIEW_DIM = 1800
THUMB_DIM = 360


class TaskSignals(QObject):
    finished = Signal(object)
    failed = Signal(str)
    progress = Signal(int, int, str)


class Task(QRunnable):
    # Python-Referenzen halten, bis die Ergebnis-Signale im GUI-Thread
    # zugestellt sind (sonst kann der Signal-Träger vorher freigegeben werden).
    _active: set["Task"] = set()

    def __init__(self, fn: Callable, *args, with_progress: bool = False, **kwargs):
        super().__init__()
        self.fn, self.args, self.kwargs = fn, args, kwargs
        self.signals = TaskSignals()
        self.with_progress = with_progress
        self.cancel_event = threading.Event()
        self.setAutoDelete(False)
        Task._active.add(self)
        self.signals.finished.connect(self._release)
        self.signals.failed.connect(self._release)

    def _release(self, *_):
        QTimer.singleShot(0, lambda: Task._active.discard(self))

    def run(self):
        try:
            if self.with_progress:
                self.kwargs["progress"] = lambda i, n, msg: self.signals.progress.emit(i, n, msg)
                self.kwargs["cancelled"] = self.cancel_event.is_set
            result = self.fn(*self.args, **self.kwargs)
        except Exception as exc:
            traceback.print_exc()
            self._emit(self.signals.failed, f"{type(exc).__name__}: {exc}")
        else:
            self._emit(self.signals.finished, result)

    @staticmethod
    def _emit(signal, value):
        try:
            signal.emit(value)
        except RuntimeError:  # Anwendung wird gerade beendet
            pass


class LatestOnlyRunner(QObject):
    resultReady = Signal(object)
    failed = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.pool = QThreadPool()
        self.pool.setMaxThreadCount(1)
        self._busy = False
        self._pending: tuple | None = None

    def request(self, fn: Callable, *args):
        if self._busy:
            self._pending = (fn, args)
            return
        self._start(fn, args)

    def _start(self, fn, args):
        self._busy = True
        task = Task(fn, *args)
        task.signals.finished.connect(self._done)
        task.signals.failed.connect(self._failed)
        self.pool.start(task)

    def _next(self):
        self._busy = False
        if self._pending:
            fn, args = self._pending
            self._pending = None
            self._start(fn, args)

    def _done(self, result):
        # Ergebnis nur ausliefern, wenn keine neuere Anfrage wartet
        if self._pending is None:
            self.resultReady.emit(result)
        self._next()

    def _failed(self, msg):
        self.failed.emit(msg)
        self._next()


# ---------------------------------------------------------------------------
# Datencontainer und Job-Funktionen
# ---------------------------------------------------------------------------

@dataclass
class LoadedImage:
    path: str
    source_id: str
    full: np.ndarray | None
    preview: np.ndarray
    analysis_proxy: np.ndarray
    thumb_proxy: np.ndarray
    full_size: tuple[int, int]          # (h, w)
    kind: str
    bit_depth: int
    encoding: str
    warnings: list[str] = field(default_factory=list)
    meta: dict = field(default_factory=dict)
    cache: pipeline.StageCache = field(default_factory=pipeline.StageCache)

    @property
    def preview_scale(self) -> float:
        return self.preview.shape[1] / self.full_size[1]


def load_job(path: str, input_encoding: str, keep_full: bool = True) -> LoadedImage:
    src: SourceImage = load_image(path, input_encoding)
    full = src.data
    return LoadedImage(
        path=path, source_id=src.source_id, full=full if keep_full else None,
        preview=np.ascontiguousarray(make_proxy(full, PREVIEW_DIM)),
        analysis_proxy=np.ascontiguousarray(pipeline.analysis_proxy(full)),
        thumb_proxy=np.ascontiguousarray(make_proxy(full, THUMB_DIM)),
        full_size=full.shape[:2], kind=src.kind, bit_depth=src.bit_depth, encoding=src.encoding,
        warnings=list(src.warnings), meta=dict(src.metadata),
    )


def to_qimage(img: np.ndarray) -> QImage:
    a = np.ascontiguousarray(np.clip(np.rint(np.clip(img, 0, 1) * 255.0), 0, 255).astype(np.uint8))
    h, w, _ = a.shape
    return QImage(a.data, w, h, 3 * w, QImage.Format_RGB888).copy()


def histogram(img: np.ndarray, bins: int = 256) -> tuple[np.ndarray, tuple[float, float]]:
    sub = img[:: max(1, img.shape[0] // 600), :: max(1, img.shape[1] // 600)].reshape(-1, 3)
    q = np.clip((sub * (bins - 1) + 0.5).astype(np.int32), 0, bins - 1)
    hist = np.stack([np.bincount(q[:, c], minlength=bins) for c in range(3)]
                    + [np.bincount(np.clip(((sub @ np.array([0.2126, 0.7152, 0.0722])) * (bins - 1) + 0.5)
                                           .astype(np.int32), 0, bins - 1), minlength=bins)])
    lo = float(np.mean(np.all(sub <= 0.5 / 255, axis=1)))
    hi = float(np.mean(np.any(sub >= 254.5 / 255, axis=1)))
    return hist.astype(np.float32), (lo, hi)


@dataclass
class PreviewResult:
    token: int
    analysis: Analysis
    analysis_key: str
    after: QImage
    before: QImage | None
    hist: np.ndarray
    clip: tuple[float, float]
    uncropped: bool


def preview_job(token: int, img: LoadedImage, settings: EditSettings, uncropped: bool) -> PreviewResult:
    s = pipeline.ensure_analysis(img.analysis_proxy, settings.copy(), img.source_id)
    view = s.copy()
    if uncropped:
        view.geometry.crop = None
    out = pipeline.render(img.preview, view, scale=img.preview_scale, output_space="srgb",
                          cache=img.cache, cache_id=img.source_id)
    before = pipeline.render_negative(img.preview, view)
    hist, clip = histogram(out)
    return PreviewResult(token, s.analysis, s.analysis.key, to_qimage(out), to_qimage(before), hist, clip, uncropped)


def thumb_job(index: int, path: str, settings: EditSettings, thumb_proxy: np.ndarray | None = None
              ) -> tuple[int, QImage, Analysis, np.ndarray, list[str]]:
    """Lädt (falls nötig) ein Bild, aktualisiert die Analyse und rendert die
    Miniatur des Positivs."""
    warnings: list[str] = []
    s = settings.copy()
    needs_analysis = not (s.lock_analysis and s.analysis.key) and s.analysis.key != s.analysis_key(_sid(path))
    if thumb_proxy is None or needs_analysis:
        src = load_image(path, s.input_encoding)
        warnings = list(src.warnings)
        s = pipeline.ensure_analysis(pipeline.analysis_proxy(src.data), s, src.source_id)
        thumb_proxy = np.ascontiguousarray(make_proxy(src.data, THUMB_DIM))
        full_w = src.data.shape[1]
        del src
    else:
        full_w = None
    scale = thumb_proxy.shape[1] / full_w if full_w else 0.1
    out = pipeline.render(thumb_proxy, s, scale=scale, output_space="srgb")
    return index, to_qimage(out), s.analysis, thumb_proxy, warnings


def _sid(path: str) -> str:
    import os

    try:
        st = os.stat(path)
        return f"{path}|{st.st_size}|{int(st.st_mtime)}"
    except OSError:
        return path


def call(fn: Callable[..., Any], *args, **kwargs) -> Any:
    return fn(*args, **kwargs)
