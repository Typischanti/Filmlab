// Kern der Negativumwandlung.
//
// Ablauf pro Pixel:
//  1. Scanwert -> lineare Transmission (sRGB-Gamma entfernen, falls nötig)
//  2. Transmission -> optische Dichte (log10). Im Dichteraum wird die orange
//     Maske eines Farbnegativs zu einem einfachen Versatz pro Kanal, und die
//     unterschiedlichen Gradationen der drei Farbschichten zu einem Faktor.
//  3. Pro Kanal Schwarz-/Weißpunkt aus der Bildanalyse -> normierte
//     Log-Belichtung x (0 = tiefste Schatten, 1 = hellste Lichter).
//  4. Weißabgleich und Belichtung als Verschiebung in x (= Multiplikation
//     im linearen Licht, also physikalisch korrekt).
//  5. Tonwertkurve (Log -> linear -> sRGB, weiche Schulter, S-Kurve).
//  6. Farbe: Dynamik/Sättigung mit farbtonerhaltender Gamut-Begrenzung,
//     HSL-Farbmischer, Color Grading.
//  7. Schärfen (Unscharf maskieren auf der Luminanz).
//
// Schritte 1–5 sind pro Kanal separierbar und werden als 16-Bit-LUT berechnet.

import { srgbToLinear, linearToSrgb, luma, hueOf, hueVector, clamp, smoothstep } from './color.js';
import { curveTable, sampleTable, isIdentityCurve } from './spline.js';
import { createImage } from './geometry.js';

export const HSL_BANDS = [
  { key: 'red', label: 'Rot', hue: 0 },
  { key: 'orange', label: 'Orange', hue: 30 },
  { key: 'yellow', label: 'Gelb', hue: 60 },
  { key: 'green', label: 'Grün', hue: 120 },
  { key: 'aqua', label: 'Cyan', hue: 180 },
  { key: 'blue', label: 'Blau', hue: 225 },
  { key: 'purple', label: 'Lila', hue: 275 },
  { key: 'magenta', label: 'Magenta', hue: 320 },
];

const LOG2 = Math.log10(2);
const CODE_MAX = 65535;

export function defaultSettings() {
  const hsl = {};
  for (const b of HSL_BANDS) hsl[b.key] = { h: 0, s: 0, l: 0 };
  return {
    version: 1,
    film: {
      type: 'color',          // 'color' | 'bw' | 'positive'
      inputGamma: 'srgb',     // 'srgb' | 'linear'
      base: null,             // gemessene Filmbasis [r,g,b] linear (0..1)
      blackMode: 'auto',      // 'auto' | 'base'
      clipBlack: 0.1,         // % Pixel, die in Schwarz clippen dürfen
      clipWhite: 0.05,        // % Pixel, die in Weiß clippen dürfen
      border: 4,              // % Rand, der bei der Analyse ignoriert wird
      linked: false,          // Kanäle gemeinsam normieren (Farben des Scans erhalten, Standard bei Dias)
      lockLevels: false,      // Analysewerte einfrieren (z. B. für eine ganze Rolle)
      levels: null,           // { lo:[3], hi:[3] } Dichte-Schwarz/Weißpunkt
      chanBlack: [0, 0, 0],   // Feinabstimmung pro Kanal (-100..100)
      chanWhite: [0, 0, 0],
    },
    tone: {
      exposure: 0,            // Blendenstufen
      contrast: 10,           // -100..100
      range: 8,               // Tonumfang in Blendenstufen (Negativ-Gradation)
      highlights: -10,
      shadows: 10,
      whites: 0,
      blacks: 0,
    },
    wb: { temp: 0, tint: 0 },
    color: { vibrance: 20, saturation: 0 },
    hsl,
    grading: {
      shadows: { hue: 215, sat: 0 },
      midtones: { hue: 40, sat: 0 },
      highlights: { hue: 45, sat: 0 },
      balance: 0,
    },
    curves: {
      master: [[0, 0], [1, 1]],
      r: [[0, 0], [1, 1]],
      g: [[0, 0], [1, 1]],
      b: [[0, 0], [1, 1]],
    },
    detail: { sharpen: 0, radius: 1.0, threshold: 2, grain: 0, grainSize: 1.0 },
    geometry: { rotation: 0, flipH: false, flipV: false, angle: 0, crop: null, aspect: 'free' },
  };
}

