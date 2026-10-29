"""Bestimmung der Filmgrundfarbe (Orangemaske bzw. Träger + Schleier).

Physikalischer Hintergrund
--------------------------
Der unbelichtete Filmrand hat die minimale Dichte D_min (Träger, Schleier und
bei C-41 die farbige Maske). Im linearen Scan ist er daher – abgesehen von
Licht, das ganz am Film vorbei fällt (Perforation, Lücken) – der *hellste*
gleichmäßige Bereich. Sein linearer Messwert B_c = k_c * 10^(-D_min,c) enthält
alle kanalweisen Faktoren k_c (Lichtquelle, Sensor, Weißabgleich, Belichtung).

Erkennung (Heuristik, siehe docs/ALGORITHM.md)
----------------------------------------------
1. Bild in Blöcke teilen, Mittelwert und relative Streuung je Block.
2. Kandidaten: gleichmäßige, ungesättigte Blöcke im Randbereich
   (bzw. außerhalb des Zuschnitts, falls gesetzt).
3. Helle Kandidaten nach Farbe clustern (log10-Abstand).
4. Cluster, die deutlich heller und neutraler als ein plausibler Filmgrund-
   Cluster sind, werden als Durchlicht ohne Film verworfen.
5. Plausibilitätsprüfung gegen den Bildinhalt.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

CLIP_LEVEL = 0.985
EPS = 1e-6
NO_LIGHT_DENSITY = 1.7   # scheinbare Dichte über Filmgrund, ab der kein Film mehr angenommen wird


@dataclass
class BaseResult:
    rgb: list[float] | None
    source: str                       # border | manual | estimate | fixed | none
    confidence: float
    rect: list[float] | None = None   # normierter Messbereich (zur Anzeige)
    warnings: list[str] = field(default_factory=list)


def _block_stats(img: np.ndarray, block: int):
    h, w = img.shape[:2]
    bh, bw = h // block, w // block
    c = img[: bh * block, : bw * block].astype(np.float64)
    c = c.reshape(bh, block, bw, block, 3)
    mean = c.mean(axis=(1, 3))
    sq = (c * c).mean(axis=(1, 3))
    std = np.sqrt(np.maximum(sq - mean * mean, 0.0))
    return mean, std, bh, bw


def image_region(img: np.ndarray, crop: list[float] | None, margin: float = 0.08) -> np.ndarray:
    """Bildinhalt ohne Ränder (für Vergleiche und Schätzungen)."""
    from .geometry import crop as do_crop, inset

    rect = inset(crop or [0.0, 0.0, 1.0, 1.0], margin if crop else 0.12)
    return do_crop(img, rect)


def is_orange(rgb) -> bool:
    r, g, b = rgb
    return r > g * 1.03 and g > b * 1.08


def check_base(rgb, img: np.ndarray, film_type: str, crop: list[float] | None = None,
               region_std: float | None = None) -> tuple[float, list[str]]:
    """Plausibilitätsprüfung eines Filmgrundwerts. Liefert (Konfidenzfaktor, Warnungen)."""
    warnings: list[str] = []
    conf = 1.0
    rgb = np.asarray(rgb, dtype=np.float64)
    if np.any(rgb <= EPS):
        return 0.0, ["Filmgrundwert enthält Nullen – Messung unbrauchbar."]
    if np.max(rgb) >= CLIP_LEVEL:
        warnings.append("Filmgrund ist (nahezu) gesättigt. Dichte-Berechnung im Schattenbereich wird verfälscht – "
                        "Scan knapper belichten.")
        conf *= 0.5
    if np.mean(rgb) < 0.04:
        warnings.append("Filmgrund sehr dunkel (Scan unterbelichtet). Erhöhtes Rauschen in den Schatten zu erwarten.")
        conf *= 0.8
    content = image_region(img, crop).reshape(-1, 3)
    if content.size:
        # 10% Toleranz: ungleichmäßige Ausleuchtung (Lichtabfall) bei Kamera-Scans
        brighter = np.mean(np.any(content > rgb * 1.10, axis=1))
        if brighter > 0.01:
            warnings.append(f"{brighter * 100:.1f}% der Bildpixel sind heller als die Referenz. "
                            "Vermutlich kein unbelichteter Filmgrund (oder Lichteinfall).")
            conf *= max(0.2, 1.0 - brighter * 5)
    if film_type == "color_negative" and not is_orange(rgb):
        warnings.append("Referenz zeigt keine typische Orangemaske (R > G > B). Entweder wurde der Scan bereits "
                        "maskenkorrigiert/weißabgeglichen oder der Bereich ist ungeeignet.")
        conf *= 0.7
    if region_std is not None and region_std > 0.08:
        warnings.append(f"Messbereich ist ungleichmäßig (Streuung {region_std * 100:.0f}%).")
        conf *= 0.7
    return conf, warnings


def detect_frame(img: np.ndarray, base, min_fraction: float = 0.3) -> list[float] | None:
    """Findet den belichteten Bildbereich des Bildes in der Mitte.

    Pixel gelten als belichtet, wenn ihre mittlere Dichte über dem Filmgrund
    0.035 übersteigt und sie nicht zum lichtlosen Filmhalter gehören.
    Filmgrund (Rand, Stege zwischen Bildern), Perforation und Halter zählen
    nicht. Zeilen/Spalten mit mindestens 20% belichteten Pixeln bilden den
    Bildbereich (zusammenhängend um die Bildmitte)."""
    base = np.asarray(base, dtype=np.float64)
    if np.any(base <= 0):
        return None
    t = img.astype(np.float64) / base
    d = -np.log10(np.clip(t, 1e-5, None)).mean(axis=-1)
    exposed = (d > 0.035) & ~no_light_mask(img, base)

    def span(frac: np.ndarray) -> tuple[int, int] | None:
        n = frac.size
        good = frac > 0.2
        c = n // 2
        if not good[c]:
            idx = np.flatnonzero(good)
            if idx.size == 0:
                return None
            c = int(idx[np.argmin(np.abs(idx - n // 2))])
        a = c
        while a > 0 and good[a - 1]:
            a -= 1
        b = c
        while b < n - 1 and good[b + 1]:
            b += 1
        return a, b + 1

    rows = span(exposed.mean(axis=1))
    cols = span(exposed.mean(axis=0))
    if rows is None or cols is None:
        return None
    # zweiter Durchlauf nur innerhalb des gefundenen Streifens (robuster bei Nachbarbildern)
    rows2 = span(exposed[:, cols[0]:cols[1]].mean(axis=1))
    cols2 = span(exposed[rows[0]:rows[1]].mean(axis=0))
    rows, cols = rows2 or rows, cols2 or cols
    h, w = d.shape
    if (rows[1] - rows[0]) < min_fraction * h or (cols[1] - cols[0]) < min_fraction * w:
        return None
    if rows == (0, h) and cols == (0, w):
        return [0.0, 0.0, 1.0, 1.0]
    return [cols[0] / w, rows[0] / h, cols[1] / w, rows[1] / h]


def measure_rect(img: np.ndarray, rect: list[float]) -> tuple[np.ndarray, float]:
    """Robuster Mittelwert (Median) eines normierten Bereichs + relative Streuung."""
    from .geometry import crop as do_crop

    region = do_crop(img, rect).reshape(-1, 3).astype(np.float64)
    if region.shape[0] == 0:
        raise ValueError("Leerer Messbereich")
    med = np.median(region, axis=0)
    lum = region.mean(axis=1)
    rel = float(np.std(lum) / max(np.mean(lum), EPS))
    return med, rel


def estimate_from_content(img: np.ndarray, crop: list[float] | None, film_type: str) -> BaseResult:
    """Ersatzschätzung ohne Filmrand: hellste Bildbereiche (≈ tiefste Szenen-
    schatten) als Näherung für D_min. Deutlich weniger zuverlässig."""
    import cv2

    region = image_region(img, crop, margin=0.02)
    if region.size == 0:
        region = img
    blurred = cv2.GaussianBlur(region.astype(np.float32), (0, 0), 2.0)
    flat = blurred.reshape(-1, 3)
    rgb = np.percentile(flat, 99.8, axis=0) * 1.02
    rgb = np.clip(rgb, 1e-4, 1.0)
    return BaseResult(
        [float(v) for v in rgb], "estimate", 0.25, None,
        ["Kein unbelichteter Filmrand verfügbar – Filmgrund wurde aus dem Bildinhalt geschätzt. "
         "Diese Schätzung ist weniger zuverlässig; Farbstiche in den Schatten sind möglich."],
    )


def no_light_mask(img: np.ndarray, base) -> np.ndarray:
    """Bereiche ohne Licht (Filmhalter, Maske, Rahmen): sehr hohe scheinbare
    Dichte (> NO_LIGHT_DENSITY über Filmgrund) UND mit dem Bildrand verbunden.
    Solche Pixel sind kein Film und dürfen weder Weißpunkt noch Bildbereich
    beeinflussen. Rückgabe: bool-Maske (H, W)."""
    import cv2

    base = np.maximum(np.asarray(base, dtype=np.float64), EPS)
    lum = np.asarray(img, dtype=np.float32) @ (np.ones(3, np.float32) / 3)
    d = -np.log10(np.maximum(lum / float(base.mean()), 1e-5))
    dark = (d > NO_LIGHT_DENSITY).astype(np.uint8)
    if not dark.any():
        return dark.astype(bool)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(dark, connectivity=4)
    h, w = dark.shape
    keep = np.zeros(n, bool)
    for i in range(1, n):
        x, y, bw_, bh_, area = stats[i]
        touches = x == 0 or y == 0 or x + bw_ >= w or y + bh_ >= h
        keep[i] = touches and area > 0.002 * h * w
    return keep[labels]


def _line_coverage(block_idx: np.ndarray, bh: int, bw: int) -> float:
    """Filmgrund-Bereiche (Filmrand, Stege zwischen Bildern) sind lange,
    gerade Streifen. Maß: größter Anteil einer Blockzeile oder -spalte, der
    vom Cluster belegt ist."""
    by, bx = np.divmod(block_idx, bw)
    col = np.bincount(bx, minlength=bw).max() / bh
    row = np.bincount(by, minlength=bh).max() / bw
    return float(max(col, row))


def detect_base(img: np.ndarray, film_type: str = "color_negative", crop: list[float] | None = None) -> BaseResult:
    """Sucht im ganzen Bild den hellsten gleichmäßigen, streifenförmigen
    Bereich (Filmrand oder Steg zwischen zwei Bildern)."""
    h, w = img.shape[:2]
    block = int(max(4, min(h, w) // 100))
    mean, std, bh, bw = _block_stats(img, block)
    if bh < 4 or bw < 4:
        return estimate_from_content(img, crop, film_type)
    lum = mean.mean(axis=-1)
    rel_std = std.mean(axis=-1) / np.maximum(lum, EPS)
    # vollständig gesättigtes Weiß (Licht ohne Film) ist nie Filmgrund
    cand = (rel_std < 0.05) & (mean.max(axis=-1) < 0.9995) & (mean.min(axis=-1) > 0.002)
    idx = np.flatnonzero(cand.ravel())
    if idx.size < 3:
        return estimate_from_content(img, crop, film_type)

    logm = np.log10(np.maximum(mean.reshape(-1, 3)[idx], EPS))
    lum_c = lum.ravel()[idx]
    order = np.argsort(-lum_c)
    # nur die hellen Kandidaten (Filmgrund ist der hellste Filmbereich)
    # (Licht ohne Film kann 4-5x heller sein als eine dichte Orangemaske)
    top = order[lum_c[order] > 0.08 * lum_c[order[0]]][:6000]

    clusters: list[list[int]] = []
    centers: list[np.ndarray] = []
    for i in top:
        v = logm[i]
        for ci, c in enumerate(centers):
            if np.max(np.abs(v - c)) < 0.045:
                clusters[ci].append(i)
                if len(clusters[ci]) < 50 or len(clusters[ci]) % 25 == 0:
                    centers[ci] = np.median(logm[clusters[ci]], axis=0)
                break
        else:
            clusters.append([i])
            centers.append(v.copy())

    flat = img.reshape(-1, 3)[:: max(1, (h * w) // 400000)]
    min_blocks = max(3, int(0.002 * bh * bw))
    infos = []
    for members, c in zip(clusters, centers):
        if len(members) < min_blocks:
            continue
        rgb = 10.0 ** c
        brighter = float(np.mean(np.any(flat > rgb * 1.10, axis=1)))
        infos.append({"members": members, "rgb": rgb, "lum": float(rgb.mean()),
                      "neutral": rgb.max() / max(rgb.min(), EPS) < 1.25, "orange": is_orange(rgb),
                      "line": _line_coverage(idx[members], bh, bw), "brighter": brighter})
    if not infos:
        return estimate_from_content(img, crop, film_type)
    infos.sort(key=lambda d: -d["lum"])

    notes = []
    good = [d for d in infos if d["line"] >= 0.3]
    if not good:
        res = estimate_from_content(img, crop, film_type)
        res.warnings.insert(0, "Kein Filmrand und kein Steg zwischen Bildern gefunden.")
        return res
    chosen = good[0]
    for alt in good[1:]:
        ratio = np.log10(chosen["lum"] / max(alt["lum"], EPS))
        if film_type == "color_negative" and chosen["neutral"] and alt["orange"]:
            notes.append("Hellerer neutraler Bereich als Durchlicht ohne Film verworfen.")
            chosen = alt
            break
        # Licht ohne Film ist praktisch immer (nahezu) gesättigtes Weiß
        if (ratio > 0.12 and chosen["neutral"] and chosen["rgb"].max() >= 0.97
                and (film_type != "color_negative" or not chosen["orange"])):
            notes.append("Deutlich hellerer Bereich als Durchlicht (Perforation/Lücke) verworfen.")
            chosen = alt
            break
    if chosen["brighter"] > 0.05:
        res = estimate_from_content(img, crop, film_type)
        res.warnings.insert(0, "Gefundener Randbereich ist dunkler als Teile des Bildinhalts und daher kein "
                               "verlässlicher Filmgrund.")
        return res

    members = chosen["members"]
    blocks = mean.reshape(-1, 3)[idx[members]]
    rgb = np.median(blocks, axis=0)
    k = idx[members[int(np.argmin(np.abs(np.log10(np.maximum(blocks, EPS)) - np.log10(rgb)).sum(axis=1)))]]
    by, bx = divmod(int(k), bw)
    rect = [bx * block / w, by * block / h, (bx + 1) * block / w, (by + 1) * block / h]
    size_conf = min(1.0, len(members) / (min_blocks * 4))
    conf, warnings = check_base(rgb, img, film_type, crop)
    conf *= 0.6 + 0.4 * size_conf
    return BaseResult([float(v) for v in rgb], "border", float(conf), rect, notes + warnings)
