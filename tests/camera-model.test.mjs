// Tests für das Filmmodell der Kamera-App (camera/js/model.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { FILMS } from '../camera/js/films.js';
import {
  buildUniforms, filmPixel, normalizeSettings, cropRect, fitArea, deviceRotation,
  dateStampText, makeLeaks, wbOffsets,
} from '../camera/js/model.js';

const MID = 0.4613; // sRGB-Wert von 18 % Grau
const ANALYTIC = FILMS.filter((f) => f.type !== 'lut');

test('Mittelgrau bleibt bei jedem Film neutral und 18 % hell', () => {
  for (const f of ANALYTIC) {
    const U = buildUniforms({ film: f.id, temp: -f.temp, tint: -f.tint });
    const out = filmPixel([MID, MID, MID], U);
    for (const v of out) assert.ok(Math.abs(v - MID) < 0.02, `${f.id}: ${out}`);
  }
});

test('Grautreppe ist monoton, Lichter laufen weich aus, Schwarz bleibt dunkel', () => {
  for (const f of ANALYTIC) {
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

test('Dynamik hebt zurückhaltende Farben stärker an als kräftige', () => {
  const sat = (c) => Math.max(...c) - Math.min(...c);
  const muted = [0.55, 0.48, 0.42];
  const vivid = [0.85, 0.25, 0.12];
  const withVib = buildUniforms({ film: 'alltag400' });
  const noVib = { ...withVib, vib: 0 };
  const gainMuted = sat(filmPixel(muted, withVib)) / sat(filmPixel(muted, noVib));
  const gainVivid = sat(filmPixel(vivid, withVib)) / sat(filmPixel(vivid, noVib));
  assert.ok(gainMuted > 1.15, `zurückhaltend ${gainMuted}`);
  assert.ok(gainVivid < gainMuted && gainVivid < 1.1, `kräftig ${gainVivid}`);
  // Grau bleibt grau
  const g = filmPixel([0.4613, 0.4613, 0.4613], buildUniforms({ film: 'alltag400', temp: -0.3, tint: 0.08 }));
  assert.ok(sat(g) < 0.02);
});

test('Belichtungsumfang: Dia frisst früh aus, Negativ behält Zeichnung in den Lichtern', async () => {
  const { filmPixelLinear, srgbToLinear: lin } = await import('../camera/js/model.js');
  const out = (film, stops) => {
    const L = 0.18 * 2 ** stops;
    const v = filmPixelLinear([L, L, L], buildUniforms({ film, grain: 0 })).map(lin);
    return (v[0] + v[1] + v[2]) / 3;
  };
  // Jeder Film erreicht Weiß ungefähr dort, wo sein Umfang endet
  for (const f of ANALYTIC) {
    if (f.over > 4.5) continue;
    assert.ok(Math.abs(out(f.id, f.over) - 0.95) < 0.01, `${f.id} bei +${f.over}`);
  }
  assert.ok(out('chrom50', 2.5) > 0.98, 'Dia bei +2,5 Blenden ausgefressen');
  assert.ok(out('pastell400', 3) < 0.8, 'Negativ bei +3 Blenden noch mit Zeichnung');
  assert.ok(out('kino500t', 4) < out('vivid100', 4), 'Kinofilm weicher als Vivid');
  // Mittelgrau bleibt bei allen Filmen erhalten
  for (const f of ANALYTIC) assert.ok(Math.abs(out(f.id, 0) - 0.18) < 0.02, `${f.id} Mittelgrau`);
});

test('Lichter-Rekonstruktion: Mitteltöne unverändert, Weiß wird zu hellem Szenenlicht', async () => {
  const { expandHighlights, HL_MAX } = await import('../camera/js/model.js');
  assert.deepEqual(expandHighlights([0.3, 0.2, 0.1]), [0.3, 0.2, 0.1]);
  const w = expandHighlights([1, 1, 1]);
  assert.ok(Math.abs(w[0] - HL_MAX) < 1e-9);
  const c = expandHighlights([0.9, 0.45, 0.3]);
  assert.ok(c[0] > 0.9 && Math.abs(c[1] / c[0] - 0.5) < 1e-9, 'Farbton bleibt');
});

test('Spektrale Filme: LUTs vollständig, Grau neutral, Mittelgrau erhalten', async () => {
  const fs = await import('node:fs');
  const { registerLut, filmPixelLinear, srgbToLinear: lin } = await import('../camera/js/model.js');
  const dir = new URL('../camera/luts/', import.meta.url);
  const idx = JSON.parse(fs.readFileSync(new URL('index.json', dir), 'utf8'));
  for (const f of FILMS.filter((x) => x.type === 'lut')) {
    const data = new Uint8Array(fs.readFileSync(new URL(`${f.lut}.bin`, dir)));
    assert.equal(data.length, idx.size ** 3 * 3, `${f.lut} Größe`);
    registerLut(f.lut, { size: idx.size, min: idx.min, max: idx.max, data });
    const U = buildUniforms({ film: f.id, grain: 0 });
    assert.equal(U.type, 2);
    for (const st of [-4, -1, 0, 1, 3]) {
      const L = 0.18 * 2 ** st;
      const o = filmPixelLinear([L, L, L], U);
      assert.ok(Math.max(...o) - Math.min(...o) < 0.02, `${f.id} grau bei ${st}: ${o}`);
    }
    const mid = filmPixelLinear([0.18, 0.18, 0.18], U).map(lin);
    assert.ok(Math.abs(mid[1] - 0.18) < 0.03, `${f.id} Mittelgrau ${mid[1]}`);
  }
});
