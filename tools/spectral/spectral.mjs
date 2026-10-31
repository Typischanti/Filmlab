// Spektrale Filmsimulation (eigene Umsetzung) zum Erzeugen von 3D-LUTs.
//
// Die Messdaten der Filme und Papiere stammen aus den Profilen von
// spektrafilm (Andrea Volpato, https://github.com/andreavolpato/spektrafilm,
// CC BY-SA 4.0). Dieser Code ist eine unabhängige Implementierung und nutzt
// nur die Daten.
//
// Kette (für jeden LUT-Knoten, lineares Szenenlicht in sRGB-Primärfarben):
//   1. RGB -> glattes Reflexionsspektrum (Sigmoid-Polynom nach Jakob & Hanika
//      2019) unter einer Tageslichtquelle
//   2. Belichtung der drei Filmschichten mit den gemessenen spektralen
//      Empfindlichkeiten, normiert auf 18 % Grau
//   3. Kennlinien -> Farbstoffdichten -> spektrale Dichte des Films
//      (Träger + Farbstoffspektren, inkl. Maskierung)
//   4a. Negativ: Vergrößererlicht durch das Negativ belichtet das Papier
//       bzw. den Kopierfilm; Filterung so, dass Mittelgrau neutral wird
//   4b. Dia: direkt betrachtet
//   5. Betrachtung unter Normlicht, Normbeobachter CIE 1931 -> XYZ
//      -> Weißabgleich auf D65 (Bradford) -> lineares sRGB

export const WL = Array.from({ length: 81 }, (_, i) => 380 + 5 * i);
const DL = 5;

// --- CIE 1931 2° Normspektralwertkurven, analytische Näherung
// (Wyman, Sloan, Shirley 2013: „Simple Analytic Approximations to the CIE XYZ
// Color Matching Functions“).
function g(x, mu, s1, s2) {
  const t = (x - mu) / (x < mu ? s1 : s2);
  return Math.exp(-0.5 * t * t);
}
export const CMF = WL.map((l) => [
  1.056 * g(l, 599.8, 37.9, 31.0) + 0.362 * g(l, 442.0, 16.0, 26.7) - 0.065 * g(l, 501.1, 20.4, 26.2),
  0.821 * g(l, 568.8, 46.9, 40.5) + 0.286 * g(l, 530.9, 16.3, 31.1),
  1.217 * g(l, 437.0, 11.8, 36.0) + 0.681 * g(l, 459.0, 26.0, 13.8),
]);

// --- Lichtquellen
export function planck(T) {
  const c1 = 3.741771e-16, c2 = 1.438777e-2;
  const v = WL.map((l) => {
    const m = l * 1e-9;
    return c1 / (m ** 5 * (Math.exp(c2 / (m * T)) - 1));
  });
  const ref = v[WL.indexOf(560)];
  return v.map((x) => x / ref);
}

// Vergrößererlampe: Halogen ≈ 3200 K mit Wärmeschutzfilter (KG3-ähnlich,
// sperrt Infrarot und tiefes Rot).
export function enlargerLamp() {
  const p = planck(3200);
  return p.map((v, i) => v / (1 + Math.exp((WL[i] - 690) / 18)));
}

// --- Farbmetrik
export const SRGB_TO_XYZ = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.072175],
  [0.0193339, 0.119192, 0.9503041],
];
export const XYZ_TO_SRGB = [
  [3.2404542, -1.5371385, -0.4985314],
  [-0.969266, 1.8760108, 0.041556],
  [0.0556434, -0.2040259, 1.0572252],
];
const D65 = [0.95047, 1.0, 1.08883];
const BRADFORD = [
  [0.8951, 0.2664, -0.1614],
  [-0.7502, 1.7135, 0.0367],
  [0.0389, -0.0685, 1.0296],
];
const BRADFORD_INV = [
  [0.9869929, -0.1470543, 0.1599627],
  [0.4323053, 0.5183603, 0.0492912],
  [-0.0085287, 0.0400428, 0.9684867],
];

export const mul = (M, v) => [
  M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2],
  M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2],
  M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2],
];
const matmul = (A, B) => A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));

