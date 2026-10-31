// Filmmodell der Kamera – reine Mathematik ohne DOM, läuft im Browser und in
// Node.js (Tests). Der Fragment-Shader in gl.js rechnet exakt dasselbe;
// filmPixel() ist die Referenz dazu.
//
// Ablauf pro Pixel (lineares Licht):
//   Szene -> Belichtung -> Vignette/Halation/Lichtleck (zusätzliches Licht)
//   -> Übersprechen in die drei Filmschichten -> log10-Belichtung
//   -> Zwischenschichteffekte (Sättigung im Log-Raum)
//   Farbnegativ: Negativdichte (weicher Fuß) + Korn -> Vergrößerer
//                (Farbfilterung) -> Papiergerade mit Fuß/Schulter
//   Diafilm:     Umkehrkurve mit Fuß/Schulter + Korn
//   -> Farbstoff-Nebenabsorptionen -> Reflexion 10^-D -> Anzeige

import { getFilm } from './films.js';

export const LOG_MID = Math.log10(0.18);
export const NEG_GAMMA = 0.6;
const NEG_TOE = 0.3;
const NEG_DMAX = 2.6;
const E_FLOOR = 1e-5;
const WB_STEP = 0.08; // log10-Belichtung pro Reglereinheit (≈ 0,27 Blenden)

export const ASPECTS = {
  '3:2': 1.5,
  '16:9': 16 / 9,
  '2.39': 2.39,
  orig: 0,
};

export const ASPECT_LABELS = { '3:2': '3:2', '16:9': '16:9', '2.39': '2.39:1', orig: 'Original' };

// Rahmenarten des fertigen Bildes
export const BORDERS = ['none', 'strip', 'print', 'instant'];
export const BORDER_LABELS = { none: 'Ohne Rahmen', strip: 'Filmstreifen', print: 'Laborabzug', instant: 'Sofortbild' };

export const DEFAULT_SETTINGS = Object.freeze({
  film: 'pastell400',
  aspect: '3:2',
  ev: 0,
  temp: 0,
  tint: 0,
  contrast: 0,
  saturation: 0,
  highlights: 0,
  fade: 0,
  grain: 1,
  grainSize: 1,
  halation: 1,
  halationRadius: 1,
  bloom: 0,
  vignette: 0,
  leak: 0,
  leakSeed: 1,
  date: false,
  border: 'none',
});

