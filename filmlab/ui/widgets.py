"""Wiederverwendbare Bedienelemente: Parameter-Regler, einklappbare Abschnitte,
Histogramm und Gradationskurven-Editor."""
from __future__ import annotations

import numpy as np
from PySide6.QtCore import QPointF, QRectF, Qt, Signal
from PySide6.QtGui import QColor, QMouseEvent, QPainter, QPainterPath, QPen
from PySide6.QtWidgets import (QDoubleSpinBox, QFrame, QHBoxLayout, QLabel, QPushButton, QSizePolicy, QSlider,
                               QVBoxLayout, QWidget)

from ..imaging.tone import monotone_curve


class _ResetLabel(QLabel):
    doubleClicked = Signal()

    def mouseDoubleClickEvent(self, e):
        self.doubleClicked.emit()


class ParamSlider(QWidget):
    """Regler mit Zahlenfeld. Doppelklick auf die Beschriftung setzt zurück."""

    valueChanged = Signal(float)      # während des Ziehens
    editStarted = Signal()
    editFinished = Signal()

    def __init__(self, label: str, minimum: float, maximum: float, default: float = 0.0,
                 decimals: int = 0, step: float | None = None, tooltip: str = "", parent=None):
        super().__init__(parent)
        self.minimum, self.maximum, self.default = minimum, maximum, default
        self.step = step or (10 ** -decimals if decimals else 1.0)
        self._steps = int(round((maximum - minimum) / self.step))
        self._block = False

        self.label = _ResetLabel(label)
        self.label.setMinimumWidth(92)
        self.label.setToolTip((tooltip + "\n" if tooltip else "") + "Doppelklick: zurücksetzen")
        self.slider = QSlider(Qt.Horizontal)
        self.slider.setRange(0, self._steps)
        self.slider.setFocusPolicy(Qt.NoFocus)
        self.spin = QDoubleSpinBox()
        self.spin.setRange(minimum, maximum)
        self.spin.setDecimals(decimals)
        self.spin.setSingleStep(self.step)
        # Hinweis: NoButtons + Stylesheet lässt das Textfeld in Qt 6 auf 1 px
        # schrumpfen; die Pfeile werden stattdessen per Stylesheet ausgeblendet.
        self.spin.setObjectName("plain")
        self.spin.setAlignment(Qt.AlignRight)
        self.spin.setKeyboardTracking(False)
        self.spin.setFixedWidth(56)

        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 1, 0, 1)
        lay.setSpacing(6)
        lay.addWidget(self.label)
        lay.addWidget(self.slider, 1)
        lay.addWidget(self.spin)

        self.slider.valueChanged.connect(self._from_slider)
        self.slider.sliderPressed.connect(self.editStarted)
        self.slider.sliderReleased.connect(self.editFinished)
        self.spin.valueChanged.connect(self._from_spin)
        self.label.doubleClicked.connect(self.reset)
        self.setValue(default, silent=True)

    def _to_pos(self, v: float) -> int:
        return int(round((v - self.minimum) / self.step))

    def _from_slider(self, pos: int):
        if self._block:
            return
        v = self.minimum + pos * self.step
        self._block = True
        self.spin.setValue(v)
        self._block = False
        self.valueChanged.emit(float(v))
        if not self.slider.isSliderDown():
            self.editFinished.emit()

    def _from_spin(self, v: float):
        if self._block:
            return
        self._block = True
        self.slider.setValue(self._to_pos(v))
        self._block = False
        self.editStarted.emit()
        self.valueChanged.emit(float(v))
        self.editFinished.emit()

    def value(self) -> float:
        return float(self.spin.value())

    def setValue(self, v: float, silent: bool = False):
        v = float(np.clip(v, self.minimum, self.maximum))
        self._block = True
        self.spin.setValue(v)
        self.slider.setValue(self._to_pos(v))
        self._block = False
        if not silent:
            self.valueChanged.emit(v)

    def reset(self):
        self.editStarted.emit()
        self.setValue(self.default)
        self.editFinished.emit()

    def wheelEvent(self, e):  # versehentliches Verstellen beim Scrollen verhindern
        e.ignore()


