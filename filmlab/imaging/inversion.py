"""Negativ -> Positiv: Transmission, optische Dichte und Normierung.

Modell (vollständig hergeleitet in docs/ALGORITHM.md)
-----------------------------------------------------
Linearer Messwert eines Kanals c:

    S_c = k_c * 10^(-D_c),      D_c = D_min,c + D_bild,c

k_c fasst Lichtquelle, Sensorempfindlichkeit, Belichtungszeit und
Weißabgleich zusammen. Mit dem Filmgrund-Messwert B_c = k_c * 10^(-D_min,c):

    D_bild,c = -log10(S_c / B_c)                      [physikalisch]

k_c und die Orangemaske kürzen sich exakt heraus. Im geraden Teil der
Schwärzungskurve gilt D_bild,c = gamma_c * log10(H_c) + const, also ist die
normierte Dichte

    e_c = (D_bild,c - d_lo,c) / (d_hi,c - d_lo,c)

eine lineare Funktion des Logarithmus der Szenenbelichtung, unabhängig von
der kanalweisen Gradation gamma_c. Mit dem logarithmischen Motivumfang
R = mean(d_hi - d_lo) / gamma_film folgt szenenlineares Licht

    L_c = 10^(R * (e_c - 1))   (Weißpunkt -> 1.0, Schwarzpunkt -> 10^-R)

Die Wahl von d_lo/d_hi (Perzentile) und der Abzug des Restschwarz sind
heuristisch und als solche gekennzeichnet.
"""
from __future__ import annotations

import numpy as np

DENSITY_MAX = 4.0      # Begrenzung: mehr Dichte über Filmgrund kommt praktisch nicht vor
MIN_RANGE = 0.05       # minimale Dichtespanne zwischen Schwarz- und Weißpunkt
R_MIN, R_MAX = 1.0, 3.6


def density(lin: np.ndarray, base) -> np.ndarray:
    """Optische Dichte über Filmgrund: D = -log10(S / B). Numerisch stabil durch
    Begrenzung der Transmission auf [10^-DENSITY_MAX, ∞).
    Werte heller als der Filmgrund ergeben (kleine) negative Dichten."""
    base = np.asarray(base, dtype=np.float32)
    t = lin / base
    np.maximum(t, np.float32(10.0 ** -DENSITY_MAX), out=t)
    return -np.log10(t, dtype=np.float32)


def density_levels(d: np.ndarray, black_clip: float, white_clip: float) -> tuple[np.ndarray, np.ndarray]:
    """Perzentile der Dichte je Kanal: niedrige Dichte = Szenenschwarz,
    hohe Dichte = Szenenweiß.  d: (N, C)."""
    lo = np.percentile(d, black_clip, axis=0)
    hi = np.percentile(d, 100.0 - white_clip, axis=0)
    return lo.astype(np.float64), hi.astype(np.float64)


def log_range(d_lo, d_hi, film_gamma: float) -> float:
    """Logarithmischer Motivumfang aus Dichtespanne und Filmgradation."""
    span = float(np.mean(np.asarray(d_hi) - np.asarray(d_lo)))
    return float(np.clip(span / max(film_gamma, 0.05), R_MIN, R_MAX))


def normalize(d: np.ndarray, d_lo, d_hi) -> np.ndarray:
    d_lo = np.asarray(d_lo, dtype=np.float32)
    span = np.maximum(np.asarray(d_hi, dtype=np.float32) - d_lo, MIN_RANGE)
    return (d - d_lo) / span


def balance_gammas(e: np.ndarray, strength: float) -> np.ndarray:
    """HEURISTIK (Auto-Farbbalance): Exponent je Kanal, der die Mediane der
    Mitteltöne angleicht. Endpunkte (0 und 1) bleiben fest. e: (N, 3)."""
    if strength <= 0 or e.shape[-1] != 3:
        return np.ones(3)
    mid = np.all((e > 0.1) & (e < 0.9), axis=-1)
    if mid.sum() < 100:
        return np.ones(3)
    med = np.median(e[mid], axis=0)
    target = float(np.exp(np.mean(np.log(med))))
    g = np.log(target) / np.log(med)
    g = np.clip(g, 0.7, 1.4)
    return np.power(g, strength)


def apply_balance(e: np.ndarray, gammas) -> np.ndarray:
    g = np.asarray(gammas, dtype=np.float32)
    if np.allclose(g, 1.0):
        return e
    pos = np.maximum(e, 0.0)
    return np.where(e > 0, np.power(pos, g), e).astype(np.float32)


def to_scene_linear(e: np.ndarray, r: float, flare: float = 1.0) -> np.ndarray:
    """Normierte Dichte -> szenenlineares Licht.
    L = 10^(R(e-1)); anschließend wird der Restschwarzwert 10^-R abgezogen
    (HEURISTIK, entspricht einer Streulicht-/Schwarzpunktkorrektur), sodass
    der Schwarzpunkt auf 0 und der Weißpunkt auf 1 fällt."""
    lin = np.power(np.float32(10.0), np.float32(r) * (e - np.float32(1.0)))
    floor = flare * 10.0 ** (-r)
    return ((lin - floor) / (1.0 - floor)).astype(np.float32)


def slide_levels(lum: np.ndarray, black_clip: float, white_clip: float) -> tuple[float, float]:
    lo = float(np.percentile(lum, black_clip))
    hi = float(np.percentile(lum, 100.0 - white_clip))
    if hi - lo < 1e-4:
        hi = lo + 1e-4
    return lo, hi
