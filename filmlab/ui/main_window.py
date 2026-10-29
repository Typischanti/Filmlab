"""Hauptfenster: verbindet Projektmodell, Imaging-Engine und Oberfläche."""
from __future__ import annotations

import copy
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PySide6.QtCore import QThreadPool, QTimer, Qt
from PySide6.QtGui import QAction, QColor, QImage, QKeySequence
from PySide6.QtWidgets import (QApplication, QFileDialog, QHBoxLayout, QInputDialog, QLabel, QMainWindow,
                               QMessageBox, QProgressBar, QProgressDialog, QPushButton, QSplitter, QVBoxLayout,
                               QWidget)

from ..core import colorspace as cs
from ..core.profiles import library
from ..core.project import History, Project, ProjectImage, load_session, save_session
from ..core.settings import BASE_MODES, FILM_TYPES, EditSettings, FilmBase, sync_settings
from ..imaging import batch, pipeline
from ..imaging.export import ExportOptions, export_image
from ..imaging.geometry import apply_geometry, crop as crop_img, inset
from ..imaging.loader import SUPPORTED_EXTENSIONS, load_image
from . import workers
from .filmstrip import FilmStrip
from .panels import LeftPanel, RightPanel
from .viewer import TOOL_BASE, TOOL_CROP, TOOL_NEUTRAL, TOOL_NONE, ImageViewer

FILE_FILTER = ("Bilder (" + " ".join(f"*{e} *{e.upper()}" for e in sorted(SUPPORTED_EXTENSIONS)) + ");;"
               "Alle Dateien (*)")


@dataclass
class ImageRuntime:
    history: History = field(default_factory=History)
    thumb: QImage | None = None
    thumb_proxy: np.ndarray | None = None
    warnings: list[str] = field(default_factory=list)
    status: str = "pending"
    error: str = ""
    thumb_busy: bool = False
    thumb_dirty: bool = False


