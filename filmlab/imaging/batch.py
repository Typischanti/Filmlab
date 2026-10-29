"""Stapelverarbeitung und Filmstreifen-Analyse."""
from __future__ import annotations

import re
import time
import traceback
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import numpy as np

from ..core.settings import Analysis, EditSettings, FilmBase
from . import inversion, pipeline
from .export import EXTENSIONS, ExportOptions, render_full, save_image
from .loader import load_image

DEFAULT_TEMPLATE = "{name}_positiv"


@dataclass
class BatchItem:
    path: str
    settings: EditSettings


@dataclass
class BatchResult:
    path: str
    output: str | None
    ok: bool
    error: str = ""
    seconds: float = 0.0


_TOKEN = re.compile(r"\{(\w+)(?::([^}]*))?\}")


def format_filename(template: str, path: str, index: int, s: EditSettings, fmt: str) -> str:
    """Ersetzt {name}, {index}, {profile}, {preset}, {film}, {date} im Dateinamen."""
    values = {
        "name": Path(path).stem,
        "index": index,
        "profile": s.profile_id,
        "preset": s.preset_id,
        "film": s.film_type,
        "date": time.strftime("%Y%m%d"),
    }

    def repl(m: re.Match) -> str:
        key, spec = m.group(1), m.group(2)
        if key not in values:
            return m.group(0)
        v = values[key]
        return format(v, spec) if spec else str(v)

    name = _TOKEN.sub(repl, template or DEFAULT_TEMPLATE)
    name = re.sub(r'[\\/:*?"<>|]+', "_", name).strip() or Path(path).stem
    return name + EXTENSIONS[fmt]


def unique_path(p: Path, taken: set[str]) -> Path:
    cand, i = p, 2
    while str(cand) in taken or cand.exists():
        cand = p.with_name(f"{p.stem}_{i}{p.suffix}")
        i += 1
    taken.add(str(cand))
    return cand


def process_one(item: BatchItem, out_path: Path, opts: ExportOptions) -> EditSettings:
    src = load_image(item.path, item.settings.input_encoding)
    s = pipeline.ensure_analysis(pipeline.analysis_proxy(src.data), item.settings.copy(), src.source_id)
    img = render_full(src.data, s, opts)
    save_image(img, out_path, opts)
    return s


def run_batch(items: list[BatchItem], out_dir: str | Path, opts: ExportOptions, template: str = DEFAULT_TEMPLATE,
              progress: Callable[[int, int, str], None] | None = None,
              cancelled: Callable[[], bool] | None = None, overwrite: bool = False) -> list[BatchResult]:
    """Exportiert alle Bilder; Fehler einzelner Dateien brechen den Stapel nicht ab."""
    out_dir = Path(out_dir)
    results: list[BatchResult] = []
    taken: set[str] = set()
    for i, item in enumerate(items):
        if cancelled and cancelled():
            break
        if progress:
            progress(i, len(items), Path(item.path).name)
        t0 = time.perf_counter()
        target = out_dir / format_filename(template, item.path, i + 1, item.settings, opts.fmt)
        target = target if overwrite and str(target) not in taken else unique_path(target, taken)
        taken.add(str(target))
        try:
            process_one(item, target, opts)
            results.append(BatchResult(item.path, str(target), True, seconds=time.perf_counter() - t0))
        except Exception as exc:  # pro Datei abfangen
            traceback.print_exc()
            results.append(BatchResult(item.path, None, False, f"{type(exc).__name__}: {exc}",
                                       time.perf_counter() - t0))
    if progress:
        progress(len(items), len(items), "")
    return results


def roll_analysis(proxies: list[np.ndarray], settings: list[EditSettings], source_ids: list[str]) -> list[EditSettings]:
    """Gemeinsame Entwicklung eines Filmstreifens.

    1. Filmgrund je Bild bestimmen. Jedes Bild behält seinen *eigenen*
       zuverlässig gemessenen Filmgrund: damit kürzen sich auch Unterschiede
       der Scanbedingungen (Belichtung, Weißabgleich, Lichtquelle) zwischen
       den Aufnahmen heraus. Bilder ohne zuverlässigen Rand erhalten den
       Median der zuverlässigen Messungen.
    2. Schwarz-/Weißpunkte (Dichten relativ zum Filmgrund) je Bild bestimmen;
       gemeinsame Werte = Median je Kanal – identische Entwicklung des Films.
    3. Analyse in allen Bildern sperren. Belichtungsunterschiede zwischen den
       Aufnahmen auf dem Film bleiben erhalten, die Farbwiedergabe ist
       konsistent.
    """
    if not proxies:
        return []
    per = [pipeline.analyze(p, s.copy(), sid) for p, s, sid in zip(proxies, settings, source_ids)]
    if all(a.base_rgb is None for a in per):  # Diafilm
        lo = float(np.median([a.slide_lo[0] for a in per]))
        hi = float(np.median([a.slide_hi[0] for a in per]))
        out = []
        for s, a in zip(settings, per):
            n = s.copy()
            n.analysis = a
            n.analysis.slide_lo, n.analysis.slide_hi = [lo] * 3, [hi] * 3
            n.lock_analysis = True
            out.append(n)
        return out
    reliable = [np.asarray(a.base_rgb) for a in per if a.base_source in ("border", "manual", "fixed")]
    fallback = np.median(np.asarray(reliable or [a.base_rgb for a in per]), axis=0)
    bases = [np.asarray(a.base_rgb) if a.base_source in ("border", "manual", "fixed") else fallback for a in per]
    notes = [f"Filmstreifen-Analyse über {len(settings)} Bilder (gesperrt)."]
    if len(reliable) > 1:
        spread = np.max(np.abs(np.log10(np.asarray(reliable) / np.median(reliable, axis=0))))
        if spread > 0.01:
            notes.append("Scanbedingungen variieren zwischen den Bildern (Belichtung/Weißabgleich); "
                         "der Filmgrund wird je Bild verwendet.")
    fixed = []
    for p, s, sid, b in zip(proxies, settings, source_ids, bases):
        n = s.copy()
        n.base = FilmBase(mode="fixed", rgb=[float(v) for v in b], offset=list(s.base.offset))
        fixed.append(pipeline.analyze(p, n, sid))
    d_lo = np.median([a.d_lo for a in fixed], axis=0)
    d_hi = np.median([a.d_hi for a in fixed], axis=0)
    d_hi = np.maximum(d_hi, d_lo + inversion.MIN_RANGE)
    r = inversion.log_range(d_lo, d_hi, settings[0].film_gamma)
    out = []
    for s, a, sid, b, own in zip(settings, fixed, source_ids, bases, per):
        n = s.copy()
        n.base = FilmBase(mode="fixed", rgb=[float(v) for v in b], offset=list(s.base.offset))
        frame_notes = list(notes)
        if own.base_source == "estimate":
            frame_notes.append("Kein Filmrand in diesem Bild: Filmgrund aus den übrigen Bildern übernommen.")
        n.analysis = Analysis(
            key=n.analysis_key(sid), base_rgb=[float(v) for v in b], base_source="fixed",
            base_confidence=a.base_confidence, frame_rect=a.frame_rect,
            d_lo=[float(v) for v in d_lo], d_hi=[float(v) for v in d_hi], log_range=r,
            scan_level=float(np.max(b)), warnings=list(a.warnings), notes=frame_notes,
        )
        n.lock_analysis = True
        out.append(n)
    return out
