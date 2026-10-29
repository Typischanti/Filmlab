"""Seitenleisten: links Bibliothek/Film/Profile/Presets, rechts Bearbeitung."""
from __future__ import annotations

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (QButtonGroup, QCheckBox, QComboBox, QFormLayout, QGridLayout, QHBoxLayout, QLabel,
                               QLineEdit, QListWidget, QListWidgetItem, QPushButton, QScrollArea, QSizePolicy, QSpinBox,
                               QVBoxLayout, QWidget)

from ..core.colorspace import OUTPUT_SPACES, SPACES
from ..core.settings import BASE_MODES, FILM_TYPES, NORMALIZATION_MODES, EditSettings
from ..imaging.batch import DEFAULT_TEMPLATE
from ..imaging.export import FORMATS
from .widgets import ColorSwatch, CurveEditor, HistogramWidget, ParamSlider, Section

# name, Beschriftung, min, max, default, Nachkommastellen, Schritt, Tooltip
PARAMS = {
    "exposure": ("Belichtung", -4.0, 4.0, 0.0, 2, 0.05, "Linearer Lichtfaktor in Blendenstufen (EV), nach der Inversion."),
    "brightness": ("Helligkeit", -100, 100, 0, 0, 1, "Hebt/senkt die Mitteltöne; Schwarz und Weiß bleiben fest."),
    "contrast": ("Kontrast", -100, 100, 0, 0, 1, "S-Kurve um Mittelgrau (monoton)."),
    "gamma": ("Gamma", 0.3, 3.0, 1.0, 2, 0.01, "Mitteltongamma im wahrnehmungsnahen Bereich."),
    "temperature": ("Temperatur", -100, 100, 0, 0, 1, "Relative Blau/Gelb-Verschiebung (±0.5 EV zwischen R und B)."),
    "tint": ("Tint", -100, 100, 0, 0, 1, "Relative Grün/Magenta-Verschiebung."),
    "black": ("Schwarzwert", -100, 100, 0, 0, 1, "Positiv: tiefere Schwärzen, negativ: angehobene Schwärzen."),
    "white": ("Weißwert", -100, 100, 0, 0, 1, "Positiv: hellere Lichter, negativ: mehr Reserve in den Lichtern."),
    "highlights": ("Lichter", -100, 100, 0, 0, 1, "Lichter anheben/zurücknehmen."),
    "shadows": ("Tiefen", -100, 100, 0, 0, 1, "Tiefen öffnen/abdunkeln."),
    "highlight_rolloff": ("Lichterschulter", 0.0, 1.0, 0.5, 2, 0.01, "Weiche Kompression statt hartem Clipping (0 = hart)."),
    "saturation": ("Sättigung", -100, 100, 0, 0, 1, "Globale Sättigung (Luminanz bleibt erhalten)."),
    "vibrance": ("Dynamik", -100, 100, 0, 0, 1, "Wirkt stärker auf wenig gesättigte Farben."),
    "sharpen_amount": ("Schärfe", 0, 200, 0, 0, 1, "Unscharfmaskierung auf der Luminanz."),
    "sharpen_radius": ("Radius", 0.3, 4.0, 1.0, 1, 0.1, "Radius in Pixeln der vollen Auflösung."),
    "nr_luma": ("Rauschen Lum.", 0, 100, 0, 0, 1, "Kantenerhaltende Luminanz-Rauschreduzierung (bilateral)."),
    "nr_chroma": ("Rauschen Farbe", 0, 100, 0, 0, 1, "Farbrauschreduzierung (Chroma-Weichzeichnung)."),
    "angle": ("Feinrotation", -10.0, 10.0, 0.0, 2, 0.05, "Ausrichten in Grad."),
    "film_gamma": ("Filmgradation", 0.3, 1.2, 0.6, 2, 0.01,
                   "Gradation γ des Negativs; bestimmt den Motivumfang R = Dichtespanne / γ."),
    "black_clip": ("Schwarz-Clip %", 0.0, 2.0, 0.05, 2, 0.01, "Anteil der Pixel, die beim Schwarzpunkt abgeschnitten werden."),
    "white_clip": ("Weiß-Clip %", 0.0, 2.0, 0.05, 2, 0.01, "Anteil der Pixel, die beim Weißpunkt abgeschnitten werden."),
    "auto_color": ("Auto-Balance", 0.0, 1.0, 0.0, 2, 0.01,
                   "HEURISTIK: gleicht die Mitteltöne der Kanäle an (Grauwelt-Annahme)."),
    "offset_r": ("Maske R (ΔD)", -0.3, 0.3, 0.0, 3, 0.005, "Feinkorrektur der Filmgrund-Dichte im Rotkanal."),
    "offset_g": ("Maske G (ΔD)", -0.3, 0.3, 0.0, 3, 0.005, "Feinkorrektur der Filmgrund-Dichte im Grünkanal."),
    "offset_b": ("Maske B (ΔD)", -0.3, 0.3, 0.0, 3, 0.005, "Feinkorrektur der Filmgrund-Dichte im Blaukanal."),
}