class Section(QWidget):
    """Einklappbarer Abschnitt der Seitenleiste."""

    def __init__(self, title: str, expanded: bool = True, parent=None):
        super().__init__(parent)
        self.button = QPushButton()
        self.button.setObjectName("section")
        self.button.setText(("▾ " if expanded else "▸ ") + title)
        self.button.setCheckable(True)
        self.button.setChecked(expanded)
        self.button.setFlat(True)
        self.button.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        self._title = title
        self.body = QWidget()
        self.body_layout = QVBoxLayout(self.body)
        self.body_layout.setContentsMargins(6, 0, 4, 8)
        self.body_layout.setSpacing(3)
        line = QFrame()
        line.setFrameShape(QFrame.HLine)
        line.setStyleSheet("color: #3a3a3c;")
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(0)
        lay.addWidget(line)
        lay.addWidget(self.button)
        lay.addWidget(self.body)
        self.body.setVisible(expanded)
        self.button.toggled.connect(self._toggle)

    def _toggle(self, on: bool):
        self.body.setVisible(on)
        self.button.setText(("▾ " if on else "▸ ") + self._title)

    def add(self, w: QWidget):
        self.body_layout.addWidget(w)
        return w

    def add_layout(self, lay):
        self.body_layout.addLayout(lay)
        return lay


