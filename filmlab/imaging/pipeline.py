"""Gesamtpipeline: Analyse (einmalig, deterministisch) und Rendering.

Konsistenz Vorschau/Export
--------------------------
Alle bildabhängigen Größen (Filmgrund, Schwarz-/Weißpunkte, Balance) werden
von ``analyze`` auf einem Analyse-Proxy fester Größe bestimmt und in den
Einstellungen gespeichert. ``render`` wendet dann für Vorschau und Export
exakt dieselbe pixelweise Transformation an; nur räumliche Filter werden mit
dem Maßstab skaliert.

Reihenfolge in ``render``:
    Geometrie -> Dichte (Filmgrund) -> Normierung -> szenenlinear
    -> Belichtung/Weißabgleich (linear) -> Tonwert-LUT (wahrnehmungsnah)
    -> Rauschreduzierung -> Schärfung -> Sättigung/Dynamik
    -> Ausgabefarbraum (Matrix, Gamut-Kompression, Transferfunktion)
"""
from __future__ import annotations

import hashlib
import json
import threading
from dataclasses import asdict

import cv2
import numpy as np

from ..core import colorspace as cs
from ..core.settings import Analysis, EditSettings
from . import detail, fastops, filmbase, inversion, tone
from .geometry import apply_geometry, crop, inset, orient
from .loader import make_proxy

ANALYSIS_DIM = 1200
ANALYSIS_INSET = 0.02


def analysis_proxy(full: np.ndarray) -> np.ndarray:
    return make_proxy(full, ANALYSIS_DIM)


def _mono(img: np.ndarray, mix) -> np.ndarray:
    w = np.asarray(mix, dtype=np.float32)
    w = w / max(float(w.sum()), 1e-6)
    return img @ w


def _smooth(region: np.ndarray) -> np.ndarray:
    import cv2

    sigma = max(1.0, min(region.shape[:2]) / 500.0)
    return cv2.GaussianBlur(np.ascontiguousarray(region, dtype=np.float32), (0, 0), sigma)


def analyze(proxy: np.ndarray, s: EditSettings, source_id: str = "") -> Analysis:
    """Bestimmt Filmgrund und Normierungsparameter. ``proxy`` sollte mit
    ``analysis_proxy`` aus dem Vollbild erzeugt sein (Reproduzierbarkeit)."""
    a = Analysis(key=s.analysis_key(source_id))
    geo = orient(proxy, s.geometry)                    # ohne Zuschnitt (Filmrand!)

    if s.film_type == "slide":
        flat = _smooth(crop(geo, inset(s.geometry.crop, ANALYSIS_INSET))).reshape(-1, 3)
        lum = flat @ tone.W_REC2020
        lo, hi = inversion.slide_levels(lum, s.black_clip, s.white_clip)
        a.slide_lo, a.slide_hi = [lo] * 3, [hi] * 3
        a.base_source = "none"
        return a

    # --- Filmgrund ---------------------------------------------------------
    mode = s.base.mode
    if mode == "manual" and s.base.rect:
        rgb, rel = filmbase.measure_rect(geo, s.base.rect)
        conf, warns = filmbase.check_base(rgb, geo, s.film_type, s.geometry.crop, rel)
        res = filmbase.BaseResult([float(v) for v in rgb], "manual", conf, list(s.base.rect), warns)
    elif mode == "fixed" and s.base.rgb:
        conf, warns = filmbase.check_base(s.base.rgb, geo, s.film_type, s.geometry.crop)
        res = filmbase.BaseResult(list(s.base.rgb), "fixed", conf, None, warns)
    elif mode == "estimate":
        res = filmbase.estimate_from_content(geo, s.geometry.crop, s.film_type)
    else:
        res = filmbase.detect_base(geo, s.film_type, s.geometry.crop)
    base = np.asarray(res.rgb, dtype=np.float64)
    a.base_rgb = [float(v) for v in base]
    a.base_source, a.base_confidence, a.base_rect = res.source, float(res.confidence), res.rect
    a.warnings.extend(res.warnings)
    a.scan_level = float(base.max())
    if a.scan_level < 0.2:
        a.notes.append(f"Filmgrund liegt bei {a.scan_level * 100:.0f}% der Sättigung – der Scan könnte "
                       "ca. {:.1f} Blenden heller belichtet werden.".format(np.log2(0.8 / max(a.scan_level, 1e-4))))

    # --- Bildbereich für die Tonwertanalyse --------------------------------
    rect = s.geometry.crop
    if rect is None and res.source != "estimate":
        a.frame_rect = filmbase.detect_frame(geo, base)
        rect = a.frame_rect
    # Transmission vor der Perzentilbildung leicht mitteln: macht Schwarz-/
    # Weißpunkt robust gegen Sensorrauschen in dichten Negativbereichen.
    flat = _smooth(crop(geo, inset(rect, ANALYSIS_INSET))).reshape(-1, 3)

    # --- Dichte & Normierung ----------------------------------------------
    if s.film_type == "bw_negative":
        d = inversion.density(_mono(flat, s.bw_mix)[:, None], float(_mono(base[None], s.bw_mix)[0]))
    else:
        d = inversion.density(flat.astype(np.float32), base)
    lo, hi = inversion.density_levels(d, s.black_clip, s.white_clip)
    normalization = s.normalization
    if res.source == "estimate" and normalization == "base":
        normalization = "auto"
        a.notes.append("Filmgrund nur geschätzt: Schwarzpunkt wird je Kanal aus dem Bildinhalt bestimmt.")
    if normalization == "base":
        # Schatten-Farbbalance aus dem Filmgrund (unbelichteter Film = neutrales
        # Schwarz), nur der gemeinsame Pegel kommt aus dem Bildinhalt.
        lo = np.full_like(lo, lo.min())
    hi = np.maximum(hi, lo + inversion.MIN_RANGE)
    if d.shape[1] == 1:
        lo, hi = np.repeat(lo, 3), np.repeat(hi, 3)
    a.d_lo, a.d_hi = [float(v) for v in lo], [float(v) for v in hi]
    a.log_range = inversion.log_range(lo, hi, s.film_gamma)

    if s.film_type == "color_negative" and s.auto_color > 0:
        e = inversion.normalize(d, lo, hi)
        a.balance = [float(v) for v in inversion.balance_gammas(e, s.auto_color)]
    return a