// Ergänzt fehlende Felder (ältere Einstellungsdateien, Presets).
export function normalizeSettings(s) {
  const d = defaultSettings();
  const merge = (base, over) => {
    if (over == null || typeof over !== 'object' || Array.isArray(over)) return over ?? base;
    const out = Array.isArray(base) ? [...base] : { ...base };
    for (const k of Object.keys(over)) {
      out[k] = base && typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k])
        ? merge(base[k], over[k])
        : over[k];
    }
    return out;
  };
  return merge(d, s);
}

export function cloneSettings(s) {
  return JSON.parse(JSON.stringify(s));
}

// ---------------------------------------------------------------------------
// Dichtetabellen

const densityCache = new Map();

// Helligkeitsorientierte Dichte pro 16-Bit-Code: größer = heller im Positiv.
export function densityTable(inputGamma, type) {
  const key = inputGamma + ':' + (type === 'positive' ? 'pos' : 'neg');
  let t = densityCache.get(key);
  if (t) return t;
  t = new Float32Array(CODE_MAX + 1);
  const sign = type === 'positive' ? 1 : -1;
  for (let i = 0; i <= CODE_MAX; i++) {
    const v = i / CODE_MAX;
    const lin = Math.max(inputGamma === 'linear' ? v : srgbToLinear(v), 1e-5);
    t[i] = sign * Math.log10(lin);
  }
  densityCache.set(key, t);
  return t;
}

export function densityOfLinear(lin, type) {
  const v = Math.log10(Math.max(lin, 1e-5));
  return type === 'positive' ? v : -v;
}

// ---------------------------------------------------------------------------
// Analyse: Schwarz-/Weißpunkt pro Kanal aus Perzentilen

export function analyze(img, settings) {
  const film = settings.film;
  const W = img.width;
  const H = img.height;
  const bx = Math.floor((W * film.border) / 100);
  const by = Math.floor((H * film.border) / 100);
  const bins = 4096; // 16-Bit-Codes werden auf 12 Bit gruppiert
  const shift = 4;
  const hists = [new Uint32Array(bins), new Uint32Array(bins), new Uint32Array(bins)];
  const d = img.data;
  // Bei 8-Bit-Quellen sind die untersten Stufen reines Quantisierungsrauschen
  const loCut = is8Bit(d) ? 2 * 257 : 16;
  const hiCut = CODE_MAX - 64; // Ausgebrannt (z. B. Perforationslöcher)
  const bw = film.type === 'bw';
  const holderCut = film.type === 'positive' ? 0 : holderThreshold(d);
  for (let y = by; y < H - by; y++) {
    let i = (y * W + bx) * 3;
    for (let x = bx; x < W - bx; x++, i += 3) {
      // Filmhalter/Klammern: viel dunkler als jede Stelle auf dem Film
      if (holderCut && Math.max(d[i], d[i + 1], d[i + 2]) < holderCut) continue;
      if (bw) {
        const g = grayCode(d[i], d[i + 1], d[i + 2]);
        if (g > loCut && g < hiCut) hists[0][g >> shift]++;
      } else {
        for (let c = 0; c < 3; c++) {
          const v = d[i + c];
          if (v > loCut && v < hiCut) hists[c][v >> shift]++;
        }
      }
    }
  }
  if (bw) { hists[1] = hists[0]; hists[2] = hists[0]; }

  const dt = densityTable(film.inputGamma, film.type);
  const pct = (h, p) => {
    let total = 0;
    for (let i = 0; i < bins; i++) total += h[i];
    if (total === 0) return null;
    const target = total * p;
    let acc = 0;
    for (let i = 0; i < bins; i++) {
      acc += h[i];
      if (acc >= target) return (i << shift) + (1 << (shift - 1));
    }
    return CODE_MAX;
  };
  const lo = [0, 0, 0];
  const hi = [0, 0, 0];
  const pb = film.clipBlack / 100;
  const pw = film.clipWhite / 100;
  for (let c = 0; c < 3; c++) {
    const a = pct(hists[c], film.type === 'positive' ? pb : 1 - pb);
    const b = pct(hists[c], film.type === 'positive' ? 1 - pw : pw);
    if (a == null || b == null) { lo[c] = film.type === 'positive' ? -2 : 0; hi[c] = film.type === 'positive' ? 0 : 2; continue; }
    lo[c] = dt[a];
    hi[c] = dt[b];
    if (hi[c] - lo[c] < 0.05) hi[c] = lo[c] + 0.05;
  }

  // Gekoppelt: gemeinsamer Umfang für alle Kanäle, die Farbbalance des
  // Scans bleibt erhalten (Dias, bereits gefilterte Scans).
  if (film.linked && film.type !== 'bw') {
    const l = Math.min(...lo);
    const h = Math.max(...hi);
    for (let c = 0; c < 3; c++) { lo[c] = l; hi[c] = h; }
    return { lo, hi };
  }

  // Schwarzpunkt aus der gemessenen Filmbasis: Die Basis definiert die
  // Farbneutralität der Schatten, die Analyse nur noch die Tiefe.
  if (film.base && film.blackMode === 'base' && film.type === 'color') {
    const db = film.base.map((v) => densityOfLinear(v, film.type));
    let off = 0;
    for (let c = 0; c < 3; c++) off += lo[c] - db[c];
    off /= 3;
    for (let c = 0; c < 3; c++) {
      lo[c] = db[c] + off;
      if (hi[c] - lo[c] < 0.05) hi[c] = lo[c] + 0.05;
    }
  }
  return { lo, hi };
}

