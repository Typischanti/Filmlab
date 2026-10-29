"""Nicht-destruktives Einstellungsmodell.

Ein Bild wird ausschließlich durch ``EditSettings`` beschrieben; das Original
wird nie verändert. Alle Felder sind JSON-serialisierbar. Unbekannte Felder
werden beim Laden ignoriert und fehlende mit Standardwerten ergänzt, sodass
ältere Projektdateien lesbar bleiben.
"""
from __future__ import annotations

import copy
import hashlib
import json
from dataclasses import asdict, dataclass, field, fields, is_dataclass
from typing import Any

FILM_TYPES = {
    "color_negative": "Farbnegativ (C-41)",
    "bw_negative": "Schwarzweißnegativ",
    "slide": "Diafilm (Positiv)",
}

NORMALIZATION_MODES = {
    "auto": "Kanalweise (Schwarz-/Weißpunkt aus Bildinhalt)",
    "base": "Filmgrund-referenziert (Schatten-Balance aus Maske)",
}

BASE_MODES = {
    "auto": "Automatisch (Filmrand)",
    "manual": "Manuell (Messbereich)",
    "estimate": "Schätzung aus Bildinhalt",
    "fixed": "Fester Wert (Filmstreifen)",
}

IDENTITY_CURVE = [[0.0, 0.0], [1.0, 1.0]]


def _identity_curves() -> dict[str, list[list[float]]]:
    return {k: copy.deepcopy(IDENTITY_CURVE) for k in ("master", "r", "g", "b")}


@dataclass
class Geometry:
    rotation: int = 0          # 0, 90, 180, 270 (im Uhrzeigersinn)
    angle: float = 0.0         # Feinrotation in Grad (-45..45)
    flip_h: bool = False
    flip_v: bool = False
    crop: list[float] | None = None  # [x0, y0, x1, y1] normiert, nach Rotation

    def is_identity(self) -> bool:
        return (self.rotation % 360 == 0 and abs(self.angle) < 1e-6 and not self.flip_h
                and not self.flip_v and (self.crop is None or self.crop == [0.0, 0.0, 1.0, 1.0]))


@dataclass
class FilmBase:
    mode: str = "auto"
    rect: list[float] | None = None   # manueller Messbereich [x0,y0,x1,y1] normiert (nach Rotation, ohne Crop)
    rgb: list[float] | None = None    # fester Filmgrundwert (linear) für mode "fixed"
    offset: list[float] = field(default_factory=lambda: [0.0, 0.0, 0.0])  # Dichte-Feinkorrektur je Kanal


@dataclass
class Analysis:
    """Ergebnis der Bildanalyse. Wird einmal (auf einem Analyse-Proxy fester
    Größe) berechnet und dann für Vorschau UND Export unverändert verwendet."""
    key: str = ""
    base_rgb: list[float] | None = None
    base_source: str = ""           # border | manual | estimate | fixed
    base_confidence: float = 0.0
    base_rect: list[float] | None = None
    frame_rect: list[float] | None = None   # automatisch erkannter Bildbereich (ohne Filmrand)
    d_lo: list[float] = field(default_factory=lambda: [0.0, 0.0, 0.0])
    d_hi: list[float] = field(default_factory=lambda: [1.0, 1.0, 1.0])
    balance: list[float] = field(default_factory=lambda: [1.0, 1.0, 1.0])
    log_range: float = 2.0
    slide_lo: list[float] = field(default_factory=lambda: [0.0, 0.0, 0.0])
    slide_hi: list[float] = field(default_factory=lambda: [1.0, 1.0, 1.0])
    scan_level: float = 0.0          # Filmgrundhelligkeit relativ zur Sättigung
    auto_ev: float = 0.0             # Vorschlag der automatischen Belichtung (EV)
    warnings: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


