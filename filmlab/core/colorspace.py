"""RGB-Farbräume, Transferfunktionen und Matrix-Konvertierungen.

Alle internen Berechnungen laufen in *linearem Rec.2020* (D65) als float32.
Rec.2020 ist groß genug, damit die stark gesättigten Farben eines Negativs
(Orangemaske) nicht in negative Werte fallen, bevor die Dichte berechnet wird.

Die Konvertierung zwischen Farbräumen erfolgt über XYZ mit Bradford-Adaption
(D65 <-> D50 für ProPhoto). Die Matrizen werden aus den Primärvalenzen
berechnet, nicht hartcodiert, und in den Tests gegen LittleCMS geprüft.
"""
from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

import numpy as np

WHITE_D65 = (0.3127, 0.3290)
WHITE_D50 = (0.3457, 0.3585)
# ICC-PCS-Weißpunkt (D50) laut ICC.1 Spezifikation
PCS_D50_XYZ = np.array([0.9642, 1.0, 0.8249])

BRADFORD = np.array(
    [
        [0.8951, 0.2664, -0.1614],
        [-0.7502, 1.7135, 0.0367],
        [0.0389, -0.0685, 1.0296],
    ]
)


@dataclass(frozen=True)
class RGBColorSpace:
    key: str
    label: str
    primaries: tuple[tuple[float, float], tuple[float, float], tuple[float, float]]
    white: tuple[float, float]
    transfer: str  # "srgb" | "gamma" | "romm" | "bt2020" | "linear"
    gamma: float = 1.0

    @property
    def to_xyz(self) -> np.ndarray:
        return rgb_to_xyz_matrix(self.primaries, self.white)

    @property
    def white_xyz(self) -> np.ndarray:
        return xy_to_xyz(self.white)


SPACES: dict[str, RGBColorSpace] = {
    "srgb": RGBColorSpace(
        "srgb", "sRGB IEC61966-2.1",
        ((0.64, 0.33), (0.30, 0.60), (0.15, 0.06)), WHITE_D65, "srgb",
    ),
    "adobe_rgb": RGBColorSpace(
        "adobe_rgb", "Adobe RGB (1998) kompatibel",
        ((0.64, 0.33), (0.21, 0.71), (0.15, 0.06)), WHITE_D65, "gamma", 563 / 256,
    ),
    "prophoto": RGBColorSpace(
        "prophoto", "ProPhoto RGB (ROMM)",
        ((0.7347, 0.2653), (0.1596, 0.8404), (0.0366, 0.0001)), WHITE_D50, "romm", 1.8,
    ),
    "rec2020": RGBColorSpace(
        "rec2020", "Rec. ITU-R BT.2020",
        ((0.708, 0.292), (0.170, 0.797), (0.131, 0.046)), WHITE_D65, "bt2020",
    ),
    "linear_rec2020": RGBColorSpace(
        "linear_rec2020", "Rec. 2020 linear",
        ((0.708, 0.292), (0.170, 0.797), (0.131, 0.046)), WHITE_D65, "linear",
    ),
}

WORKING_SPACE = SPACES["linear_rec2020"]
OUTPUT_SPACES = ["srgb", "adobe_rgb", "prophoto", "rec2020", "linear_rec2020"]


def xy_to_xyz(xy: tuple[float, float]) -> np.ndarray:
    x, y = xy
    return np.array([x / y, 1.0, (1.0 - x - y) / y])


@lru_cache(maxsize=None)
def rgb_to_xyz_matrix(primaries, white) -> np.ndarray:
    p = np.column_stack([xy_to_xyz(c) for c in primaries])
    s = np.linalg.solve(p, xy_to_xyz(white))
    return p * s


def adaptation_matrix(src_white_xyz: np.ndarray, dst_white_xyz: np.ndarray) -> np.ndarray:
    """Bradford-Farbanpassung von src- auf dst-Weißpunkt (XYZ)."""
    src = BRADFORD @ src_white_xyz
    dst = BRADFORD @ dst_white_xyz
    return np.linalg.inv(BRADFORD) @ np.diag(dst / src) @ BRADFORD


def conversion_matrix(src: RGBColorSpace | str, dst: RGBColorSpace | str) -> np.ndarray:
    src = SPACES[src] if isinstance(src, str) else src
    dst = SPACES[dst] if isinstance(dst, str) else dst
    m = src.to_xyz
    if src.white != dst.white:
        m = adaptation_matrix(src.white_xyz, dst.white_xyz) @ m
    return np.linalg.inv(dst.to_xyz) @ m


