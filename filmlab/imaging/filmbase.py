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


def _region_mask(bh: int, bw: int, crop: list[float] | None, strip: float) -> np.ndarray:
    yy, xx = np.mgrid[0:bh, 0:bw]
    cx, cy = (xx + 0.5) / bw, (yy + 0.5) / bh
    if crop and (crop[2] - crop[0]) * (crop[3] - crop[1]) < 0.95:
        x0, y0, x1, y1 = crop
        return (cx < x0) | (cx > x1) | (cy < y0) | (cy > y1)
    return (cx < strip) | (cx > 1 - strip) | (cy < strip) | (cy > 1 - strip)


def image_region(img: np.ndarray, crop: list[float] | None, margin: float = 0.08) -> np.ndarray:
    """Bildinhalt ohne Ränder (für Vergleiche und Schätzungen)."""
    from .geometry import crop as do_crop, inset

    rect = inset(crop or [0.0, 0.0, 1.0, 1.0], margin if crop else 0.12)
    return do_crop(img, rect)


def is_orange(rgb) -> bool:
    r, g, b = rgb
    return r > g * 1.08 and g > b * 1.08


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
        brighter = np.mean(np.any(content > rgb * 1.03, axis=1))
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


def detect_frame(img: np.ndarray, base, min_fraction: float = 0.4) -> list[float] | None:
    """Findet den belichteten Bildbereich innerhalb des Filmrands.

    Pixel gelten als belichtet, wenn ihre mittlere Dichte über dem Filmgrund
    0.06 übersteigt; Pixel heller als der Filmgrund (Perforation, Lücken)
    gelten als unbelichtet. Zeilen/Spalten mit mindestens 30% belichteten
    Pixeln bilden den Bildbereich (zusammenhängend um die Mitte)."""
    base = np.asarray(base, dtype=np.float64)
    if np.any(base <= 0):
        return None
    t = img.astype(np.float64) / base
    d = -np.log10(np.clip(t, 1e-4, None)).mean(axis=-1)
    exposed = d > 0.06

    def span(frac: np.ndarray) -> tuple[int, int] | None:
        n = frac.size
        good = frac > 0.3
        c = n // 2
        if not good[c]:
            # nächste belichtete Position zur Mitte suchen
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
    rgb = np.minimum(rgb, 1.0)
    return BaseResult(
        [float(v) for v in rgb], "estimate", 0.25, None,
        ["Kein unbelichteter Filmrand verfügbar – Filmgrund wurde aus dem Bildinhalt geschätzt. "
         "Diese Schätzung ist weniger zuverlässig; Farbstiche in den Schatten sind möglich."],
    )


def detect_base(img: np.ndarray, film_type: str = "color_negative", crop: list[float] | None = None) -> BaseResult:
    h, w = img.shape[:2]
    block = int(max(4, min(h, w) // 80))
    mean, std, bh, bw = _block_stats(img, block)
    if bh < 4 or bw < 4:
        return estimate_from_content(img, crop, film_type)
    lum = mean.mean(axis=-1)
    rel_std = std.mean(axis=-1) / np.maximum(lum, EPS)
    region = _region_mask(bh, bw, crop, strip=0.12)
    cand = region & (rel_std < 0.05) & (mean.max(axis=-1) < CLIP_LEVEL) & (mean.min(axis=-1) > 0.002)
    idx = np.flatnonzero(cand.ravel())
    if idx.size < 3:
        return estimate_from_content(img, crop, film_type)

    logm = np.log10(np.maximum(mean.reshape(-1, 3)[idx], EPS))
    lum_c = lum.ravel()[idx]
    order = np.argsort(-lum_c)
    # Nur die helleren Kandidaten betrachten (Filmgrund ist hell)
    top = order[: max(3, int(np.ceil(order.size * 0.5)))]

    clusters: list[list[int]] = []
    centers: list[np.ndarray] = []
    for i in top:
        v = logm[i]
        for ci, c in enumerate(centers):
            if np.max(np.abs(v - c)) < 0.045:
                clusters[ci].append(i)
                centers[ci] = np.median(logm[clusters[ci]], axis=0)
                break
        else:
            clusters.append([i])
            centers.append(v.copy())

    content = image_region(img, crop).reshape(-1, 3)
    p_content = np.percentile(content, 99.5, axis=0) if content.size else np.zeros(3)

    infos = []
    min_blocks = max(3, int(0.003 * bh * bw))
    for members, c in zip(clusters, centers):
        if len(members) < min_blocks:
            continue
        rgb = 10.0 ** c
        neutral = rgb.max() / max(rgb.min(), EPS) < 1.25
        covers = np.all(rgb >= p_content * 0.97)
        infos.append({"members": members, "rgb": rgb, "lum": float(rgb.mean()), "neutral": neutral,
                      "covers": covers, "orange": is_orange(rgb)})
    if not infos:
        return estimate_from_content(img, crop, film_type)
    infos.sort(key=lambda d: -d["lum"])

    chosen = infos[0]
    notes = []
    for alt in infos[1:]:
        brighter = np.log10(chosen["lum"] / max(alt["lum"], EPS))
        if not alt["covers"] or len(alt["members"]) < min_blocks:
            continue
        if film_type == "color_negative" and chosen["neutral"] and alt["orange"]:
            notes.append("Hellerer neutraler Bereich als Durchlicht ohne Film verworfen.")
            chosen = alt
            break
        if brighter > 0.12 and chosen["neutral"] and (film_type != "color_negative" or not chosen["orange"]):
            notes.append("Deutlich hellerer Bereich als Durchlicht (Perforation/Lücke) verworfen.")
            chosen = alt
            break

    if not chosen["covers"]:
        res = estimate_from_content(img, crop, film_type)
        res.warnings.insert(0, "Gefundener Randbereich ist dunkler als Teile des Bildinhalts und daher kein "
                               "verlässlicher Filmgrund.")
        return res

    members = chosen["members"]
    blocks = mean.reshape(-1, 3)[idx[members]]
    rgb = np.median(blocks, axis=0)
    # Repräsentativer Block zur Anzeige
    k = idx[members[int(np.argmin(np.abs(np.log10(np.maximum(blocks, EPS)) - np.log10(rgb)).sum(axis=1)))]]
    by, bx = divmod(int(k), bw)
    rect = [bx * block / w, by * block / h, (bx + 1) * block / w, (by + 1) * block / h]

    size_conf = min(1.0, len(members) / (min_blocks * 4))
    conf, warnings = check_base(rgb, img, film_type, crop)
    conf *= 0.6 + 0.4 * size_conf
    return BaseResult([float(v) for v in rgb], "border", float(conf), rect, notes + warnings)