// Schwelle für „zu dunkel für Film“: Selbst die dichteste Stelle eines
// Negativs lässt im hellsten Kanal noch deutlich Licht durch.
function holderThreshold(data) {
  const step = Math.max(1, Math.floor(data.length / 3 / 20000)) * 3;
  const m = [];
  for (let i = 0; i < data.length; i += step) m.push(Math.max(data[i], data[i + 1], data[i + 2]));
  m.sort((a, b) => a - b);
  return m[Math.floor(m.length * 0.99)] * 0.12;
}

// Stichprobe: Sind alle Werte Vielfache von 257 (also aus 8 Bit hochskaliert)?
function is8Bit(data) {
  const step = Math.max(1, Math.floor(data.length / 5000));
  for (let i = 0; i < data.length; i += step) if (data[i] % 257 !== 0) return false;
  return true;
}

export function grayCode(r, g, b) {
  return (r * 0.299 + g * 0.587 + b * 0.114 + 0.5) | 0;
}

// ---------------------------------------------------------------------------
// Tonwertkurve

const TONE_SIZE = 8192;
const TONE_MIN = -0.5;
const TONE_MAX = 1.5;

export function contrastK(contrast) {
  return Math.pow(2, contrast / 100);
}

// Basiskurve: normierte Log-Belichtung x -> Anzeigewert (sRGB, 0..1).
export function toneFunction(tone) {
  const R = Math.max(1, tone.range) * LOG2;
  const floor = Math.pow(10, -R);
  const gain = Math.pow(2, tone.exposure);
  const knee = 0.82;
  const shoulder = (v) => (v <= knee ? v : knee + (1 - knee) * Math.tanh((v - knee) / (1 - knee)));
  const norm = 1 / shoulder(1);
  const k = contrastK(tone.contrast);
  const p = 0.45;
  const sh = tone.shadows / 100;
  const hl = tone.highlights / 100;
  const wh = tone.whites / 100;
  const bl = tone.blacks / 100;
  return (x) => {
    // Belichtung multiplikativ im linearen Licht: Schwarz bleibt Schwarz
    const lin = (gain * (Math.pow(10, (x - 1) * R) - floor)) / (1 - floor);
    let v = lin < 0 ? lin * 12.92 : linearToSrgb(lin);
    v = shoulder(v) * norm;
    // S-Kurve um den Mittelton-Drehpunkt
    let y;
    if (v <= 0) y = v * k;
    else if (v >= 1) y = 1;
    else if (v < p) y = p * Math.pow(v / p, k);
    else y = 1 - (1 - p) * Math.pow((1 - v) / (1 - p), k);
    // Tiefen / Lichter / Weiß / Schwarz
    const yc = clamp(y, 0, 1);
    const inv = 1 - yc;
    y += sh * 0.22 * (yc * inv * inv * 6.75);
    y += hl * 0.22 * (yc * yc * inv * 6.75);
    y += wh * 0.12 * yc * yc * yc;
    y += bl * 0.10 * inv * inv * inv;
    return y;
  };
}

