"""Schnelle elementweise Operationen auf float32-Bildern (OpenCV, SIMD und
mehrere Threads). Alle Funktionen haben numerisch äquivalente NumPy-Fallbacks
und arbeiten durchgehend in float32 (keine Ganzzahl-Zwischenschritte)."""
from __future__ import annotations

import cv2
import numpy as np

_REMAP_LIMIT = 32000  # cv2.remap: Kartengröße < SHRT_MAX


def f32(img: np.ndarray) -> np.ndarray:
    return np.ascontiguousarray(img, dtype=np.float32)


def cmin(img: np.ndarray) -> np.ndarray:
    """Minimum über die Kanalachse (deutlich schneller als img.min(axis=-1))."""
    return np.minimum(np.minimum(img[..., 0], img[..., 1]), img[..., 2])


def cmax(img: np.ndarray) -> np.ndarray:
    return np.maximum(np.maximum(img[..., 0], img[..., 1]), img[..., 2])


def power(x: np.ndarray, p: float) -> np.ndarray:
    """max(x, 0) ** p"""
    return cv2.pow(np.maximum(f32(x), np.float32(0.0)), float(p))


def transform(img: np.ndarray, m: np.ndarray) -> np.ndarray:
    """Farbmatrix (3x3) bzw. Gewichtsvektor (1x3) auf ein HxWx3-Bild."""
    m = np.asarray(m, dtype=np.float32)
    if m.ndim == 1:
        m = m[None, :]
    img = f32(img)
    if img.ndim == 3 and img.shape[0] * img.shape[1] > 0:
        try:
            return cv2.transform(img, m)
        except cv2.error:
            pass
    out = img.reshape(-1, 3) @ m.T
    return out.reshape(img.shape[:-1] + ((m.shape[0],) if m.shape[0] > 1 else ())).astype(np.float32)


def lut1d(x: np.ndarray, lut: np.ndarray, xmax: float) -> np.ndarray:
    """Lineare Interpolation einer gleichabständigen Tabelle lut über [0, xmax]
    an den Stellen x (einkanalig). Werte außerhalb werden an den Rand geklemmt."""
    x = f32(x)
    n = lut.size
    pos = x * np.float32((n - 1) / xmax)
    if x.ndim == 2 and max(x.shape) < _REMAP_LIMIT:
        mapy = np.zeros_like(pos)
        return cv2.remap(f32(lut)[None, :], pos, mapy, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    pos = np.clip(pos, 0.0, n - 1.000001)
    i = pos.astype(np.int32)
    f = pos - i
    return lut[i] * (1.0 - f) + lut[i + 1] * f


def lut3(img: np.ndarray, luts: np.ndarray, xmax: float) -> np.ndarray:
    """Kanalweise 1D-LUTs (3 x N) auf ein HxWx3-Bild."""
    chans = cv2.split(f32(img)) if img.ndim == 3 else [img[..., c] for c in range(3)]
    return cv2.merge([lut1d(c, luts[i], xmax) for i, c in enumerate(chans)])


_MAPY_CACHE: dict[tuple, np.ndarray] = {}


def _channel_rows(h: int, w: int, c: int, shared: bool) -> np.ndarray:
    key = (h, w, c, shared)
    m = _MAPY_CACHE.get(key)
    if m is None:
        row = np.zeros(w * c, np.float32) if shared else np.tile(np.arange(c, dtype=np.float32), w)
        m = np.ascontiguousarray(np.broadcast_to(row, (h, w * c)))
        if len(_MAPY_CACHE) > 8:
            _MAPY_CACHE.clear()
        _MAPY_CACHE[key] = m
    return m


def lut_channels(img: np.ndarray, luts: np.ndarray, xmax: float, prescale=None) -> np.ndarray:
    """Kanalweise 1D-LUTs (C x N, gleichabständig über [0, xmax]) auf ein
    HxWxC-Bild in EINEM cv2.remap-Aufruf: das Bild wird als (H, W*C)-Karte
    gelesen, die Zeile der LUT-Tabelle wählt den Kanal. ``prescale`` (je
    Kanal) skaliert die Eingangswerte vor dem Nachschlagen."""
    img = f32(img)
    h, w, c = img.shape
    luts = f32(np.atleast_2d(luts))
    shared = luts.shape[0] == 1
    factor = np.float32((luts.shape[1] - 1) / xmax)
    if prescale is not None:
        factor = (np.asarray(prescale, dtype=np.float32) * factor).astype(np.float32)
    mapx = img * factor
    if w * c < _REMAP_LIMIT and h < _REMAP_LIMIT:
        mapy = _channel_rows(h, w, c, shared)
        out = cv2.remap(luts, mapx.reshape(h, w * c), mapy, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        return out.reshape(h, w, c)
    # Fallback für sehr breite Bilder
    n = luts.shape[1]
    pos = np.clip(mapx, 0.0, n - 1.000001)
    i = pos.astype(np.int32)
    f = pos - i
    rows = np.zeros(c, np.int64) if shared else np.arange(c)
    flat = luts[rows]  # (C, N)
    out = np.empty_like(pos)
    for ch in range(c):
        l = flat[ch]
        out[..., ch] = l[i[..., ch]] * (1.0 - f[..., ch]) + l[i[..., ch] + 1] * f[..., ch]
    return out
