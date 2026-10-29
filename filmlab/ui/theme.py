"""Dunkles, ruhiges Farbschema (neutralgrau, damit die Bildbeurteilung nicht
durch farbige Bedienelemente beeinflusst wird)."""
from __future__ import annotations

from PySide6.QtGui import QColor, QPalette
from PySide6.QtWidgets import QApplication

BG = "#1e1e1f"
PANEL = "#252526"
PANEL_2 = "#2d2d2f"
BORDER = "#3a3a3c"
TEXT = "#d8d8d8"
TEXT_DIM = "#9a9a9a"
ACCENT = "#6d9eeb"
WARN = "#e0a050"

STYLESHEET = f"""
QWidget {{ background: {BG}; color: {TEXT}; font-size: 12px; }}
QMainWindow::separator {{ background: {BORDER}; width: 1px; height: 1px; }}
QFrame#panel, QScrollArea#panel, QWidget#panelContent {{ background: {PANEL}; }}
QLabel {{ background: transparent; }}
QLabel#dim {{ color: {TEXT_DIM}; }}
QLabel#warn {{ color: {WARN}; }}
QLabel#heading {{ font-weight: 600; color: {TEXT}; padding: 4px 0; }}
QPushButton, QToolButton {{
    background: {PANEL_2}; border: 1px solid {BORDER}; border-radius: 4px; padding: 4px 10px;
}}
QPushButton:hover, QToolButton:hover {{ border-color: #55575b; background: #343437; }}
QPushButton:pressed, QToolButton:pressed {{ background: #3c3c40; }}
QPushButton:checked, QToolButton:checked {{ background: #3a4a63; border-color: {ACCENT}; }}
QPushButton:disabled {{ color: #666; }}
QPushButton#primary {{ background: #34507a; border-color: #4a6da3; }}
QPushButton#section, QPushButton#section:checked, QPushButton#section:hover {{
    border: none; background: transparent; font-weight: 600; text-align: left; padding: 6px 2px; }}
QComboBox, QSpinBox, QDoubleSpinBox, QLineEdit {{
    background: {PANEL_2}; border: 1px solid {BORDER}; border-radius: 3px; padding: 2px 4px;
    selection-background-color: {ACCENT};
}}
QDoubleSpinBox#plain::up-button, QDoubleSpinBox#plain::down-button {{ width: 0px; border: none; }}
QComboBox QAbstractItemView {{ background: {PANEL_2}; border: 1px solid {BORDER}; }}
QSlider::groove:horizontal {{ height: 3px; background: #444; border-radius: 1px; }}
QSlider::sub-page:horizontal {{ background: #5a5a5e; border-radius: 1px; }}
QSlider::handle:horizontal {{ background: #c8c8c8; width: 11px; height: 11px; margin: -5px 0; border-radius: 6px; }}
QSlider::handle:horizontal:hover {{ background: #ffffff; }}
QListWidget {{ background: {PANEL}; border: none; outline: none; }}
QListWidget::item {{ padding: 3px; border-radius: 3px; }}
QListWidget::item:selected {{ background: #3a4a63; color: white; }}
QListWidget::item:hover {{ background: #303033; }}
QScrollBar:vertical {{ background: {PANEL}; width: 10px; }}
QScrollBar::handle:vertical {{ background: #4a4a4d; border-radius: 4px; min-height: 30px; }}
QScrollBar:horizontal {{ background: {PANEL}; height: 10px; }}
QScrollBar::handle:horizontal {{ background: #4a4a4d; border-radius: 4px; min-width: 30px; }}
QScrollBar::add-line, QScrollBar::sub-line {{ width: 0; height: 0; }}
QStatusBar {{ background: {PANEL}; color: {TEXT_DIM}; }}
QMenuBar {{ background: {PANEL}; }}
QMenuBar::item:selected, QMenu::item:selected {{ background: #3a4a63; }}
QMenu {{ background: {PANEL_2}; border: 1px solid {BORDER}; }}
QToolTip {{ background: #333; color: {TEXT}; border: 1px solid {BORDER}; }}
QProgressBar {{ border: 1px solid {BORDER}; border-radius: 3px; text-align: center; background: {PANEL_2}; }}
QProgressBar::chunk {{ background: #4a6da3; }}
QTabWidget::pane {{ border: none; }}
QCheckBox {{ background: transparent; }}
"""


def apply_theme(app: QApplication) -> None:
    app.setStyle("Fusion")
    pal = QPalette()
    for role, color in [
        (QPalette.Window, BG), (QPalette.WindowText, TEXT), (QPalette.Base, PANEL_2),
        (QPalette.AlternateBase, PANEL), (QPalette.Text, TEXT), (QPalette.Button, PANEL_2),
        (QPalette.ButtonText, TEXT), (QPalette.Highlight, ACCENT), (QPalette.HighlightedText, "#ffffff"),
        (QPalette.ToolTipBase, "#333333"), (QPalette.ToolTipText, TEXT),
    ]:
        pal.setColor(role, QColor(color))
    pal.setColor(QPalette.Disabled, QPalette.Text, QColor("#666"))
    pal.setColor(QPalette.Disabled, QPalette.ButtonText, QColor("#666"))
    app.setPalette(pal)
    app.setStyleSheet(STYLESHEET)