export function toneTable(tone) {
  const f = toneFunction(tone);
  const t = new Float32Array(TONE_SIZE);
  for (let i = 0; i < TONE_SIZE; i++) {
    t[i] = f(TONE_MIN + ((TONE_MAX - TONE_MIN) * i) / (TONE_SIZE - 1));
  }
  return t;
}

function sampleTone(t, x) {
  return sampleTable(t, (x - TONE_MIN) / (TONE_MAX - TONE_MIN));
}

// Weißabgleich-Vektoren im x-Raum (0.0015 pro Reglereinheit ≈ ±1,1 Blenden bei 100)
const WB_SCALE = 0.0015;
export function wbOffsets(wb) {
  const t = wb.temp * WB_SCALE;
  const m = wb.tint * WB_SCALE;
  return [t + 0.5 * m, -m, -t + 0.5 * m];
}

// Umkehrung: Kanalverschiebungen -> Temperatur/Tönung (Mittelwert wird ignoriert).
export function offsetsToWb(o) {
  const mean = (o[0] + o[1] + o[2]) / 3;
  const r = o[0] - mean, g = o[1] - mean, b = o[2] - mean;
  return {
    temp: (r - b) / (2 * WB_SCALE),
    tint: (0.5 * r - g + 0.5 * b) / (1.5 * WB_SCALE),
  };
}

// Normierte Log-Belichtung x eines Codes (ohne Weißabgleich).
export function codeToX(code, c, levels, film) {
  const dt = densityTable(film.inputGamma, film.type);
  return channelX(dt[code], c, levels, film);
}

function channelX(d, c, levels, film) {
  const lo = levels.lo[c];
  const hi = levels.hi[c];
  let x = (d - lo) / (hi - lo);
  const cb = (film.chanBlack?.[c] || 0) * 0.002;
  const cw = 1 + (film.chanWhite?.[c] || 0) * 0.002;
  return (x - cb) / (cw - cb);
}

// Bei Dias/Positiven ist der gemessene Umfang bereits der Motivumfang:
// 8 „Blenden“ bedeuten dann „unverändert“, andere Werte skalieren relativ.
export function effectiveTone(settings, levels) {
  if (settings.film.type !== 'positive' || !levels) return settings.tone;
  const span = Math.max(...levels.hi.map((h, c) => h - levels.lo[c]));
  return { ...settings.tone, range: (span / LOG2) * (settings.tone.range / 8) };
}

// Erstellt drei LUTs (16-Bit-Code -> Anzeigewert, float).
export function buildLUTs(settings, levels) {
  const film = settings.film;
  const dt = densityTable(film.inputGamma, film.type);
  const tt = toneTable(effectiveTone(settings, levels));
  const bw = film.type === 'bw';
  const wbo = bw ? [0, 0, 0] : wbOffsets(settings.wb);
  const master = curveTable(settings.curves.master);
  const masterId = isIdentityCurve(settings.curves.master);
  const chans = ['r', 'g', 'b'].map((k) => (isIdentityCurve(settings.curves[k]) ? null : curveTable(settings.curves[k])));
  const luts = [];
  const nChan = bw ? 1 : 3;
  for (let c = 0; c < nChan; c++) {
    const lut = new Float32Array(CODE_MAX + 1);
    const lo = levels.lo[c];
    const span = levels.hi[c] - lo;
    const cb = (film.chanBlack?.[c] || 0) * 0.002;
    const cw = 1 + (film.chanWhite?.[c] || 0) * 0.002;
    const ct = bw ? null : chans[c];
    let prevD = NaN;
    let prevY = 0;
    for (let i = 0; i <= CODE_MAX; i++) {
      const d = dt[i];
      if (d === prevD) { lut[i] = prevY; continue; }
      let x = ((d - lo) / span - cb) / (cw - cb) + wbo[c];
      let y = sampleTone(tt, x);
      if (!masterId) y = sampleTable(master, clamp(y, 0, 1));
      if (ct) y = sampleTable(ct, clamp(y, 0, 1));
      lut[i] = y;
      prevD = d;
      prevY = y;
    }
    luts.push(lut);
  }
  if (bw) { luts.push(luts[0], luts[0]); }
  return luts;
}

