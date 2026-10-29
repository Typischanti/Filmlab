"""Geometrische Transformationen: 90°-Rotation, Spiegelung, Feinrotation, Zuschnitt.

Alle Koordinaten (Zuschnitt, Messbereiche) sind auf die Bildgröße normiert,
damit sie für Vorschau-Proxy und volle Auflösung identisch gelten.
"""
from __future__ import annotations

import cv2
import numpy as np

from ..core.settings import Geometry


def orient(img: np.ndarray, geom: Geometry) -> np.ndarray:
    k = (geom.rotation // 90) % 4
    out = np.rot90(img, k=-k) if k else img
    if geom.flip_h:
        out = out[:, ::-1]
    if geom.flip_v:
        out = out[::-1]
    if abs(geom.angle) > 1e-6:
        out = rotate_fine(out, geom.angle)
    return np.ascontiguousarray(out)


def rotate_fine(img: np.ndarray, angle_deg: float) -> np.ndarray:
    h, w = img.shape[:2]
    m = cv2.getRotationMatrix2D(((w - 1) / 2.0, (h - 1) / 2.0), -angle_deg, 1.0)
    out = cv2.warpAffine(img, m, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    return np.maximum(out, 0.0) if out.dtype.kind == "f" else out


def crop_box(shape: tuple[int, int], rect: list[float] | None) -> tuple[int, int, int, int]:
    h, w = shape[:2]
    if not rect:
        return 0, 0, w, h
    x0, y0, x1, y1 = rect
    x0, x1 = sorted((min(max(x0, 0.0), 1.0), min(max(x1, 0.0), 1.0)))
    y0, y1 = sorted((min(max(y0, 0.0), 1.0), min(max(y1, 0.0), 1.0)))
    ix0, iy0 = int(round(x0 * w)), int(round(y0 * h))
    ix1, iy1 = max(ix0 + 1, int(round(x1 * w))), max(iy0 + 1, int(round(y1 * h)))
    return ix0, iy0, min(ix1, w), min(iy1, h)


def crop(img: np.ndarray, rect: list[float] | None) -> np.ndarray:
    x0, y0, x1, y1 = crop_box(img.shape, rect)
    return img[y0:y1, x0:x1]


def apply_geometry(img: np.ndarray, geom: Geometry, with_crop: bool = True) -> np.ndarray:
    out = orient(img, geom)
    if with_crop:
        out = crop(out, geom.crop)
    return out


def inset(rect: list[float] | None, fraction: float) -> list[float]:
    """Verkleinert einen normierten Bereich an allen Seiten um ``fraction``
    seiner Größe (z.B. um Filmränder aus der Tonwertanalyse auszuschließen)."""
    x0, y0, x1, y1 = rect or [0.0, 0.0, 1.0, 1.0]
    dx, dy = (x1 - x0) * fraction, (y1 - y0) * fraction
    return [x0 + dx, y0 + dy, x1 - dx, y1 - dy]
