// Automatische Erkennung des Bildfelds in einem Scan, der auch Filmhalter,
// unbelichteten Filmrand (Filmbasis) oder Leuchtpult zeigt.
//
// Vorgehen: Jedes Pixel wird als „Halter“ (viel dunkler als alles auf dem
// Film), „Filmrand“ (Farbe der Filmbasis) oder „Bild“ klassifiziert. Über
// Zeilen- und Spaltenprofile wird dann das größte zusammenhängende Rechteck
// mit überwiegend Bildpixeln gesucht.

import { makeMapping, extract, fitDownscale, orientedSize } from './geometry.js';

const MAX_DIM = 600;

// Liefert einen normierten Zuschnitt {x,y,w,h} im ausgerichteten Bild
// (ohne Begradigung) oder null, wenn kein Rahmen erkennbar ist.
export function detectFrame(src, settings) {
  const small = fitDownscale(src, MAX_DIM);
  const geom = { ...settings.geometry, angle: 0 };
  const [w, h] = orientedSize(small.width, small.height, geom.rotation);
  const img = extract(small, makeMapping(small, geom, { x: 0, y: 0, w: 1, h: 1 }, w, h), w, 0, h);
  return detectFrameInImage(img, settings.film.type);
}

export function detectFrameInImage(img, type) {
  const { width: W, height: H, data: d } = img;
  const n = W * H;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) lum[i] = (d[i * 3] + d[i * 3 + 1] + d[i * 3 + 2]) / (3 * 65535);
  const sorted = Float32Array.from(lum).sort();
  const bright = sorted[Math.floor(n * 0.99)];
  if (bright < 0.05) return null;

  // Halter: deutlich dunkler als die hellsten Bereiche (Filmbasis/Leuchtpult)
  const holderTh = bright * 0.14;
  const isHolder = new Uint8Array(n);
  for (let i = 0; i < n; i++) isHolder[i] = lum[i] < holderTh ? 1 : 0;

  // Filmbasis: Farbe der hellsten Filmpixel (nicht bei Dias). Beim
  // Farbnegativ ist die Basis orange – neutral-helle Pixel sind Leuchtpult.
  // Alles, was in jedem Kanal mindestens so hell wie die Basis ist, kann
  // nicht zum Bild gehören (Basis, durchscheinendes Licht).
  const isBase = new Uint8Array(n);
  if (type !== 'positive') {
    const cand = (i) => !isHolder[i] && (type !== 'color' || d[i * 3 + 2] < 0.9 * d[i * 3]);
    const film = [];
    for (let i = 0; i < n; i++) if (cand(i)) film.push(lum[i]);
    film.sort((a, b) => a - b);
    if (film.length > n * 0.05) {
      const th = film[Math.floor(film.length * 0.97)];
      const acc = [0, 0, 0];
      let cnt = 0;
      for (let i = 0; i < n; i++) {
        if (cand(i) && lum[i] >= th) {
          acc[0] += d[i * 3]; acc[1] += d[i * 3 + 1]; acc[2] += d[i * 3 + 2]; cnt++;
        }
      }
      const base = acc.map((v) => v / cnt / 65535 - 0.07);
      for (let i = 0; i < n; i++) {
        const j = i * 3;
        if (d[j] / 65535 >= base[0] && d[j + 1] / 65535 >= base[1] && d[j + 2] / 65535 >= base[2]) isBase[i] = 1;
      }
    }
  }

  // Von außen nach innen abtragen, solange eine Zeile/Spalte fast nur aus
  // Halter oder Filmbasis besteht. Schwarze Motivbereiche im Bild (die im
  // Negativ basisfarben sind) bleiben so erhalten.
  const empty = (i) => isHolder[i] || isBase[i];
  const TH = 0.7;
  let x0 = 0, x1 = W, y0 = 0, y1 = H;
  const colFrac = (x) => {
    let c = 0;
    for (let y = y0; y < y1; y++) c += empty(y * W + x);
    return c / Math.max(1, y1 - y0);
  };
  const rowFrac = (y) => {
    let c = 0;
    for (let x = x0; x < x1; x++) c += empty(y * W + x);
    return c / Math.max(1, x1 - x0);
  };
  // Schmale Mischsäume (Filmkante, Halterkante, gewellter Film) dürfen
  // übersprungen werden, wenn direkt dahinter eindeutig Rand folgt.
  const skip = (pos, dir, frac, size) => {
    const look = Math.max(3, Math.round(size * 0.03));
    const need = Math.max(2, Math.round(size * 0.006));
    let run = 0;
    for (let k = 1; k <= look; k++) {
      const p = pos + dir * k;
      if (p < 0 || p >= size) break;
      run = frac(p) > 0.85 ? run + 1 : 0;
      if (run >= need) return k;
    }
    return 0;
  };
  // Steht die Kante in einem Mischsaum, bis zur ersten sauberen Bildzeile vorrücken.
  const settle = (pos, dir, frac, size) => {
    const look = Math.max(3, Math.round(size * 0.04));
    for (let k = 1; k <= look; k++) {
      const p = pos + dir * k;
      if (p < 0 || p >= size) break;
      if (frac(p) < 0.08) return frac(pos) >= 0.08 ? k : 0;
    }
    return 0;
  };
  for (let iter = 0, moved = true; moved && iter < 30; iter++) {
    moved = false;
    while (x1 - x0 > W * 0.1 && colFrac(x0) > TH) { x0++; moved = true; }
    while (x1 - x0 > W * 0.1 && colFrac(x1 - 1) > TH) { x1--; moved = true; }
    while (y1 - y0 > H * 0.1 && rowFrac(y0) > TH) { y0++; moved = true; }
    while (y1 - y0 > H * 0.1 && rowFrac(y1 - 1) > TH) { y1--; moved = true; }
    if (!moved) {
      let k;
      if ((k = skip(x0, 1, colFrac, W))) { x0 += k; moved = true; }
      if ((k = skip(x1 - 1, -1, colFrac, W))) { x1 -= k; moved = true; }
      if ((k = skip(y0, 1, rowFrac, H))) { y0 += k; moved = true; }
      if ((k = skip(y1 - 1, -1, rowFrac, H))) { y1 -= k; moved = true; }
    }
  }
  let k;
  if ((k = settle(x0, 1, colFrac, W))) x0 += k;
  if ((k = settle(x1 - 1, -1, colFrac, W))) x1 -= k;
  if ((k = settle(y0, 1, rowFrac, H))) y0 += k;
  if ((k = settle(y1 - 1, -1, rowFrac, H))) y1 -= k;
  if (x1 - x0 <= W * 0.1 || y1 - y0 <= H * 0.1) return null;

  // etwas nach innen, damit kein Rand stehen bleibt
  const inX = Math.max(1, Math.round((x1 - x0) * 0.008));
  const inY = Math.max(1, Math.round((y1 - y0) * 0.008));
  x0 += inX; x1 -= inX; y0 += inY; y1 -= inY;
  const rect = { x: x0 / W, y: y0 / H, w: (x1 - x0) / W, h: (y1 - y0) / H };
  if (rect.w * rect.h < 0.12) return null;
  if (rect.w > 0.97 && rect.h > 0.97) return null; // bereits randlos
  return rect;
}