// ---------------------------------------------------------------------------
// Farbe

function colorOpsActive(s) {
  if (s.film.type === 'bw') {
    const g = s.grading;
    return g.shadows.sat || g.midtones.sat || g.highlights.sat;
  }
  if (s.color.vibrance || s.color.saturation) return true;
  for (const b of HSL_BANDS) {
    const h = s.hsl[b.key];
    if (h.h || h.s || h.l) return true;
  }
  const g = s.grading;
  return g.shadows.sat || g.midtones.sat || g.highlights.sat;
}

// Gewichte der HSL-Bänder für einen Farbton (Partition der Eins).
function bandWeights(hue, out) {
  out.fill(0);
  const n = HSL_BANDS.length;
  for (let i = 0; i < n; i++) {
    const a = HSL_BANDS[i].hue;
    const b = i + 1 < n ? HSL_BANDS[i + 1].hue : HSL_BANDS[0].hue + 360;
    let h = hue;
    if (h < a) h += 360;
    if (h >= a && h < b) {
      const t = smoothstep((h - a) / (b - a));
      out[i] = 1 - t;
      out[(i + 1) % n] = t;
      return out;
    }
  }
  return out;
}

function prepareColor(s) {
  const bw = s.film.type === 'bw';
  const hslActive = !bw && HSL_BANDS.some((b) => {
    const h = s.hsl[b.key];
    return h.h || h.s || h.l;
  });
  // HSL als Tabelle über 360 Grad vorberechnen
  let hueShift = null, satMul = null, lumAdd = null;
  if (hslActive) {
    hueShift = new Float32Array(361);
    satMul = new Float32Array(361);
    lumAdd = new Float32Array(361);
    const w = new Float32Array(HSL_BANDS.length);
    for (let d = 0; d <= 360; d++) {
      bandWeights(d % 360, w);
      let hs = 0, ss = 0, ls = 0;
      for (let i = 0; i < HSL_BANDS.length; i++) {
        const v = s.hsl[HSL_BANDS[i].key];
        hs += w[i] * v.h;
        ss += w[i] * v.s;
        ls += w[i] * v.l;
      }
      hueShift[d] = hs * 0.3;        // ±30°
      satMul[d] = 1 + ss / 100;      // 0..2
      lumAdd[d] = ls / 100 * 0.25;   // ±0,25
    }
  }
  const g = s.grading;
  const grade = [g.shadows, g.midtones, g.highlights].map((z) => {
    const v = hueVector(z.hue);
    const a = (z.sat / 100) * 0.18;
    return [v[0] * a, v[1] * a, v[2] * a];
  });
  return {
    bw,
    sat: 1 + s.color.saturation / 100,
    vib: s.color.vibrance / 100,
    hslActive, hueShift, satMul, lumAdd,
    gradeActive: !!(g.shadows.sat || g.midtones.sat || g.highlights.sat),
    grade,
    balance: g.balance / 100,
  };
}

// Rodrigues-Drehung um die Grauachse.
function rotateHue(rgb, deg) {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const k = (1 - c) / 3;
  const q = s / Math.sqrt(3);
  const r = rgb[0], g = rgb[1], b = rgb[2];
  rgb[0] = r * (c + k) + g * (k - q) + b * (k + q);
  rgb[1] = r * (k + q) + g * (c + k) + b * (k - q);
  rgb[2] = r * (k - q) + g * (k + q) + b * (c + k);
}

