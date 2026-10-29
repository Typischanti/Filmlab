"""Schärfung und Rauschreduzierung (im wahrnehmungsnahen Bereich q).

Radien sind auf die volle Auflösung bezogen und werden mit ``scale`` (Breite
des gerenderten Bildes / volle Breite) skaliert, damit die verkleinerte
Vorschau dem verkleinerten Export entspricht.
"""
from __future__ import annotations

import cv2
import numpy as np

from . import fastops
from .tone import W_REC2020


def _blur(img: np.ndarray, sigma: float) -> np.ndarray:
    if sigma < 0.15:
        return img
    return cv2.GaussianBlur(img, (0, 0), sigmaX=sigma, sigmaY=sigma, borderType=cv2.BORDER_REFLECT)


def reduce_noise(q: np.ndarray, luma: float, chroma: float, scale: float, mono: bool = False) -> np.ndarray:
    if luma <= 0 and (chroma <= 0 or mono):
        return q
    y = fastops.transform(q, W_REC2020)
    out = q
    if chroma > 0 and not mono:
        c = (q - y[..., None]).astype(np.float32)
        sigma = chroma / 100.0 * 6.0 * scale
        out = y[..., None] + _blur(c, sigma)
    if luma > 0:
        sigma_space = (0.8 + luma / 100.0 * 4.0) * scale
        if sigma_space >= 0.3:
            sigma_color = 0.015 + luma / 100.0 * 0.07
            y32 = np.ascontiguousarray(y, dtype=np.float32)
            yf = cv2.bilateralFilter(y32, -1, sigma_color, sigma_space, borderType=cv2.BORDER_REFLECT)
            out = out + (yf - y32)[..., None]
    return out.astype(np.float32)


def sharpen(q: np.ndarray, amount: float, radius: float, scale: float) -> np.ndarray:
    """Unscharfmaskierung auf der Luminanz (keine Farbsäume)."""
    if amount <= 0:
        return q
    sigma = radius * scale
    if sigma < 0.2:
        return q
    y = fastops.transform(q, W_REC2020)
    detail = y - _blur(y, sigma)
    return (q + (amount / 100.0) * detail[..., None]).astype(np.float32)