class HistogramWidget(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumHeight(90)
        self.hist: np.ndarray | None = None
        self.clip = (0.0, 0.0)

    def set_data(self, hist: np.ndarray | None, clip: tuple[float, float] = (0.0, 0.0)):
        self.hist = hist
        self.clip = clip
        self.update()

    def paintEvent(self, e):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        r = self.rect().adjusted(1, 1, -1, -1)
        p.fillRect(r, QColor("#1a1a1b"))
        p.setPen(QPen(QColor("#333"), 1))
        for i in range(1, 4):
            x = r.left() + r.width() * i / 4
            p.drawLine(QPointF(x, r.top()), QPointF(x, r.bottom()))
        if self.hist is not None:
            h = self.hist.astype(np.float64)
            # Quadratwurzel-Skala: Details sichtbar, Spitzen nicht dominant
            peak = np.sqrt(np.percentile(h[:, 1:-1], 99.5) if h.shape[1] > 2 else h.max()) or 1.0
            colors = [QColor(230, 80, 80, 110), QColor(80, 200, 90, 110), QColor(90, 130, 240, 110),
                      QColor(220, 220, 220, 90)]
            p.setCompositionMode(QPainter.CompositionMode_Plus)
            n = h.shape[1]
            for ch in range(h.shape[0]):
                path = QPainterPath(QPointF(r.left(), r.bottom()))
                for i in range(n):
                    x = r.left() + r.width() * i / (n - 1)
                    y = r.bottom() - r.height() * min(np.sqrt(h[ch, i]) / peak, 1.0)
                    path.lineTo(x, y)
                path.lineTo(r.right(), r.bottom())
                path.closeSubpath()
                p.fillPath(path, colors[ch % 4])
            p.setCompositionMode(QPainter.CompositionMode_SourceOver)
        lo, hi = self.clip
        p.setPen(QColor("#9a9a9a"))
        if lo > 0.001:
            p.drawText(r.adjusted(4, 2, 0, 0), Qt.AlignLeft | Qt.AlignTop, f"▼ {lo * 100:.1f}%")
        if hi > 0.001:
            p.drawText(r.adjusted(0, 2, -4, 0), Qt.AlignRight | Qt.AlignTop, f"{hi * 100:.1f}% ▲")


class CurveEditor(QWidget):
    """Gradationskurve: Klick fügt Punkt hinzu, Ziehen verschiebt,
    Doppelklick/Rechtsklick entfernt. Monotone Interpolation."""

    curveChanged = Signal(str, list)
    editStarted = Signal()
    editFinished = Signal()

    CHANNEL_COLORS = {"master": QColor("#d8d8d8"), "r": QColor("#e06060"), "g": QColor("#60c070"),
                      "b": QColor("#6090f0")}

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumSize(200, 200)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        self.channel = "master"
        self.curves = {k: [[0.0, 0.0], [1.0, 1.0]] for k in ("master", "r", "g", "b")}
        self._drag: int | None = None
        self.hist: np.ndarray | None = None

    def heightForWidth(self, w):
        return w

    def set_curves(self, curves: dict):
        self.curves = {k: [list(p) for p in v] for k, v in curves.items()}
        self.update()

    def set_channel(self, ch: str):
        self.channel = ch
        self.update()

    def _area(self) -> QRectF:
        s = min(self.width(), self.height()) - 12
        return QRectF((self.width() - s) / 2, 6, s, s)

    def _to_widget(self, x, y) -> QPointF:
        a = self._area()
        return QPointF(a.left() + x * a.width(), a.bottom() - y * a.height())

    def _to_curve(self, pos: QPointF) -> tuple[float, float]:
        a = self._area()
        return (float(np.clip((pos.x() - a.left()) / a.width(), 0, 1)),
                float(np.clip((a.bottom() - pos.y()) / a.height(), 0, 1)))

    def _hit(self, pos: QPointF) -> int | None:
        for i, (x, y) in enumerate(self.curves[self.channel]):
            if (self._to_widget(x, y) - pos).manhattanLength() < 10:
                return i
        return None

    def paintEvent(self, e):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        a = self._area()
        p.fillRect(a, QColor("#1a1a1b"))
        p.setPen(QPen(QColor("#333"), 1))
        for i in range(1, 4):
            p.drawLine(QPointF(a.left() + a.width() * i / 4, a.top()), QPointF(a.left() + a.width() * i / 4, a.bottom()))
            p.drawLine(QPointF(a.left(), a.top() + a.height() * i / 4), QPointF(a.right(), a.top() + a.height() * i / 4))
        p.setPen(QPen(QColor("#444"), 1, Qt.DashLine))
        p.drawLine(self._to_widget(0, 0), self._to_widget(1, 1))
        # andere Kanäle dezent
        xs = np.linspace(0, 1, 128)
        for ch, pts in self.curves.items():
            if ch == self.channel:
                continue
            if len(pts) == 2 and np.allclose(pts, [[0, 0], [1, 1]]):
                continue
            c = QColor(self.CHANNEL_COLORS[ch])
            c.setAlpha(80)
            self._draw_curve(p, pts, xs, c, 1)
        self._draw_curve(p, self.curves[self.channel], xs, self.CHANNEL_COLORS[self.channel], 2)
        p.setBrush(QColor("#1a1a1b"))
        p.setPen(QPen(self.CHANNEL_COLORS[self.channel], 1.5))
        for x, y in self.curves[self.channel]:
            p.drawEllipse(self._to_widget(x, y), 4, 4)

    def _draw_curve(self, p, pts, xs, color, width):
        ys = monotone_curve(pts, xs)
        path = QPainterPath(self._to_widget(xs[0], ys[0]))
        for x, y in zip(xs[1:], ys[1:]):
            path.lineTo(self._to_widget(x, float(np.clip(y, 0, 1))))
        p.setPen(QPen(color, width))
        p.setBrush(Qt.NoBrush)
        p.drawPath(path)

    def mousePressEvent(self, e: QMouseEvent):
        pos = e.position()
        idx = self._hit(pos)
        pts = self.curves[self.channel]
        if e.button() == Qt.RightButton:
            if idx is not None and 0 < idx < len(pts) - 1:
                self.editStarted.emit()
                pts.pop(idx)
                self._emit()
                self.editFinished.emit()
            return
        self.editStarted.emit()
        if idx is None:
            x, y = self._to_curve(pos)
            pts.append([x, y])
            pts.sort(key=lambda q: q[0])
            idx = pts.index([x, y])
            self._emit()
        self._drag = idx

    def mouseMoveEvent(self, e: QMouseEvent):
        if self._drag is None:
            return
        pts = self.curves[self.channel]
        x, y = self._to_curve(e.position())
        i = self._drag
        lo = pts[i - 1][0] + 0.01 if i > 0 else 0.0
        hi = pts[i + 1][0] - 0.01 if i < len(pts) - 1 else 1.0
        if i == 0:
            hi = min(hi, 0.99)
        pts[i] = [float(np.clip(x, lo, hi)), y]
        self._emit()

    def mouseReleaseEvent(self, e):
        if self._drag is not None:
            self._drag = None
            self.editFinished.emit()

    def mouseDoubleClickEvent(self, e):
        idx = self._hit(e.position())
        pts = self.curves[self.channel]
        if idx is not None and 0 < idx < len(pts) - 1:
            pts.pop(idx)
            self._emit()
            self.editFinished.emit()

    def reset_channel(self):
        self.editStarted.emit()
        self.curves[self.channel] = [[0.0, 0.0], [1.0, 1.0]]
        self._emit()
        self.editFinished.emit()

    def _emit(self):
        self.update()
        self.curveChanged.emit(self.channel, [list(p) for p in self.curves[self.channel]])


class ColorSwatch(QLabel):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setFixedSize(36, 20)
        self.set_color(None)

    def set_color(self, rgb8: tuple[int, int, int] | None):
        if rgb8 is None:
            self.setStyleSheet("background: transparent; border: 1px dashed #555; border-radius: 3px;")
        else:
            self.setStyleSheet(f"background: rgb{tuple(rgb8)}; border: 1px solid #555; border-radius: 3px;")
