// Tests für das Filmmodell der Kamera-App (camera/js/model.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { FILMS } from '../camera/js/films.js';
import {
  buildUniforms, filmPixel, normalizeSettings, cropRect, fitArea, deviceRotation,
  dateStampText, makeLeaks, wbOffsets,
} from '../camera/js/model.js';

const MID = 0.4613; // sRGB-Wert von 18 % Grau

test('Mittelgrau bleibt bei jedem Film neutral und 18 % hell', () => {
  for (const f of FILMS) {
    const U = buildUniforms({ film: f.id, temp: -f.temp, tint: -f.tint });
    const out = filmPixel([MID, MID, MID], U);
    for (const v of out) assert.ok(Math.abs(v - MID) < 0.02, `${f.id}: ${out}`);
  }
});

test('Grautreppe ist monoton, Lichter laufen weich aus, Schwarz bleibt dunkel', () => {
  for (const f of FILMS) {
    const U = buildUniforms({ film: f.id });
    let prev = -1;
    for (let x = 0; x <= 1.0001; x += 0.02) {
      const y = filmPixel([x, x, x], U);
      const l = (y[0] + y[1] + y[2]) / 3;
      assert.ok(l >= prev - 1e-6, `${f.id} nicht monoton bei ${x}`);
      prev = l;
    }
    const black = filmPixel([0, 0, 0], U);
    const white = filmPixel([1, 1, 1], U);
    assert.ok(Math.max(...black) < 0.08, `${f.id} Schwarz ${black}`);
    assert.ok(Math.min(...white) > 0.8, `${f.id} Weiß ${white}`);
  }
});

test('Belichtung macht heller, Temperatur wärmer, Verblassen hebt Schwarz an', () => {
  const base = buildUniforms({ film: 'pastell400' });
  const g = filmPixel([0.3, 0.3, 0.3], base);
  const bright = filmPixel([0.3, 0.3, 0.3], buildUniforms({ film: 'pastell400', ev: 1 }));
  assert.ok(bright[1] > g[1] + 0.05);
  const warm = filmPixel([0.4, 0.4, 0.4], buildUniforms({ film: 'pastell400', temp: 1 }));
  const cool = filmPixel([0.4, 0.4, 0.4], buildUniforms({ film: 'pastell400', temp: -1 }));
  assert.ok(warm[0] - warm[2] > cool[0] - cool[2] + 0.05);
  const faded = filmPixel([0, 0, 0], buildUniforms({ film: 'pastell400', fade: 1 }));
  assert.ok(faded[1] > filmPixel([0, 0, 0], base)[1] + 0.1);
  const o = wbOffsets(0.7, -0.3);
  assert.ok(Math.abs(o[0] + o[1] + o[2]) < 1e-12);
});

test('Sättigung: Diafilm kräftiger als Porträtfilm', () => {
  const sat = (c) => Math.max(...c) - Math.min(...c);
  const red = [0.75, 0.3, 0.25];
  assert.ok(sat(filmPixel(red, buildUniforms({ film: 'chrom50' }))) > sat(filmPixel(red, buildUniforms({ film: 'pastell400' }))));
});

test('Zuschnitt folgt der langen Bildseite', () => {
  assert.deepEqual(cropRect(4032, 3024, '3:2'), { x: 0, y: 168, w: 4032, h: 2688 });
  assert.deepEqual(cropRect(3024, 4032, '3:2'), { x: 168, y: 0, w: 2688, h: 4032 });
  const c = cropRect(3024, 4032, '2.39');
  assert.ok(Math.abs(c.h / c.w - 2.39) < 0.01);
  assert.deepEqual(cropRect(100, 50, 'orig'), { x: 0, y: 0, w: 100, h: 50 });
  const f = fitArea(6000, 4000);
  assert.ok(f.w * f.h <= 16_000_000 && f.w / f.h > 1.49);
});

test('Lage aus der Schwerkraft (iOS-Konvention)', () => {
  assert.equal(deviceRotation(0, -9.8, 0, 0), 0);
  assert.equal(deviceRotation(-9.8, 0, 0, 0), 90);
  assert.equal(deviceRotation(9.8, 0, 0, 0), 270);
  assert.equal(deviceRotation(0, 9.8, 0, 0), 180);
  assert.equal(deviceRotation(0.2, -0.3, -9.7, 90), 90); // flach: bleibt
  assert.equal(deviceRotation(-6.9, -6.9, 0, 0), 0); // Diagonale: Hysterese
});

test('Lichtlecks sind reproduzierbar, Einstellungen werden bereinigt', () => {
  assert.deepEqual(makeLeaks(42, 0.6), makeLeaks(42, 0.6));
  assert.notDeepEqual(makeLeaks(42, 0.6), makeLeaks(43, 0.6));
  const s = normalizeSettings({ film: 'kino500t', ev: 99, aspect: 'quatsch', date: 1, seed: 7 });
  assert.equal(s.ev, 2);
  assert.equal(s.aspect, '3:2');
  assert.equal(s.date, true);
  assert.equal(s.seed, 7);
  assert.equal(dateStampText(new Date(2026, 9, 31).getTime()), "'26 10 31");
  assert.equal(dateStampText(new Date(2026, 2, 5).getTime()), "'26  3 05");
});