function applyColor(buf, n, P) {
  const px = [0, 0, 0];
  for (let i = 0; i < n * 3; i += 3) {
    let r = buf[i], g = buf[i + 1], b = buf[i + 2];

    if (!P.bw) {
      // HSL-Farbmischer
      if (P.hslActive) {
        const h = hueOf(r, g, b);
        if (h >= 0) {
          const hi = h | 0;
          const max = Math.max(r, g, b);
          const chroma = max - Math.min(r, g, b);
          const amt = clamp(chroma * 2.5, 0, 1); // Graustufen bleiben unberührt
          const hs = P.hueShift[hi] * amt;
          if (hs) {
            px[0] = r; px[1] = g; px[2] = b;
            rotateHue(px, hs);
            r = px[0]; g = px[1]; b = px[2];
          }
          const y = luma(r, g, b);
          const sm = 1 + (P.satMul[hi] - 1) * amt;
          r = y + (r - y) * sm;
          g = y + (g - y) * sm;
          b = y + (b - y) * sm;
          const la = P.lumAdd[hi] * amt;
          if (la) {
            r *= 1 + la; g *= 1 + la; b *= 1 + la;
          }
        }
      }

      // Dynamik + Sättigung, farbtonerhaltend und gamut-sicher
      let factor = P.sat;
      if (P.vib) {
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const chroma = clamp(max - min, 0, 1);
        let v = P.vib * (1 - chroma) * (1 - chroma);
        if (P.vib > 0) {
          // Hauttöne (Orange) schonen
          const h = hueOf(r, g, b);
          if (h >= 0) {
            const dh = Math.abs(((h - 25 + 540) % 360) - 180);
            const skin = dh < 30 ? 1 - dh / 30 : 0;
            v *= 1 - 0.5 * skin;
          }
        }
        factor *= 1 + v;
      }
      if (factor !== 1) {
        const y = luma(r, g, b);
        let dr = r - y, dg = g - y, db = b - y;
        let f = factor;
        if (f > 1 && y > 0 && y < 1) {
          // Maximaler Faktor, der im Gamut bleibt
          let lim = Infinity;
          for (const d of [dr, dg, db]) {
            if (d > 1e-6) lim = Math.min(lim, (1 - y) / d);
            else if (d < -1e-6) lim = Math.min(lim, -y / d);
          }
          if (lim < f) {
            // weich gegen die Gamut-Grenze laufen statt hart zu clippen
            const base = Math.min(1, lim);
            if (lim > 1) {
              const room = lim - 1;
              const want = f - 1;
              f = 1 + room * Math.tanh(want / room);
            } else {
              f = base;
            }
          }
        }
        r = y + dr * f;
        g = y + dg * f;
        b = y + db * f;
      }
    }

    // Color Grading (Schatten / Mitteltöne / Lichter)
    if (P.gradeActive) {
      const y = clamp(luma(r, g, b) + P.balance * 0.25, 0, 1);
      const ws = (1 - y) * (1 - y);
      const wh = y * y;
      const wm = Math.max(0, 1 - ws - wh) * 2;
      const G = P.grade;
      r += G[0][0] * ws + G[1][0] * wm + G[2][0] * wh;
      g += G[0][1] * ws + G[1][1] * wm + G[2][1] * wh;
      b += G[0][2] * ws + G[1][2] * wm + G[2][2] * wh;
    }

    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b;
  }
}

// ---------------------------------------------------------------------------
// Schärfen (Unscharf maskieren auf der Luminanz) und Korn

function boxBlurH(src, dst, w, h, r) {
  const norm = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[o + clamp(k, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      dst[o + x] = acc * norm;
      acc += src[o + Math.min(w - 1, x + r + 1)] - src[o + Math.max(0, x - r)];
    }
  }
}

function boxBlurV(src, dst, w, h, r) {
  const norm = 1 / (2 * r + 1);
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[clamp(k, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = acc * norm;
      acc += src[Math.min(h - 1, y + r + 1) * w + x] - src[Math.max(0, y - r) * w + x];
    }
  }
}

// Gauß-Näherung durch drei Boxfilter.
export function gaussianBlur(buf, w, h, sigma) {
  if (sigma < 0.3) return buf;
  const r = Math.max(1, Math.round(Math.sqrt((12 * sigma * sigma) / 3 + 1) / 2 - 0.5));
  const a = new Float32Array(buf);
  const b = new Float32Array(buf.length);
  for (let i = 0; i < 3; i++) {
    boxBlurH(a, b, w, h, r);
    boxBlurV(b, a, w, h, r);
  }
  return a;
}