@dataclass
class EditSettings:
    # --- Film & Konvertierung -------------------------------------------
    film_type: str = "color_negative"
    profile_id: str = "generic_color_negative"
    preset_id: str = "neutral"
    input_encoding: str = "auto"      # auto | srgb | linear (nur Nicht-RAW)
    base: FilmBase = field(default_factory=FilmBase)
    normalization: str = "auto"
    black_clip: float = 0.05          # Prozent der Pixel unter dem Schwarzpunkt
    white_clip: float = 0.05          # Prozent der Pixel über dem Weißpunkt
    film_gamma: float = 0.60          # Gradation des Negativs (Dichte je log10 Belichtung)
    bw_mix: list[float] = field(default_factory=lambda: [0.2627, 0.6780, 0.0593])
    auto_color: float = 1.0           # Heuristischer Mitteltonausgleich 0..1 (nur Farbnegativ)
    lock_analysis: bool = False
    auto_crop: bool = True            # erkannten Bildbereich als Zuschnitt verwenden, solange kein eigener gesetzt ist

    # --- Belichtung & Weißabgleich (nach Inversion, szenenlinear) ----------
    exposure: float = 0.0             # EV
    auto_exposure: bool = True        # Analysevorschlag (auto_ev) zur Belichtung addieren
    temperature: float = 0.0          # -100..100 (relativ)
    tint: float = 0.0                 # -100..100 (relativ)
    wb_gains: list[float] = field(default_factory=lambda: [1.0, 1.0, 1.0])

    # --- Tonwerte (wahrnehmungsnaher Bereich) -----------------------------
    black: float = 0.0                # -100..100
    white: float = 0.0                # -100..100
    contrast: float = 0.0             # -100..100
    brightness: float = 0.0           # -100..100
    highlights: float = 0.0           # -100..100
    shadows: float = 0.0              # -100..100
    gamma: float = 1.0                # 0.3..3.0
    highlight_rolloff: float = 0.5    # 0..1 weiche Lichterschulter
    curves: dict[str, list[list[float]]] = field(default_factory=_identity_curves)

    # --- Farbe --------------------------------------------------------------
    saturation: float = 0.0           # -100..100
    vibrance: float = 0.0             # -100..100

    # --- Details --------------------------------------------------------------
    sharpen_amount: float = 0.0       # 0..200 (%)
    sharpen_radius: float = 1.0       # px (bezogen auf volle Auflösung)
    nr_luma: float = 0.0              # 0..100
    nr_chroma: float = 0.0            # 0..100

    geometry: Geometry = field(default_factory=Geometry)
    analysis: Analysis = field(default_factory=Analysis)

    # ------------------------------------------------------------------
    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "EditSettings":
        return _from_dict(cls, data or {})

    def copy(self) -> "EditSettings":
        return copy.deepcopy(self)

    def analysis_key(self, source_id: str = "") -> str:
        """Hash aller Eingaben, von denen die Analyse abhängt."""
        relevant = {
            "src": source_id,
            "film_type": self.film_type,
            "input_encoding": self.input_encoding,
            "base": asdict(self.base) | {"offset": None},
            "normalization": self.normalization,
            "black_clip": self.black_clip,
            "white_clip": self.white_clip,
            "film_gamma": self.film_gamma,
            "bw_mix": self.bw_mix,
            "auto_color": self.auto_color,
            "geometry": asdict(self.geometry),
        }
        return hashlib.sha1(json.dumps(relevant, sort_keys=True).encode()).hexdigest()[:16]


# Parameter, die beim Synchronisieren zwischen Bildern übertragen werden
# (Geometrie und bildspezifische Analyse bleiben pro Bild).
SYNC_EXCLUDE = {"geometry", "analysis"}

# Parameter, die ein "Look" (Preset) setzen darf.
LOOK_PARAMS = {
    "exposure", "temperature", "tint", "black", "white", "contrast", "brightness",
    "highlights", "shadows", "gamma", "highlight_rolloff", "saturation", "vibrance",
    "sharpen_amount", "sharpen_radius", "nr_luma", "nr_chroma", "auto_color", "curves",
}

# Parameter, die ein Filmprofil setzen darf.
FILM_PARAMS = {"film_type", "film_gamma", "bw_mix", "normalization", "black_clip", "white_clip"}


def _from_dict(cls, data: dict[str, Any]):
    kwargs = {}
    for f in fields(cls):
        if f.name not in data:
            continue
        value = data[f.name]
        default = f.default_factory() if callable(f.default_factory) else f.default  # type: ignore[misc]
        if is_dataclass(default) and isinstance(value, dict):
            value = _from_dict(type(default), value)
        elif f.name == "curves" and isinstance(value, dict):
            merged = _identity_curves()
            for k, v in value.items():
                if k in merged and isinstance(v, list) and len(v) >= 2:
                    merged[k] = [[float(a), float(b)] for a, b in v]
            value = merged
        kwargs[f.name] = value
    return cls(**kwargs)


def apply_overrides(settings: EditSettings, overrides: dict[str, Any], allowed: set[str] | None = None) -> EditSettings:
    """Setzt Parameter aus einem Profil/Preset (gibt eine neue Instanz zurück)."""
    s = settings.copy()
    for key, value in overrides.items():
        if allowed is not None and key not in allowed:
            continue
        if not hasattr(s, key):
            continue
        if key == "curves":
            merged = _identity_curves()
            merged.update({k: [list(map(float, p)) for p in v] for k, v in value.items() if k in merged})
            value = merged
        setattr(s, key, copy.deepcopy(value))
    return s


def sync_settings(src: EditSettings, dst: EditSettings, include_geometry: bool = False) -> EditSettings:
    """Überträgt Bearbeitungsparameter von src auf dst."""
    out = src.copy()
    if not include_geometry:
        out.geometry = copy.deepcopy(dst.geometry)
    out.analysis = copy.deepcopy(dst.analysis)
    # Manuelle Filmgrund-Messbereiche beziehen sich auf das jeweilige Bild.
    if src.base.mode == "manual":
        out.base = copy.deepcopy(dst.base) if dst.base.mode == "manual" else FilmBase(mode="auto", offset=list(src.base.offset))
    return out
