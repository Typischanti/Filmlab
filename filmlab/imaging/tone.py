"""Tonwert- und Farbbearbeitung (HEURISTISCH / gestalterisch).

Die Eingabe ist szenenlineares Licht (Schwarz = 0, Weiß ≈ 1, Rec.2020).
Belichtung und Weißabgleich wirken linear (physikalisch sinnvoll als
Lichtmengen-Faktoren). Alle übrigen Tonwertwerkzeuge arbeiten in einem
wahrnehmungsnahen Bereich q = L^(1/2.2) und werden zu einer monotonen
1D-Tabelle (LUT, float, 8192 Stützstellen) zusammengefasst; Monotonie wird
erzwungen, damit keine Tonwertumkehr entstehen kann.
"""
from __future__ import annotations

import numpy as np

from ..core.colorspace import luminance_weights
from ..core.settings import EditSettings
from . import fastops

PERC_GAMMA = 2.2
LUT_SIZE = 8192
LUT_MAX = 2.0          # q-Bereich der LUT (≈ 2.2 Blenden über Weiß)
CONTRAST_PIVOT = 0.18 ** (1 / PERC_GAMMA)
W_REC2020 = luminance_weights()


def to_perceptual(lin: np.ndarray) -> np.ndarray:
    return fastops.power(lin, 1.0 / PERC_GAMMA)


def from_perceptual(q: np.ndarray) -> np.ndarray:
    return fastops.power(q, PERC_GAMMA)


# ---------------------------------------------------------------------------
# Lineare Stufe
# ---------------------------------------------------------------------------

def white_balance_gains(s: EditSettings) -> np.ndarray:
    """Kanalfaktoren aus Neutralpunkt-Messung, Temperatur und Tint.
    Temperatur/Tint sind relative Verschiebungen (±0.5 Blenden zwischen den
    Kanälen bei ±100), keine Kelvin-Angaben, da die Aufnahmelichtart eines
    Negativs unbekannt ist. Die Gesamthelligkeit (Luminanz) bleibt erhalten."""
    t = s.temperature / 100.0 * 0.5
    n = s.tint / 100.0 * 0.5
    gains = np.asarray(s.wb_gains, dtype=np.float64) * np.array([2.0 ** t, 2.0 ** (-n), 2.0 ** (-t)])
    gains /= float(np.dot(gains, W_REC2020))
    return gains.astype(np.float32)


def apply_linear(lin: np.ndarray, s: EditSettings, mono: bool = False) -> np.ndarray:
    gain = np.float32(2.0 ** s.exposure)
    if mono:
        return lin * gain
    return lin * (white_balance_gains(s) * gain)


# ---------------------------------------------------------------------------
# Tonkurven
# ---------------------------------------------------------------------------

def monotone_curve(points: list[list[float]], x: np.ndarray) -> np.ndarray:
    """Monotone kubische Hermite-Interpolation (Fritsch-Carlson). Verhindert
    Überschwinger und damit Tonwertumkehrungen zwischen Kontrollpunkten."""
    pts = sorted((float(a), float(b)) for a, b in points)
    xs = np.array([p[0] for p in pts])
    ys = np.array([p[1] for p in pts])
    # doppelte x entfernen
    keep = np.concatenate([[True], np.diff(xs) > 1e-6])
    xs, ys = xs[keep], ys[keep]
    if xs.size < 2:
        return np.clip(x, 0, 1)
    if xs.size == 2:
        return np.interp(x, xs, ys)
    h = np.diff(xs)
    delta = np.diff(ys) / h
    m = np.zeros_like(xs)
    m[0], m[-1] = delta[0], delta[-1]
    for k in range(1, xs.size - 1):
        if delta[k - 1] * delta[k] <= 0:
            m[k] = 0.0
        else:
            w1, w2 = 2 * h[k] + h[k - 1], h[k] + 2 * h[k - 1]
            m[k] = (w1 + w2) / (w1 / delta[k - 1] + w2 / delta[k])
    xc = np.clip(x, xs[0], xs[-1])
    idx = np.clip(np.searchsorted(xs, xc) - 1, 0, xs.size - 2)
    t = (xc - xs[idx]) / h[idx]
    t2, t3 = t * t, t * t * t
    y = ((2 * t3 - 3 * t2 + 1) * ys[idx] + (t3 - 2 * t2 + t) * h[idx] * m[idx]
         + (-2 * t3 + 3 * t2) * ys[idx + 1] + (t3 - t2) * h[idx] * m[idx + 1])
    # außerhalb der Kontrollpunkte konstant fortsetzen
    y = np.where(x < xs[0], ys[0], np.where(x > xs[-1], ys[-1], y))
    return y


def _is_identity(points) -> bool:
    return len(points) == 2 and np.allclose(points, [[0, 0], [1, 1]])


def shoulder(q: np.ndarray, rolloff: float) -> np.ndarray:
    """Weiche Lichterschulter: identisch bis zum Knie k, darüber Reinhard-
    artige Kompression, die den Punkt w>1 exakt auf 1 abbildet (C1-stetig,
    monoton). rolloff=0 entspricht hartem Clipping bei 1."""
    rolloff = float(np.clip(rolloff, 0.0, 1.0))
    if rolloff <= 1e-4:
        return np.minimum(q, 1.0)
    k = 1.0 - 0.3 * rolloff
    uw = 1.0 + 3.0 * rolloff
    u = np.maximum(q - k, 0.0) / (1.0 - k)
    comp = k + (1.0 - k) * u * (1.0 + u / (uw * uw)) / (1.0 + u)
    return np.where(q > k, np.minimum(comp, 1.0), q)


