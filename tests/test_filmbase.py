"""Filmgrund-Erkennung, Ersatzschätzung und Plausibilitätsprüfungen."""
import numpy as np

from filmlab.core.settings import EditSettings, FilmBase
from filmlab.imaging import filmbase, pipeline
from filmlab.imaging.synthetic import ScanModel, make_negative


def test_detects_border_without_sprockets():
    neg = make_negative(300, 450)
    res = filmbase.detect_base(neg.negative, "color_negative")
    assert res.source == "border"
    np.testing.assert_allclose(res.rgb, neg.base_rgb, rtol=1e-4)
    assert res.confidence > 0.8


def test_rejects_unfiltered_light_through_sprocket_holes():
    neg = make_negative(300, 450, sprockets=True, scan=ScanModel(light=(0.9, 0.9, 0.9)))
    assert neg.negative.max() < 0.985  # Durchlicht nicht geclippt -> muss verworfen werden
    res = filmbase.detect_base(neg.negative, "color_negative")
    assert res.source == "border"
    np.testing.assert_allclose(res.rgb, neg.base_rgb, rtol=1e-3)


def test_detects_with_noise():
    neg = make_negative(300, 450, sprockets=True, scan=ScanModel(noise=0.01))
    res = filmbase.detect_base(neg.negative, "color_negative")
    np.testing.assert_allclose(res.rgb, neg.base_rgb, rtol=0.01)


def test_frame_detection():
    neg = make_negative(300, 450, sprockets=True)
    rect = filmbase.detect_frame(neg.negative, neg.base_rgb)
    x0, y0, x1, y1 = neg.frame
    np.testing.assert_allclose(rect, [x0 / 450, y0 / 300, x1 / 450, y1 / 300], atol=0.01)


def test_fallback_estimate_when_no_border_is_flagged():
    neg = make_negative(300, 450, border=0.0)
    res = filmbase.detect_base(neg.negative, "color_negative")
    assert res.source == "estimate"
    assert res.confidence < 0.5
    assert any("weniger zuverlässig" in w for w in res.warnings)
    s = EditSettings()
    a = pipeline.analyze(neg.negative, s)
    assert a.base_source == "estimate"
    assert any("geschätzt" in n.lower() for n in a.notes + a.warnings)


def test_manual_selection_in_image_area_triggers_warning():
    neg = make_negative(300, 450)
    s = EditSettings(base=FilmBase(mode="manual", rect=[0.45, 0.45, 0.55, 0.55]))
    a = pipeline.analyze(neg.negative, s)
    assert a.base_source == "manual"
    assert a.warnings, "Messbereich im Bild muss als unplausibel gemeldet werden"
    assert a.base_confidence < 0.5


def test_manual_selection_on_border_is_accepted():
    neg = make_negative(300, 450)
    s = EditSettings(base=FilmBase(mode="manual", rect=[0.005, 0.2, 0.05, 0.8]))
    a = pipeline.analyze(neg.negative, s)
    np.testing.assert_allclose(a.base_rgb, neg.base_rgb, rtol=1e-4)
    assert not a.warnings
    assert a.base_confidence > 0.9


def test_clipped_base_is_reported():
    neg = make_negative(300, 450, scan=ScanModel(light=(3.0, 6.0, 12.0)))  # Filmgrund überbelichtet
    conf, warnings = filmbase.check_base(np.minimum(neg.base_rgb, 1.0), neg.negative, "color_negative")
    assert any("gesättigt" in w for w in warnings)
    assert conf <= 0.5


def test_non_orange_reference_is_reported_for_c41():
    neg = make_negative(300, 450)
    conf, warnings = filmbase.check_base([0.5, 0.5, 0.5], neg.negative * 0.1, "color_negative")
    assert any("Orangemaske" in w for w in warnings)


def test_base_density_offset_shifts_color():
    neg = make_negative(240, 360)
    s = EditSettings()
    s.analysis = pipeline.analyze(neg.negative, s)
    a = pipeline.render(neg.negative, s)
    # +ΔD: dem Filmgrund wird mehr Dichte zugeschrieben -> Kanal wird im Positiv dunkler
    s.base.offset = [0.0, 0.0, 0.05]
    b = pipeline.render(neg.negative, s)
    x0, y0, x1, y1 = neg.frame
    diff = (b - a)[y0:y1, x0:x1].mean(axis=(0, 1))
    assert diff[2] < -0.005 and abs(diff[0]) < abs(diff[2]) / 3
