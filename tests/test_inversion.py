"""Korrektheit der Negativumkehr an synthetischen Negativen mit bekannter Szene."""
import numpy as np
import pytest

from conftest import analyzed, gray_patches
from filmlab.imaging import inversion, pipeline
from filmlab.imaging.synthetic import FilmModel, ScanModel, make_negative

STEPS = np.geomspace(0.02, 0.9, 12)


def test_exact_inversion_of_linear_film_model():
    """Für ein ideales (lineares) Filmmodell ist die Umkehr exakt: das
    szenenlineare Ergebnis entspricht der Szenenbelichtung (bis auf den
    dokumentierten Schwarzpunktabzug)."""
    film = FilmModel()
    neg = make_negative(300, 450, film=film)
    s = analyzed(neg.negative, film_gamma=float(np.mean(film.gamma)), black_clip=0.0, white_clip=0.0)
    lin = pipeline.scene_linear(neg.negative, s, s.analysis)
    patches = gray_patches(neg, lin)
    floor = STEPS[0] / STEPS[-1]
    expected = (STEPS / STEPS[-1] - floor) / (1 - floor)
    np.testing.assert_allclose(patches, np.repeat(expected[:, None], 3, axis=1), atol=2e-4)


def test_gray_scale_stays_neutral_with_different_layer_gammas():
    neg = make_negative(300, 450, film=FilmModel(gamma=(0.50, 0.62, 0.75)))
    s = analyzed(neg.negative)
    patches = gray_patches(neg, pipeline.scene_linear(neg.negative, s, s.analysis))[2:]  # ohne Schwarz
    ratios = patches / patches.mean(axis=1, keepdims=True)
    assert np.max(np.abs(ratios - 1)) < 0.01


@pytest.mark.parametrize("light,d_min", [
    ((1.0, 1.0, 1.0), (0.25, 0.62, 0.95)),
    ((2.0, 1.2, 0.7), (0.25, 0.62, 0.95)),     # andere Lichtquelle / Weißabgleich
    ((1.5, 1.5, 1.5), (0.40, 0.80, 1.10)),     # dichtere Orangemaske
    ((0.6, 0.8, 1.9), (0.10, 0.30, 0.50)),     # schwache Maske, blaues Licht
])
def test_result_independent_of_mask_and_light(light, d_min):
    """Orangemaske und kanalweise Lichtfaktoren k_c kürzen sich physikalisch
    heraus – das Positiv muss identisch sein."""
    ref_neg = make_negative(240, 360)
    ref = analyzed(ref_neg.negative)
    ref_lin = pipeline.scene_linear(ref_neg.negative, ref, ref.analysis)

    neg = make_negative(240, 360, film=FilmModel(d_min=d_min), scan=ScanModel(light=light))
    assert neg.negative.max() < 1.0, "Testaufbau: kein Clipping"
    s = analyzed(neg.negative)
    lin = pipeline.scene_linear(neg.negative, s, s.analysis)
    x0, y0, x1, y1 = neg.frame
    np.testing.assert_allclose(lin[y0:y1, x0:x1], ref_lin[y0:y1, x0:x1], atol=2e-4)


def test_mask_compensation_uses_measured_base(negative):
    s = analyzed(negative.negative)
    np.testing.assert_allclose(s.analysis.base_rgb, negative.base_rgb, rtol=1e-4)
    # Dichte des Filmrands relativ zur Basis ist 0
    d = inversion.density(negative.negative[5:10, 40:60], np.asarray(s.analysis.base_rgb))
    assert np.abs(d).max() < 1e-3


def test_base_mode_neutral_shadows_from_mask():
    """Filmgrund-referenzierte Normierung: der Schwarzpunkt ist für alle
    Kanäle gleich (Schatten-Balance aus der Maske)."""
    neg = make_negative(240, 360)
    s = analyzed(neg.negative, normalization="base")
    assert len(set(np.round(s.analysis.d_lo, 9))) == 1


def test_density_numerically_stable():
    base = np.array([0.5, 0.3, 0.1], dtype=np.float32)
    img = np.array([[[0.0, 0.0, 0.0], [1e-12, 1e-9, 1e-7], [0.5, 0.3, 0.1], [1.0, 1.0, 1.0]]], dtype=np.float32)
    d = inversion.density(img, base)
    assert np.all(np.isfinite(d))
    assert d.max() <= inversion.DENSITY_MAX + 1e-6
    np.testing.assert_allclose(d[0, 2], 0.0, atol=1e-6)
    assert np.all(d[0, 3] < 0)  # heller als Filmgrund -> negative Dichte (nicht NaN)


def test_scene_linear_no_nan_with_degenerate_input():
    img = np.zeros((50, 60, 3), np.float32)
    img[:, :, 0] = 0.4
    s = analyzed(img)
    lin = pipeline.scene_linear(img, s, s.analysis)
    assert np.all(np.isfinite(lin))
    out = pipeline.finish(lin, s)
    assert np.all(np.isfinite(out)) and out.min() >= 0 and out.max() <= 1


def test_bw_negative_produces_gray():
    neg = make_negative(240, 360)
    s = analyzed(neg.negative, film_type="bw_negative")
    out = pipeline.render(neg.negative, s)
    assert np.allclose(out[..., 0], out[..., 1], atol=1e-6) and np.allclose(out[..., 1], out[..., 2], atol=1e-6)
    patches = gray_patches(neg, out)[:, 0]
    assert np.all(np.diff(patches) > 0), "Graustufen müssen monoton heller werden"


def test_slide_positive_workflow_keeps_order_and_neutrality():
    neg = make_negative(240, 360, border=0.0)
    pos = neg.scene * 0.8                    # Dia: Transmission ~ Szene
    s = analyzed(pos, film_type="slide")
    patches = gray_patches(neg, pipeline.render(pos, s))
    assert np.all(np.diff(patches.mean(axis=1)) > 0)
    assert np.max(np.ptp(patches, axis=1)) < 2e-3


def test_auto_color_balance_aligns_midtone_medians():
    e = np.random.default_rng(0).uniform(0.2, 0.8, (5000, 3)).astype(np.float32)
    e[:, 2] = e[:, 2] ** 1.2
    g = inversion.balance_gammas(e, 1.0)
    out = inversion.apply_balance(e, g)
    med = np.median(out, axis=0)
    assert np.ptp(med) < 0.01
    assert np.allclose(inversion.balance_gammas(e, 0.0), 1.0)