// Chromatische Adaption von Weiß ws auf Weiß wd (Bradford).
export function adaptMatrix(ws, wd) {
  const s = mul(BRADFORD, ws), d = mul(BRADFORD, wd);
  const D = [[d[0] / s[0], 0, 0], [0, d[1] / s[1], 0], [0, 0, d[2] / s[2]]];
  return matmul(BRADFORD_INV, matmul(D, BRADFORD));
}

// Spektrum (Strahlung) -> XYZ, normiert auf Y der Lichtquelle.
export function spectrumXYZ(S, illumY = 1) {
  let X = 0, Y = 0, Z = 0;
  for (let i = 0; i < WL.length; i++) {
    X += S[i] * CMF[i][0];
    Y += S[i] * CMF[i][1];
    Z += S[i] * CMF[i][2];
  }
  return [X / illumY, Y / illumY, Z / illumY];
}

export function illumY(I) {
  let Y = 0;
  for (let i = 0; i < WL.length; i++) Y += I[i] * CMF[i][1];
  return Y;
}

// --- Spektrum aus RGB: Reflexion r(λ) = sigmoid(c0 x² + c1 x + c2)
const XN = WL.map((l) => (l - 380) / 400);
const sig = (z) => 0.5 + z / (2 * Math.sqrt(1 + z * z));

export function makeUpsampler(illum) {
  const Yi = illumY(illum);
  const white = spectrumXYZ(illum, Yi);
  // sRGB-Werte gelten für D65; auf das Weiß der Lichtquelle adaptieren
  const A = adaptMatrix(D65, white);
  const W = WL.map((_, i) => [illum[i] * CMF[i][0] / Yi, illum[i] * CMF[i][1] / Yi, illum[i] * CMF[i][2] / Yi]);
  const xyzOf = (c) => {
    let X = 0, Y = 0, Z = 0;
    for (let i = 0; i < WL.length; i++) {
      const r = sig(c[0] * XN[i] * XN[i] + c[1] * XN[i] + c[2]);
      X += r * W[i][0];
      Y += r * W[i][1];
      Z += r * W[i][2];
    }
    return [X, Y, Z];
  };
  // Fehler im Lab-ähnlichen Raum (Kubikwurzel), damit dunkle Farben zählen
  const f = (v) => Math.cbrt(Math.max(v, 1e-9));
  const resid = (c, t) => {
    const x = xyzOf(c);
    return [f(x[0]) - f(t[0]), f(x[1]) - f(t[1]), f(x[2]) - f(t[2])];
  };
  // noU: nur Formen ohne U-Krümmung (c0 ≤ 0) – so haben Rot, Gelb, Grün
  // und Blau keine unnatürlichen Ausläufer am anderen Spektrumende
  return (rgb, guess, noU = false) => {
    const t = mul(A, mul(SRGB_TO_XYZ, rgb));
    let c = guess ? guess.slice() : [0, 0, 0];
    if (noU) c[0] = Math.min(c[0], 0);
    let lambda = 1e-3;
    let r = resid(c, t);
    let err = r[0] ** 2 + r[1] ** 2 + r[2] ** 2;
    for (let it = 0; it < 60 && err > 1e-10; it++) {
      // Jacobi-Matrix numerisch
      const J = [];
      for (let k = 0; k < 3; k++) {
        const h = 1e-4;
        const cc = c.slice();
        cc[k] += h;
        const rr = resid(cc, t);
        J.push([(rr[0] - r[0]) / h, (rr[1] - r[1]) / h, (rr[2] - r[2]) / h]);
      }
      // (JᵀJ + λI) δ = -Jᵀr
      const JtJ = [0, 1, 2].map((a) => [0, 1, 2].map((b) => J[a][0] * J[b][0] + J[a][1] * J[b][1] + J[a][2] * J[b][2]));
      const Jtr = [0, 1, 2].map((a) => J[a][0] * r[0] + J[a][1] * r[1] + J[a][2] * r[2]);
      let improved = false;
      for (let tries = 0; tries < 8; tries++) {
        const M = JtJ.map((row, a) => row.map((v, b) => v + (a === b ? lambda * (1 + v) : 0)));
        const d = solve3(M, Jtr.map((v) => -v));
        if (!d) break;
        const cn = [c[0] + d[0], c[1] + d[1], c[2] + d[2]];
        if (noU) cn[0] = Math.min(cn[0], 0);
        const rn = resid(cn, t);
        const en = rn[0] ** 2 + rn[1] ** 2 + rn[2] ** 2;
        if (en < err) {
          c = cn;
          r = rn;
          err = en;
          lambda = Math.max(lambda * 0.3, 1e-7);
          improved = true;
          break;
        }
        lambda *= 10;
      }
      if (!improved) break;
    }
    return { coef: c, err, spectrum: XN.map((x) => sig(c[0] * x * x + c[1] * x + c[2])) };
  };
}