class MainWindow(QMainWindow):
    def __init__(self, restore_session: bool = True):
        super().__init__()
        self.setWindowTitle("FilmLab – Negativ-Konverter")
        self.resize(1600, 980)
        self.setAcceptDrops(True)
        self.lib = library()
        self.project = Project()
        self.runtime: list[ImageRuntime] = []
        self.loaded: workers.LoadedImage | None = None
        self._lru: "OrderedDict[str, workers.LoadedImage]" = OrderedDict()
        self._loading_path: str | None = None
        self._token = 0
        self.tool = TOOL_NONE
        self.view_mode = "after"

        self.preview_runner = workers.LatestOnlyRunner(self)
        self.preview_runner.resultReady.connect(self._on_preview)
        self.preview_runner.failed.connect(lambda m: self.statusBar().showMessage(f"Vorschaufehler: {m}", 8000))
        self.load_pool = QThreadPool(self)
        self.load_pool.setMaxThreadCount(1)
        self.thumb_pool = QThreadPool(self)
        self.thumb_pool.setMaxThreadCount(1)
        self.job_pool = QThreadPool(self)
        self.job_pool.setMaxThreadCount(1)
        self._thumb_queue: list[int] = []

        self._autosave = QTimer(self, singleShot=True, interval=1200, timeout=self._do_autosave)
        self._thumb_timer = QTimer(self, singleShot=True, interval=900, timeout=self._refresh_dirty_thumbs)

        self._build_ui()
        self._build_menu()
        if restore_session:
            QTimer.singleShot(0, self._restore_session)

    # ------------------------------------------------------------------ UI
    def _build_ui(self):
        self.left = LeftPanel()
        self.right = RightPanel()
        self.viewer = ImageViewer()
        self.strip = FilmStrip()

        center = QWidget()
        cl = QVBoxLayout(center)
        cl.setContentsMargins(0, 0, 0, 0)
        cl.setSpacing(0)
        bar = QWidget()
        bar.setObjectName("panelContent")
        bl = QHBoxLayout(bar)
        bl.setContentsMargins(8, 4, 8, 4)
        self.mode_buttons = {}
        for key, text in (("after", "Nachher"), ("before", "Vorher"), ("split", "Split")):
            b = QPushButton(text)
            b.setCheckable(True)
            b.setChecked(key == "after")
            b.clicked.connect(lambda _=False, k=key: self.set_view_mode(k))
            bl.addWidget(b)
            self.mode_buttons[key] = b
        bl.addSpacing(16)
        fit = QPushButton("Einpassen")
        fit.clicked.connect(self.viewer.fit)
        z100 = QPushButton("1:1")
        z100.setToolTip("1 Vorschaupixel = 1 Bildschirmpixel")
        z100.clicked.connect(self.viewer.zoom_100)
        bl.addWidget(fit)
        bl.addWidget(z100)
        self.zoom_label = QLabel("")
        self.zoom_label.setObjectName("dim")
        bl.addWidget(self.zoom_label)
        bl.addStretch(1)
        self.tool_label = QLabel("")
        self.tool_label.setObjectName("warn")
        bl.addWidget(self.tool_label)
        cl.addWidget(bar)
        cl.addWidget(self.viewer, 1)

        hsplit = QSplitter(Qt.Horizontal)
        hsplit.addWidget(self.left)
        hsplit.addWidget(center)
        hsplit.addWidget(self.right)
        hsplit.setStretchFactor(1, 1)
        hsplit.setSizes([250, 1000, 350])
        vsplit = QSplitter(Qt.Vertical)
        vsplit.addWidget(hsplit)
        vsplit.addWidget(self.strip)
        vsplit.setStretchFactor(0, 1)
        self.setCentralWidget(vsplit)

        self.progress = QProgressBar()
        self.progress.setMaximumWidth(220)
        self.progress.setVisible(False)
        self.statusBar().addPermanentWidget(self.progress)

        self.left.openFiles.connect(self.open_files_dialog)
        self.left.imageSelected.connect(self.select_image)
        self.left.filmTypeChanged.connect(self.on_film_type)
        self.left.profileSelected.connect(self.on_profile)
        self.left.presetSelected.connect(self.on_preset)
        self.left.savePreset.connect(self.save_preset)
        self.strip.currentChanged.connect(self.select_image)
        self.strip.action.connect(self.on_action)
        self.right.paramChanged.connect(self.on_param)
        self.right.action.connect(self.on_action)
        self.right.curveChanged.connect(self.on_curve)
        self.viewer.rectPicked.connect(self.on_rect_picked)
        self.viewer.cropEdited.connect(self.on_crop_edited)
        self.viewer.zoomChanged.connect(lambda z: self.zoom_label.setText(f"{z * 100:.0f} %"))
        self._refresh_library_lists()

    def _build_menu(self):
        mb = self.menuBar()
        m = mb.addMenu("&Datei")
        self._act(m, "Bilder öffnen …", self.open_files_dialog, QKeySequence.Open)
        self._act(m, "Projekt öffnen …", self.open_project_dialog, "Ctrl+Shift+O")
        self._act(m, "Projekt speichern", self.save_project, QKeySequence.Save)
        self._act(m, "Projekt speichern unter …", lambda: self.save_project(True), QKeySequence.SaveAs)
        m.addSeparator()
        self._act(m, "Bild exportieren …", lambda: self.on_action("export_current"), "Ctrl+E")
        self._act(m, "Stapel-Export …", lambda: self.on_action("export_batch"), "Ctrl+Shift+E")
        m.addSeparator()
        self._act(m, "Bild aus Projekt entfernen", self.remove_current, "Ctrl+Backspace")
        self._act(m, "Beenden", self.close, QKeySequence.Quit)
        m = mb.addMenu("&Bearbeiten")
        self.undo_act = self._act(m, "Rückgängig", self.undo, QKeySequence.Undo)
        self.redo_act = self._act(m, "Wiederholen", self.redo, QKeySequence.Redo)
        self._act(m, "Wiederholen", self.redo, "Ctrl+Y")
        m.addSeparator()
        self._act(m, "Bearbeitung zurücksetzen (Profil + Preset)", self.reset_settings, "Ctrl+R")
        self._act(m, "Einstellungen kopieren", self.copy_settings, "Ctrl+Shift+C")
        self._act(m, "Einstellungen einfügen", self.paste_settings, "Ctrl+Shift+V")
        m = mb.addMenu("&Ansicht")
        self._act(m, "Nachher", lambda: self.set_view_mode("after"), "Ctrl+1")
        self._act(m, "Vorher", lambda: self.set_view_mode("before"), "Ctrl+2")
        self._act(m, "Split-View", lambda: self.set_view_mode("split"), "Ctrl+3")
        self._act(m, "Vorher/Nachher umschalten", self.toggle_before, "\\")
        self._act(m, "Einpassen", self.viewer.fit, "Ctrl+0")
        m = mb.addMenu("&Hilfe")
        self._act(m, "Über FilmLab", self.about)
        self._update_undo()

    def _act(self, menu, text, slot, shortcut=None):
        a = QAction(text, self)
        if shortcut:
            a.setShortcut(QKeySequence(shortcut))
        a.triggered.connect(slot)
        menu.addAction(a)
        return a

    # ------------------------------------------------------------ Zugriff
    @property
    def cur_index(self) -> int:
        return self.project.current

    @property
    def cur(self) -> EditSettings | None:
        i = self.project.current
        return self.project.images[i].settings if 0 <= i < len(self.project.images) else None

    def _set_cur(self, s: EditSettings):
        self.project.images[self.project.current].settings = s

    # -------------------------------------------------------------- Import
    def open_files_dialog(self):
        files, _ = QFileDialog.getOpenFileNames(self, "Negative öffnen", "", FILE_FILTER)
        if files:
            self.add_files(files)

    def add_files(self, files: list[str]):
        existing = {im.path for im in self.project.images}
        template = self.cur.copy() if self.cur else self.lib.apply(EditSettings(), "generic_color_negative", "neutral")
        added = 0
        first_new = len(self.project.images)
        for f in files:
            f = str(Path(f).resolve())
            if f in existing or Path(f).suffix.lower() not in SUPPORTED_EXTENSIONS:
                continue
            s = self.lib.apply(EditSettings(), template.profile_id, template.preset_id)
            self.project.images.append(ProjectImage(f, s))
            self.runtime.append(ImageRuntime())
            self.strip.add_item(Path(f).name)
            self.left.images.addItem(Path(f).name)
            self._queue_thumb(len(self.project.images) - 1)
            added += 1
        if added:
            self.statusBar().showMessage(f"{added} Bild(er) importiert", 4000)
            self.select_image(first_new)
            self._schedule_autosave()

    def dragEnterEvent(self, e):
        if e.mimeData().hasUrls():
            e.acceptProposedAction()

    def dropEvent(self, e):
        paths = [u.toLocalFile() for u in e.mimeData().urls() if u.isLocalFile()]
        projects = [p for p in paths if p.endswith(".filmlab")]
        if projects:
            self.open_project(projects[0])
        else:
            self.add_files(paths)

    def remove_current(self):
        i = self.cur_index
        if i < 0:
            return
        self.project.images.pop(i)
        self.runtime.pop(i)
        self.strip.list.takeItem(i)
        self.left.images.takeItem(i)
        self._thumb_queue = [q if q < i else q - 1 for q in self._thumb_queue if q != i]
        self.loaded = None
        self.project.current = -1
        if self.project.images:
            self.select_image(min(i, len(self.project.images) - 1))
        else:
            self.viewer.clear("Keine Bilder")
        self._schedule_autosave()

    # ------------------------------------------------------------ Auswahl
    def select_image(self, index: int):
        if not (0 <= index < len(self.project.images)):
            return
        if index == self.project.current and self.loaded and self.loaded.path == self.project.images[index].path:
            return
        self._set_tool(TOOL_NONE)
        self.project.current = index
        self.strip.set_current(index)
        self.left.images.blockSignals(True)
        self.left.images.setCurrentRow(index)
        self.left.images.blockSignals(False)
        self._sync_panels()
        path = self.project.images[index].path
        if self.loaded is not None and self.loaded.path != path:
            self.loaded.full = None  # Vollbild nur für das aktuelle Bild halten
        if path in self._lru:
            self.loaded = self._lru[path]
            self._lru.move_to_end(path)
            self._after_loaded()
            return
        self.loaded = None
        self._loading_path = path
        self.viewer.clear(f"Lade {Path(path).name} …")
        self.progress.setVisible(True)
        self.progress.setRange(0, 0)
        task = workers.Task(workers.load_job, path, self.cur.input_encoding)
        task.signals.finished.connect(self._on_loaded)
        task.signals.failed.connect(lambda msg, p=path: self._on_load_failed(p, msg))
        self.load_pool.start(task)

    def _on_loaded(self, img: workers.LoadedImage):
        self.progress.setVisible(False)
        self._lru[img.path] = img
        while len(self._lru) > 4:
            _, old = self._lru.popitem(last=False)
            old.full = None
        if self.cur is None or self.project.images[self.cur_index].path != img.path:
            img.full = None
            return
        self.loaded = img
        rt = self.runtime[self.cur_index]
        rt.warnings = img.warnings
        rt.status = "ready"
        if rt.thumb_proxy is None:
            rt.thumb_proxy = img.thumb_proxy
        self._after_loaded(reset_view=True)

    def _on_load_failed(self, path: str, msg: str):
        self.progress.setVisible(False)
        for i, im in enumerate(self.project.images):
            if im.path == path:
                self.runtime[i].status, self.runtime[i].error = "error", msg
                self.strip.set_thumb(i, None, "Fehler")
        if self.cur is not None and self.project.images[self.cur_index].path == path:
            self.viewer.clear(f"Datei konnte nicht geladen werden:\n{msg}")
        self.statusBar().showMessage(f"Ladefehler: {msg}", 10000)

    def _after_loaded(self, reset_view: bool = False):
        img = self.loaded
        self.viewer.full_width = img.full_size[1]
        h, w = img.full_size
        self.right.info.setText(f"{Path(img.path).name} · {w}×{h} · {img.kind.upper()} {img.bit_depth} Bit · "
                                f"{img.encoding}")
        self._reset_view_pending = reset_view
        self.request_preview()

    # ------------------------------------------------------------ Vorschau
    def request_preview(self):
        if self.loaded is None or self.cur is None:
            return
        self._token += 1
        uncropped = self.tool in (TOOL_CROP, TOOL_BASE)
        self.preview_runner.request(workers.preview_job, self._token, self.loaded, self.cur.copy(), uncropped)

    def _on_preview(self, res: workers.PreviewResult):
        s = self.cur
        if s is None or self.loaded is None:
            return
        if (not s.lock_analysis and res.analysis_key == s.analysis_key(self.loaded.source_id)
                and s.analysis.key != res.analysis_key):
            s.analysis = res.analysis
            self._schedule_autosave()
        reset = getattr(self, "_reset_view_pending", False)
        self._reset_view_pending = False
        before = res.before
        after = res.after
        if self.tool == TOOL_BASE:
            after = res.before   # Filmgrund wird auf dem Negativ gewählt
        self.viewer.set_images(after, before, reset_view=reset)
        self.right.histogram.set_data(res.hist, res.clip)
        self._update_base_info()
        self._update_overlays()

    def _update_overlays(self):
        s = self.cur
        ov = []
        if s and self.tool in (TOOL_BASE, TOOL_CROP):
            a = s.analysis
            if a.base_rect:
                ov.append((a.base_rect, QColor("#ffd060"), "Filmgrund"))
            if self.tool == TOOL_CROP and a.frame_rect:
                ov.append((a.frame_rect, QColor(120, 200, 255, 160), ""))
        self.viewer.set_overlays(ov)

    def _update_base_info(self):
        s = self.cur
        a = s.analysis if s else None
        rp = self.right
        rt = self.runtime[self.cur_index] if s else None
        if not s or s.film_type == "slide":
            rp.base_swatch.set_color(None)
            rp.base_label.setText("Diafilm: keine Inversion")
            rp.base_warn.setText("")
            return
        if a is None or a.base_rgb is None:
            rp.base_swatch.set_color(None)
            rp.base_label.setText("Analyse läuft …")
            return
        rgb = np.asarray(a.base_rgb, dtype=np.float32)
        disp = cs.encode(np.clip(cs.apply_matrix(rgb[None, None], cs.conversion_matrix(cs.WORKING_SPACE, "srgb")),
                                 0, 1), "srgb")[0, 0]
        rp.base_swatch.set_color(tuple(int(round(v * 255)) for v in disp))
        src = {"border": "Filmrand (automatisch)", "manual": "Manueller Messbereich",
               "estimate": "GESCHÄTZT aus Bildinhalt", "fixed": "Fester Wert / Filmstreifen"}.get(a.base_source, "")
        rp.base_label.setText(f"{src}\nRGB lin. {rgb[0]:.3f} / {rgb[1]:.3f} / {rgb[2]:.3f} · "
                              f"Konfidenz {a.base_confidence * 100:.0f}%\nMotivumfang R = {a.log_range:.2f} log "
                              f"({a.log_range / np.log10(2):.1f} EV)" + ("  · gesperrt" if s.lock_analysis else ""))
        msgs = list(a.warnings) + list(a.notes) + (rt.warnings if rt else [])
        rp.base_warn.setText("\n".join("• " + m for m in msgs))

    # ------------------------------------------------------------ Änderungen
    def _change(self, label: str, fn, group: str | None = None, rethumb: bool = True):
        s = self.cur
        if s is None:
            return
        before = s.copy()
        fn(s)
        self.runtime[self.cur_index].history.record(before, label, group)
        self._after_change(rethumb)

    def _after_change(self, rethumb: bool = True):
        self._update_undo()
        self.request_preview()
        self._schedule_autosave()
        if rethumb and 0 <= self.cur_index < len(self.runtime):
            self.runtime[self.cur_index].thumb_dirty = True
            self._thumb_timer.start()

    def on_param(self, name: str, value):
        label = self.right.sliders[name].label.text() if name in self.right.sliders else name

        def apply(s: EditSettings):
            if name.startswith("offset_"):
                s.base.offset["rgb".index(name[-1])] = float(value)
                if s.film_type == "bw_negative":
                    s.base.offset = [float(value)] * 3
            elif name == "angle":
                s.geometry.angle = float(value)
            elif name == "base.mode":
                s.base.mode = value
                if value == "manual" and not s.base.rect:
                    QTimer.singleShot(0, lambda: self._set_tool(TOOL_BASE))
                if value == "fixed" and not s.base.rgb and s.analysis.base_rgb:
                    s.base.rgb = list(s.analysis.base_rgb)
            elif name == "input_encoding":
                s.input_encoding = value
            else:
                setattr(s, name, value)
        self._change(label, apply, group=name)
        if name == "input_encoding" and self.loaded:
            # Datei mit anderer Linearisierung neu laden
            self._lru.pop(self.loaded.path, None)
            self.loaded = None
            idx = self.cur_index
            self.project.current = -1
            self.select_image(idx)
        if name in ("base.mode", "lock_analysis"):
            self._sync_panels()

    def on_curve(self, channel: str, points: list):
        def apply(s):
            s.curves[channel] = [list(map(float, p)) for p in points]
        self._change("Gradationskurve", apply, group="curve_" + channel)

    def on_film_type(self, ft: str):
        profiles = self.lib.profiles_for(ft)
        pid = profiles[0].id if profiles else self.cur.profile_id
        self._change(f"Filmtyp: {FILM_TYPES[ft]}", lambda s: self._apply_profile(s, pid, ft))
        self._sync_panels()

    def _apply_profile(self, s: EditSettings, pid: str, film_type: str | None = None):
        new = self.lib.apply(s, profile_id=pid)
        if film_type:
            new.film_type = film_type
        for k, v in new.__dict__.items():
            setattr(s, k, v)

    def on_profile(self, pid: str):
        p = self.lib.profiles.get(pid)
        if not p or self.cur is None:
            return
        self._change(f"Profil: {p.name}", lambda s: self._apply_profile(s, pid))
        self._sync_panels()

    def on_preset(self, preset_id: str):
        pr = self.lib.presets.get(preset_id)
        if not pr or self.cur is None:
            return

        def apply(s):
            new = self.lib.apply(s, preset_id=preset_id)
            for k, v in new.__dict__.items():
                setattr(s, k, v)
        self._change(f"Preset: {pr.name}", apply)
        self._sync_panels()

    def save_preset(self):
        if self.cur is None:
            return
        name, ok = QInputDialog.getText(self, "Preset speichern", "Name des Presets:")
        if not ok or not name.strip():
            return
        pid = "user_" + "".join(c if c.isalnum() else "_" for c in name.strip().lower())
        path = self.lib.save_user_preset(pid, name.strip(), self.cur)
        self.cur.preset_id = pid
        self._refresh_library_lists()
        self.statusBar().showMessage(f"Preset gespeichert: {path}", 6000)

    def reset_settings(self):
        if self.cur is None:
            return

        def apply(s):
            fresh = self.lib.apply(EditSettings(), s.profile_id, s.preset_id)
            fresh.geometry = copy.deepcopy(s.geometry)
            fresh.input_encoding = s.input_encoding
            for k, v in fresh.__dict__.items():
                setattr(s, k, v)
        self._change("Zurücksetzen", apply)
        self._sync_panels()

    def copy_settings(self):
        if self.cur:
            self._clipboard = self.cur.copy()
            self.statusBar().showMessage("Einstellungen kopiert", 3000)

    def paste_settings(self):
        clip = getattr(self, "_clipboard", None)
        if clip is None or self.cur is None:
            return
        self._change("Einstellungen eingefügt", lambda s: [setattr(s, k, v) for k, v in
                                                           sync_settings(clip, s).__dict__.items()])
        self._sync_panels()

    # ------------------------------------------------------------ Aktionen
    def on_action(self, name: str):
        s = self.cur
        if name.startswith("tool_"):
            self._set_tool(name[5:])
            return
        if name == "export_batch":
            self.export_batch()
            return
        if s is None:
            return
        if name == "wb_reset":
            def f(s):
                s.wb_gains, s.temperature, s.tint = [1.0, 1.0, 1.0], 0.0, 0.0
            self._change("Weißabgleich zurücksetzen", f)
            self._sync_panels()
        elif name == "base_redetect":
            def f(s):
                s.base = FilmBase(mode="auto", offset=list(s.base.offset))
                s.lock_analysis = False
                s.analysis.key = ""
            self._change("Filmgrund neu erkennen", f)
            self._sync_panels()
        elif name in ("rotate_left", "rotate_right"):
            d = 90 if name == "rotate_right" else 270
            def f(s):
                s.geometry.rotation = (s.geometry.rotation + d) % 360
                s.geometry.crop = _rotate_rect(s.geometry.crop, d)
                if s.base.rect:
                    s.base.rect = _rotate_rect(s.base.rect, d)
            self._change("Drehen", f)
        elif name in ("flip_h", "flip_v"):
            def f(s):
                setattr(s.geometry, name, not getattr(s.geometry, name))
                for attr in ("crop",):
                    r = s.geometry.crop
                    if r:
                        s.geometry.crop = _flip_rect(r, name == "flip_h")
                if s.base.rect:
                    s.base.rect = _flip_rect(s.base.rect, name == "flip_h")
            self._change("Spiegeln", f)
        elif name == "crop_auto":
            fr = s.analysis.frame_rect
            if not fr:
                self.statusBar().showMessage("Kein Bildbereich erkannt (kein Filmrand gefunden).", 5000)
                return
            self._change("Zuschnitt: Bildbereich", lambda s: setattr(s.geometry, "crop", inset(fr, 0.005)))
            self._set_tool(TOOL_NONE)
        elif name == "crop_reset":
            self._change("Zuschnitt zurücksetzen", lambda s: setattr(s.geometry, "crop", None))
            if self.tool == TOOL_CROP:
                self.viewer.crop_rect = [0.0, 0.0, 1.0, 1.0]
        elif name == "browse_out":
            d = QFileDialog.getExistingDirectory(self, "Zielordner wählen", self.right.out_dir.text())
            if d:
                self.right.out_dir.setText(d)
        elif name == "export_current":
            self.export_current()
        elif name in ("sync", "sync_geometry"):
            self.sync_to_selected(include_geometry=name == "sync_geometry")
        elif name == "roll":
            self.roll_analysis()
        elif name == "unlock":
            self.unlock_selected()

    def _set_tool(self, tool: str):
        prev = self.tool
        self.tool = tool
        self.viewer.set_tool(tool)
        self.right.crop_btn.setChecked(tool == TOOL_CROP)
        self.right.base_pick_btn.setChecked(tool == TOOL_BASE)
        self.right.neutral_btn.setChecked(tool == TOOL_NEUTRAL)
        texts = {TOOL_CROP: "Zuschnitt: Rahmen aufziehen/anpassen – erneut 'Zuschneiden' klicken zum Beenden",
                 TOOL_BASE: "Filmgrund: Rechteck auf unbelichtetem Filmrand aufziehen",
                 TOOL_NEUTRAL: "Neutralpunkt: auf neutrale Fläche klicken"}
        self.tool_label.setText(texts.get(tool, ""))
        if tool == TOOL_CROP and self.cur:
            self.viewer.crop_rect = list(self.cur.geometry.crop or [0.0, 0.0, 1.0, 1.0])
        if tool == TOOL_BASE:
            self.viewer.set_mode("after")
        elif prev == TOOL_BASE:
            self.viewer.set_mode(self.view_mode)
        if (tool in (TOOL_CROP, TOOL_BASE)) != (prev in (TOOL_CROP, TOOL_BASE)):
            self.viewer.fit_mode = True
            self.request_preview()
        self._update_overlays()

    def on_crop_edited(self, rect: list):
        r = None if rect == [0.0, 0.0, 1.0, 1.0] else [float(v) for v in rect]
        self._change("Zuschnitt", lambda s: setattr(s.geometry, "crop", r), group="crop")

    def on_rect_picked(self, tool: str, rect: list):
        s = self.cur
        if s is None or self.loaded is None:
            return
        if tool == TOOL_BASE:
            def f(s):
                s.base.mode = "manual"
                s.base.rect = [float(v) for v in rect]
                s.lock_analysis = False
            self._change("Filmgrund-Messbereich", f)
            self._set_tool(TOOL_NONE)
            self._sync_panels()
        elif tool == TOOL_NEUTRAL:
            self._pick_neutral(rect)
            self._set_tool(TOOL_NONE)

    def _pick_neutral(self, rect: list):
        """Weißabgleich so, dass der gewählte Bereich neutral wird (im
        szenenlinearen Bild nach Belichtung, vor dem Weißabgleich)."""
        s = self.cur
        if s.film_type == "bw_negative":
            return
        lin = pipeline.scene_linear(apply_geometry(self.loaded.preview, s.geometry), s, s.analysis)
        region = crop_img(lin, rect).reshape(-1, 3)
        mean = np.median(region, axis=0).astype(np.float64)
        if np.any(mean <= 1e-5):
            self.statusBar().showMessage("Bereich zu dunkel für Neutralpunkt-Messung.", 5000)
            return
        gains = 1.0 / mean
        gains /= gains[1]

        def f(s):
            s.wb_gains = [float(v) for v in gains]
            s.temperature = 0.0
            s.tint = 0.0
        self._change("Neutralpunkt", f)
        self._sync_panels()

    def set_view_mode(self, mode: str):
        self.view_mode = mode
        for k, b in self.mode_buttons.items():
            b.setChecked(k == mode)
        if self.tool != TOOL_BASE:
            self.viewer.set_mode(mode)

    def toggle_before(self):
        self.set_view_mode("before" if self.view_mode != "before" else "after")

    # ------------------------------------------------------------ Undo/Redo
    def undo(self):
        self._history_step(True)

    def redo(self):
        self._history_step(False)

    def _history_step(self, undo: bool):
        if self.cur is None:
            return
        h = self.runtime[self.cur_index].history
        new = h.undo(self.cur) if undo else h.redo(self.cur)
        if new is None:
            return
        self._set_cur(new)
        self._sync_panels()
        self._after_change()

    def _update_undo(self):
        h = self.runtime[self.cur_index].history if self.cur is not None else None
        self.undo_act.setEnabled(bool(h and h.can_undo))
        self.redo_act.setEnabled(bool(h and h.can_redo))
        self.undo_act.setText("Rückgängig" + (f": {h.undo_label()}" if h and h.can_undo else ""))
        self.redo_act.setText("Wiederholen" + (f": {h.redo_label()}" if h and h.can_redo else ""))

    # ------------------------------------------------------------ Panels
    def _sync_panels(self):
        s = self.cur
        if s is None:
            return
        self.right.load_settings(s)
        self.left.set_film_type(s.film_type)
        self._refresh_library_lists()
        self._update_base_info()
        self._update_undo()

    def _refresh_library_lists(self):
        s = self.cur
        ft = s.film_type if s else "color_negative"
        self.left.set_profiles(self.lib.profiles_for(ft), s.profile_id if s else "")
        self.left.set_presets(list(self.lib.presets.values()), s.preset_id if s else "")

    # ------------------------------------------------------------ Miniaturen
    def _queue_thumb(self, index: int):
        if index not in self._thumb_queue:
            self._thumb_queue.append(index)
        self._pump_thumbs()

    def _pump_thumbs(self):
        if any(rt.thumb_busy for rt in self.runtime) or not self._thumb_queue:
            return
        i = self._thumb_queue.pop(0)
        if not (0 <= i < len(self.runtime)):
            self._pump_thumbs()
            return
        rt = self.runtime[i]
        rt.thumb_busy = True
        rt.thumb_dirty = False
        im = self.project.images[i]
        task = workers.Task(workers.thumb_job, i, im.path, im.settings.copy(), rt.thumb_proxy)
        task.signals.finished.connect(lambda res, p=im.path: self._on_thumb(res, p))
        task.signals.failed.connect(lambda msg, idx=i, p=im.path: self._on_thumb_failed(idx, p, msg))
        self.thumb_pool.start(task)

    def _on_thumb(self, res, path):
        i, qimg, analysis, proxy, warnings = res
        if i < len(self.runtime) and self.project.images[i].path == path:
            rt = self.runtime[i]
            rt.thumb_busy = False
            rt.thumb, rt.thumb_proxy = qimg, proxy
            if warnings:
                rt.warnings = warnings
            if rt.status != "ready":
                rt.status = "ready"
            s = self.project.images[i].settings
            if not s.lock_analysis and analysis.key == s.analysis_key(_sid_of(path)) and s.analysis.key != analysis.key:
                s.analysis = analysis
            self.strip.set_thumb(i, qimg)
        else:
            for rt in self.runtime:
                rt.thumb_busy = False
        self._pump_thumbs()

    def _on_thumb_failed(self, i, path, msg):
        if i < len(self.runtime) and self.project.images[i].path == path:
            self.runtime[i].thumb_busy = False
            self.runtime[i].status, self.runtime[i].error = "error", msg
            self.strip.set_thumb(i, None, "Fehler")
        else:
            for rt in self.runtime:
                rt.thumb_busy = False
        self._pump_thumbs()

    def _refresh_dirty_thumbs(self):
        for i, rt in enumerate(self.runtime):
            if rt.thumb_dirty and not rt.thumb_busy:
                self._queue_thumb(i)

    # ------------------------------------------------------------ Stapel
    def _targets(self) -> list[int]:
        rows = self.strip.selected_rows()
        return rows if len(rows) > 1 else list(range(len(self.project.images)))

    def sync_to_selected(self, include_geometry: bool = False):
        if self.cur is None:
            return
        rows = [r for r in self.strip.selected_rows() if r != self.cur_index]
        if not rows:
            QMessageBox.information(self, "Synchronisieren",
                                    "Bitte im Filmstreifen weitere Bilder markieren (Strg/Umschalt + Klick).")
            return
        for r in rows:
            dst = self.project.images[r].settings
            self.runtime[r].history.record(dst, "Synchronisiert")
            self.project.images[r].settings = sync_settings(self.cur, dst, include_geometry)
            self.runtime[r].thumb_dirty = True
        self._refresh_dirty_thumbs()
        self._schedule_autosave()
        self.statusBar().showMessage(f"Einstellungen auf {len(rows)} Bild(er) übertragen", 4000)

    def roll_analysis(self):
        idx = self._targets()
        if len(idx) < 2:
            QMessageBox.information(self, "Filmstreifen-Analyse", "Mindestens zwei Bilder werden benötigt.")
            return
        paths = [self.project.images[i].path for i in idx]
        settings = [self.project.images[i].settings.copy() for i in idx]

        def job(progress=None, cancelled=None):
            proxies, sids = [], []
            for k, (p, s) in enumerate(zip(paths, settings)):
                progress(k, len(paths), Path(p).name)
                src = load_image(p, s.input_encoding)
                proxies.append(pipeline.analysis_proxy(src.data))
                sids.append(src.source_id)
                del src
            progress(len(paths), len(paths), "Analyse")
            return batch.roll_analysis(proxies, settings, sids)

        def done(new_settings):
            for i, ns in zip(idx, new_settings):
                self.runtime[i].history.record(self.project.images[i].settings, "Filmstreifen-Analyse")
                self.project.images[i].settings = ns
                self.runtime[i].thumb_dirty = True
            self._sync_panels()
            self._after_change(rethumb=False)
            self._refresh_dirty_thumbs()
            self.statusBar().showMessage(f"Filmstreifen-Analyse über {len(idx)} Bilder abgeschlossen", 6000)

        self._run_job(job, done, "Filmstreifen-Analyse")

    def unlock_selected(self):
        for i in self._targets():
            s = self.project.images[i].settings
            if s.lock_analysis or s.base.mode == "fixed":
                self.runtime[i].history.record(s, "Analyse freigeben")
                s.lock_analysis = False
                s.base = FilmBase(mode="auto", offset=list(s.base.offset))
                s.analysis.key = ""
                self.runtime[i].thumb_dirty = True
        self._sync_panels()
        self._after_change(rethumb=False)
        self._refresh_dirty_thumbs()

    def _export_opts(self) -> tuple[ExportOptions, dict]:
        d = self.right.export_options()
        self.project.export = d
        return ExportOptions(fmt=d["fmt"], output_space=d["output_space"], jpeg_quality=d["jpeg_quality"]), d

    def _out_dir(self, d: dict, path: str) -> Path:
        return Path(d["out_dir"]) if d["out_dir"] else Path(path).parent / "export"

    def export_current(self):
        if self.cur is None:
            return
        opts, d = self._export_opts()
        im = self.project.images[self.cur_index]
        out_dir = self._out_dir(d, im.path)
        target = batch.unique_path(out_dir / batch.format_filename(d["template"], im.path, self.cur_index + 1,
                                                                   im.settings, opts.fmt), set())
        settings = im.settings.copy()
        full = self.loaded.full if self.loaded and self.loaded.path == im.path else None

        def job(progress=None, cancelled=None):
            data = full
            s = settings
            if data is None:
                src = load_image(im.path, s.input_encoding)
                data = src.data
                s = pipeline.ensure_analysis(pipeline.analysis_proxy(data), s, src.source_id)
            progress(0, 1, target.name)
            export_image(data, s, target, opts)
            return target

        self._run_job(job, lambda t: self.statusBar().showMessage(f"Exportiert: {t}", 10000), "Export", modal=False)

    def export_batch(self):
        if not self.project.images:
            return
        opts, d = self._export_opts()
        idx = self._targets()
        items = [batch.BatchItem(self.project.images[i].path, self.project.images[i].settings.copy()) for i in idx]
        out_dir = self._out_dir(d, items[0].path)
        if QMessageBox.question(self, "Stapel-Export", f"{len(items)} Bild(er) als {opts.fmt.upper()} nach\n{out_dir}\n"
                                "exportieren?") != QMessageBox.Yes:
            return

        def job(progress=None, cancelled=None):
            return batch.run_batch(items, out_dir, opts, d["template"], progress=progress, cancelled=cancelled)

        def done(results):
            ok = sum(r.ok for r in results)
            errs = [f"{Path(r.path).name}: {r.error}" for r in results if not r.ok]
            msg = f"{ok} von {len(items)} Bild(er) exportiert nach\n{out_dir}"
            if errs:
                QMessageBox.warning(self, "Stapel-Export", msg + "\n\nFehler:\n" + "\n".join(errs))
            else:
                QMessageBox.information(self, "Stapel-Export", msg)

        self._run_job(job, done, "Stapel-Export")

    def _run_job(self, fn, on_done, title: str, modal: bool = True):
        task = workers.Task(fn, with_progress=True)
        dlg = None
        if modal:
            dlg = QProgressDialog(title + " …", "Abbrechen", 0, 0, self)
            dlg.setWindowTitle(title)
            dlg.setWindowModality(Qt.WindowModal)
            dlg.setMinimumDuration(200)
            dlg.canceled.connect(task.cancel_event.set)
        self.progress.setVisible(True)
        self.progress.setRange(0, 0)

        def prog(i, n, msg):
            if dlg:
                dlg.setMaximum(n)
                dlg.setValue(i)
                dlg.setLabelText(f"{title}: {msg}" if msg else title)
            self.progress.setRange(0, n)
            self.progress.setValue(i)

        def fin(res):
            self.progress.setVisible(False)
            if dlg:
                dlg.reset()
            on_done(res)

        def fail(msg):
            self.progress.setVisible(False)
            if dlg:
                dlg.reset()
            QMessageBox.critical(self, title, f"{title} fehlgeschlagen:\n{msg}")

        task.signals.progress.connect(prog)
        task.signals.finished.connect(fin)
        task.signals.failed.connect(fail)
        self.job_pool.start(task)

    # ------------------------------------------------------------ Projekt
    def save_project(self, save_as: bool = False):
        if not self.project.images:
            return
        self._export_opts()
        path = self.project.path
        if save_as or not path:
            path, _ = QFileDialog.getSaveFileName(self, "Projekt speichern", path or "Film.filmlab",
                                                  "FilmLab-Projekt (*.filmlab)")
            if not path:
                return
            if not path.endswith(".filmlab"):
                path += ".filmlab"
        try:
            self.project.save(path)
            self.setWindowTitle(f"FilmLab – {Path(path).name}")
            self.statusBar().showMessage(f"Projekt gespeichert: {path}", 5000)
        except OSError as exc:
            QMessageBox.critical(self, "Speichern", f"Projekt konnte nicht gespeichert werden:\n{exc}")

    def open_project_dialog(self):
        path, _ = QFileDialog.getOpenFileName(self, "Projekt öffnen", "", "FilmLab-Projekt (*.filmlab)")
        if path:
            self.open_project(path)

    def open_project(self, path: str):
        try:
            proj = Project.load(path)
        except (OSError, ValueError) as exc:
            QMessageBox.critical(self, "Projekt öffnen", f"Projekt konnte nicht geladen werden:\n{exc}")
            return
        self._load_project(proj)
        self.setWindowTitle(f"FilmLab – {Path(path).name}")

    def _load_project(self, proj: Project):
        self.project = Project(export=proj.export, path=proj.path)
        self.runtime.clear()
        self.strip.clear()
        self.left.images.clear()
        self._lru.clear()
        self.loaded = None
        self._thumb_queue.clear()
        missing = []
        for im in proj.images:
            if not Path(im.path).is_file():
                missing.append(im.path)
                continue
            self.project.images.append(im)
            self.runtime.append(ImageRuntime())
            self.strip.add_item(Path(im.path).name)
            self.left.images.addItem(Path(im.path).name)
            self._queue_thumb(len(self.project.images) - 1)
        self.right.set_export_options(proj.export)
        if missing:
            QMessageBox.warning(self, "Projekt", "Folgende Dateien fehlen:\n" + "\n".join(missing))
        if self.project.images:
            self.project.current = -1
            self.select_image(max(0, min(proj.current, len(self.project.images) - 1)))

    def _restore_session(self):
        proj = load_session()
        if proj and proj.images:
            self._load_project(proj)
            self.statusBar().showMessage("Letzte Sitzung wiederhergestellt", 4000)

    def _schedule_autosave(self):
        self._autosave.start()

    def _do_autosave(self):
        try:
            self.project.export = self.right.export_options()
            save_session(self.project)
            if self.project.path:
                self.project.save()
        except OSError as exc:
            self.statusBar().showMessage(f"Automatisches Speichern fehlgeschlagen: {exc}", 8000)

    def closeEvent(self, e):
        self._do_autosave()
        super().closeEvent(e)

    def about(self):
        QMessageBox.about(self, "Über FilmLab",
                          "<b>FilmLab</b> 0.1 – Negativ-Konverter mit linearer Float-Pipeline.<br><br>"
                          "Dichtebasierte Inversion mit kanalweiser Filmgrund-Kompensation, "
                          "nicht-destruktive Bearbeitung, 16-Bit-Export mit ICC-Profil.<br><br>"
                          "Mathematische Grundlagen: docs/ALGORITHM.md")


def _sid_of(path: str) -> str:
    return workers._sid(path)


def _rotate_rect(r, deg: int):
    """Normiertes Rechteck um 90°-Schritte (im Uhrzeigersinn) mitdrehen."""
    if not r:
        return r
    x0, y0, x1, y1 = r
    if deg == 90:
        return [1 - y1, x0, 1 - y0, x1]
    if deg == 270:
        return [y0, 1 - x1, y1, 1 - x0]
    return r


def _flip_rect(r, horizontal: bool):
    x0, y0, x1, y1 = r
    return [1 - x1, y0, 1 - x0, y1] if horizontal else [x0, 1 - y1, x1, 1 - y0]
