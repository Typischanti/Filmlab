// Geometrie: 90°-Drehung, Spiegeln, Begradigen, Zuschnitt und Skalierung.
// Bilder sind { width, height, data: Uint16Array } mit 3 Kanälen (RGB, verschachtelt).

export function createImage(width, height) {
  return { width, height, data: new Uint16Array(width * height * 3) };
}

// Größe des orientierten Bildes (nach 90°-Drehung).
export function orientedSize(width, height, rotation) {
  return rotation % 180 === 0 ? [width, height] : [height, width];
}

// Zoomfaktor, damit beim Begradigen keine leeren Ecken entstehen.
export function straightenZoom(w, h, angleDeg) {
  const t = Math.abs((angleDeg * Math.PI) / 180);
  if (t < 1e-6) return 1;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return Math.max(c + (h / w) * s, c + (w / h) * s);
}

// Liefert eine Funktion, die normierte Koordinaten im ausgerichteten
// (gedrehten/gespiegelten/begradigten) Bild auf Quellpixel abbildet.
function orientedToSource(src, geom) {
  const W = src.width;
  const H = src.height;
  const rot = ((geom.rotation % 360) + 360) % 360;
  const [OW, OH] = orientedSize(W, H, rot);
  const ang = ((geom.angle || 0) * Math.PI) / 180;
  const zoom = straightenZoom(OW, OH, geom.angle || 0);
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);

  return (nx, ny) => {
    // in Pixel des ausgerichteten Bildes, Begradigung um die Mitte
    let X = (nx - 0.5) * OW;
    let Y = (ny - 0.5) * OH;
    const rx = (X * ca + Y * sa) / zoom;
    const ry = (-X * sa + Y * ca) / zoom;
    X = rx + OW / 2;
    Y = ry + OH / 2;
    if (geom.flipH) X = OW - X;
    if (geom.flipV) Y = OH - Y;
    let sx, sy;
    switch (rot) {
      case 90: sx = Y; sy = H - X; break;
      case 180: sx = W - X; sy = H - Y; break;
      case 270: sx = W - Y; sy = X; break;
      default: sx = X; sy = Y;
    }
    return [sx, sy];
  };
}

// Affine Abbildung Ausgabepixel (u,v) -> Quellkoordinate (Pixelzentren).
// rect: normierter Ausschnitt {x,y,w,h} im ausgerichteten Bild.
export function makeMapping(src, geom, rect, outW, outH) {
  const f = orientedToSource(src, geom);
  const at = (u, v) => f(rect.x + ((u + 0.5) / outW) * rect.w, rect.y + ((v + 0.5) / outH) * rect.h);
  const [c, f0] = at(0, 0);
  const [ux, uy] = at(1, 0);
  const [vx, vy] = at(0, 1);
  return {
    a: ux - c, b: vx - c, c: c - 0.5,
    d: uy - f0, e: vy - f0, f: f0 - 0.5,
  };
}

// Bilineares Abtasten der Zeilen [row0,row1) eines Ausgabebildes.
export function extract(src, m, outW, row0, row1) {
  const W = src.width;
  const H = src.height;
  const sd = src.data;
  const rows = row1 - row0;
  const out = createImage(outW, rows);
  const od = out.data;
  const maxX = W - 1;
  const maxY = H - 1;
  const axisAligned = Math.abs(m.b) < 1e-9 && Math.abs(m.d) < 1e-9;
  let o = 0;
  for (let v = row0; v < row1; v++) {
    let sx = m.b * v + m.c;
    let sy = m.e * v + m.f;
    for (let u = 0; u < outW; u++) {
      let x = sx, y = sy;
      if (x < 0) x = 0; else if (x > maxX) x = maxX;
      if (y < 0) y = 0; else if (y > maxY) y = maxY;
      const x0 = x | 0;
      const y0 = y | 0;
      const fx = x - x0;
      const fy = y - y0;
      const x1 = x0 < maxX ? x0 + 1 : x0;
      const y1 = y0 < maxY ? y0 + 1 : y0;
      const i00 = (y0 * W + x0) * 3;
      const i10 = (y0 * W + x1) * 3;
      const i01 = (y1 * W + x0) * 3;
      const i11 = (y1 * W + x1) * 3;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;
      od[o] = sd[i00] * w00 + sd[i10] * w10 + sd[i01] * w01 + sd[i11] * w11 + 0.5;
      od[o + 1] = sd[i00 + 1] * w00 + sd[i10 + 1] * w10 + sd[i01 + 1] * w01 + sd[i11 + 1] * w11 + 0.5;
      od[o + 2] = sd[i00 + 2] * w00 + sd[i10 + 2] * w10 + sd[i01 + 2] * w01 + sd[i11 + 2] * w11 + 0.5;
      o += 3;
      sx += m.a;
      if (!axisAligned) sy += m.d;
    }
  }
  return out;
}

// Flächenmittelnde Verkleinerung um einen ganzzahligen Faktor.
export function boxDownscale(src, factor) {
  if (factor <= 1) return src;
  const W = Math.max(1, Math.floor(src.width / factor));
  const H = Math.max(1, Math.floor(src.height / factor));
  const out = createImage(W, H);
  const sd = src.data;
  const od = out.data;
  const SW = src.width;
  const n = factor * factor;
  const acc = new Float64Array(W * 3);
  for (let y = 0; y < H; y++) {
    acc.fill(0);
    for (let j = 0; j < factor; j++) {
      let s = ((y * factor + j) * SW) * 3;
      for (let x = 0; x < W; x++) {
        let r = 0, g = 0, b = 0;
        for (let i = 0; i < factor; i++) {
          r += sd[s]; g += sd[s + 1]; b += sd[s + 2];
          s += 3;
        }
        acc[x * 3] += r; acc[x * 3 + 1] += g; acc[x * 3 + 2] += b;
      }
    }
    let o = y * W * 3;
    for (let x = 0; x < W * 3; x++) od[o + x] = acc[x] / n + 0.5;
  }
  return out;
}

// Verkleinert so, dass die längere Kante höchstens maxDim beträgt.
export function fitDownscale(src, maxDim) {
  const factor = Math.floor(Math.max(src.width, src.height) / maxDim);
  return factor > 1 ? boxDownscale(src, factor) : src;
}

export const FULL_RECT = Object.freeze({ x: 0, y: 0, w: 1, h: 1 });

// Pixelgröße des Zuschnitts für ein Quellbild.
export function cropPixelSize(src, geom) {
  const [OW, OH] = orientedSize(src.width, src.height, geom.rotation);
  const r = geom.crop || FULL_RECT;
  return [Math.max(1, Math.round(r.w * OW)), Math.max(1, Math.round(r.h * OH))];
}
