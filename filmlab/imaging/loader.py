"""Bildimport: RAW (LibRaw/rawpy), TIFF (tifffile), JPEG/PNG.

Ergebnis ist immer ein lineares float32-Bild im Arbeitsfarbraum
(lineares Rec.2020, D65), Werte relativ zur Sensor-/Dateisättigung (1.0).
Es gibt keine 8-Bit-Zwischenschritte: RAW wird mit 16 Bit linear dekodiert,
TIFF/PNG mit voller Bittiefe gelesen.
"""
from __future__ import annotations

import io
import os
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from ..core import colorspace as cs

RAW_EXTENSIONS = {
    ".dng", ".nef", ".nrw", ".cr2", ".cr3", ".crw", ".arw", ".srf", ".sr2", ".raf", ".orf",
    ".rw2", ".pef", ".srw", ".x3f", ".3fr", ".fff", ".iiq", ".mos", ".mrw", ".erf", ".kdc",
    ".dcr", ".rwl", ".raw",
}
TIFF_EXTENSIONS = {".tif", ".tiff"}
STD_EXTENSIONS = {".jpg", ".jpeg", ".png"}
SUPPORTED_EXTENSIONS = RAW_EXTENSIONS | TIFF_EXTENSIONS | STD_EXTENSIONS


class ImageLoadError(Exception):
    pass


@dataclass
class SourceImage:
    path: str
    data: np.ndarray                 # HxWx3 float32, linear Rec.2020
    kind: str                        # raw | tiff | jpeg | png | synthetic
    bit_depth: int
    encoding: str                    # angewandte Linearisierung
    clipped_fraction: float = 0.0    # Anteil gesättigter Pixel im Original
    metadata: dict = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)

    @property
    def source_id(self) -> str:
        try:
            st = os.stat(self.path)
            return f"{self.path}|{st.st_size}|{int(st.st_mtime)}"
        except OSError:
            return self.path

    @property
    def shape(self) -> tuple[int, int]:
        return self.data.shape[:2]


def is_supported(path: str | os.PathLike) -> bool:
    return Path(path).suffix.lower() in SUPPORTED_EXTENSIONS


def load_image(path: str | os.PathLike, input_encoding: str = "auto", half_size: bool = False) -> SourceImage:
    p = Path(path)
    if not p.is_file():
        raise ImageLoadError(f"Datei nicht gefunden: {p}")
    ext = p.suffix.lower()
    try:
        if ext in RAW_EXTENSIONS:
            return _load_raw(p, half_size=half_size)
        if ext in TIFF_EXTENSIONS:
            return _load_tiff(p, input_encoding)
        if ext in STD_EXTENSIONS:
            return _load_standard(p, input_encoding)
    except ImageLoadError:
        raise
    except Exception as exc:  # Bibliotheksfehler sauber verpacken
        raise ImageLoadError(f"{p.name}: {type(exc).__name__}: {exc}") from exc
    raise ImageLoadError(f"Nicht unterstütztes Format: {ext}")


# ---------------------------------------------------------------------------

def _load_raw(p: Path, half_size: bool = False) -> SourceImage:
    import rawpy

    with rawpy.imread(str(p)) as raw:
        # Lineare Dekodierung: gamma=(1,1), keine automatische Aufhellung,
        # 16 Bit, Tageslicht-Weißabgleich (LibRaw-Standard ohne camera_wb),
        # Highlight-Clip (hält die Daten linear), Ausgabe direkt in Rec.2020.
        # Der Weißabgleich ist für die Negativkonvertierung unkritisch, da er
        # als kanalweiser Faktor durch die Filmgrund-Normierung herausfällt.
        params = dict(
            gamma=(1, 1),
            no_auto_bright=True,
            output_bps=16,
            use_camera_wb=False,
            use_auto_wb=False,
            output_color=rawpy.ColorSpace.Rec2020,
            highlight_mode=rawpy.HighlightMode.Clip,
            demosaic_algorithm=rawpy.DemosaicAlgorithm.AHD,
            half_size=half_size,
        )
        try:
            rgb = raw.postprocess(**params)
        except Exception:
            params.pop("demosaic_algorithm")
            rgb = raw.postprocess(**params)
        meta = {
            "camera_wb": [float(v) for v in raw.camera_whitebalance],
            "black_level": [int(v) for v in raw.black_level_per_channel],
            "white_level": int(raw.white_level),
            "raw_type": str(raw.raw_type),
            "sizes": {"width": int(raw.sizes.width), "height": int(raw.sizes.height)},
        }
    data = rgb.astype(np.float32) / 65535.0
    clipped = float(np.mean(np.any(rgb >= 65530, axis=-1)))
    src = SourceImage(str(p), np.ascontiguousarray(data), "raw", 16, "linear (LibRaw)", clipped, meta)
    if clipped > 0.001:
        src.warnings.append(
            f"{clipped * 100:.2f}% der Pixel sind im RAW gesättigt. Falls der Filmgrund betroffen ist, "
            "ist die Maskenmessung unzuverlässig – Scan knapper belichten.")
    return src