def s_curve(q: np.ndarray, g: float, pivot: float = CONTRAST_PIVOT) -> np.ndarray:
    q = np.clip(q, 0.0, 1.0)
    lo = pivot * np.power(q / pivot, g)
    hi = 1.0 - (1.0 - pivot) * np.power((1.0 - q) / (1.0 - pivot), g)
    return np.where(q < pivot, lo, hi)


def base_tone(q: np.ndarray, s: EditSettings) -> np.ndarray:
    q = shoulder(q, s.highlight_rolloff)
    # Schwarz-/Weißpunkt
    bp = s.black / 100.0 * 0.15
    wp = 1.0 - s.white / 100.0 * 0.15
    q = (q - bp) / max(wp - bp, 1e-3)
    q = np.clip(q, 0.0, 1.0)
    # Gamma
    if abs(s.gamma - 1.0) > 1e-6:
        q = np.power(q, 1.0 / max(s.gamma, 0.05))
    # Helligkeit (Mitteltöne, Endpunkte fest)
    a = s.brightness / 100.0 * 0.2
    q = q + a * 4.0 * q * (1.0 - q)
    # Tiefen / Lichter
    q = (q + 0.12 * (s.shadows / 100.0) * 6.75 * q * (1.0 - q) ** 2
         + 0.12 * (s.highlights / 100.0) * 6.75 * q * q * (1.0 - q))
    # Kontrast: konvexe Mischung mit S-Kurve (bleibt monoton)
    c = s.contrast / 100.0
    if abs(c) > 1e-6:
        g = 2.2 if c > 0 else 1.0 / 2.2
        m = min(abs(c), 1.0) * 0.85
        q = (1.0 - m) * q + m * s_curve(q, g)
    return np.clip(q, 0.0, 1.0)


def build_tone_lut(s: EditSettings) -> tuple[np.ndarray, np.ndarray]:
    """Liefert (x, lut[3, N]) für q_in in [0, LUT_MAX]."""
    x = np.linspace(0.0, LUT_MAX, LUT_SIZE, dtype=np.float64)
    q = base_tone(x, s)
    if not _is_identity(s.curves.get("master", [[0, 0], [1, 1]])):
        q = monotone_curve(s.curves["master"], q)
    luts = []
    for ch in ("r", "g", "b"):
        pts = s.curves.get(ch, [[0, 0], [1, 1]])
        qc = q if _is_identity(pts) else monotone_curve(pts, q)
        qc = np.maximum.accumulate(np.clip(qc, 0.0, 1.0))
        luts.append(qc)
    return x.astype(np.float32), np.stack(luts).astype(np.float32)


SQRT_LUT_SIZE = 16384
SQRT_MAX = float(np.sqrt(LUT_MAX ** PERC_GAMMA))   # sqrt(L) bei q = LUT_MAX


def build_sqrt_tone_lut(s: EditSettings) -> np.ndarray:
    """Tonwert-LUT, indiziert über sqrt(L) statt q = L^(1/2.2).

    q = (sqrt L)^(2/2.2) ist im sqrt-Bereich nahezu linear, daher ist die
    lineare Interpolation sehr genau, und das teure pow() pro Pixel entfällt
    (sqrt ist eine einfache SIMD-Operation). Ergebnis: (3, SQRT_LUT_SIZE)."""
    xs = np.linspace(0.0, SQRT_MAX, SQRT_LUT_SIZE, dtype=np.float64)
    q_in = np.power(xs, 2.0 / PERC_GAMMA)
    q = base_tone(q_in, s)
    if not _is_identity(s.curves.get("master", [[0, 0], [1, 1]])):
        q = monotone_curve(s.curves["master"], q)
    luts = []
    for ch in ("r", "g", "b"):
        pts = s.curves.get(ch, [[0, 0], [1, 1]])
        qc = q if _is_identity(pts) else monotone_curve(pts, q)
        luts.append(np.maximum.accumulate(np.clip(qc, 0.0, 1.0)))
    return np.stack(luts).astype(np.float32)


Q_TO_LIN_LUT = np.power(np.linspace(0.0, 1.0, 4096), PERC_GAMMA).astype(np.float32)[None, :]


def linear_gains(s: EditSettings, mono: bool = False) -> np.ndarray:
    gain = 2.0 ** s.exposure
    return (np.full(3, gain, np.float32) if mono else white_balance_gains(s) * np.float32(gain)).astype(np.float32)


def apply_lut(q: np.ndarray, x: np.ndarray, lut: np.ndarray) -> np.ndarray:
    """Kanalweise lineare Interpolation der Tonwert-LUT (gleichmäßiges Raster)."""
    return fastops.lut3(q, lut, LUT_MAX)


# ---------------------------------------------------------------------------
# Farbe
# ---------------------------------------------------------------------------

def apply_color(q: np.ndarray, s: EditSettings) -> np.ndarray:
    sat = 1.0 + s.saturation / 100.0
    vib = s.vibrance / 100.0
    if abs(sat - 1.0) < 1e-6 and abs(vib) < 1e-6:
        return q
    y = fastops.transform(q, W_REC2020)[..., None]
    if abs(vib) > 1e-6:
        chroma = np.clip(fastops.cmax(q) - fastops.cmin(q), 0.0, 1.0)[..., None]
        factor = np.float32(sat) * (np.float32(1.0) + np.float32(vib) * (np.float32(1.0) - chroma) ** 2)
    else:
        factor = np.float32(sat)
    out = q - y
    out *= factor
    out += y
    return out
