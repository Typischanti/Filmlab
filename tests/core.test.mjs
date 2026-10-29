import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSpline, curveTable } from '../js/core/spline.js';
import {
  defaultSettings, normalizeSettings, wbOffsets, offsetsToWb, analyze, buildLUTs,
  processToFloat, neutralWb, toneFunction,
} from '../js/core/pipeline.js';
import { createImage, makeMapping, extract, orientedSize } from '../js/core/geometry.js';
import { linearToSrgb } from '../js/core/color.js';
import { encodeTiff16, decodeTiff } from '../js/core/tiff.js';

// Simuliertes Negativ: Graukeil mit oranger Maske.
function syntheticNegative(w = 64, h = 16) {
  const img = createImage(w, h);
  const base = [0.22, 0.58, 0.88];
  const gamma = [0.58, 0.63, 0.68];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const logE = -2.2 + (2.6 * x) / (w - 1);
      for (let c = 0; c < 3; c++) {
        const t = Math.pow(10, -(base[c] + gamma[c] * (logE + 2.4)));
        img.data[(y * w + x) * 3 + c] = Math.round(linearToSrgb(t) * 65535);
      }
    }
  }
  return img;
}

test('Spline ist monoton und trifft die Stützpunkte', () => {
  const pts = [[0, 0], [0.3, 0.2], [0.6, 0.85], [1, 1]];
  const f = makeSpline(pts);
  for (const [x, y] of pts) assert.ok(Math.abs(f(x) - y) < 1e-9);
  let prev = -1;
  for (let i = 0; i <= 1000; i++) {
    const v = f(i / 1000);
    assert.ok(v >= prev - 1e-9);
    prev = v;
  }
  const t = curveTable([[0, 0], [1, 1]], 11);
  assert.ok(Math.abs(t[5] - 0.5) < 1e-6);
});

test('Weißabgleich-Umrechnung ist umkehrbar', () => {
  const wb = { temp: 37, tint: -18 };
  const back = offsetsToWb(wbOffsets(wb));
  assert.ok(Math.abs(back.temp - 37) < 1e-6);
  assert.ok(Math.abs(back.tint + 18) < 1e-6);
});

test('Graukeil wird trotz oranger Maske neutral und richtig herum', () => {
  const img = syntheticNegative();
  const s = defaultSettings();
  s.color.vibrance = 0;
  s.film.border = 0;
  const levels = analyze(img, s);
  const out = processToFloat(img, s, levels, buildLUTs(s, levels));
  const w = img.width;
  let prevL = -1;
  for (let x = 2; x < w - 2; x++) {
    const i = (8 * w + x) * 3;
    const [r, g, b] = [out[i], out[i + 1], out[i + 2]];
    assert.ok(Math.max(r, g, b) - Math.min(r, g, b) < 0.03, `Pixel ${x} nicht neutral: ${r} ${g} ${b}`);
    const L = (r + g + b) / 3;
    assert.ok(L >= prevL - 1e-6, 'Helligkeit muss mit der Belichtung steigen');
    prevL = L;
  }
});

test('Pipette setzt neutralen Weißabgleich', () => {
  const img = syntheticNegative();
  const s = defaultSettings();
  s.film.border = 0;
  const levels = analyze(img, s);
  // künstlicher Farbstich: Rotkanal verschieben
  levels.lo[0] -= 0.05;
  const i = (8 * img.width + 32) * 3;
  const codes = [img.data[i], img.data[i + 1], img.data[i + 2]];
  s.wb = neutralWb(codes, s, levels);
  const luts = buildLUTs(s, levels);
  const r = luts[0][codes[0]], g = luts[1][codes[1]], b = luts[2][codes[2]];
  assert.ok(Math.max(r, g, b) - Math.min(r, g, b) < 0.01, `${r} ${g} ${b}`);
});

test('Tonkurve ist monoton und bildet 0..1 ab', () => {
  const f = toneFunction(defaultSettings().tone);
  assert.ok(Math.abs(f(0)) < 0.03);
  // Weißpunkt knapp unter Weiß (weiche Schulter), Spitzlichter nie über 1
  assert.ok(f(1) > 0.85 && f(1) < 0.98, `f(1) = ${f(1)}`);
  assert.ok(f(1.5) <= 1 && f(1.5) > f(1));
  let prev = -Infinity;
  for (let i = 0; i <= 200; i++) {
    const v = f(-0.2 + (1.4 * i) / 200);
    assert.ok(v >= prev - 1e-9);
    prev = v;
  }
});

test('Drehen und Spiegeln bilden Pixel exakt ab', () => {
  const img = createImage(3, 2);
  for (let i = 0; i < 6; i++) img.data[i * 3] = i * 1000;
  const geom = { rotation: 90, flipH: false, flipV: false, angle: 0 };
  const [w, h] = orientedSize(3, 2, 90);
  const out = extract(img, makeMapping(img, geom, { x: 0, y: 0, w: 1, h: 1 }, w, h), w, 0, h);
  // 90° im Uhrzeigersinn: oberste Zeile des Ergebnisses = linke Spalte von unten nach oben
  assert.deepEqual([out.data[0], out.data[3]], [3000, 0]);
  assert.deepEqual([out.data[4 * 3], out.data[5 * 3]], [5000, 2000]);
});

test('Einstellungen werden mit Standardwerten ergänzt', () => {
  const s = normalizeSettings({ tone: { exposure: 1 } });
  assert.equal(s.tone.exposure, 1);
  assert.equal(s.tone.contrast, defaultSettings().tone.contrast);
  assert.ok(s.hsl.red);
});