def _to_float(arr: np.ndarray) -> tuple[np.ndarray, int]:
    if arr.dtype == np.uint8:
        return arr.astype(np.float32) / 255.0, 8
    if arr.dtype == np.uint16:
        return arr.astype(np.float32) / 65535.0, 16
    if arr.dtype in (np.float16, np.float32, np.float64):
        return arr.astype(np.float32), 32
    if arr.dtype == np.uint32:
        return (arr.astype(np.float64) / 4294967295.0).astype(np.float32), 32
    if arr.dtype == bool:
        return arr.astype(np.float32), 1
    raise ImageLoadError(f"Nicht unterstützter Datentyp {arr.dtype}")


def _to_rgb(arr: np.ndarray) -> np.ndarray:
    if arr.ndim == 2:
        return np.repeat(arr[..., None], 3, axis=-1)
    if arr.ndim == 3:
        if arr.shape[0] in (3, 4) and arr.shape[2] not in (3, 4):  # planar
            arr = np.moveaxis(arr, 0, -1)
        if arr.shape[2] == 1:
            return np.repeat(arr, 3, axis=-1)
        if arr.shape[2] == 2:  # Grau + Alpha
            return np.repeat(arr[..., :1], 3, axis=-1)
        if arr.shape[2] >= 3:
            return arr[..., :3]
    raise ImageLoadError(f"Nicht unterstützte Bildgeometrie {arr.shape}")


def _linearize(rgb: np.ndarray, encoding: str) -> np.ndarray:
    if encoding == "linear":
        lin = rgb
    else:
        lin = cs.decode(rgb, "srgb")
    return cs.apply_matrix(lin, cs.conversion_matrix("srgb", cs.WORKING_SPACE))


def _load_tiff(p: Path, input_encoding: str) -> SourceImage:
    import tifffile

    warnings: list[str] = []
    with tifffile.TiffFile(str(p)) as tif:
        page = tif.pages[0]
        arr = page.asarray()
        icc = page.tags.get("InterColorProfile")
        photometric = page.photometric
    if int(photometric) not in (0, 1, 2):  # MINISWHITE, MINISBLACK, RGB
        raise ImageLoadError(f"TIFF-Farbmodell {photometric!r} wird nicht unterstützt (nur RGB/Graustufen).")
    data, depth = _to_float(arr)
    if int(photometric) == 0:  # MINISWHITE
        data = 1.0 - data
    data = _to_rgb(data)
    encoding = input_encoding if input_encoding != "auto" else ("linear" if depth == 32 else "srgb")
    if icc is not None and encoding != "linear":
        warnings.append("Eingebettetes ICC-Profil wird nicht ausgewertet; sRGB-Kodierung wird angenommen.")
    src = SourceImage(str(p), np.ascontiguousarray(_linearize(data, encoding)), "tiff", depth,
                      encoding, float(np.mean(np.any(data >= 0.9995, axis=-1))), {}, warnings)
    return src


def _load_standard(p: Path, input_encoding: str) -> SourceImage:
    warnings: list[str] = []
    if p.suffix.lower() == ".png":
        import cv2

        arr = cv2.imread(str(p), cv2.IMREAD_UNCHANGED)
        if arr is None:
            raise ImageLoadError(f"PNG konnte nicht gelesen werden: {p.name}")
        if arr.ndim == 3:
            arr = arr[..., [2, 1, 0] + ([3] if arr.shape[2] == 4 else [])]
        kind = "png"
    else:
        from PIL import Image, ImageCms, ImageOps

        with Image.open(p) as im:
            im = ImageOps.exif_transpose(im)
            icc = im.info.get("icc_profile")
            if im.mode not in ("RGB", "L"):
                im = im.convert("RGB")
            if icc and im.mode == "RGB":
                try:
                    src_prof = ImageCms.ImageCmsProfile(io.BytesIO(icc))
                    im = ImageCms.profileToProfile(im, src_prof, ImageCms.createProfile("sRGB"),
                                                   renderingIntent=1, outputMode="RGB")
                except Exception:
                    warnings.append("Eingebettetes ICC-Profil konnte nicht angewendet werden; sRGB angenommen.")
            arr = np.asarray(im)
        kind = "jpeg"
    data, depth = _to_float(arr)
    data = _to_rgb(data)
    encoding = input_encoding if input_encoding != "auto" else "srgb"
    if depth == 8:
        warnings.append("8-Bit-Quelle: begrenzte Tonwertreserven für die Negativumkehr (Banding möglich).")
    return SourceImage(str(p), np.ascontiguousarray(_linearize(data, encoding)), kind, depth, encoding,
                       float(np.mean(np.any(data >= 0.999, axis=-1))), {}, warnings)


def make_proxy(data: np.ndarray, max_dim: int) -> np.ndarray:
    """Verkleinert flächengetreu (INTER_AREA) auf max_dim Pixel lange Kante."""
    import cv2

    h, w = data.shape[:2]
    scale = max_dim / max(h, w)
    if scale >= 1.0:
        return data
    size = (max(1, int(round(w * scale))), max(1, int(round(h * scale))))
    return cv2.resize(data, size, interpolation=cv2.INTER_AREA)
