"""Tonwertverarbeitung, Schwarz-/Weißpunkt, Clipping, Konsistenz Vorschau/Export."""
import cv2
import numpy as np
import pytest

from conftest import analyzed, gray_patches
from filmlab.core.settings import EditSettings
from filmlab.imaging import pipeline, tone
from filmlab.imaging.loader import make_proxy
from filmlab.imaging.synthetic import ScanModel, make_negative


def test_neutral_settings_are_identity_tone():
    """Mit neutralen Reglern und harter Schulter ist die Tonwertstufe die
    Identität: Ausgabe = kodiertes szenenlineares Licht."""
    s = EditSettings(highlight_rolloff=0.0)
    lin = np.random.default_rng(0).random((64, 64, 3)).astype(np.float32)
    out = pipeline.finish(lin, s, output_space="linear_rec2020")
    np.testing.assert_allclose(out, lin, atol=2e-4)


@pytest.mark.parametrize("seed", range(6))
def test_tone_lut_monotone_for_random_settings(seed):
    rng = np.random.default_rng(seed)
    s = EditSettings(contrast=rng.uniform(-100, 100), brightness=rng.uniform(-100, 100),
                     highlights=rng.uniform(-100, 100), shadows=rng.uniform(-100, 100),
                     black=rng.uniform(-100, 100), white=rng.uniform(-100, 100), gamma=rng.uniform(0.3, 3),
                     highlight_rolloff=rng.uniform(0, 1))
    s.curves["master"] = [[0, 0], [0.3, rng.uniform(0.1, 0.5)], [0.7, rng.uniform(0.5, 0.9)], [1, 1]]
    _, lut = tone.build_tone_lut(s)
    assert np.all(np.diff(lut, axis=1) >= 0), "Tonwertumkehr in der LUT"
    assert lut.min() >= 0 and lut.max() <= 1


def test_monotone_curve_no_overshoot():
    pts = [[0, 0], [0.2, 0.5], [0.25, 0.52], [1, 1]]
    y = tone.monotone_curve(pts, np.linspace(0, 1, 2001))
    assert np.all(np.diff(y) >= -1e-12) and y.max() <= 1 + 1e-9


def test_shoulder_is_smooth_and_bounded():
    q = np.linspace(0, 3, 30001)
    for r in (0.0, 0.3, 0.7, 1.0):
        y = tone.shoulder(q, r)
        assert np.all(np.diff(y) >= -1e-12)
        assert y.max() <= 1.0
        k = 1 - 0.3 * r
        np.testing.assert_allclose(y[q <= k], q[q <= k])
    # weiche Schulter: Weiß (q=1) wird nicht hart abgeschnitten
    assert tone.shoulder(np.array([1.0]), 0.8)[0] < 1.0
    assert tone.shoulder(np.array([1.3]), 0.8)[0] < 1.0


def test_black_and_white_points_map_to_extremes():
    neg = make_negative(300, 450)
    s = analyzed(neg.negative, black_clip=0.0, white_clip=0.0, highlight_rolloff=0.0)
    out = pipeline.render(neg.negative, s, output_space="linear_rec2020")
    patches = gray_patches(neg, out)
    assert patches[0].max() < 1e-3          # Szenenschwarz -> 0
    assert patches[-1].min() > 0.995         # Szenenweiß -> 1


def test_clip_fraction_respects_settings():
    neg = make_negative(300, 450, scan=ScanModel(noise=0.004))
    s = analyzed(neg.negative, black_clip=0.5, white_clip=0.5, highlight_rolloff=0.0)
    s.geometry.crop = None
    out = pipeline.render(neg.negative, s, output_space="linear_rec2020")
    x0, y0, x1, y1 = neg.frame
    region = out[y0 + 10:y1 - 10, x0 + 10:x1 - 10]
    hi = np.mean(np.any(region >= 0.9999, axis=-1))
    assert hi < 0.03


def test_default_output_has_no_hard_highlight_clipping():
    neg = make_negative(300, 450)
    s = analyzed(neg.negative)                # Standard: weiche Schulter 0.5
    out = pipeline.render(neg.negative, s)
    assert np.mean(out >= 1.0) == 0.0