def ensure_analysis(proxy: np.ndarray, s: EditSettings, source_id: str = "") -> EditSettings:
    """Aktualisiert die gespeicherte Analyse, falls ihre Eingaben sich geändert
    haben und sie nicht gesperrt ist (Filmstreifen-Konsistenz)."""
    if s.lock_analysis and s.analysis.key:
        return s
    key = s.analysis_key(source_id)
    if s.analysis.key != key:
        s.analysis = analyze(proxy, s, source_id)
    return s


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

def scene_linear(img: np.ndarray, s: EditSettings, a: Analysis) -> np.ndarray:
    """Geometrisch transformiertes lineares Scanbild -> szenenlineares Positiv."""
    img = img.astype(np.float32, copy=False)
    if s.film_type == "slide":
        lo = np.float32(a.slide_lo[0])
        hi = np.float32(a.slide_hi[0])
        return (img - lo) / (hi - lo)
    if a.base_rgb is None:
        raise ValueError("Analyse fehlt (kein Filmgrund bestimmt)")
    base = np.asarray(a.base_rgb, dtype=np.float64) * 10.0 ** (-np.asarray(s.base.offset, dtype=np.float64))
    if s.film_type == "bw_negative":
        d = inversion.density(_mono(img, s.bw_mix)[..., None], float(_mono(base[None], s.bw_mix)[0]))
        e = inversion.normalize(d, a.d_lo[:1], a.d_hi[:1])
        lin = inversion.to_scene_linear(e, a.log_range)
        return np.repeat(lin, 3, axis=-1)
    d = inversion.density(img, base)
    e = inversion.normalize(d, a.d_lo, a.d_hi)
    e = inversion.apply_balance(e, a.balance)
    return inversion.to_scene_linear(e, a.log_range)


def finish(lin: np.ndarray, s: EditSettings, scale: float = 1.0, output_space: str = "srgb",
           sqrt_lin: np.ndarray | None = None) -> np.ndarray:
    """Szenenlinear -> kodiertes Ausgabebild (float32, 0..1).

    Schneller Pfad: Belichtung/Weißabgleich werden als Skalierung des LUT-
    Index angewendet (sqrt(g*L) = sqrt(g)*sqrt(L)), Transferfunktionen als
    vorberechnete Float-LUTs. Numerisch gleichwertig zu ``finish_reference``
    (Abweichung < 1e-4, siehe Tests)."""
    mono = s.film_type == "bw_negative"
    if sqrt_lin is None:
        sqrt_lin = cv2.sqrt(np.maximum(fastops.f32(lin), np.float32(0.0)))
    luts = tone.build_sqrt_tone_lut(s)
    q = fastops.lut_channels(sqrt_lin, luts, tone.SQRT_MAX, prescale=np.sqrt(tone.linear_gains(s, mono)))
    q = detail.reduce_noise(q, s.nr_luma, s.nr_chroma, scale, mono=mono)
    q = detail.sharpen(q, s.sharpen_amount, s.sharpen_radius, scale)
    if not mono:
        q = tone.apply_color(q, s)
    out_lin = fastops.lut_channels(q, tone.Q_TO_LIN_LUT, 1.0)   # q^2.2, mit Klemmung auf [0, 1]
    return to_output(out_lin, output_space)