// Regler: Bereich, Schritt, Anzeige. Die Werte sind Abweichungen vom Film
// (0 bzw. 1 = so, wie der Film ab Werk aussieht).
export const SLIDERS = [
  { group: 'Belichtung & Farbe', key: 'ev', label: 'Belichtung', min: -2, max: 2, step: 0.05, fmt: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1).replace('.', ',')} EV` },
  { group: 'Belichtung & Farbe', key: 'temp', label: 'Temperatur', min: -1, max: 1, step: 0.01, fmt: signed },
  { group: 'Belichtung & Farbe', key: 'tint', label: 'Tönung', min: -1, max: 1, step: 0.01, fmt: signed },
  { group: 'Belichtung & Farbe', key: 'contrast', label: 'Kontrast', min: -1, max: 1, step: 0.01, fmt: signed },
  { group: 'Belichtung & Farbe', key: 'saturation', label: 'Sättigung', min: -1, max: 1, step: 0.01, fmt: signed },
  { group: 'Belichtung & Farbe', key: 'highlights', label: 'Lichter', min: -1, max: 1, step: 0.01, fmt: signed },
  { group: 'Belichtung & Farbe', key: 'fade', label: 'Verblassen', min: 0, max: 1, step: 0.01, fmt: percent },
  { group: 'Film', key: 'grain', label: 'Korn', min: 0, max: 3, step: 0.05, fmt: percent },
  { group: 'Film', key: 'grainSize', label: 'Korngröße', min: 0.5, max: 2.5, step: 0.05, fmt: percent },
  { group: 'Film', key: 'halation', label: 'Halation', min: 0, max: 3, step: 0.05, fmt: percent },
  { group: 'Film', key: 'halationRadius', label: 'Halation-Radius', min: 0.4, max: 2.5, step: 0.05, fmt: percent },
  { group: 'Film', key: 'bloom', label: 'Bloom', min: 0, max: 1, step: 0.01, fmt: percent },
  { group: 'Film', key: 'vignette', label: 'Vignette', min: 0, max: 1, step: 0.01, fmt: percent },
  { group: 'Effekte', key: 'leak', label: 'Lichtleck', min: 0, max: 1, step: 0.01, fmt: percent },
];

function signed(v) {
  const n = Math.round(v * 100);
  return n > 0 ? `+${n}` : `${n}`;
}
function percent(v) {
  return `${Math.round(v * 100)} %`;
}

export function normalizeSettings(s) {
  const out = { ...DEFAULT_SETTINGS };
  if (s && typeof s === 'object') {
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (s[k] === undefined) continue;
      const def = DEFAULT_SETTINGS[k];
      if (typeof def === 'number' && Number.isFinite(Number(s[k]))) out[k] = Number(s[k]);
      else if (typeof def === 'boolean') out[k] = Boolean(s[k]);
      else if (typeof def === 'string' && typeof s[k] === 'string') out[k] = s[k];
    }
    for (const k of ['seed', 'takenAt']) if (Number.isFinite(s[k])) out[k] = s[k];
  }
  // ältere Fotos: frame: true -> Filmstreifen
  if (s && s.border === undefined && s.frame === true) out.border = 'strip';
  if (!BORDERS.includes(out.border)) out.border = 'none';
  if (!(out.aspect in ASPECTS)) out.aspect = DEFAULT_SETTINGS.aspect;
  for (const sl of SLIDERS) out[sl.key] = clamp(out[sl.key], sl.min, sl.max);
  return out;
}

// ---------------------------------------------------------------------------
// Hilfsfunktionen

export function clamp(x, a, b) {
  return x < a ? a : x > b ? b : x;
}

export function softplus(x, k) {
  return Math.max(x, 0) + k * Math.log1p(Math.exp(-Math.abs(x) / k));
}

export function srgbToLinear(v) {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(v) {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

function normalizeRows(m) {
  return m.map((row) => {
    const s = row[0] + row[1] + row[2];
    return row.map((v) => v / s);
  });
}

// Nebenabsorptionen der Farbstoffe (Zeilen: R, G, B; Spalten: C, M, Y),
// für Grau neutral normiert.
const DYES = normalizeRows([
  [1.0, 0.08, 0.02],
  [0.22, 1.0, 0.1],
  [0.08, 0.3, 1.0],
]);

export function dyeMatrix(strength) {
  return DYES.map((row, r) => row.map((v, c) => (r === c ? 1 : 0) * (1 - strength) + v * strength));
}

// Farbfilterung (Weißabgleich) als Verschiebung der Papierbelichtung je
// Schicht; ohne Mittelwert, damit sich die Helligkeit nicht ändert.
// Positive Temperatur = wärmer, positive Tönung = magenta.
export function wbOffsets(temp, tint) {
  const o = [-WB_STEP * temp, WB_STEP * tint, WB_STEP * temp];
  const m = (o[0] + o[1] + o[2]) / 3;
  return o.map((v) => v - m);
}

function paperCurve(Dl, U) {
  const d1 = U.dmin + softplus(Dl - U.dmin, U.toe);
  return U.dmax - softplus(U.dmax - d1, U.shoulder);
}

// Geradendichte, die nach Fuß/Schulter genau die Zieldichte ergibt.
function solveLine(target, U) {
  let lo = target - 1, hi = target + 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (paperCurve(mid, U) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function negDensity(u, g, lat) {
  const dn = g * softplus(u + lat, NEG_TOE);
  return NEG_DMAX - softplus(NEG_DMAX - dn, 0.3);
}

// ---------------------------------------------------------------------------
// Lichter-Rekonstruktion: Das iPhone staucht helle Szenenteile in die
// letzten Tonwerte vor Weiß. Diese Kompression wird hier umgekehrt, damit der
// Film wieder echtes Szenenlicht bekommt – bis HL_MAX (≈ 4,5 Blenden über
// Mittelgrau). Ob die Lichter dann weich auslaufen (Negativ) oder hart
// ausfressen (Dia), entscheidet der Belichtungsumfang des Films.
// Skaliert wird über den hellsten Kanal, damit Farbtöne erhalten bleiben.
export const HL_KNEE = 0.55;
export const HL_MAX = 4.0;
const HL_C = 1 - (1 - HL_KNEE) / (HL_MAX - HL_KNEE);

export function expandHighlights(c) {
  const m = Math.max(c[0], c[1], c[2]);
  if (m <= HL_KNEE) return c;
  const t = Math.min((m - HL_KNEE) / (1 - HL_KNEE), 1);
  const m2 = HL_KNEE + ((1 - HL_KNEE) * t) / (1 - HL_C * t);
  return c.map((v) => (v * m2) / m);
}

// ---------------------------------------------------------------------------
// Belichtungsumfang: Jeder Film hat angegeben, wie viele Blenden über
// Mittelgrau seine Lichter Papierweiß erreichen (film.over). Daraus wird die
// Weichheit des Papierfußes berechnet – lange Negativ-Lichter laufen weich
// aus, Diafilm frisst früh und hart aus.
const WHITE_TARGET = 0.95; // lineare Helligkeit, ab der Lichter als weiß gelten
const toeCache = new Map();

function filmToe(film) {
  if (!film.over) return film.paper.toe;
  if (toeCache.has(film.id)) return toeCache.get(film.id);
  const L = 0.18 * Math.pow(2, film.over);
  const lum = (t) => {
    const U = buildFor({ ...film, paper: { ...film.paper, toe: t } }, normalizeSettings({ film: film.id, grain: 0 }), {});
    const v = filmPixelLinear([L, L, L], U).map(srgbToLinear);
    return (v[0] + v[1] + v[2]) / 3;
  };
  // größere Weichheit -> Lichter erreichen Weiß später
  let lo = 0.02, hi = 1.5;
  if (lum(lo) < WHITE_TARGET) {
    toeCache.set(film.id, lo);
    return lo;
  }
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (lum(mid) >= WHITE_TARGET) lo = mid;
    else hi = mid;
  }
  const t = (lo + hi) / 2;
  toeCache.set(film.id, t);
  return t;
}

// ---------------------------------------------------------------------------
// Film + Einstellungen -> Parameter für Shader und Referenz.
// ctx.shortSide: kurze Bildseite in Ausgabepixeln (für Korn/Halation).

export function buildUniforms(settings, ctx = {}) {
  const s = normalizeSettings(settings);
  const film = getFilm(s.film);
  if (film.type === 'lut') return buildLut(film, s, ctx);
  return buildFor({ ...film, paper: { ...film.paper, toe: filmToe(film) } }, s, ctx);
}

// ---------------------------------------------------------------------------
// Spektrale Filme: Die ganze Kette (Spektrum, Film, Abzug, Betrachtung) steckt
// in einer vorab berechneten 3D-LUT (tools/spectral). Regler, Korn und
// Effekte wirken wie beim analytischen Modell im Belichtungsraum davor.

const LUTS = new Map();

export function registerLut(id, lut) {
  LUTS.set(id, lut); // { size, min, max, data: Uint8Array (sRGB, Rot zuerst) }
}

export function getLut(id) {
  return LUTS.get(id) ?? null;
}

function buildLut(film, s, ctx) {
  const shortSide = ctx.shortSide ?? 1000;
  const lut = LUTS.get(film.lut);
  const cellPx = film.grain.size * s.grainSize * shortSide;
  return {
    type: 2,
    lut: film.lut,
    lutMin: lut?.min ?? -3.6,
    lutMax: lut?.max ?? 2.1,
    lutSize: lut?.size ?? 33,
    gain: Math.pow(2, s.ev),
    cross: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    sat: Math.max(0, 1 + s.saturation * 0.6),
    vib: 0,
    contrast: Math.pow(2, s.contrast * 0.55),
    // Temperatur/Tönung wie ein Farbfilter vor dem Objektiv
    wbShift: wbOffsets(s.temp, s.tint).map((v) => -v),
    highlights: s.highlights,
    fade: s.fade,
    grainCell: Math.max(1, cellPx),
    grainAmp: film.grain.amount * s.grain * Math.min(1, cellPx) * Math.sqrt(Math.max(1, s.grainSize)),
    grainColor: film.grain.color,
    halation: film.halation.amount * s.halation,
    halationRadius: film.halation.radius * s.halationRadius,
    halationTint: film.halation.tint,
    bloom: film.bloom + s.bloom * 0.6,
    vignette: s.vignette,
    leaks: s.leak > 0 ? makeLeaks(s.leakSeed, s.leak) : [],
    seed: (s.seed ?? 0) >>> 0,
    // vom analytischen Modell nicht genutzt
    negG: [0, 0, 0], lat: 0, printer: [0, 0, 0], lineG: [0, 0, 0], offset: [0, 0, 0],
    dmid: 0, dmin: 0, dmax: 1, toe: 0.1, shoulder: 0.1, rk: 0, dye: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  };
}

// Belichtungsraum vor der LUT: Sättigung, Kontrast, Filter, Lichter, Korn
export function lutInput(u, U, noise = [0, 0, 0]) {
  const m = (u[0] + u[1] + u[2]) / 3;
  return u.map((v, k) => {
    let x = (m + (v - m) * U.sat) * U.contrast + U.wbShift[k];
    const h = Math.min(Math.max(x / 1.5, 0), 1);
    x += U.highlights * 0.3 * h * h;
    // Korn als Dichteschwankung im Negativ, umgerechnet in Belichtung
    x += (U.grainAmp / NEG_GAMMA) * noise[k] * (0.35 + Math.sqrt(Math.max(NEG_GAMMA * (x + 2), 0)));
    return x;
  });
}

// Tetraedrische Interpolation: entlang der Grauachse nur graue Stützstellen,
// damit Neutrales neutral bleibt (trilinear würde farbige Nachbarn mischen).
export function lutLookup(lut, t) {
  const N = lut.size, d = lut.data;
  const f = t.map((v) => Math.min(Math.max((v - lut.min) / (lut.max - lut.min), 0), 1) * (N - 1));
  const i = f.map((v) => Math.min(N - 2, Math.floor(v)));
  const [fx, fy, fz] = f.map((v, k) => v - i[k]);
  const at = (dx, dy, dz) => {
    const o = (((i[2] + dz) * N + (i[1] + dy)) * N + (i[0] + dx)) * 3;
    return [d[o] / 255, d[o + 1] / 255, d[o + 2] / 255];
  };
  const c000 = at(0, 0, 0), c111 = at(1, 1, 1);
  let a, b, wa, wb, wc;
  if (fx >= fy) {
    if (fy >= fz) [a, b, wa, wb, wc] = [at(1, 0, 0), at(1, 1, 0), fx, fy, fz];
    else if (fx >= fz) [a, b, wa, wb, wc] = [at(1, 0, 0), at(1, 0, 1), fx, fz, fy];
    else [a, b, wa, wb, wc] = [at(0, 0, 1), at(1, 0, 1), fz, fx, fy];
  } else if (fz >= fy) [a, b, wa, wb, wc] = [at(0, 0, 1), at(0, 1, 1), fz, fy, fx];
  else if (fz >= fx) [a, b, wa, wb, wc] = [at(0, 1, 0), at(0, 1, 1), fy, fz, fx];
  else [a, b, wa, wb, wc] = [at(0, 1, 0), at(1, 1, 0), fy, fx, fz];
  return [0, 1, 2].map((k) => c000[k] + wa * (a[k] - c000[k]) + wb * (b[k] - a[k]) + wc * (c111[k] - b[k]));
}

function lutPixel(c, U, noise) {
  const lut = LUTS.get(U.lut);
  if (!lut) throw new Error(`LUT ${U.lut} nicht geladen`);
  const u = c.map((v) => Math.log10(Math.max(v, E_FLOOR)) - LOG_MID);
  const o = lutLookup(lut, lutInput(u, U, noise));
  return o.map((v) => {
    const lin = srgbToLinear(v);
    return linearToSrgb(clamp(lin * (1 - 0.1 * U.fade) + 0.1 * U.fade, 0, 1));
  });
}

function buildFor(film, s, ctx) {
  const shortSide = ctx.shortSide ?? 1000;
  const slide = film.type === 'slide';

  const sysG = film.gamma * Math.pow(2, s.contrast * 0.55);
  const layers = film.layers;
  // Schwarzweiß: Temperatur/Tönung wirken als leichte Papiertonung
  const wbScale = film.bw ? 0.35 : 1;
  const wb = wbOffsets(film.temp + s.temp * wbScale, film.tint + s.tint * wbScale);

  const dmin = film.paper.dmin;
  const dmaxPaper = film.paper.dmax;
  const dmax = dmaxPaper - s.fade * Math.max(0, dmaxPaper - 1.25);
  const U = {
    type: slide ? 1 : 0,
    gain: Math.pow(2, s.ev),
    // S/W: alle Schichten sehen dieselbe spektrale Empfindlichkeit -> neutral
    cross: film.bw ? normalizeRows([film.spectral, film.spectral, film.spectral]) : normalizeRows(film.cross),
    sat: Math.max(0, 1 + film.sat + s.saturation * 0.6),
    vib: film.vibrance ?? 0,
    dmin,
    dmax,
    toe: film.paper.toe * Math.pow(2, -s.highlights * 1.2),
    shoulder: film.paper.shoulder,
    rk: Math.pow(10, -(dmaxPaper - dmin)),
    dye: dyeMatrix(clamp(film.dyes, 0, 1)),
  };

  // Mittelgrau (18 %) soll nach allen Stufen wieder 18 % ergeben.
  const reflMid = 0.18 * (1 - U.rk) + U.rk;
  const dTarget = dmin - Math.log10(reflMid);
  U.dmid = solveLine(dTarget, U);

  if (slide) {
    U.lineG = layers.map((l) => sysG * l);
    U.offset = wb.map((o) => sysG * o);
    U.negG = [0, 0, 0];
    U.lat = 0;
    U.printer = [0, 0, 0];
  } else {
    U.negG = layers.map((l) => NEG_GAMMA * l);
    U.lat = film.latitude;
    U.lineG = [sysG / NEG_GAMMA, sysG / NEG_GAMMA, sysG / NEG_GAMMA];
    // Vergrößerer: Belichtung je Schicht so, dass Mittelgrau auf dmid fällt.
    U.printer = U.negG.map((g, k) => negDensity(0, g, U.lat) + wb[k]);
    U.offset = [0, 0, 0];
  }

  // Korn: Größe relativ zur Bildseite; kleiner als ein Pixel mittelt sich
  // (Rauschamplitude ~ Korngröße/Pixel), damit Vorschau und Export gleich wirken.
  const cellPx = film.grain.size * s.grainSize * shortSide;
  U.grainCell = Math.max(1, cellPx);
  U.grainAmp = film.grain.amount * s.grain * Math.min(1, cellPx) * Math.sqrt(Math.max(1, s.grainSize));
  U.grainColor = film.grain.color;

  U.halation = film.halation.amount * s.halation;
  U.halationRadius = film.halation.radius * s.halationRadius;
  U.halationTint = film.halation.tint;
  U.bloom = film.bloom + s.bloom * 0.6;
  U.vignette = s.vignette;
  U.leaks = s.leak > 0 ? makeLeaks(s.leakSeed, s.leak) : [];
  U.seed = (s.seed ?? 0) >>> 0;
  return U;
}

// Sättigung im Log-Raum. Dynamik (vib) verstärkt zurückhaltende Farben
// mehr als bereits kräftige: Die Zwischenschichteffekte wirken am stärksten
// bei kleinen Belichtungsunterschieden der Schichten.
const VIB_WIDTH = 0.3; // log10-Spreizung, ab der die Dynamik abklingt

export function satGain(u, m, U) {
  const c = Math.max(Math.abs(u[0] - m), Math.abs(u[1] - m), Math.abs(u[2] - m));
  return U.sat * (1 + U.vib * Math.exp(-c / VIB_WIDTH));
}

// Referenz-Pixel: sRGB-Wert (0..1) -> sRGB-Ausgabe. noise: Kornrauschen je
// Schicht, extra: zusätzliches lineares Licht (Halation, Lichtleck).
export function filmPixel(rgb, U, noise = [0, 0, 0], extra = [0, 0, 0]) {
  const c = expandHighlights(rgb.map(srgbToLinear)).map((v, k) => v * U.gain + extra[k]);
  return filmPixelLinear(c, U, noise);
}

// Wie filmPixel, aber mit linearem Szenenlicht als Eingabe.
export function filmPixelLinear(c, U, noise = [0, 0, 0]) {
  if (U.type === 2) return lutPixel(c, U, noise);
  const e = U.cross.map((row) => row[0] * c[0] + row[1] * c[1] + row[2] * c[2]);
  let u = e.map((v) => Math.log10(Math.max(v, E_FLOOR)) - LOG_MID);
  const m = (u[0] + u[1] + u[2]) / 3;
  u = u.map((v) => m + (v - m) * satGain(u, m, U));
  let Dl;
  if (U.type === 1) {
    Dl = u.map((v, k) => {
      const d = U.dmid - U.lineG[k] * v + U.offset[k];
      return d + U.grainAmp * noise[k] * (0.35 + Math.sqrt(Math.max(d - U.dmin, 0)));
    });
  } else {
    Dl = u.map((v, k) => {
      let dn = negDensity(v, U.negG[k], U.lat);
      dn += U.grainAmp * noise[k] * (0.35 + Math.sqrt(Math.max(dn, 0)));
      return U.dmid + U.lineG[k] * (U.printer[k] - dn);
    });
  }
  const D = Dl.map((d) => paperCurve(d, U));
  const Dv = U.dye.map((row) => row[0] * D[0] + row[1] * D[1] + row[2] * D[2]);
  return Dv.map((d) => {
    const refl = Math.pow(10, -(d - U.dmin));
    const lin = (refl - U.rk) / (1 - U.rk);
    return linearToSrgb(clamp(lin, 0, 1));
  });
}

// ---------------------------------------------------------------------------
// Lichtlecks: aus einem Startwert reproduzierbar erzeugt. Lecks entstehen an
// den Bildrändern (Kamerarückwand, Filmtransport) und sind echtes Licht, das
// den Film belichtet – deshalb laufen sie durch die Filmkurve.

export function rng(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LEAK_COLORS = [
  [1.0, 0.32, 0.08],
  [1.0, 0.5, 0.12],
  [1.0, 0.72, 0.3],
  [1.0, 0.2, 0.18],
];

export function makeLeaks(seed, strength) {
  const r = rng(seed * 7919 + 13);
  const n = 1 + Math.floor(r() * 2.2);
  // Lecks meist an einer Seite (der Filmtür), gelegentlich gegenüber
  const side = Math.floor(r() * 4);
  const leaks = [];
  for (let i = 0; i < n; i++) {
    const sd = i === 0 || r() < 0.65 ? side : (side + 2) % 4;
    const col = LEAK_COLORS[Math.floor(r() * LEAK_COLORS.length)];
    leaks.push({
      side: sd,
      pos: 0.12 + r() * 0.76,
      width: 0.12 + r() * 0.35,
      depth: 0.06 + r() * 0.22,
      color: col,
      intensity: strength * (1.2 + r() * 2.8) * (i === 0 ? 1 : 0.6),
    });
  }
  return leaks;
}

export function leakLight(u, v, leaks) {
  const out = [0, 0, 0];
  for (const L of leaks) {
    let d, a;
    if (L.side === 0) { d = u; a = v; }
    else if (L.side === 1) { d = 1 - u; a = v; }
    else if (L.side === 2) { d = v; a = u; }
    else { d = 1 - v; a = u; }
    const g = Math.exp(-(((a - L.pos) / L.width) ** 2)) * Math.exp(-d / L.depth);
    for (let k = 0; k < 3; k++) out[k] += L.color[k] * L.intensity * g;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Zuschnitt: mittiger Ausschnitt im gewünschten Seitenverhältnis, die lange
// Bildseite liegt immer entlang der langen Seite der Vorlage.

export function cropRect(w, h, aspect) {
  const a = ASPECTS[aspect] ?? 0;
  if (!a) return { x: 0, y: 0, w, h };
  const landscape = w >= h;
  const target = landscape ? a : 1 / a;
  let cw = w, ch = h;
  if (w / h > target) cw = Math.round(h * target);
  else ch = Math.round(w / target);
  return { x: Math.round((w - cw) / 2), y: Math.round((h - ch) / 2), w: cw, h: ch };
}

// Größe so begrenzen, dass Safari die Leinwand noch anlegen kann.
export const MAX_CANVAS_AREA = 16_000_000;

export function fitArea(w, h, maxArea = MAX_CANVAS_AREA) {
  const a = w * h;
  if (a <= maxArea) return { w, h, scale: 1 };
  const k = Math.sqrt(maxArea / a);
  return { w: Math.floor(w * k), h: Math.floor(h * k), scale: k };
}

// ---------------------------------------------------------------------------
// Lage des Telefons aus der Schwerkraft (iOS-Konvention: aufrecht y ≈ -9,81).
// Ergebnis: Drehung des Geräts gegen den Uhrzeigersinn in Grad (0/90/180/270).

export function deviceRotation(x, y, z, prev = 0) {
  const planar = Math.hypot(x, y);
  if (planar < 3 || Math.abs(z) > 8.5) return prev; // flach gehalten
  let ang = (Math.atan2(-x, -y) * 180) / Math.PI;
  if (ang < 0) ang += 360;
  const snapped = ((Math.round(ang / 90) * 90) % 360 + 360) % 360;
  const diff = Math.abs(((ang - snapped + 540) % 360) - 180);
  return diff <= 32 ? snapped : prev; // Hysterese um die Diagonalen
}

// ---------------------------------------------------------------------------
// Datumsstempel im Stil der Kompaktkameras: ’26 10 31

export function dateStampText(ts) {
  const d = new Date(ts);
  const yy = String(d.getFullYear() % 100).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, ' ');
  const dd = String(d.getDate()).padStart(2, '0');
  return `'${yy} ${mm} ${dd}`;
}
