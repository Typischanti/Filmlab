"""Erzeugt simulierte Farbnegativ-Scans aus Testfotos (für Tests und Abstimmung).

Filmmodell: Dichte = Basisdichte (orange Maske) + Gradation * log10(Belichtung)
mit weichem Durchhang (Toe) und Schulter pro Farbschicht, danach Durchleuchtung
mit einer leicht farbigen Lichtquelle und sRGB-kodiertem 16-Bit-Scan.

Aufruf: python3 tools/make_test_negatives.py <ausgabeordner>
Benötigt numpy, scikit-image, tifffile.
"""
import sys
from pathlib import Path

import numpy as np
import skimage.data
import tifffile


def srgb_to_linear(v):
    return np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(v):
    v = np.clip(v, 0, 1)
    return np.where(v <= 0.0031308, v * 12.92, 1.055 * v ** (1 / 2.4) - 0.055)


def film_negative(rgb8, exposure=1.0, border=0.06, seed=0, balance=0.0):
    """balance: 0 = weißes Scanlicht, 1 = Licht vollständig auf die Maske abgestimmt."""
    lin = srgb_to_linear(rgb8.astype(np.float64) / 255.0) * exposure
    base = np.array([0.22, 0.58, 0.88])      # orange Maske
    gamma = np.array([0.58, 0.63, 0.68])     # unterschiedliche Schichtgradation
    log_e = np.log10(np.maximum(lin, 1e-6) / 0.18)
    # weicher Toe: Dichte wächst erst ab ca. -2,2 log-Einheiten
    toe = -2.0
    x = log_e - toe
    soft = np.log1p(np.exp(x * 3.0)) / 3.0     # Softplus
    dens = base + gamma * soft
    dens = np.minimum(dens, base + 2.6 - 0.4 * np.exp(-(base + 2.6 - dens)))  # Schulter
    light = np.array([1.0, 0.97, 0.93])        # leicht warme Lichtquelle
    light = light * 10.0 ** (balance * (base - base[0]))
    t = light * 10.0 ** (-dens)
    rng = np.random.default_rng(seed)
    t *= 1 + rng.normal(0, 0.004, t.shape)     # etwas Scanrauschen
    # unbelichteter Filmrand
    h, w, _ = t.shape
    bh, bw = int(h * border), int(w * border)
    out = np.empty((h + 2 * bh, w + 2 * bw, 3))
    out[:] = light * 10.0 ** (-base)
    out[bh:bh + h, bw:bw + w] = t
    return (linear_to_srgb(out) * 65535 + 0.5).astype(np.uint16)


def main():
    outdir = Path(sys.argv[1] if len(sys.argv) > 1 else 'test-negatives')
    outdir.mkdir(parents=True, exist_ok=True)
    images = {
        'astronaut': skimage.data.astronaut(),
        'coffee': skimage.data.coffee(),
        'chelsea': skimage.data.chelsea(),
        'rocket': skimage.data.rocket(),
    }
    for name, img in images.items():
        neg = film_negative(img, exposure=1.0)
        tifffile.imwrite(outdir / f'{name}_neg16.tif', neg, photometric='rgb')
        tifffile.imwrite(outdir / f'{name}_orig.tif', img, photometric='rgb')
    # Varianten zum Testen des Decoders
    neg = film_negative(images['coffee'])
    tifffile.imwrite(outdir / 'coffee_neg16_lzw.tif', neg, photometric='rgb', compression='lzw')
    tifffile.imwrite(outdir / 'coffee_neg16_zip_pred.tif', neg, photometric='rgb', compression='zlib', predictor=True)
    tifffile.imwrite(outdir / 'coffee_neg16_tiled.tif', neg, photometric='rgb', tile=(64, 64))
    tifffile.imwrite(outdir / 'coffee_neg16_planar.tif', np.ascontiguousarray(np.moveaxis(neg, 2, 0)), photometric='rgb', planarconfig='separate')
    tifffile.imwrite(outdir / 'coffee_neg8_packbits.tif', (neg >> 8).astype(np.uint8), photometric='rgb', compression='packbits')
    tifffile.imwrite(outdir / 'coffee_neg16_be.tif', neg, photometric='rgb', byteorder='>')
    np.save(outdir / 'coffee_neg16.npy', neg)
    print('geschrieben nach', outdir)


if __name__ == '__main__':
    main()
