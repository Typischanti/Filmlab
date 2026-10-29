// Komplettes Rendern eines Bildes (Export, Kommandozeile) in Streifen,
// damit auch große Scans mit begrenztem Speicher verarbeitet werden.

import { makeMapping, extract, boxDownscale, cropPixelSize, FULL_RECT, fitDownscale } from './geometry.js';
import { analyze, buildLUTs, processToFloat, autoExposure } from './pipeline.js';

export const PREVIEW_MAX = 2400;

// Analysebild: verkleinert, gedreht und zugeschnitten.
// Korn, Staub und Kompressionsartefakte werden durch Mittelung unterdrückt,
// damit einzelne Ausreißer die Perzentile nicht verfälschen.
export function analysisImage(src, settings, maxDim = 1000) {
  const small = fitDownscale(src, maxDim);
  const geom = settings.geometry;
  const rect = geom.crop || FULL_RECT;
  const [w, h] = cropPixelSize(small, geom);
  const img = extract(small, makeMapping(small, geom, rect, w, h), w, 0, h);
  return boxBlur3(img);
}

function boxBlur3(img) {
  const { width: W, height: H, data: d } = img;
  const out = new Uint16Array(d.length);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - 1), y1 = Math.min(H - 1, y + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - 1), x1 = Math.min(W - 1, x + 1);
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          const i = (yy * W + xx) * 3;
          r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
        }
      }
      const o = (y * W + x) * 3;
      out[o] = r / n + 0.5; out[o + 1] = g / n + 0.5; out[o + 2] = b / n + 0.5;
    }
  }
  return { width: W, height: H, data: out };
}

export function resolveLevels(src, settings) {
  if (settings.film.lockLevels && settings.film.levels) return settings.film.levels;
  return analyze(analysisImage(src, settings), settings);
}

export { autoExposure };

// Rendert in Zielgröße. opts.maxDim: längste Kante (0 = Originalgröße).
// Rückgabe { width, height, rgb: Float32Array }.
export async function renderFull(src, settings, opts = {}) {
  const levels = opts.levels || resolveLevels(src, settings);
  const geom = settings.geometry;
  const rect = geom.crop || FULL_RECT;
  let [w, h] = cropPixelSize(src, geom);
  let source = src;
  let scale = 1;
  if (opts.maxDim && Math.max(w, h) > opts.maxDim) {
    scale = opts.maxDim / Math.max(w, h);
    const factor = Math.floor(1 / scale);
    if (factor >= 2) source = boxDownscale(src, factor);
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
  }
  const luts = buildLUTs(settings, levels);
  const mapping = makeMapping(source, geom, rect, w, h);
  const out = new Float32Array(w * h * 3);
  const stripe = 512;
  const d = settings.detail;
  const needsNeighbourhood = d.sharpen > 0 || d.grain > 0;
  const overlap = needsNeighbourhood ? Math.ceil(Math.max(d.radius, d.grainSize) * scale * 4) + 4 : 0;
  for (let y0 = 0; y0 < h; y0 += stripe) {
    const y1 = Math.min(h, y0 + stripe);
    const a = Math.max(0, y0 - overlap);
    const b = Math.min(h, y1 + overlap);
    const part = extract(source, mapping, w, a, b);
    const buf = processToFloat(part, settings, levels, luts, { scale, origin: [0, a] });
    out.set(buf.subarray((y0 - a) * w * 3, (y1 - a) * w * 3), y0 * w * 3);
    if (opts.onProgress) await opts.onProgress(y1 / h);
  }
  return { width: w, height: h, rgb: out, levels };
}
