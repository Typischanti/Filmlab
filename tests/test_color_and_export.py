"""Farbmanagement (Matrizen, Transferfunktionen, ICC gegen LittleCMS) und Export."""
import io

import cv2
import numpy as np
import pytest
import tifffile
from PIL import Image, ImageCms

from filmlab.core import colorspace as cs
from filmlab.core.icc import icc_profile_bytes
from filmlab.imaging.export import ExportOptions, quantize, save_image, write_png


@pytest.mark.parametrize("space", list(cs.SPACES))
def test_transfer_roundtrip(space):
    x = np.linspace(0, 1, 4097, dtype=np.float32)
    np.testing.assert_allclose(cs.decode(cs.encode(x, space), space), x, atol=2e-6)


@pytest.mark.parametrize("a,b", [("srgb", "prophoto"), ("adobe_rgb", "rec2020"), ("prophoto", "linear_rec2020")])
def test_matrix_roundtrip_and_white(a, b):
    m = cs.conversion_matrix(a, b)
    np.testing.assert_allclose(cs.conversion_matrix(b, a) @ m, np.eye(3), atol=1e-9)
    np.testing.assert_allclose(m @ np.ones(3), np.ones(3), atol=1e-4)  # Weiß bleibt Weiß


def test_srgb_matrix_matches_reference():
    # Referenz: IEC 61966-2-1 (gerundet)
    ref = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]])
    np.testing.assert_allclose(cs.SPACES["srgb"].to_xyz, ref, atol=2e-4)


@pytest.mark.parametrize("space", ["srgb", "adobe_rgb", "prophoto", "rec2020"])
def test_icc_profile_matches_littlecms(space):
    """Eigene ICC-Profile werden von LittleCMS gelesen und liefern dieselbe
    Transformation wie die interne Matrix-Pipeline."""
    srgb = ImageCms.createProfile("sRGB")
    prof = ImageCms.ImageCmsProfile(io.BytesIO(icc_profile_bytes(space)))
    img = np.random.default_rng(1).integers(0, 256, (32, 32, 3), dtype=np.uint8)
    t = ImageCms.buildTransform(srgb, prof, "RGB", "RGB", renderingIntent=1)
    lcms = np.asarray(ImageCms.applyTransform(Image.fromarray(img), t)).astype(float)
    lin = cs.apply_matrix(cs.decode(img / 255.0, "srgb"), cs.conversion_matrix("srgb", space))
    ours = np.clip(cs.encode(np.clip(lin, 0, 1), space), 0, 1) * 255
    assert np.abs(lcms - ours).max() <= 1.5


def test_gamut_compress_preserves_luminance_and_removes_negatives():
    w = cs.luminance_weights("srgb")
    x = np.array([[[-0.2, 0.5, 0.3], [0.1, 0.2, 0.3]]], dtype=np.float32)
    y = cs.gamut_compress(x, w)
    assert y.min() >= -1e-6
    np.testing.assert_allclose(y @ w, x @ w, atol=1e-6)
    np.testing.assert_allclose(y[0, 1], x[0, 1])


def test_16bit_quantization_precision():
    x = np.linspace(0, 1, 65536, dtype=np.float32)[None, :, None].repeat(3, axis=2)
    q = quantize(x, 16)
    assert q.dtype == np.uint16
    assert len(np.unique(q[..., 0])) == 65536  # keine Tonwertabrisse durch Quantisierung


def test_8bit_dither_is_deterministic_and_unbiased():
    x = np.full((64, 64, 3), 0.5 / 255 + 100 / 255, dtype=np.float32)
    a, b = quantize(x, 8, dither=True), quantize(x, 8, dither=True)
    assert np.array_equal(a, b)
    assert abs(a.mean() - 100.5) < 0.1


def test_tiff16_roundtrip_with_icc(tmp_path):
    img = np.random.default_rng(2).random((40, 50, 3)).astype(np.float32)
    p = tmp_path / "out.tif"
    save_image(img, p, ExportOptions(fmt="tiff16", output_space="adobe_rgb"))
    with tifffile.TiffFile(p) as t:
        data = t.pages[0].asarray()
        icc = t.pages[0].tags["InterColorProfile"].value
    assert data.dtype == np.uint16 and data.shape == (40, 50, 3)
    np.testing.assert_array_equal(data, quantize(img, 16))
    assert bytes(icc) == icc_profile_bytes("adobe_rgb")


def test_png16_and_png8(tmp_path):
    img = np.random.default_rng(3).random((30, 20, 3)).astype(np.float32)
    p16 = tmp_path / "a.png"
    save_image(img, p16, ExportOptions(fmt="png16"))
    back = cv2.imread(str(p16), cv2.IMREAD_UNCHANGED)[..., ::-1]
    assert back.dtype == np.uint16
    np.testing.assert_array_equal(back, quantize(img, 16))
    p8 = tmp_path / "b.png"
    save_image(img, p8, ExportOptions(fmt="png8"))
    with Image.open(p8) as im:
        assert im.mode == "RGB" and "icc_profile" in im.info
        assert im.info["icc_profile"] == icc_profile_bytes("srgb")


def test_jpeg_quality_and_icc(tmp_path):
    img = np.random.default_rng(4).random((64, 64, 3)).astype(np.float32)
    lo, hi = tmp_path / "lo.jpg", tmp_path / "hi.jpg"
    save_image(img, lo, ExportOptions(fmt="jpeg", jpeg_quality=30))
    save_image(img, hi, ExportOptions(fmt="jpeg", jpeg_quality=98, output_space="prophoto"))
    assert lo.stat().st_size < hi.stat().st_size
    with Image.open(hi) as im:
        assert im.info.get("icc_profile") == icc_profile_bytes("prophoto")


def test_no_partial_file_on_error(tmp_path):
    out = tmp_path / "out"
    with pytest.raises(Exception):
        save_image(np.zeros((4, 4, 3), np.float32), out / "x.bin", ExportOptions(fmt="nope"))
    assert list(out.iterdir()) == []


def test_png_writer_rejects_gray(tmp_path):
    with pytest.raises(Exception):
        write_png(tmp_path / "g.png", np.zeros((4, 4), np.uint8))
