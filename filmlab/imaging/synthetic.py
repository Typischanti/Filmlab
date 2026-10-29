"""Synthetische Negative mit bekanntem Szeneninhalt (für Tests und Demo).

Filmmodell: D_c = D_min,c + gamma_c * (log10(H_c) - log10(H_ref)) + D_fog
Scanmodell:  S_c = k_c * 10^(-D_c) (+ Rauschen)

Da der Szeneninhalt H bekannt ist, lässt sich die Korrektheit der Umkehrung
quantitativ prüfen.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np


@dataclass
class FilmModel:
    d_min: tuple[float, float, float] = (0.25, 0.62, 0.95)    # Träger + Orangemaske (R, G, B)
    gamma: tuple[float, float, float] = (0.55, 0.62, 0.68)    # kanalweise Gradation
    h_ref: float = 0.01                                        # Belichtung bei Dichte = D_min + fog
    fog: float = 0.12
    toe: float = 0.0                                           # 0 = rein linearer Kurvenverlauf


@dataclass
class ScanModel:
    light: tuple[float, float, float] = (1.55, 1.6, 1.7)      # k_c: Lichtquelle * Sensor * Belichtung
    noise: float = 0.0
    seed: int = 1


@dataclass
class SyntheticNegative:
    negative: np.ndarray            # linearer Scan (HxWx3)
    scene: np.ndarray               # Szenenbelichtung H im Bildbereich (HxWx3, 0 im Rand)
    frame: tuple[int, int, int, int]  # x0, y0, x1, y1 des Bildbereichs
    base_rgb: np.ndarray            # exakter Filmgrund-Messwert
    film: FilmModel = field(default_factory=FilmModel)
    scan: ScanModel = field(default_factory=ScanModel)


def test_scene(h: int, w: int) -> np.ndarray:
    """Szene mit neutraler Graustufenleiste, Farbfeldern und Verläufen.
    Werte sind Belichtungen H (linear), Bereich ca. 0.02 .. 1.0."""
    scene = np.zeros((h, w, 3), dtype=np.float64)
    # Hintergrund: weicher Verlauf (Himmel -> Boden)
    yy, xx = np.mgrid[0:h, 0:w] / np.array([h, w])[:, None, None]
    scene[..., 0] = 0.18 * (0.6 + 0.8 * xx)
    scene[..., 1] = 0.18 * (0.7 + 0.6 * (1 - yy))
    scene[..., 2] = 0.18 * (0.5 + 0.9 * (1 - yy))
    # Graustufenleiste oben: 0.02 .. 0.9 (log-gleichabständig)
    steps = np.geomspace(0.02, 0.9, 12)
    bh = h // 5
    for i, v in enumerate(steps):
        x0, x1 = i * w // 12, (i + 1) * w // 12
        scene[:bh, x0:x1] = v
    # Farbfelder unten
    colors = [
        (0.40, 0.25, 0.18), (0.12, 0.30, 0.10), (0.10, 0.14, 0.40), (0.55, 0.45, 0.10),
        (0.45, 0.12, 0.12), (0.12, 0.35, 0.40), (0.35, 0.20, 0.40), (0.60, 0.48, 0.38),
    ]
    for i, c in enumerate(colors):
        x0, x1 = i * w // 8, (i + 1) * w // 8
        scene[h - bh:, x0:x1] = c
    return np.clip(scene, 0.02, 1.0)


def expose_film(scene: np.ndarray, film: FilmModel) -> np.ndarray:
    logh = np.log10(np.maximum(scene, 1e-6) / film.h_ref)
    if film.toe > 0:
        # weicher Fuß: softplus im Log-Raum
        logh = film.toe * np.log10(1 + 10 ** (logh / film.toe))
    return np.asarray(film.d_min) + film.fog + np.asarray(film.gamma) * logh


def make_negative(h: int = 400, w: int = 600, border: float = 0.07, film: FilmModel | None = None,
                  scan: ScanModel | None = None, sprockets: bool = False, scene: np.ndarray | None = None
                  ) -> SyntheticNegative:
    film = film or FilmModel()
    scan = scan or ScanModel()
    by, bx = int(h * border), int(w * border)
    frame = (bx, by, w - bx, h - by)
    fh, fw = frame[3] - frame[1], frame[2] - frame[0]
    sc = test_scene(fh, fw) if scene is None else scene
    density = np.empty((h, w, 3), dtype=np.float64)
    density[...] = np.asarray(film.d_min) + film.fog          # unbelichteter Rand
    density[frame[1]:frame[3], frame[0]:frame[2]] = expose_film(sc, film)
    k = np.asarray(scan.light)
    neg = k * 10.0 ** (-density)
    if sprockets:
        hole_w, hole_h = max(2, w // 40), max(2, by // 2)
        for x in range(w // 20, w, w // 10):
            neg[by // 4: by // 4 + hole_h, x: x + hole_w] = np.minimum(k, 1.0)
            neg[h - by // 4 - hole_h: h - by // 4, x: x + hole_w] = np.minimum(k, 1.0)
    if scan.noise > 0:
        rng = np.random.default_rng(scan.seed)
        neg = neg * (1 + rng.normal(0, scan.noise, neg.shape)) + rng.normal(0, scan.noise * 0.05, neg.shape)
    neg = np.clip(neg, 0.0, 1.0).astype(np.float32)
    full_scene = np.zeros((h, w, 3), dtype=np.float32)
    full_scene[frame[1]:frame[3], frame[0]:frame[2]] = sc
    base_rgb = k * 10.0 ** (-(np.asarray(film.d_min) + film.fog))
    return SyntheticNegative(neg, full_scene, frame, base_rgb, film, scan)


def write_dng(path, linear_rgb: np.ndarray, black: int = 512, white: int = 16383) -> None:
    """Schreibt ein lineares RGB-Bild als Bayer-DNG (RGGB) zum Testen des
    RAW-Pfads (LibRaw). Kamerafarbraum = lineares sRGB (ColorMatrix1 = XYZ->sRGB)."""
    import tifffile

    h, w = linear_rgb.shape[:2]
    h, w = h - h % 2, w - w % 2
    lin = np.clip(linear_rgb[:h, :w], 0.0, 1.0)
    cfa = np.empty((h, w), np.float64)
    cfa[0::2, 0::2] = lin[0::2, 0::2, 0]
    cfa[0::2, 1::2] = lin[0::2, 1::2, 1]
    cfa[1::2, 0::2] = lin[1::2, 0::2, 1]
    cfa[1::2, 1::2] = lin[1::2, 1::2, 2]
    raw = np.round(black + cfa * (white - black)).astype(np.uint16)
    xyz_to_srgb = np.array([[3.2406, -1.5372, -0.4986], [-0.9689, 1.8758, 0.0415], [0.0557, -0.2040, 1.0570]])
    cm: list[int] = []
    for v in xyz_to_srgb.ravel():
        cm += [int(round(v * 10000)), 10000]
    extratags = [
        (50706, "B", 4, (1, 4, 0, 0), True),          # DNGVersion
        (50708, "s", 0, "FilmLab Synthetic", True),    # UniqueCameraModel
        (33421, "H", 2, (2, 2), True),                 # CFARepeatPatternDim
        (33422, "B", 4, (0, 1, 1, 2), True),           # CFAPattern RGGB
        (50714, "H", 1, black, True),                  # BlackLevel
        (50717, "H", 1, white, True),                  # WhiteLevel
        (50721, "2i", 9, cm, True),                    # ColorMatrix1
        (50778, "H", 1, 21, True),                     # CalibrationIlluminant1 = D65
        (50728, "2I", 3, [1, 1, 1, 1, 1, 1], True),    # AsShotNeutral
    ]
    tifffile.imwrite(str(path), raw, photometric=32803, subfiletype=0, extratags=extratags, metadata=None)


def make_strip_in_holder(h: int = 400, w: int = 600, film: FilmModel | None = None,
                         scan: ScanModel | None = None) -> SyntheticNegative:
    """Realistischer Kamera-Scan: Filmstreifen mit drei Bildern in einem
    schwarzen Filmhalter. Filmgrund ist nur an den Stegen zwischen den
    Bildern und an einem schmalen Filmrand sichtbar; links/rechts sind
    Nachbarbilder angeschnitten. ``frame`` bezeichnet das mittlere Bild."""
    film = film or FilmModel()
    scan = scan or ScanModel()
    k = np.asarray(scan.light)
    holder_h = int(h * 0.06)                     # schwarzer Halter oben/unten
    edge = int(h * 0.03)                         # unbelichteter Filmrand
    gap = int(w * 0.025)                         # Steg zwischen den Bildern
    fw = int(w * 0.62)
    x0 = (w - fw) // 2
    y0, y1 = holder_h + edge, h - holder_h - edge
    density = np.empty((h, w, 3))
    density[...] = np.asarray(film.d_min) + film.fog
    sc = test_scene(y1 - y0, fw)
    density[y0:y1, x0:x0 + fw] = expose_film(sc, film)
    # Nachbarbilder (andere, dunklere Szene)
    nb = expose_film(np.clip(test_scene(y1 - y0, fw)[:, ::-1] * 0.6, 0.02, 1), film)
    lw = x0 - gap
    density[y0:y1, :lw] = nb[:, fw - lw:]
    rx = x0 + fw + gap
    density[y0:y1, rx:] = nb[:, : w - rx]
    neg = k * 10.0 ** (-density)
    neg[:holder_h] = 0.004
    neg[h - holder_h:] = 0.004
    if scan.noise > 0:
        rng = np.random.default_rng(scan.seed)
        neg = neg * (1 + rng.normal(0, scan.noise, neg.shape))
    full_scene = np.zeros((h, w, 3), np.float32)
    full_scene[y0:y1, x0:x0 + fw] = sc
    return SyntheticNegative(np.clip(neg, 0, 1).astype(np.float32), full_scene, (x0, y0, x0 + fw, y1),
                             k * 10.0 ** (-(np.asarray(film.d_min) + film.fog)), film, scan)
