"""Export: TIFF 16 Bit, JPEG (8 Bit, Qualitätsregelung), PNG 8/16 Bit.

Quantisierung erfolgt erst ganz am Ende aus float32. Bei 8-Bit-Ausgaben
wird mit deterministischem TPDF-Rauschen (±1 LSB) gedithert, um Banding in
weichen Verläufen zu vermeiden. Allen Dateien wird das ICC-Profil des
Ausgabefarbraums eingebettet.
"""
from __future__ import annotations

import os
import struct
import zlib
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from ..core.icc import icc_profile_bytes
from ..core.settings import EditSettings
from . import pipeline

FORMATS = {"tiff16": "TIFF 16 Bit", "jpeg": "JPEG", "png16": "PNG 16 Bit", "png8": "PNG 8 Bit", "tiff8": "TIFF 8 Bit"}
EXTENSIONS = {"tiff16": ".tif", "tiff8": ".tif", "jpeg": ".jpg", "png16": ".png", "png8": ".png"}


class ExportError(Exception):
    pass


@dataclass
class ExportOptions:
    fmt: str = "tiff16"
    output_space: str = "srgb"
    jpeg_quality: int = 95
    tiff_compression: str = "zlib"   # zlib | none
    dither: bool = True
    max_dim: int | None = None       # optionale Verkleinerung (lange Kante)


def quantize(img: np.ndarray, bits: int, dither: bool = True, seed: int = 0) -> np.ndarray:
    maxv = (1 << bits) - 1
    x = np.clip(img, 0.0, 1.0).astype(np.float32) * maxv
    if dither and bits == 8:
        rng = np.random.default_rng(seed)
        x = x + (rng.random(x.shape, dtype=np.float32) - rng.random(x.shape, dtype=np.float32))
    x = np.clip(np.rint(x), 0, maxv)
    return x.astype(np.uint8 if bits == 8 else np.uint16)


def write_tiff(path: str | os.PathLike, arr: np.ndarray, icc: bytes, compression: str = "zlib") -> None:
    import tifffile

    kwargs = {}
    if compression == "zlib":
        kwargs["compression"] = "zlib"
        kwargs["predictor"] = True
    tifffile.imwrite(str(path), arr, photometric="rgb", iccprofile=icc, metadata=None,
                     software="FilmLab", **kwargs)


def write_png(path: str | os.PathLike, arr: np.ndarray, icc: bytes | None = None) -> None:
    """Minimaler, standardkonformer PNG-Writer (RGB, 8 oder 16 Bit, iCCP)."""
    if arr.ndim != 3 or arr.shape[2] != 3:
        raise ExportError("PNG-Export erwartet RGB-Daten")
    h, w, _ = arr.shape
    bits = 16 if arr.dtype == np.uint16 else 8
    data = arr.astype(">u2" if bits == 16 else np.uint8)
    raw = np.empty((h, 1 + w * 3 * (bits // 8)), dtype=np.uint8)
    raw[:, 0] = 0  # Filter: none
    raw[:, 1:] = data.reshape(h, -1).view(np.uint8)

    def chunk(tag: bytes, payload: bytes) -> bytes:
        return struct.pack(">I", len(payload)) + tag + payload + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)

    out = b"\x89PNG\r\n\x1a\n"
    out += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, bits, 2, 0, 0, 0))
    if icc:
        out += chunk(b"iCCP", b"ICC Profile\0\0" + zlib.compress(icc))
    out += chunk(b"IDAT", zlib.compress(raw.tobytes(), 6))
    out += chunk(b"IEND", b"")
    Path(path).write_bytes(out)


def write_jpeg(path: str | os.PathLike, arr: np.ndarray, icc: bytes, quality: int) -> None:
    from PIL import Image

    Image.fromarray(arr, "RGB").save(str(path), "JPEG", quality=int(np.clip(quality, 1, 100)), subsampling=0,
                                     optimize=True, icc_profile=icc)


def save_image(img: np.ndarray, path: str | os.PathLike, opts: ExportOptions) -> None:
    """Speichert ein kodiertes float32-Bild (0..1)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    icc = icc_profile_bytes(opts.output_space)
    tmp = path.with_name(path.name + ".part")
    try:
        if opts.fmt == "tiff16":
            write_tiff(tmp, quantize(img, 16), icc, opts.tiff_compression)
        elif opts.fmt == "tiff8":
            write_tiff(tmp, quantize(img, 8, opts.dither), icc, opts.tiff_compression)
        elif opts.fmt == "png16":
            write_png(tmp, quantize(img, 16), icc)
        elif opts.fmt == "png8":
            write_png(tmp, quantize(img, 8, opts.dither), icc)
        elif opts.fmt == "jpeg":
            write_jpeg(tmp, quantize(img, 8, opts.dither), icc, opts.jpeg_quality)
        else:
            raise ExportError(f"Unbekanntes Format {opts.fmt}")
        os.replace(tmp, path)  # atomar: keine halbfertigen Dateien
    finally:
        if tmp.exists():
            tmp.unlink()


def render_full(full: np.ndarray, s: EditSettings, opts: ExportOptions) -> np.ndarray:
    if s.analysis.base_rgb is None and s.film_type != "slide":
        raise ExportError("Keine Analyse vorhanden – Bild zuerst analysieren.")
    img = full
    scale = 1.0
    if opts.max_dim:
        from .loader import make_proxy

        img = make_proxy(full, opts.max_dim)
        scale = img.shape[1] / full.shape[1]
    return pipeline.render(img, s, scale=scale, output_space=opts.output_space)


def export_image(full: np.ndarray, s: EditSettings, path: str | os.PathLike, opts: ExportOptions) -> Path:
    out = render_full(full, s, opts)
    save_image(out, path, opts)
    return Path(path)