def test_smooth_gradient_has_no_tonal_breaks_in_16bit():
    """Ein feiner Verlauf durch die komplette Pipeline darf keine Lücken
    (Tonwertabrisse) aufweisen."""
    h, w, border = 40, 4400, 0.04
    fh, fw = h - 2 * int(h * border), w - 2 * int(w * border)
    scene = np.tile(np.geomspace(0.02, 0.9, fw)[None, :, None], (fh, 1, 3))
    neg = make_negative(h, w, border=border, scene=scene)
    s = analyzed(neg.negative, contrast=25, saturation=20)
    out = pipeline.render(neg.negative, s)
    x0, y0, x1, y1 = neg.frame
    row = (out[(y0 + y1) // 2, x0 + 5:x1 - 5, 1] * 65535).round()
    steps = np.diff(row)
    assert np.all(steps >= 0), "Verlauf muss monoton bleiben"
    assert steps.max() <= 64, f"Sprung von {steps.max()} 16-Bit-Stufen"


def test_preview_matches_export():
    """Verkleinerte Vorschau == verkleinerter Export (gleiche Analyse,
    räumliche Filter maßstabsgerecht)."""
    neg = make_negative(900, 1350, sprockets=True, scan=ScanModel(noise=0.003))
    s = analyzed(neg.negative, contrast=20, saturation=15, temperature=10, nr_chroma=30)
    s.geometry.crop = [0.08, 0.08, 0.92, 0.92]
    s.geometry.rotation = 90
    proxy = make_proxy(neg.negative, 450)
    scale = proxy.shape[1] / neg.negative.shape[1]
    prev = pipeline.render(proxy, s, scale=scale)
    full = pipeline.render(neg.negative, s, scale=1.0)
    full_small = cv2.resize(full, (prev.shape[1], prev.shape[0]), interpolation=cv2.INTER_AREA)
    diff = np.abs(prev - full_small)
    assert diff.mean() < 0.004
    assert np.percentile(diff, 99) < 0.03


def test_saturation_zero_gives_neutral():
    neg = make_negative(240, 360)
    s = analyzed(neg.negative, saturation=-100)
    out = pipeline.render(neg.negative, s, output_space="linear_rec2020")
    # Luminanzgewichtete Entsättigung im Arbeitsraum -> R=G=B
    assert np.max(np.ptp(out, axis=-1)) < 2e-3


def test_white_balance_gains_preserve_luminance():
    s = EditSettings(temperature=60, tint=-30)
    g = tone.white_balance_gains(s)
    assert abs(float(g @ tone.W_REC2020) - 1.0) < 1e-6
    assert g[0] > g[2]


def test_sharpen_and_nr_do_not_shift_mean():
    rng = np.random.default_rng(5)
    q = np.clip(0.5 + rng.normal(0, 0.05, (128, 128, 3)), 0, 1).astype(np.float32)
    from filmlab.imaging import detail
    a = detail.sharpen(q, 100, 1.5, 1.0)
    b = detail.reduce_noise(q, 50, 50, 1.0)
    assert abs(a.mean() - q.mean()) < 1e-3 and abs(b.mean() - q.mean()) < 1e-3
    assert b.std() < q.std() and a.std() > q.std()


@pytest.mark.parametrize("space", ["srgb", "adobe_rgb", "prophoto", "rec2020", "linear_rec2020"])
@pytest.mark.parametrize("seed", range(3))
def test_fast_path_matches_reference(space, seed):
    """Der LUT-basierte schnelle Pfad (Vorschau UND Export) entspricht der
    direkten pow()-Referenzimplementierung."""
    rng = np.random.default_rng(seed)
    lin = np.concatenate([rng.random((64, 64, 3)) * 1.3, np.geomspace(1e-5, 2.0, 64 * 64 * 3).reshape(64, 64, 3)])
    lin = lin.astype(np.float32)
    s = EditSettings(exposure=rng.uniform(-1, 1), temperature=rng.uniform(-50, 50), tint=rng.uniform(-50, 50),
                     contrast=rng.uniform(-60, 60), saturation=rng.uniform(-50, 50), vibrance=rng.uniform(-50, 50),
                     highlights=rng.uniform(-50, 50), shadows=rng.uniform(-50, 50),
                     highlight_rolloff=rng.uniform(0, 1))
    s.curves["g"] = [[0, 0], [0.4, 0.45], [1, 1]]
    fast = pipeline.finish(lin, s, output_space=space)
    ref = pipeline.finish_reference(lin, s, output_space=space)
    from filmlab.core import colorspace as cs
    # in linearem Licht vergleichen (reine Gamma-Kurven haben bei 0 unendliche
    # Steigung und vergrößern Abweichungen von 1e-8 künstlich)
    assert np.abs(cs.decode(fast, space) - cs.decode(ref, space)).max() < 2e-6
    visible = ref > 0.01
    assert np.abs(fast - ref)[visible].max() < 5e-5   # < 4 Stufen bei 16 Bit