def _slider(name: str) -> ParamSlider:
    label, lo, hi, default, dec, step, tip = PARAMS[name]
    return ParamSlider(label, lo, hi, default, dec, step, tip)


class LeftPanel(QWidget):
    openFiles = Signal()
    imageSelected = Signal(int)
    filmTypeChanged = Signal(str)
    profileSelected = Signal(str)
    presetSelected = Signal(str)
    savePreset = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setObjectName("panelContent")
        self.setMinimumWidth(230)
        self.setMaximumWidth(320)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(8, 8, 8, 8)
        lay.setSpacing(6)
        self.open_btn = QPushButton("Bilder öffnen …")
        self.open_btn.setObjectName("primary")
        lay.addWidget(self.open_btn)

        lay.addWidget(self._heading("Importierte Bilder"))
        self.images = QListWidget()
        self.images.setMinimumHeight(100)
        lay.addWidget(self.images, 2)

        lay.addWidget(self._heading("Filmtyp"))
        self.film_type = QComboBox()
        for k, v in FILM_TYPES.items():
            self.film_type.addItem(v, k)
        lay.addWidget(self.film_type)

        lay.addWidget(self._heading("Filmprofile"))
        self.profiles = QListWidget()
        lay.addWidget(self.profiles, 2)
        self.profile_info = QLabel()
        self.profile_info.setObjectName("dim")
        self.profile_info.setWordWrap(True)
        lay.addWidget(self.profile_info)

        lay.addWidget(self._heading("Presets"))
        self.presets = QListWidget()
        lay.addWidget(self.presets, 1)
        self.save_preset_btn = QPushButton("Look als Preset speichern …")
        lay.addWidget(self.save_preset_btn)

        self.open_btn.clicked.connect(self.openFiles)
        self.images.currentRowChanged.connect(lambda r: r >= 0 and self.imageSelected.emit(r))
        self.film_type.activated.connect(lambda i: self.filmTypeChanged.emit(self.film_type.itemData(i)))
        self.profiles.itemClicked.connect(lambda it: self.profileSelected.emit(it.data(Qt.UserRole)))
        self.presets.itemClicked.connect(lambda it: self.presetSelected.emit(it.data(Qt.UserRole)))
        self.save_preset_btn.clicked.connect(self.savePreset)

    @staticmethod
    def _heading(text):
        l = QLabel(text)
        l.setObjectName("heading")
        return l

    def set_profiles(self, profiles, current_id: str):
        self.profiles.blockSignals(True)
        self.profiles.clear()
        for p in profiles:
            it = QListWidgetItem(p.name)
            it.setData(Qt.UserRole, p.id)
            it.setToolTip(f"{p.description}\n\n{p.basis}")
            self.profiles.addItem(it)
            if p.id == current_id:
                it.setSelected(True)
                self.profiles.setCurrentItem(it)
                self.profile_info.setText(p.description)
        self.profiles.blockSignals(False)

    def set_presets(self, presets, current_id: str):
        self.presets.blockSignals(True)
        self.presets.clear()
        for p in presets:
            it = QListWidgetItem(p.name + ("" if p.builtin else "  (eigenes)"))
            it.setData(Qt.UserRole, p.id)
            it.setToolTip(p.description)
            self.presets.addItem(it)
            if p.id == current_id:
                self.presets.setCurrentItem(it)
        self.presets.blockSignals(False)

    def set_film_type(self, ft: str):
        idx = self.film_type.findData(ft)
        self.film_type.blockSignals(True)
        self.film_type.setCurrentIndex(idx)
        self.film_type.blockSignals(False)