def finish_reference(lin: np.ndarray, s: EditSettings, scale: float = 1.0, output_space: str = "srgb") -> np.ndarray:
    """Direkte (langsame) Referenzimplementierung von ``finish`` mit pow()
    und exakten Transferfunktionen – dient der Verifikation des schnellen Pfads."""
    mono = s.film_type == "bw_negative"
    lin = tone.apply_linear(lin, s, mono=mono)
    q = np.power(np.maximum(lin, 0.0).astype(np.float64), 1.0 / tone.PERC_GAMMA)
    q = tone.base_tone(np.minimum(q, tone.LUT_MAX), s)          # pixelweise, ohne LUT
    if not tone._is_identity(s.curves["master"]):
        q = tone.monotone_curve(s.curves["master"], q)
    q = np.stack([q[..., c] if tone._is_identity(s.curves[ch]) else tone.monotone_curve(s.curves[ch], q[..., c])
                  for c, ch in enumerate("rgb")], axis=-1)
    q = np.clip(q, 0.0, 1.0).astype(np.float32)
    q = detail.reduce_noise(q, s.nr_luma, s.nr_chroma, scale, mono=mono)
    q = detail.sharpen(q, s.sharpen_amount, s.sharpen_radius, scale)
    if not mono:
        q = tone.apply_color(q, s)
    out_lin = np.power(np.clip(q, 0.0, 1.0), tone.PERC_GAMMA).astype(np.float32)
    space = cs.SPACES[output_space]
    out = cs.apply_matrix(out_lin, cs.conversion_matrix(cs.WORKING_SPACE, space))
    out = cs.gamut_compress(out, cs.luminance_weights(space))
    return np.clip(cs.encode(np.clip(out, 0.0, 1.0), space), 0.0, 1.0)


_ENCODE_LUTS: dict[str, np.ndarray] = {}


def _encode_lut(space: cs.RGBColorSpace) -> np.ndarray:
    """Kodierungs-LUT über sqrt(linear) (glatt, daher genau interpolierbar)."""
    lut = _ENCODE_LUTS.get(space.key)
    if lut is None:
        xs = np.linspace(0.0, 1.0, 16384, dtype=np.float64)
        lut = cs.encode((xs * xs).astype(np.float32), space).astype(np.float32)[None, :]
        _ENCODE_LUTS[space.key] = lut
    return lut


def to_output(lin_working: np.ndarray, output_space: str) -> np.ndarray:
    space = cs.SPACES[output_space]
    m = cs.conversion_matrix(cs.WORKING_SPACE, space)
    out = cs.apply_matrix(lin_working, m)
    out = cs.gamut_compress(out, cs.luminance_weights(space))
    np.clip(out, 0.0, 1.0, out=out)
    if space.transfer == "linear":
        return out
    return np.clip(fastops.lut_channels(cv2.sqrt(out), _encode_lut(space), 1.0), 0.0, 1.0)


def render(img: np.ndarray, s: EditSettings, scale: float = 1.0, output_space: str = "srgb",
           cache: "StageCache | None" = None, cache_id: str = "") -> np.ndarray:
    sq = None
    key = None
    if cache is not None:
        key = cache.key(cache_id, img.shape, s)
        sq = cache.get(key)
    if sq is None:
        lin = scene_linear(apply_geometry(img, s.geometry), s, s.analysis)
        sq = cv2.sqrt(np.maximum(lin, np.float32(0.0)))
        del lin
        if cache is not None:
            cache.put(key, sq)
    return finish(None, s, scale, output_space, sqrt_lin=sq)


def render_negative(img: np.ndarray, s: EditSettings, with_crop: bool = True) -> np.ndarray:
    """Unbearbeitete Ansicht des Scans (für Vorher-Ansicht, Messbereichswahl)."""
    geo = apply_geometry(img, s.geometry, with_crop=with_crop)
    return to_output(geo, "srgb")


class StageCache:
    """Zwischenspeicher für sqrt(szenenlinear) (teuerste Stufe). Bei
    reinen Tonwert-/Farbänderungen entfällt so die Dichteberechnung."""

    def __init__(self, capacity: int = 2):
        self.capacity = capacity
        self._items: dict[str, np.ndarray] = {}
        self._lock = threading.Lock()

    @staticmethod
    def key(cache_id: str, shape, s: EditSettings) -> str:
        rel = {
            "id": cache_id, "shape": list(shape), "geom": asdict(s.geometry), "film": s.film_type,
            "bw": s.bw_mix, "off": s.base.offset, "a": asdict(s.analysis) | {"warnings": None, "notes": None},
        }
        return hashlib.sha1(json.dumps(rel, sort_keys=True, default=str).encode()).hexdigest()

    def get(self, key):
        with self._lock:
            return self._items.get(key)

    def put(self, key, value):
        with self._lock:
            self._items[key] = value
            while len(self._items) > self.capacity:
                self._items.pop(next(iter(self._items)))

    def clear(self):
        with self._lock:
            self._items.clear()