def apply_matrix(img: np.ndarray, m: np.ndarray) -> np.ndarray:
    """Wendet eine 3x3-Matrix auf ein HxWx3-Bild an (float32)."""
    img = np.ascontiguousarray(img, dtype=np.float32)
    if np.allclose(m, np.eye(3), atol=1e-9):
        return img
    if img.ndim == 3 and img.shape[-1] == 3:
        import cv2

        return cv2.transform(img, np.asarray(m, dtype=np.float32))
    out = img.reshape(-1, 3) @ m.T.astype(np.float32)
    return out.reshape(img.shape).astype(np.float32, copy=False)


def _pow(x: np.ndarray, p: float) -> np.ndarray:
    import cv2

    x = np.ascontiguousarray(np.maximum(x, np.float32(0.0)), dtype=np.float32)
    if x.ndim <= 3 and (x.ndim < 3 or x.shape[-1] <= 4) and x.size:
        return cv2.pow(x, float(p))
    return np.power(x, np.float32(p))


def luminance_weights(space: RGBColorSpace | str = WORKING_SPACE) -> np.ndarray:
    space = SPACES[space] if isinstance(space, str) else space
    return space.to_xyz[1].astype(np.float32)


# ---------------------------------------------------------------------------
# Transferfunktionen (lineare Lichtwerte <-> kodierte Werte), jeweils 0..1
# ---------------------------------------------------------------------------

def encode(lin: np.ndarray, space: RGBColorSpace | str) -> np.ndarray:
    space = SPACES[space] if isinstance(space, str) else space
    x = np.asarray(lin, dtype=np.float32)
    t = space.transfer
    if t == "linear":
        return x.copy()
    if t == "srgb":
        return np.where(x <= 0.0031308, 12.92 * x,
                        1.055 * _pow(np.maximum(x, 0.0031308), 1 / 2.4) - 0.055).astype(np.float32)
    if t == "gamma":
        return (np.sign(x) * np.power(np.abs(x), 1.0 / space.gamma)).astype(np.float32)
    if t == "romm":
        et = 1.0 / 512.0
        return np.where(x < et, 16.0 * x, np.power(np.maximum(x, et), 1 / 1.8)).astype(np.float32)
    if t == "bt2020":
        a, b = 1.09929682680944, 0.018053968510807
        return np.where(x < b, 4.5 * x, a * np.power(np.maximum(x, b), 0.45) - (a - 1)).astype(np.float32)
    raise ValueError(f"Unbekannte Transferfunktion {t}")


def decode(enc: np.ndarray, space: RGBColorSpace | str) -> np.ndarray:
    space = SPACES[space] if isinstance(space, str) else space
    v = np.asarray(enc, dtype=np.float32)
    t = space.transfer
    if t == "linear":
        return v.copy()
    if t == "srgb":
        return np.where(v <= 0.04045, v / 12.92,
                        np.power((np.maximum(v, 0.04045) + 0.055) / 1.055, 2.4)).astype(np.float32)
    if t == "gamma":
        return (np.sign(v) * np.power(np.abs(v), space.gamma)).astype(np.float32)
    if t == "romm":
        return np.where(v < 16.0 / 512.0, v / 16.0, np.power(np.maximum(v, 16.0 / 512.0), 1.8)).astype(np.float32)
    if t == "bt2020":
        a, b = 1.09929682680944, 0.018053968510807
        return np.where(v < 4.5 * b, v / 4.5,
                        np.power((np.maximum(v, 4.5 * b) + (a - 1)) / a, 1 / 0.45)).astype(np.float32)
    raise ValueError(f"Unbekannte Transferfunktion {t}")


def gamut_compress(lin: np.ndarray, weights: np.ndarray) -> np.ndarray:
    """Bringt negative Komponenten (außerhalb des Zielgamuts) durch Entsättigung
    in Richtung Luminanz zurück, statt hart zu clippen. Luminanz bleibt erhalten."""
    mn = np.minimum(np.minimum(lin[..., 0], lin[..., 1]), lin[..., 2])
    neg = mn < 0
    if lin.ndim != 3:
        neg_rows = slice(None) if neg.any() else None
    else:
        idx = np.flatnonzero(neg.any(axis=1))
        neg_rows = idx if idx.size else None
    if neg_rows is None:
        return lin
    import cv2

    out = lin.copy()
    sub = np.ascontiguousarray(out[neg_rows], dtype=np.float32)   # nur betroffene Zeilen
    m = mn[neg_rows][..., None]
    y = cv2.transform(sub, np.asarray(weights, dtype=np.float32)[None, :]).reshape(m.shape)
    np.maximum(y, 0.0, out=y)
    # t = 1 im Gamut, sonst y / (y - min): Entsättigung genau bis min = 0
    t = np.where(m < 0, y / np.maximum(y - m, np.float32(1e-12)), np.float32(1.0)).astype(np.float32)
    sub -= y
    sub *= t
    sub += y
    out[neg_rows] = sub
    return out