class RightPanel(QScrollArea):
    paramChanged = Signal(str, object)     # Parametername, Wert
    action = Signal(str)                   # benannte Aktionen (Buttons)
    curveChanged = Signal(str, list)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setObjectName("panel")
        self.setWidgetResizable(True)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self.setMinimumWidth(320)
        self.setMaximumWidth(400)
        content = QWidget()
        content.setObjectName("panelContent")
        self.setWidget(content)
        lay = QVBoxLayout(content)
        lay.setContentsMargins(8, 6, 8, 8)
        lay.setSpacing(2)
        self.sliders: dict[str, ParamSlider] = {}

        # Histogramm
        self.histogram = HistogramWidget()
        lay.addWidget(self.histogram)
        self.info = QLabel("")
        self.info.setObjectName("dim")
        lay.addWidget(self.info)

        # Belichtung
        sec = Section("Belichtung")
        for n in ("exposure", "brightness", "contrast", "gamma"):
            sec.add(self._add(n))
        lay.addWidget(sec)

        # Weißabgleich
        sec = Section("Weißabgleich")
        for n in ("temperature", "tint"):
            sec.add(self._add(n))
        row = QHBoxLayout()
        self.neutral_btn = QPushButton("Neutralpunkt wählen")
        self.neutral_btn.setCheckable(True)
        self.neutral_btn.setToolTip("Auf eine neutrale (graue) Fläche im Positiv klicken oder ziehen.")
        wb_reset = QPushButton("Zurücksetzen")
        row.addWidget(self.neutral_btn)
        row.addWidget(wb_reset)
        sec.add_layout(row)
        self.neutral_btn.clicked.connect(lambda on: self.action.emit("tool_neutral" if on else "tool_none"))
        wb_reset.clicked.connect(lambda: self.action.emit("wb_reset"))
        lay.addWidget(sec)
        self.wb_section = sec

        # Filmgrund
        sec = Section("Filmgrund / Orangemaske")
        self.base_section = sec
        form = QFormLayout()
        form.setLabelAlignment(Qt.AlignLeft)
        self.base_mode = QComboBox()
        for k, v in BASE_MODES.items():
            self.base_mode.addItem(v, k)
        self.base_mode.activated.connect(lambda i: self.paramChanged.emit("base.mode", self.base_mode.itemData(i)))
        form.addRow("Quelle", self.base_mode)
        sec.add_layout(form)
        row = QHBoxLayout()
        self.base_pick_btn = QPushButton("Bereich wählen")
        self.base_pick_btn.setCheckable(True)
        self.base_pick_btn.setToolTip("Rechteck auf dem unbelichteten Filmrand aufziehen (Negativansicht).")
        redetect = QPushButton("Neu erkennen")
        row.addWidget(self.base_pick_btn)
        row.addWidget(redetect)
        sec.add_layout(row)
        self.base_pick_btn.clicked.connect(lambda on: self.action.emit("tool_base" if on else "tool_none"))
        redetect.clicked.connect(lambda: self.action.emit("base_redetect"))
        row = QHBoxLayout()
        self.base_swatch = ColorSwatch()
        self.base_label = QLabel("–")
        self.base_label.setObjectName("dim")
        self.base_label.setWordWrap(True)
        row.addWidget(self.base_swatch)
        row.addWidget(self.base_label, 1)
        sec.add_layout(row)
        self.base_warn = QLabel("")
        self.base_warn.setObjectName("warn")
        self.base_warn.setWordWrap(True)
        sec.add(self.base_warn)
        for n in ("offset_r", "offset_g", "offset_b"):
            sec.add(self._add(n))
        form = QFormLayout()
        self.normalization = QComboBox()
        for k, v in NORMALIZATION_MODES.items():
            self.normalization.addItem(v, k)
        self.normalization.activated.connect(
            lambda i: self.paramChanged.emit("normalization", self.normalization.itemData(i)))
        form.addRow("Normierung", self.normalization)
        self.input_encoding = QComboBox()
        for k, v in (("auto", "Automatisch"), ("srgb", "sRGB-kodiert"), ("linear", "Linear")):
            self.input_encoding.addItem(v, k)
        self.input_encoding.setToolTip("Nur für TIFF/JPEG/PNG: Kodierung der Scandatei. RAW ist immer linear.")
        self.input_encoding.activated.connect(
            lambda i: self.paramChanged.emit("input_encoding", self.input_encoding.itemData(i)))
        form.addRow("Eingangsdaten", self.input_encoding)
        sec.add_layout(form)
        for n in ("film_gamma", "black_clip", "white_clip", "auto_color"):
            sec.add(self._add(n))
        self.lock_cb = QCheckBox("Analyse sperren (Filmstreifen-Konsistenz)")
        self.lock_cb.toggled.connect(lambda on: self.paramChanged.emit("lock_analysis", on))
        sec.add(self.lock_cb)
        lay.addWidget(sec)

        # Farben
        sec = Section("Farben")
        for n in ("saturation", "vibrance"):
            sec.add(self._add(n))
        lay.addWidget(sec)
        self.color_section = sec

        # Tonwerte
        sec = Section("Tonwerte")
        for n in ("black", "white", "highlights", "shadows", "highlight_rolloff"):
            sec.add(self._add(n))
        row = QHBoxLayout()
        self.curve_group = QButtonGroup(self)
        for i, (key, text) in enumerate((("master", "RGB"), ("r", "R"), ("g", "G"), ("b", "B"))):
            b = QPushButton(text)
            b.setCheckable(True)
            b.setChecked(i == 0)
            b.setProperty("channel", key)
            self.curve_group.addButton(b, i)
            row.addWidget(b)
        reset_curve = QPushButton("↺")
        reset_curve.setToolTip("Kurve des Kanals zurücksetzen")
        row.addWidget(reset_curve)
        sec.add_layout(row)
        self.curve = CurveEditor()
        sec.add(self.curve)
        self.curve_group.idClicked.connect(
            lambda i: self.curve.set_channel(self.curve_group.button(i).property("channel")))
        reset_curve.clicked.connect(self.curve.reset_channel)
        self.curve.curveChanged.connect(self.curveChanged)
        lay.addWidget(sec)

        # Details
        sec = Section("Details", expanded=False)
        for n in ("sharpen_amount", "sharpen_radius", "nr_luma", "nr_chroma"):
            sec.add(self._add(n))
        lay.addWidget(sec)

        # Geometrie
        sec = Section("Zuschnitt & Rotation", expanded=False)
        grid = QGridLayout()
        buttons = [("↶ 90°", "rotate_left"), ("↷ 90°", "rotate_right"), ("⇋ Spiegeln", "flip_h"),
                   ("⇵ Spiegeln", "flip_v")]
        for i, (t, a) in enumerate(buttons):
            b = QPushButton(t)
            b.clicked.connect(lambda _=False, a=a: self.action.emit(a))
            grid.addWidget(b, i // 2, i % 2)
        sec.add_layout(grid)
        sec.add(self._add("angle"))
        row = QHBoxLayout()
        self.crop_btn = QPushButton("Zuschneiden")
        self.crop_btn.setCheckable(True)
        auto_crop = QPushButton("Bildbereich")
        auto_crop.setToolTip("Zuschnitt auf den automatisch erkannten Bildbereich (ohne Filmrand)")
        reset_crop = QPushButton("Zurücksetzen")
        row.addWidget(self.crop_btn)
        row.addWidget(auto_crop)
        row.addWidget(reset_crop)
        sec.add_layout(row)
        self.crop_btn.clicked.connect(lambda on: self.action.emit("tool_crop" if on else "tool_none"))
        auto_crop.clicked.connect(lambda: self.action.emit("crop_auto"))
        reset_crop.clicked.connect(lambda: self.action.emit("crop_reset"))
        lay.addWidget(sec)

        # Export
        sec = Section("Export")
        form = QFormLayout()
        self.fmt = QComboBox()
        for k, v in FORMATS.items():
            self.fmt.addItem(v, k)
        self.space = QComboBox()
        for k in OUTPUT_SPACES:
            self.space.addItem(SPACES[k].label, k)
        self.quality = QSpinBox()
        self.quality.setRange(1, 100)
        self.quality.setValue(95)
        self.template = QLineEdit(DEFAULT_TEMPLATE)
        self.template.setToolTip("Platzhalter: {name} {index:03d} {profile} {preset} {film} {date}")
        out_row = QHBoxLayout()
        self.out_dir = QLineEdit()
        self.out_dir.setPlaceholderText("Ordner des Originals / export")
        browse = QPushButton("…")
        browse.setFixedWidth(30)
        browse.clicked.connect(lambda: self.action.emit("browse_out"))
        out_row.addWidget(self.out_dir)
        out_row.addWidget(browse)
        form.addRow("Format", self.fmt)
        form.addRow("Farbraum", self.space)
        form.addRow("JPEG-Qualität", self.quality)
        form.addRow("Dateiname", self.template)
        form.addRow("Zielordner", out_row)
        sec.add_layout(form)
        row = QHBoxLayout()
        exp = QPushButton("Bild exportieren")
        exp.setObjectName("primary")
        bexp = QPushButton("Stapel exportieren …")
        exp.clicked.connect(lambda: self.action.emit("export_current"))
        bexp.clicked.connect(lambda: self.action.emit("export_batch"))
        row.addWidget(exp)
        row.addWidget(bexp)
        sec.add_layout(row)
        self.fmt.currentIndexChanged.connect(lambda: self.quality.setEnabled(self.fmt.currentData() == "jpeg"))
        self.quality.setEnabled(False)
        lay.addWidget(sec)
        lay.addStretch(1)
        self._shrink_combos()
        content.setMinimumWidth(0)

    def _shrink_combos(self):
        from PySide6.QtWidgets import QComboBox as _C

        for c in self.findChildren(_C):
            c.setSizeAdjustPolicy(_C.AdjustToMinimumContentsLengthWithIcon)
            c.setMinimumContentsLength(8)
        for b in self.findChildren(QPushButton):
            if b.objectName() != "section":
                b.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Fixed)

    def _add(self, name: str) -> ParamSlider:
        s = _slider(name)
        s.valueChanged.connect(lambda v, n=name: self.paramChanged.emit(n, v))
        self.sliders[name] = s
        return s

    # ------------------------------------------------------------------
    def load_settings(self, s: EditSettings):
        for name, sl in self.sliders.items():
            if name.startswith("offset_"):
                v = s.base.offset["rgb".index(name[-1])]
            elif name == "angle":
                v = s.geometry.angle
            else:
                v = getattr(s, name)
            sl.setValue(v, silent=True)
        for combo, value in ((self.base_mode, s.base.mode), (self.normalization, s.normalization),
                             (self.input_encoding, s.input_encoding)):
            combo.blockSignals(True)
            combo.setCurrentIndex(max(0, combo.findData(value)))
            combo.blockSignals(False)
        self.lock_cb.blockSignals(True)
        self.lock_cb.setChecked(s.lock_analysis)
        self.lock_cb.blockSignals(False)
        self.curve.set_curves(s.curves)
        negative = s.film_type != "slide"
        mono = s.film_type == "bw_negative"
        for n in ("offset_r", "offset_g", "offset_b", "film_gamma"):
            self.sliders[n].setEnabled(negative)
        for n in ("offset_r", "offset_b"):
            self.sliders[n].setVisible(not mono)
        self.sliders["offset_g"].label.setText("Filmgrund (ΔD)" if mono else "Maske G (ΔD)")
        self.sliders["auto_color"].setEnabled(s.film_type == "color_negative")
        self.base_mode.setEnabled(negative)
        self.base_pick_btn.setEnabled(negative)
        self.normalization.setEnabled(negative)
        self.wb_section.setEnabled(not mono)
        self.color_section.setEnabled(not mono)

    def export_options(self) -> dict:
        return {"fmt": self.fmt.currentData(), "output_space": self.space.currentData(),
                "jpeg_quality": self.quality.value(), "template": self.template.text(),
                "out_dir": self.out_dir.text()}

    def set_export_options(self, d: dict):
        if not d:
            return
        self.fmt.setCurrentIndex(max(0, self.fmt.findData(d.get("fmt", "tiff16"))))
        self.space.setCurrentIndex(max(0, self.space.findData(d.get("output_space", "srgb"))))
        self.quality.setValue(int(d.get("jpeg_quality", 95)))
        self.template.setText(d.get("template", DEFAULT_TEMPLATE))
        self.out_dir.setText(d.get("out_dir", ""))