function solve3(M, b) {
  const [a, bb, c] = M;
  const det = a[0] * (bb[1] * c[2] - bb[2] * c[1]) - a[1] * (bb[0] * c[2] - bb[2] * c[0]) + a[2] * (bb[0] * c[1] - bb[1] * c[0]);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-18) return null;
  const inv = [
    [bb[1] * c[2] - bb[2] * c[1], a[2] * c[1] - a[1] * c[2], a[1] * bb[2] - a[2] * bb[1]],
    [bb[2] * c[0] - bb[0] * c[2], a[0] * c[2] - a[2] * c[0], a[2] * bb[0] - a[0] * bb[2]],
    [bb[0] * c[1] - bb[1] * c[0], a[1] * c[0] - a[0] * c[1], a[0] * bb[1] - a[1] * bb[0]],
  ];
  return inv.map((row) => (row[0] * b[0] + row[1] * b[1] + row[2] * b[2]) / det);
}

// --- Profile
export function loadProfile(json) {
  const D = json.data;
  const clean = (v) => (v == null || Number.isNaN(v) ? 0 : v);
  return {
    name: json.info.name,
    stock: json.info.stock,
    type: json.info.type, // negative | positive
    support: json.info.support, // film | paper
    targetPrint: json.info.target_print,
    sens: D.log_sensitivity.map((r) => r.map((v) => (v == null || Number.isNaN(v) ? 0 : Math.pow(10, v)))),
    dye: D.channel_density.map((r) => r.map(clean)),
    base: D.base_density.map(clean),
    logE: D.log_exposure,
    curves: [0, 1, 2].map((k) => D.density_curves.map((r) => clean(r[k]))),
  };
}

function interpCurve(xs, ys, x) {
  if (x <= xs[0]) return ys[0];
  const n = xs.length - 1;
  if (x >= xs[n]) return ys[n];
  const step = (xs[n] - xs[0]) / n;
  const f = (x - xs[0]) / step;
  const i = Math.min(n - 1, Math.floor(f));
  const t = f - i;
  return ys[i] * (1 - t) + ys[i + 1] * t;
}

// Objektiv vor dem Film: Glas und Vergütung sperren UV und tiefes Violett.
export const LENS = WL.map((l) => 1 / (1 + Math.exp(-(l - 408) / 7)));

export function layerExposure(P, S, lens = null) {
  const e = [0, 0, 0];
  for (let i = 0; i < WL.length; i++) {
    const s = lens ? S[i] * lens[i] : S[i];
    for (let k = 0; k < 3; k++) e[k] += s * P.sens[i][k];
  }
  return e;
}

export function densities(P, logE) {
  return [0, 1, 2].map((k) => interpCurve(P.logE, P.curves[k], logE[k]));
}

// DIR-Kuppler (Entwicklungshemmer): Bildet eine Schicht mehr Dichte als bei
// neutraler Belichtung, hemmt sie die Entwicklung der anderen Schichten.
// Für Grau heben sich die Beiträge auf – die gemessenen Kennlinien bleiben
// erhalten; farbige Motive werden gesättigter.
export function densitiesDIR(P, logE, alpha) {
  const D = densities(P, logE);
  if (!alpha) return D;
  const m = (logE[0] + logE[1] + logE[2]) / 3;
  const excess = D.map((d, k) => d - interpCurve(P.logE, P.curves[k], m));
  return D.map((d, k) => {
    let inh = 0;
    for (let j = 0; j < 3; j++) if (j !== k) inh += excess[j];
    return Math.max(0, d - alpha * inh);
  });
}

export function transmittance(P, D) {
  return P.base.map((b, i) => Math.pow(10, -(b + D[0] * P.dye[i][0] + D[1] * P.dye[i][1] + D[2] * P.dye[i][2])));
}