function applySharpen(buf, w, h, detail, scale) {
  const amount = detail.sharpen / 100 * 1.5;
  const sigma = detail.radius * scale;
  const n = w * h;
  const Y = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 3) Y[i] = luma(buf[j], buf[j + 1], buf[j + 2]);
  const B = gaussianBlur(Y, w, h, Math.max(0.35, sigma));
  const th = (detail.threshold / 100) * 0.1;
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    let dlt = Y[i] - B[i];
    const a = Math.abs(dlt);
    if (a < th) dlt *= a / th; // Schwelle: Rauschen nicht verstärken
    const add = dlt * amount;
    buf[j] += add; buf[j + 1] += add; buf[j + 2] += add;
  }
}

// Deterministisches Rauschen, damit Vorschau und Export übereinstimmen.
function hashNoise(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967295) * 2 - 1;
}

function applyGrain(buf, w, h, detail, scale, origin) {
  const amount = detail.grain / 100 * 0.12;
  const size = Math.max(0.5, detail.grainSize);
  const n = w * h;
  const N = new Float32Array(n);
  // Rauschen in Bildkoordinaten (Originalauflösung) erzeugen
  const inv = 1 / (scale * size);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx = Math.floor((origin[0] + x) * inv);
      const gy = Math.floor((origin[1] + y) * inv);
      N[y * w + x] = hashNoise(gx, gy, 7);
    }
  }
  const B = gaussianBlur(N, w, h, 0.5 * scale * size);
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    const y = clamp(luma(buf[j], buf[j + 1], buf[j + 2]), 0, 1);
    const m = 4 * y * (1 - y); // Korn vor allem in den Mitteltönen
    const add = B[i] * amount * m * 1.8;
    buf[j] += add; buf[j + 1] += add; buf[j + 2] += add;
  }
}

// ---------------------------------------------------------------------------
// Rendern

// Verarbeitet ein (bereits ausgeschnittenes) 16-Bit-Bild zu Float-RGB.
// opts.scale: Verhältnis Vorschau/Original (für Radien), opts.origin: Position im Original.
export function processToFloat(img, settings, levels, luts, opts = {}) {
  const n = img.width * img.height;
  const buf = opts.buffer && opts.buffer.length === n * 3 ? opts.buffer : new Float32Array(n * 3);
  const d = img.data;
  const [lr, lg, lb] = luts;
  if (settings.film.type === 'bw') {
    for (let i = 0; i < n * 3; i += 3) {
      const y = lr[grayCode(d[i], d[i + 1], d[i + 2])];
      buf[i] = y; buf[i + 1] = y; buf[i + 2] = y;
    }
  } else {
    for (let i = 0; i < n * 3; i += 3) {
      buf[i] = lr[d[i]];
      buf[i + 1] = lg[d[i + 1]];
      buf[i + 2] = lb[d[i + 2]];
    }
  }
  if (colorOpsActive(settings)) applyColor(buf, n, prepareColor(settings));
  const scale = opts.scale ?? 1;
  if (settings.detail.sharpen > 0) applySharpen(buf, img.width, img.height, settings.detail, scale);
  if (settings.detail.grain > 0) applyGrain(buf, img.width, img.height, settings.detail, scale, opts.origin || [0, 0]);
  return buf;
}

export function floatToRGBA(buf, out, opts = {}) {
  const n = buf.length / 3;
  const warn = opts.clipWarn;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    let r = buf[i * 3], g = buf[i * 3 + 1], b = buf[i * 3 + 2];
    if (warn) {
      // Lichter, die in allen Kanälen ausfressen -> rot; abgesoffene Tiefen -> blau
      if (r >= 0.999 && g >= 0.999 && b >= 0.999) { r = 1; g = 0.1; b = 0.1; }
      else if (r <= 0.001 && g <= 0.001 && b <= 0.001) { r = 0.1; g = 0.35; b = 1; }
    }
    out[j] = clamp(r, 0, 1) * 255 + 0.5;
    out[j + 1] = clamp(g, 0, 1) * 255 + 0.5;
    out[j + 2] = clamp(b, 0, 1) * 255 + 0.5;
    out[j + 3] = 255;
  }
  return out;
}

export function floatToU16(buf) {
  const out = new Uint16Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = clamp(buf[i], 0, 1) * 65535 + 0.5;
  return out;
}

