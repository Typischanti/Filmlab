"""Kommandozeile für Konvertierung ohne Oberfläche.

Beispiele:
    python -m filmlab.cli convert scan.dng -o out/ --profile kodak_portra_400
    python -m filmlab.cli convert *.NEF -o out/ --roll --format jpeg --quality 92
    python -m filmlab.cli demo -o samples/
    python -m filmlab.cli profiles
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .core.colorspace import OUTPUT_SPACES
from .core.profiles import library
from .core.settings import EditSettings
from .imaging import batch, export, pipeline
from .imaging.loader import load_image


def _settings(args) -> EditSettings:
    lib = library()
    if args.profile not in lib.profiles:
        raise SystemExit(f"Unbekanntes Profil '{args.profile}'. Verfügbar: {', '.join(lib.profiles)}")
    preset = args.preset or lib.profiles[args.profile].recommended_preset
    if preset not in lib.presets:
        raise SystemExit(f"Unbekanntes Preset '{preset}'. Verfügbar: {', '.join(lib.presets)}")
    s = lib.apply(EditSettings(), args.profile, preset)
    if args.normalization:
        s.normalization = args.normalization
    if args.exposure:
        s.exposure = args.exposure
    return s


def cmd_convert(args) -> int:
    s = _settings(args)
    opts = export.ExportOptions(fmt=args.format, output_space=args.space, jpeg_quality=args.quality)
    items = [batch.BatchItem(str(p), s.copy()) for p in args.inputs]
    if args.roll and len(items) > 1:
        print(f"Filmstreifen-Analyse über {len(items)} Bilder ...")
        srcs = [load_image(i.path, s.input_encoding) for i in items]
        proxies = [pipeline.analysis_proxy(x.data) for x in srcs]
        new = batch.roll_analysis(proxies, [i.settings for i in items], [x.source_id for x in srcs])
        for it, ns in zip(items, new):
            it.settings = ns
        del srcs

    def progress(i, n, name):
        if name:
            print(f"[{i + 1}/{n}] {name}")

    results = batch.run_batch(items, args.output, opts, args.template, progress=progress)
    failed = [r for r in results if not r.ok]
    for r in results:
        print(("OK   " if r.ok else "FEHLER ") + (r.output or r.path) + (f"  ({r.error})" if r.error else "")
              + f"  {r.seconds:.1f}s")
    return 1 if failed else 0


def cmd_analyze(args) -> int:
    s = _settings(args)
    for p in args.inputs:
        src = load_image(p, s.input_encoding)
        a = pipeline.analyze(pipeline.analysis_proxy(src.data), s, src.source_id)
        print(f"{p}: Filmgrund={['%.4f' % v for v in a.base_rgb or []]} Quelle={a.base_source} "
              f"Konfidenz={a.base_confidence:.2f} D_lo={['%.3f' % v for v in a.d_lo]} "
              f"D_hi={['%.3f' % v for v in a.d_hi]} R={a.log_range:.2f}")
        for w in src.warnings + a.warnings + a.notes:
            print("   -", w)
    return 0


def cmd_demo(args) -> int:
    from .imaging.synthetic import ScanModel, make_negative

    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    neg = make_negative(1200, 1800, sprockets=True, scan=ScanModel(noise=0.004))
    target = out / "synthetic_negative.tif"
    # als lineares 16-Bit-TIFF speichern (wie ein linearer Scanner-Export)
    import numpy as np
    import tifffile

    tifffile.imwrite(target, np.round(np.clip(neg.negative, 0, 1) * 65535).astype(np.uint16), photometric="rgb")
    print(f"Synthetisches lineares Negativ geschrieben: {target}")
    print("Hinweis: beim Öffnen 'Eingangskodierung: linear' wählen (CLI: wird automatisch gesetzt).")
    s = library().apply(EditSettings(), "generic_color_negative", "neutral")
    s.input_encoding = "linear"
    res = batch.run_batch([batch.BatchItem(str(target), s)], out, export.ExportOptions(), "{name}_positiv")
    print("Positiv:", res[0].output if res[0].ok else res[0].error)
    return 0


def cmd_profiles(args) -> int:
    lib = library()
    print("Filmprofile:")
    for p in lib.profiles_for():
        print(f"  {p.id:28s} {p.name}  [{p.film_type}]")
    print("Presets:")
    for p in lib.presets.values():
        print(f"  {p.id:28s} {p.name}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="filmlab-cli", description="FilmLab Negativ-Konverter (Kommandozeile)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p):
        p.add_argument("inputs", nargs="+")
        p.add_argument("--profile", default="generic_color_negative")
        p.add_argument("--preset", default=None)
        p.add_argument("--normalization", choices=["auto", "base"], default=None)
        p.add_argument("--exposure", type=float, default=0.0)

    c = sub.add_parser("convert", help="Negative konvertieren und exportieren")
    common(c)
    c.add_argument("-o", "--output", required=True)
    c.add_argument("--format", choices=list(export.FORMATS), default="tiff16")
    c.add_argument("--space", choices=OUTPUT_SPACES, default="srgb")
    c.add_argument("--quality", type=int, default=95)
    c.add_argument("--template", default=batch.DEFAULT_TEMPLATE)
    c.add_argument("--roll", action="store_true", help="gemeinsame Filmstreifen-Analyse")
    c.set_defaults(func=cmd_convert)

    a = sub.add_parser("analyze", help="Filmgrund und Tonwertanalyse ausgeben")
    common(a)
    a.set_defaults(func=cmd_analyze)

    d = sub.add_parser("demo", help="Synthetisches Testnegativ erzeugen und konvertieren")
    d.add_argument("-o", "--output", default="samples")
    d.set_defaults(func=cmd_demo)

    p = sub.add_parser("profiles", help="Profile und Presets auflisten")
    p.set_defaults(func=cmd_profiles)

    args = ap.parse_args(argv)
    try:
        return args.func(args)
    except Exception as exc:
        print(f"Fehler: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