// --- Gesamte Kette
// film: Aufnahmematerial, print: Papier/Kopierfilm (null bei Dia)
export function makeChain(film, print, opts = {}) {
  const scene = planck(opts.sceneCCT ?? 5500);
  const dir = opts.dir ?? 0;
  const up = makeUpsampler(scene);
  const view = planck(opts.viewCCT ?? 5000);
  const viewY = illumY(view);
  const lamp = enlargerLamp();

  // Belichtungsnormierung: 18 % Grau -> log E = 0 je Schicht
  const grey = scene.map((v) => 0.18 * v);
  const eGrey = layerExposure(film, grey, LENS);
  let filmShift = 0; // Belichtungskorrektur (Dia: Mittelgrau -> 18 %)
  const filmLogE = (S) => layerExposure(film, S, LENS).map((e, k) => Math.log10(Math.max(e / eGrey[k], 1e-12)) + filmShift);

  let paperOff = [0, 0, 0];
  const printLogE = (T) => {
    const e = [0, 0, 0];
    for (let i = 0; i < WL.length; i++) for (let k = 0; k < 3; k++) e[k] += lamp[i] * T[i] * print.sens[i][k];
    return e.map((v, k) => Math.log10(Math.max(v, 1e-30)) + paperOff[k]);
  };

  // Endergebnis eines Szenenspektrums als Spektrum (Reflexion/Transmission)
  const finalSpectrum = (S) => {
    const Tn = transmittance(film, densitiesDIR(film, filmLogE(S), dir));
    if (!print) return Tn;
    return transmittance(print, densities(print, printLogE(Tn)));
  };
  const whiteSpectrum = print ? print.base.map((b) => Math.pow(10, -b)) : film.base.map((b) => Math.pow(10, -b));
  const toXYZ = (T) => spectrumXYZ(T.map((t, i) => t * view[i]), viewY);

  if (print) {
    // Filterung: Mittelgrau-Negativ belichtet alle Papierschichten gleich
    // stark; Gesamtbelichtung so, dass der Abzug 18 % Helligkeit erreicht.
    // Filterung auf ein Grau unter balanceCCT (Standard: Szenenlicht). Ein
    // niedrigerer Wert lässt z. B. Kunstlichtfilm bei Tageslicht kühler.
    const balGrey = opts.balanceCCT ? planck(opts.balanceCCT).map((v) => 0.18 * v) : grey;
    const yScale = illumY(scene) / illumY(balGrey.map((v) => v / 0.18));
    const Tgrey = transmittance(film, densitiesDIR(film, filmLogE(balGrey.map((v) => v * yScale)), dir));
    paperOff = [0, 0, 0];
    const raw = printLogE(Tgrey);
    const whiteY = toXYZ(whiteSpectrum)[1];
    const yAt = (x) => {
      paperOff = raw.map((v) => x - v);
      return toXYZ(finalSpectrum(balGrey.map((v) => v * yScale)))[1] / whiteY;
    };
    const target = opts.midTarget ?? 0.18;
    let lo = -3, hi = 4; // mehr Papierbelichtung -> dunkler
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (yAt(mid) > target) lo = mid;
      else hi = mid;
    }
    paperOff = raw.map((v) => (lo + hi) / 2 - v);
  }

  if (!print) {
    // Dia: Belichtung so wählen, dass Mittelgrau mit 18 % Helligkeit erscheint
    const target = opts.midTarget ?? 0.18;
    const whiteY = toXYZ(whiteSpectrum)[1];
    let lo = -1.5, hi = 1.5; // mehr Belichtung -> heller
    for (let i = 0; i < 60; i++) {
      filmShift = (lo + hi) / 2;
      if (toXYZ(finalSpectrum(grey))[1] / whiteY > target) hi = filmShift;
      else lo = filmShift;
    }
    filmShift = (lo + hi) / 2;
  }

  // Weiß des Materials -> Bildschirmweiß (D65), Schwarz -> Bildschirmschwarz
  const wXYZ = toXYZ(whiteSpectrum);
  const A = adaptMatrix(wXYZ.map((v) => v / wXYZ[1]), D65);
  const blackSpectrum = finalSpectrum(scene.map((v) => v * 1e-6));
  const toRGB = (T) => mul(XYZ_TO_SRGB, mul(A, toXYZ(T).map((v) => v / wXYZ[1])));
  const black = toRGB(blackSpectrum);
  const yb = Math.max(0, 0.2126 * black[0] + 0.7152 * black[1] + 0.0722 * black[2]);

  let guessU = null, guessFree = null;
  // rgb: lineares Szenenlicht (sRGB-Primärfarben, 0.18 = Mittelgrau)
  const renderRaw = (rgb) => {
    const m = Math.max(rgb[0], rgb[1], rgb[2], 1e-12);
    const refl = rgb.map((v) => Math.min(Math.max(v, 0) / m, 1));
    let r = up(refl, guessU, true);
    guessU = r.err < 1e-6 ? r.coef : null;
    if (r.err > 1e-6) {
      const r2 = up(refl, guessFree, false);
      guessFree = r2.err < 1e-6 ? r2.coef : null;
      if (r2.err < r.err) r = r2;
    }
    const S = r.spectrum.map((v, i) => v * m * scene[i]);
    return toRGB(finalSpectrum(S));
  };

  // Graubalance wie beim Laborscanner: Kanalkurven so, dass neutrale
  // Motive auf der ganzen Grauachse neutral bleiben (inkl. Schwarz/Weiß).
  const ramp = [];
  for (let st = -16; st <= 9; st += 0.25) {
    const v = 0.18 * 2 ** st;
    const raw = renderRaw([v, v, v]);
    ramp.push({ raw, Y: 0.2126 * raw[0] + 0.7152 * raw[1] + 0.0722 * raw[2] });
  }
  const yMin = Math.min(...ramp.map((p) => p.Y));
  const curves = [0, 1, 2].map((k) => {
    const pts = ramp.map((p) => [p.raw[k], Math.max(0, (p.Y - yMin) / (1 - yMin))]).sort((a, b) => a[0] - b[0]);
    // streng monoton machen
    const out = [];
    for (const [x, y] of pts) if (!out.length || (x > out[out.length - 1][0] + 1e-9 && y >= out[out.length - 1][1])) out.push([x, y]);
    return out;
  });
  const applyCurve = (pts, v) => {
    const n = pts.length - 1;
    if (v <= pts[0][0]) return pts[0][0] > 0 ? (v / pts[0][0]) * pts[0][1] : pts[0][1];
    if (v >= pts[n][0]) {
      const [x, y] = pts[n];
      return x < 1 ? y + ((v - x) * (1 - y)) / (1 - x) : y + (v - x);
    }
    let lo = 0, hi = n;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid][0] <= v) lo = mid;
      else hi = mid;
    }
    const t = (v - pts[lo][0]) / (pts[hi][0] - pts[lo][0]);
    return pts[lo][1] + t * (pts[hi][1] - pts[lo][1]);
  };
  // Laborabgleich an einem Punkt: Schwarz neutral, Mittelgrau neutral auf
  // 18 % (wie Filterung bzw. Scanner-Weißabgleich). Lichter und Schatten
  // behalten die filmtypischen Farbverschiebungen.
  const rawBlack = renderRaw([1e-7, 1e-7, 1e-7]);
  // Mittelgrau so, wie das Labor es sieht: Grau unter balanceCCT (bei
  // Kunstlichtfilm bleibt Tageslicht-Grau dadurch bewusst kühl)
  let midIn = [0.18, 0.18, 0.18];
  if (opts.balanceCCT) {
    const bal = planck(opts.balanceCCT);
    const xyz = spectrumXYZ(bal, illumY(bal));
    const sceneWhite = spectrumXYZ(scene, illumY(scene));
    const rgb = mul(XYZ_TO_SRGB, mul(adaptMatrix(sceneWhite, D65), xyz));
    const Y = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    midIn = rgb.map((v) => (0.18 * v) / Y);
  }
  const rawMid = renderRaw(midIn);
  const midTarget = opts.midTarget ?? 0.18;
  const gains = rawMid.map((v, k) => (midTarget - 0) / Math.max(v - rawBlack[k], 1e-6));
  // balance 1: Grauachse überall neutral (Scanner-Automatik), 0: nur
  // Schwarz und Mittelgrau abgeglichen
  const balance = opts.balance ?? 1;
  const render = (rgb) => {
    const raw = renderRaw(rgb);
    return raw.map((v, k) => {
      const mid = (v - rawBlack[k]) * gains[k];
      return balance ? mid + balance * (applyCurve(curves[k], v) - mid) : mid;
    });
  };
  return { render, renderRaw, finalSpectrum, toRGB, yb };
}