test('16-Bit-TIFF schreiben und lesen', async () => {
  const w = 5, h = 3;
  const px = new Uint16Array(w * h * 3).map((_, i) => i * 997);
  const buf = encodeTiff16(w, h, px);
  const img = await decodeTiff(buf);
  assert.equal(img.width, w);
  assert.equal(img.height, h);
  assert.deepEqual(Array.from(img.data), Array.from(px));
});

test('Positiv-Modus gibt einen Scan nahezu unverändert aus', () => {
  const img = createImage(64, 8);
  for (let x = 0; x < 64; x++) {
    for (let y = 0; y < 8; y++) {
      const i = (y * 64 + x) * 3;
      const v = 0.03 + (0.95 * x) / 63;
      img.data[i] = Math.round(v * 65535);
      img.data[i + 1] = Math.round(v * 0.8 * 65535);
      img.data[i + 2] = Math.round(v * 0.6 * 65535);
    }
  }
  const s = defaultSettings();
  s.film.type = 'positive';
  s.film.linked = true;
  s.film.border = 0;
  s.film.clipBlack = 0;
  s.film.clipWhite = 0;
  s.tone = { ...s.tone, contrast: 0, highlights: 0, shadows: 0 };
  s.color.vibrance = 0;
  const levels = analyze(img, s);
  const out = processToFloat(img, s, levels, buildLUTs(s, levels));
  // Farbverhältnis in den Mitteltönen bleibt erhalten (gekoppelte Kanäle)
  const i = (4 * 64 + 40) * 3;
  assert.ok(out[i] > out[i + 1] && out[i + 1] > out[i + 2], 'Farbbalance muss erhalten bleiben');
  const err = Math.abs(out[i] - img.data[i] / 65535);
  assert.ok(err < 0.08, `Abweichung zu groß: ${err}`);
});

test('Belichtung lässt Schwarz schwarz', () => {
  const t = defaultSettings().tone;
  for (const ev of [-2, -1, 1, 2]) {
    const f = toneFunction({ ...t, exposure: ev, blacks: 0 });
    assert.ok(Math.abs(f(0)) < 0.02, `EV ${ev}: ${f(0)}`);
  }
});

test('Bildfeld wird trotz Filmhalter und Filmrand erkannt', async () => {
  const { detectFrameInImage } = await import('../js/core/autocrop.js');
  const W = 300, H = 200;
  const img = createImage(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      let px;
      if (x < 40 || x >= 260) px = [2000, 2000, 2200];                       // Halter
      else if (x < 55 || x >= 245 || y < 15 || y >= 185) px = [64000, 58000, 47000]; // Filmbasis
      else {
        const t = (x * 7 + y * 13) % 100 / 100;                             // Bildinhalt
        px = [30000 + t * 20000, 16000 + t * 15000, 5000 + t * 10000];
      }
      img.data.set(px, i);
    }
  }
  const r = detectFrameInImage(img, 'color');
  assert.ok(r, 'Rahmen muss erkannt werden');
  assert.ok(Math.abs(r.x - 55 / W) < 0.02 && Math.abs(r.x + r.w - 245 / W) < 0.02, JSON.stringify(r));
  assert.ok(Math.abs(r.y - 15 / H) < 0.02 && Math.abs(r.y + r.h - 185 / H) < 0.02, JSON.stringify(r));
});

test('Beschnittener Kanal im Scan: Schwarzpunkt wird geschätzt und rekonstruiert', () => {
  // Graukeil, Rotkanal in den dünnen Bereichen (Schatten) bei 100 % abgeschnitten
  const img = syntheticNegative(200, 10);
  for (let i = 0; i < img.data.length; i += 3) img.data[i] = Math.min(65535, Math.round(img.data[i] * 1.6));
  const s = defaultSettings();
  s.film.border = 0;
  s.color.vibrance = 0;
  const levels = analyze(img, s);
  assert.ok(levels.clip && levels.clip[0] > 0 && !levels.clip[1], 'Clipping im Rotkanal muss erkannt werden');
  const out = processToFloat(img, s, levels, buildLUTs(s, levels));
  // Mitteltöne bleiben neutral
  const i = (5 * 200 + 120) * 3;
  assert.ok(Math.abs(out[i] - out[i + 1]) < 0.05 && Math.abs(out[i + 1] - out[i + 2]) < 0.05, `${out[i]} ${out[i + 1]} ${out[i + 2]}`);
});

test('Bei Nachbarbildern im Scan wird das mittlere, größte Bild gewählt', async () => {
  const { detectFrameInImage } = await import('../js/core/autocrop.js');
  const W = 400, H = 200;
  const img = createImage(W, H);
  const isImage = (x) => (x >= 10 && x < 60) || (x >= 80 && x < 320) || (x >= 340 && x < 395);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = ((x * 7 + y * 13) % 100) / 100;
      const px = isImage(x) && y >= 12 && y < 188
        ? [30000 + t * 20000, 16000 + t * 15000, 5000 + t * 10000]
        : [64000, 58000, 47000];
      img.data.set(px, (y * W + x) * 3);
    }
  }
  const r = detectFrameInImage(img, 'color');
  assert.ok(r, 'Rahmen muss erkannt werden');
  assert.ok(Math.abs(r.x - 80 / W) < 0.02 && Math.abs(r.x + r.w - 320 / W) < 0.02, JSON.stringify(r));
});
