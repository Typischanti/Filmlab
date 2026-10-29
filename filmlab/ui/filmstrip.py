"""Filmstreifen mit Miniaturen und Stapelaktionen."""
from __future__ import annotations

from PySide6.QtCore import QSize, Qt, Signal
from PySide6.QtGui import QAction, QColor, QIcon, QImage, QPainter, QPixmap
from PySide6.QtWidgets import (QAbstractItemView, QHBoxLayout, QListView, QListWidget, QListWidgetItem, QMenu,
                               QPushButton, QToolButton, QVBoxLayout, QWidget)

THUMB_H = 84


def _placeholder(text: str = "…") -> QIcon:
    pm = QPixmap(int(THUMB_H * 1.5), THUMB_H)
    pm.fill(QColor("#2a2a2c"))
    p = QPainter(pm)
    p.setPen(QColor("#777"))
    p.drawText(pm.rect(), Qt.AlignCenter, text)
    p.end()
    return QIcon(pm)


class FilmStrip(QWidget):
    currentChanged = Signal(int)
    action = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setObjectName("panelContent")
        lay = QHBoxLayout(self)
        lay.setContentsMargins(6, 4, 6, 4)
        self.list = QListWidget()
        self.list.setViewMode(QListView.IconMode)
        self.list.setFlow(QListView.LeftToRight)
        self.list.setWrapping(False)
        self.list.setMovement(QListView.Static)
        self.list.setIconSize(QSize(int(THUMB_H * 1.5), THUMB_H))
        self.list.setSelectionMode(QAbstractItemView.ExtendedSelection)
        self.list.setHorizontalScrollMode(QAbstractItemView.ScrollPerPixel)
        self.list.setFixedHeight(THUMB_H + 42)
        self.list.setSpacing(4)
        self.list.setUniformItemSizes(True)
        lay.addWidget(self.list, 1)

        col = QVBoxLayout()
        sync = QToolButton()
        sync.setText("Einstellungen synchronisieren")
        sync.setToolTip("Bearbeitung des aktuellen Bildes auf alle markierten Bilder übertragen")
        sync.setPopupMode(QToolButton.MenuButtonPopup)
        menu = QMenu(sync)
        a1 = QAction("Ohne Zuschnitt/Rotation", menu)
        a2 = QAction("Inklusive Zuschnitt/Rotation", menu)
        menu.addAction(a1)
        menu.addAction(a2)
        sync.setMenu(menu)
        sync.clicked.connect(lambda: self.action.emit("sync"))
        a1.triggered.connect(lambda: self.action.emit("sync"))
        a2.triggered.connect(lambda: self.action.emit("sync_geometry"))
        roll = QPushButton("Filmstreifen-Analyse")
        roll.setToolTip("Gemeinsamer Filmgrund und gemeinsame Schwarz-/Weißpunkte für alle markierten Bilder "
                        "(bzw. alle Bilder) – konsistente Entwicklung eines Films.")
        unlock = QPushButton("Analyse freigeben")
        unlock.setToolTip("Sperre der markierten Bilder lösen; Analyse wieder je Bild.")
        batch = QPushButton("Stapel-Export …")
        for w in (sync, roll, unlock, batch):
            w.setMinimumWidth(190)
            col.addWidget(w)
        roll.clicked.connect(lambda: self.action.emit("roll"))
        unlock.clicked.connect(lambda: self.action.emit("unlock"))
        batch.clicked.connect(lambda: self.action.emit("export_batch"))
        lay.addLayout(col)
        self.list.currentRowChanged.connect(lambda r: r >= 0 and self.currentChanged.emit(r))

    def add_item(self, name: str):
        it = QListWidgetItem(_placeholder(), name)
        it.setSizeHint(QSize(int(THUMB_H * 1.5) + 12, THUMB_H + 30))
        it.setTextAlignment(Qt.AlignHCenter | Qt.AlignTop)
        it.setToolTip(name)
        self.list.addItem(it)

    def set_thumb(self, index: int, img: QImage | None, text: str = ""):
        it = self.list.item(index)
        if it is None:
            return
        if img is None:
            it.setIcon(_placeholder(text or "Fehler"))
        else:
            it.setIcon(QIcon(QPixmap.fromImage(img.scaled(self.list.iconSize(), Qt.KeepAspectRatio,
                                                          Qt.SmoothTransformation))))

    def selected_rows(self) -> list[int]:
        return sorted(self.list.row(i) for i in self.list.selectedItems())

    def set_current(self, index: int):
        self.list.blockSignals(True)
        self.list.setCurrentRow(index)
        self.list.blockSignals(False)

    def clear(self):
        self.list.clear()
