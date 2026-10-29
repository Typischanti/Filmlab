"""Bildansicht mit Zoom/Pan, Vorher/Nachher, Split-View, Zuschnitt und
Messwerkzeugen (Filmgrund-Bereich, Neutralpunkt)."""
from __future__ import annotations

from PySide6.QtCore import QPointF, QRectF, Qt, Signal
from PySide6.QtGui import QColor, QCursor, QImage, QPainter, QPen, QPixmap
from PySide6.QtWidgets import QWidget

TOOL_NONE, TOOL_CROP, TOOL_BASE, TOOL_NEUTRAL = "none", "crop", "base", "neutral"


class ImageViewer(QWidget):
    rectPicked = Signal(str, list)        # tool, [x0,y0,x1,y1] normiert
    cropEdited = Signal(list)
    zoomChanged = Signal(float)
    pixelHovered = Signal(float, float)   # normierte Position

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMouseTracking(True)
        self.setFocusPolicy(Qt.StrongFocus)
        self.setMinimumSize(320, 240)
        self._after: QPixmap | None = None
        self._before: QPixmap | None = None
        self.mode = "after"               # after | before | split
        self.split = 0.5
        self.scale = 1.0
        self.offset = QPointF(0, 0)
        self.fit_mode = True
        self.tool = TOOL_NONE
        self.crop_rect: list[float] | None = None
        self.overlays: list[tuple[list[float], QColor, str]] = []
        self.full_width = 0               # Breite in voller Auflösung (für Zoomanzeige)
        self.message = "Bilder öffnen (Strg+O) oder hierher ziehen"
        self._drag_start: QPointF | None = None
        self._drag_mode: str | None = None
        self._drag_rect: list[float] | None = None
        self._pan_origin = QPointF()
        self._space = False

    # ------------------------------------------------------------------
    def set_images(self, after: QImage | None, before: QImage | None = None, reset_view: bool = False,
                   upscale: float = 1.0):
        """``upscale`` > 1: Entwurfsbild geringerer Auflösung, das in der
        logischen Größe des vollen Vorschaubilds dargestellt wird."""
        old = self._img_size() if self._after else None
        self._after = QPixmap.fromImage(after) if after is not None else None
        self._before = QPixmap.fromImage(before) if before is not None else None
        pm = self._after or self._before
        self._logical = (pm.width() * upscale, pm.height() * upscale) if pm else None
        new = self._img_size()
        if reset_view or old is None or (abs(old[0] - new[0]) > 2 or abs(old[1] - new[1]) > 2):
            self.fit_mode = True
        if self.fit_mode:
            self.fit()
        self.update()

    def clear(self, message: str = ""):
        self._after = self._before = None
        self.message = message
        self.update()

    def set_mode(self, mode: str):
        self.mode = mode
        self.update()

    def set_tool(self, tool: str):
        self.tool = tool
        self.setCursor(Qt.CrossCursor if tool in (TOOL_BASE, TOOL_NEUTRAL) else Qt.ArrowCursor)
        self.update()

    def set_overlays(self, overlays):
        self.overlays = overlays
        self.update()

    # ------------------------------------------------------------------
    def _img_size(self):
        if getattr(self, "_logical", None):
            return self._logical
        pm = self._after or self._before
        return (pm.width(), pm.height()) if pm else (1, 1)

    def fit(self):
        w, h = self._img_size()
        if w <= 1:
            return
        margin = 16
        self.scale = min((self.width() - margin) / w, (self.height() - margin) / h)
        self.scale = max(self.scale, 0.01)
        self.offset = QPointF((self.width() - w * self.scale) / 2, (self.height() - h * self.scale) / 2)
        self.fit_mode = True
        self.zoomChanged.emit(self.display_zoom())
        self.update()

    def display_zoom(self) -> float:
        w, _ = self._img_size()
        return self.scale * w / self.full_width if self.full_width else self.scale

    def zoom_to(self, factor: float, anchor: QPointF | None = None):
        anchor = anchor or QPointF(self.width() / 2, self.height() / 2)
        img_pt = (anchor - self.offset) / self.scale
        self.scale = max(0.02, min(factor, 32.0))
        self.offset = anchor - img_pt * self.scale
        self.fit_mode = False
        self.zoomChanged.emit(self.display_zoom())
        self.update()

    def zoom_100(self):
        w, _ = self._img_size()
        # 100 % bezogen auf die Vorschau-Pixel (begrenzt durch Vorschauauflösung)
        self.zoom_to(1.0)

    def resizeEvent(self, e):
        if self.fit_mode:
            self.fit()
        super().resizeEvent(e)

    def _to_norm(self, pos: QPointF) -> tuple[float, float]:
        w, h = self._img_size()
        p = (pos - self.offset) / self.scale
        return min(max(p.x() / w, 0.0), 1.0), min(max(p.y() / h, 0.0), 1.0)

    def _to_widget_rect(self, r: list[float]) -> QRectF:
        w, h = self._img_size()
        return QRectF(self.offset.x() + r[0] * w * self.scale, self.offset.y() + r[1] * h * self.scale,
                      (r[2] - r[0]) * w * self.scale, (r[3] - r[1]) * h * self.scale)

    # ------------------------------------------------------------------
    def paintEvent(self, e):
        p = QPainter(self)
        p.fillRect(self.rect(), QColor("#141415"))
        if not (self._after or self._before):
            p.setPen(QColor("#777"))
            p.drawText(self.rect(), Qt.AlignCenter, self.message)
            return
        p.setRenderHint(QPainter.SmoothPixmapTransform, self.scale < 2.0)
        w, h = self._img_size()
        target = QRectF(self.offset.x(), self.offset.y(), w * self.scale, h * self.scale)
        pm = self._after or self._before
        src = QRectF(0, 0, pm.width(), pm.height())
        if self.mode == "before" and self._before:
            p.drawPixmap(target, self._before, src)
        elif self.mode == "split" and self._before and self._after:
            sx = target.left() + target.width() * self.split
            p.save()
            p.setClipRect(QRectF(target.left(), target.top(), sx - target.left(), target.height()))
            p.drawPixmap(target, self._before, src)
            p.restore()
            p.save()
            p.setClipRect(QRectF(sx, target.top(), target.right() - sx, target.height()))
            p.drawPixmap(target, self._after, src)
            p.restore()
            p.setPen(QPen(QColor(255, 255, 255, 200), 1))
            p.drawLine(QPointF(sx, target.top()), QPointF(sx, target.bottom()))
            p.setPen(QColor(255, 255, 255, 180))
            p.drawText(QRectF(sx - 80, target.top() + 4, 74, 18), Qt.AlignRight, "Vorher")
            p.drawText(QRectF(sx + 6, target.top() + 4, 74, 18), Qt.AlignLeft, "Nachher")
        elif self._after:
            p.drawPixmap(target, self._after, src)
        p.setRenderHint(QPainter.Antialiasing)
        for rect, color, label in self.overlays:
            r = self._to_widget_rect(rect)
            p.setPen(QPen(color, 1.5, Qt.DashLine))
            p.setBrush(Qt.NoBrush)
            p.drawRect(r)
            if label:
                p.drawText(r.adjusted(3, 2, 200, 0).topLeft() + QPointF(0, 12), label)
        if self.tool == TOOL_CROP and self.crop_rect:
            r = self._to_widget_rect(self.crop_rect)
            shade = QColor(0, 0, 0, 140)
            p.setPen(Qt.NoPen)
            p.setBrush(shade)
            p.drawRect(QRectF(target.left(), target.top(), target.width(), r.top() - target.top()))
            p.drawRect(QRectF(target.left(), r.bottom(), target.width(), target.bottom() - r.bottom()))
            p.drawRect(QRectF(target.left(), r.top(), r.left() - target.left(), r.height()))
            p.drawRect(QRectF(r.right(), r.top(), target.right() - r.right(), r.height()))
            p.setBrush(Qt.NoBrush)
            p.setPen(QPen(QColor(255, 255, 255, 220), 1))
            p.drawRect(r)
            p.setPen(QPen(QColor(255, 255, 255, 70), 1))
            for i in (1, 2):
                p.drawLine(QPointF(r.left() + r.width() * i / 3, r.top()), QPointF(r.left() + r.width() * i / 3, r.bottom()))
                p.drawLine(QPointF(r.left(), r.top() + r.height() * i / 3), QPointF(r.right(), r.top() + r.height() * i / 3))
            p.setPen(Qt.NoPen)
            p.setBrush(QColor(255, 255, 255))
            for c in (r.topLeft(), r.topRight(), r.bottomLeft(), r.bottomRight()):
                p.drawRect(QRectF(c.x() - 4, c.y() - 4, 8, 8))
        if self._drag_rect and self.tool in (TOOL_BASE, TOOL_NEUTRAL):
            p.setPen(QPen(QColor("#ffd060"), 1.5))
            p.setBrush(QColor(255, 208, 96, 40))
            p.drawRect(self._to_widget_rect(self._drag_rect))

    # ------------------------------------------------------------------
    def wheelEvent(self, e):
        if not self._after:
            return
        factor = 1.0015 ** e.angleDelta().y()
        self.zoom_to(self.scale * factor, e.position())

    def keyPressEvent(self, e):
        if e.key() == Qt.Key_Space:
            self._space = True
            self.setCursor(Qt.OpenHandCursor)
        elif e.key() == Qt.Key_F:
            self.fit()
        elif e.key() == Qt.Key_1:
            self.zoom_100()
        else:
            super().keyPressEvent(e)

    def keyReleaseEvent(self, e):
        if e.key() == Qt.Key_Space and not e.isAutoRepeat():
            self._space = False
            self.set_tool(self.tool)
        super().keyReleaseEvent(e)

    def _crop_hit(self, pos: QPointF) -> str | None:
        if not self.crop_rect:
            return None
        r = self._to_widget_rect(self.crop_rect)
        tol = 8
        near_l, near_r = abs(pos.x() - r.left()) < tol, abs(pos.x() - r.right()) < tol
        near_t, near_b = abs(pos.y() - r.top()) < tol, abs(pos.y() - r.bottom()) < tol
        inside_x = r.left() - tol < pos.x() < r.right() + tol
        inside_y = r.top() - tol < pos.y() < r.bottom() + tol
        edge = ""
        if near_t and inside_x:
            edge += "t"
        if near_b and inside_x:
            edge += "b"
        if near_l and inside_y:
            edge += "l"
        if near_r and inside_y:
            edge += "r"
        if edge:
            return edge
        if r.contains(pos):
            return "move"
        return None

    def mousePressEvent(self, e):
        pos = e.position()
        self._drag_start = pos
        if e.button() == Qt.MiddleButton or self._space or (e.button() == Qt.LeftButton and self.tool == TOOL_NONE
                                                            and self.mode != "split"):
            self._drag_mode = "pan"
            self._pan_origin = self.offset
            self.setCursor(Qt.ClosedHandCursor)
            return
        if e.button() != Qt.LeftButton:
            return
        if self.tool == TOOL_NONE and self.mode == "split":
            self._drag_mode = "split"
            self._update_split(pos)
        elif self.tool == TOOL_CROP:
            hit = self._crop_hit(pos)
            self._drag_mode = ("crop_" + hit) if hit else "crop_new"
            self._crop_origin = list(self.crop_rect) if self.crop_rect else None
            if not hit:
                x, y = self._to_norm(pos)
                self.crop_rect = [x, y, x, y]
        elif self.tool in (TOOL_BASE, TOOL_NEUTRAL):
            self._drag_mode = "pick"
            x, y = self._to_norm(pos)
            self._drag_rect = [x, y, x, y]

    def _update_split(self, pos):
        w, _ = self._img_size()
        self.split = min(max((pos.x() - self.offset.x()) / (w * self.scale), 0.0), 1.0)
        self.update()

    def mouseMoveEvent(self, e):
        pos = e.position()
        if self._after:
            x, y = self._to_norm(pos)
            self.pixelHovered.emit(x, y)
        if self._drag_mode is None:
            if self.tool == TOOL_CROP:
                hit = self._crop_hit(pos)
                cursors = {"move": Qt.SizeAllCursor, "t": Qt.SizeVerCursor, "b": Qt.SizeVerCursor,
                           "l": Qt.SizeHorCursor, "r": Qt.SizeHorCursor, "tl": Qt.SizeFDiagCursor,
                           "br": Qt.SizeFDiagCursor, "tr": Qt.SizeBDiagCursor, "bl": Qt.SizeBDiagCursor}
                self.setCursor(cursors.get(hit or "", Qt.CrossCursor))
            return
        if self._drag_mode == "pan":
            self.offset = self._pan_origin + (pos - self._drag_start)
            self.fit_mode = False
            self.update()
        elif self._drag_mode == "split":
            self._update_split(pos)
        elif self._drag_mode.startswith("crop"):
            x, y = self._to_norm(pos)
            if self._drag_mode == "crop_new":
                self.crop_rect[2], self.crop_rect[3] = x, y
            elif self._drag_mode == "crop_move" and self._crop_origin:
                x0, y0 = self._to_norm(self._drag_start)
                dx, dy = x - x0, y - y0
                o = self._crop_origin
                dx = min(max(dx, -o[0]), 1 - o[2])
                dy = min(max(dy, -o[1]), 1 - o[3])
                self.crop_rect = [o[0] + dx, o[1] + dy, o[2] + dx, o[3] + dy]
            else:
                edges = self._drag_mode[5:]
                r = list(self._crop_origin)
                if "l" in edges:
                    r[0] = x
                if "r" in edges:
                    r[2] = x
                if "t" in edges:
                    r[1] = y
                if "b" in edges:
                    r[3] = y
                self.crop_rect = r
            self.update()
        elif self._drag_mode == "pick":
            x, y = self._to_norm(pos)
            self._drag_rect[2], self._drag_rect[3] = x, y
            self.update()

    def mouseReleaseEvent(self, e):
        mode = self._drag_mode
        self._drag_mode = None
        if mode == "pan":
            self.set_tool(self.tool)
            if self._space:
                self.setCursor(Qt.OpenHandCursor)
        elif mode and mode.startswith("crop") and self.crop_rect:
            r = self.crop_rect
            r = [min(r[0], r[2]), min(r[1], r[3]), max(r[0], r[2]), max(r[1], r[3])]
            if r[2] - r[0] < 0.02 or r[3] - r[1] < 0.02:
                r = self._crop_origin or [0.0, 0.0, 1.0, 1.0]
            self.crop_rect = r
            self.cropEdited.emit(list(r))
            self.update()
        elif mode == "pick" and self._drag_rect:
            r = self._drag_rect
            r = [min(r[0], r[2]), min(r[1], r[3]), max(r[0], r[2]), max(r[1], r[3])]
            w, h = self._img_size()
            # Mindestgröße: einzelner Klick misst ein 7x7-Pixel-Feld
            if (r[2] - r[0]) * w < 7:
                cx = (r[0] + r[2]) / 2
                r[0], r[2] = max(cx - 3.5 / w, 0), min(cx + 3.5 / w, 1)
            if (r[3] - r[1]) * h < 7:
                cy = (r[1] + r[3]) / 2
                r[1], r[3] = max(cy - 3.5 / h, 0), min(cy + 3.5 / h, 1)
            self._drag_rect = None
            self.update()
            self.rectPicked.emit(self.tool, r)