// Histogramm (256 Bins pro Kanal + Luminanz) aus RGBA-Daten.
export function histogramRGBA(rgba) {
  const h = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    h[0][r]++; h[1][g]++; h[2][b]++;
    h[3][(r * 54 + g * 183 + b * 19) >> 8]++;
  }
  return h;
}

// Ungerenderte Ansicht des Scans (für Vorher/Nachher).
export function rawToRGBA(img, out) {
  const d = img.data;
  for (let i = 0, j = 0; i < d.length; i += 3, j += 4) {
    out[j] = d[i] >> 8; out[j + 1] = d[i + 1] >> 8; out[j + 2] = d[i + 2] >> 8; out[j + 3] = 255;
  }
  return out;
}

// Mittelwert eines Bereichs (für Pipetten), Codes 0..65535.
export function sampleArea(img, cx, cy, radius) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = Math.max(0, cy - radius); y <= Math.min(img.height - 1, cy + radius); y++) {
    for (let x = Math.max(0, cx - radius); x <= Math.min(img.width - 1, cx + radius); x++) {
      const i = (y * img.width + x) * 3;
      r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++;
    }
  }
  return n ? [r / n, g / n, b / n] : [0, 0, 0];
}

export function codeToLinear(code, inputGamma) {
  const v = code / CODE_MAX;
  return inputGamma === 'linear' ? v : srgbToLinear(v);
}

// Weißabgleich so setzen, dass der gemessene Bereich neutral wird.
export function neutralWb(codes, settings, levels) {
  const film = settings.film;
  const dt = densityTable(film.inputGamma, film.type);
  const x = codes.map((v, c) => {
    // Interpolation zwischen Codes für Genauigkeit
    const i = clamp(Math.floor(v), 0, CODE_MAX - 1);
    const f = v - i;
    const d = dt[i] * (1 - f) + dt[i + 1] * f;
    return channelX(d, c, levels, film);
  });
  const mean = (x[0] + x[1] + x[2]) / 3;
  const wb = offsetsToWb(x.map((v) => mean - v));
  return { temp: Math.round(clamp(wb.temp, -100, 100)), tint: Math.round(clamp(wb.tint, -100, 100)) };
}

// Automatische Belichtung: Median der Luminanz Richtung Mittelgrau legen,
// ohne Spitzlichter ausfressen bzw. tiefe Schatten absaufen zu lassen.
export function autoExposure(img, settings, levels) {
  const film = settings.film;
  const dt = densityTable(film.inputGamma, film.type);
  const wbo = film.type === 'bw' ? [0, 0, 0] : wbOffsets(settings.wb);
  const n = img.width * img.height;
  const step = Math.max(1, Math.floor(n / 12000));
  const xs = [];
  const d = img.data;
  for (let i = 0; i < n; i += step) {
    const j = i * 3;
    if (film.type === 'bw') {
      const x = channelX(dt[grayCode(d[j], d[j + 1], d[j + 2])], 0, levels, film);
      xs.push(x, x, x);
    } else {
      for (let c = 0; c < 3; c++) xs.push(channelX(dt[d[j + c]], c, levels, film) + wbo[c]);
    }
  }
  const m = xs.length / 3;
  const L = new Float32Array(m);
  const stats = (ev) => {
    const f = toneFunction({ ...effectiveTone(settings, levels), exposure: ev });
    for (let k = 0; k < m; k++) L[k] = luma(f(xs[k * 3]), f(xs[k * 3 + 1]), f(xs[k * 3 + 2]));
    const sorted = Float32Array.from(L).sort();
    const at = (p) => sorted[Math.min(m - 1, Math.floor(p * m))];
    return { med: at(0.5), hi: at(0.995) };
  };
  const target = 0.42;
  const base = stats(0);
  let best = 0;
  let bestErr = Math.abs(base.med - target);
  for (let ev = -2; ev <= 2.001; ev += 0.1) {
    const st = stats(ev);
    if (ev > 0 && (base.hi > 0.95 || st.hi > 0.97)) continue;  // Lichter schützen
    const err = Math.abs(st.med - target);
    if (err < bestErr - 1e-4) { bestErr = err; best = ev; }
  }
  // gedämpft anwenden, damit Low-Key/High-Key-Bilder ihren Charakter behalten
  return Math.round(best * (best > 0 ? 0.5 : 0.7) * 20) / 20;
}

export { createImage };
