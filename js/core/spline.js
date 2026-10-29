// Monotone kubische Interpolation (Fritsch–Carlson) für Gradationskurven.
// Monotonie verhindert Überschwinger und damit Tonwertumkehrungen.

export function isIdentityCurve(points) {
  return (
    points.length === 2 &&
    points[0][0] === 0 && points[0][1] === 0 &&
    points[1][0] === 1 && points[1][1] === 1
  );
}

export function makeSpline(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  const n = pts.length;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  if (n === 1) return () => ys[0];

  const d = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    const dx = xs[i + 1] - xs[i];
    d[i] = dx > 0 ? (ys[i + 1] - ys[i]) / dx : 0;
  }
  const m = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }

  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    let hi = n - 1;
    while (hi - i > 1) {
      const mid = (i + hi) >> 1;
      if (xs[mid] > x) hi = mid;
      else i = mid;
    }
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[i] +
      (t3 - 2 * t2 + t) * h * m[i] +
      (-2 * t3 + 3 * t2) * ys[i + 1] +
      (t3 - t2) * h * m[i + 1]
    );
  };
}

// Tabelle mit `size` Stützstellen über [0,1].
export function curveTable(points, size = 4096) {
  const t = new Float32Array(size);
  if (isIdentityCurve(points)) {
    for (let i = 0; i < size; i++) t[i] = i / (size - 1);
    return t;
  }
  const f = makeSpline(points);
  for (let i = 0; i < size; i++) t[i] = f(i / (size - 1));
  return t;
}

// Lineare Interpolation in einer Tabelle über [0,1]; Werte außerhalb werden
// mit der Steigung am Rand fortgesetzt, damit Überbelichtung erhalten bleibt.
export function sampleTable(t, x) {
  const n = t.length - 1;
  if (x <= 0) return t[0] + x * (t[1] - t[0]) * n;
  if (x >= 1) return t[n] + (x - 1) * (t[n] - t[n - 1]) * n;
  const f = x * n;
  const i = f | 0;
  const a = f - i;
  return t[i] + (t[i + 1] - t[i]) * a;
}
