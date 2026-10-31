// Entwickeln in voller Auflösung, Datumsstempel, Filmrahmen, Dateien.

import { cropRect, fitArea, dateStampText, MAX_CANVAS_AREA } from './model.js';
import { getFilm } from './films.js';

export const MAX_SOURCE_AREA = 12_600_000;

// ---------------------------------------------------------------------------
// Quellen laden

export async function loadImage(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

// Bild -> Canvas, höchstens maxArea Pixel (EXIF-Drehung übernimmt der Browser).
export function imageToCanvas(img, maxArea = MAX_SOURCE_AREA) {
  const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
  const { w, h } = fitArea(w0, h0, maxArea);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  return c;
}

export function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.92) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Bild konnte nicht gespeichert werden.'))), type, quality),
  );
}

export function scaledCanvas(src, maxSide) {
  const k = Math.min(1, maxSide / Math.max(src.width, src.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(src.width * k));
  c.height = Math.max(1, Math.round(src.height * k));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

// Aufnahmedatum aus JPEG-EXIF (DateTimeOriginal), sonst null.
export async function exifDate(file) {
  try {
    const buf = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
    if (buf.getUint16(0) !== 0xffd8) return null;
    let off = 2;
    while (off + 4 < buf.byteLength) {
      const marker = buf.getUint16(off);
      const len = buf.getUint16(off + 2);
      if (marker === 0xffe1 && buf.getUint32(off + 4) === 0x45786966) {
        const tiff = off + 10;
        const le = buf.getUint16(tiff) === 0x4949;
        const u16 = (o) => buf.getUint16(o, le);
        const u32 = (o) => buf.getUint32(o, le);
        const readIfd = (ifd, tagWanted) => {
          const n = u16(tiff + ifd);
          for (let i = 0; i < n; i++) {
            const e = tiff + ifd + 2 + i * 12;
            if (u16(e) === tagWanted) return u32(e + 8);
          }
          return null;
        };
        const exifIfd = readIfd(u32(tiff + 4), 0x8769);
        const ptr = exifIfd != null ? readIfd(exifIfd, 0x9003) : null;
        if (ptr == null) return null;
        let s = '';
        for (let i = 0; i < 19; i++) s += String.fromCharCode(buf.getUint8(tiff + ptr + i));
        const m = s.match(/(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/);
        if (!m) return null;
        return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
      }
      if ((marker & 0xff00) !== 0xff00) break;
      off += 2 + len;
    }
  } catch {
    /* kein EXIF */
  }
  return null;
}

// ---------------------------------------------------------------------------
// Entwickeln

// Rahmenmaße in Millimetern (Kleinbild, 35 mm breit, Bildbreite 36 mm).
const FILM_W = 35;
const FRAME_LEN = 36;
const SIDE_GAP = 2.6;

export function frameLayout(imgW, imgH) {
  const landscape = imgW >= imgH;
  const long = landscape ? imgW : imgH;
  const mm = long / FRAME_LEN;
  const L = Math.round((FRAME_LEN + 2 * SIDE_GAP) * mm);
  const S = Math.round(FILM_W * mm);
  return landscape
    ? { w: L, h: S, ix: Math.round((L - imgW) / 2), iy: Math.round((S - imgH) / 2), mm, landscape }
    : { w: S, h: L, ix: Math.round((S - imgW) / 2), iy: Math.round((L - imgH) / 2), mm, landscape };
}

// Ausgabegröße so wählen, dass das fertige Bild (ggf. mit Rahmen) in die
// Größengrenze von Safari passt.
export function outputSize(srcW, srcH, settings) {
  const crop = cropRect(srcW, srcH, settings.aspect);
  let w = crop.w, h = crop.h;
  const k = settings.frame ? frameLayout(w, h) : { w, h };
  const area = k.w * k.h;
  if (area > MAX_CANVAS_AREA) {
    const s = Math.sqrt(MAX_CANVAS_AREA / area);
    w = Math.floor(w * s);
    h = Math.floor(h * s);
  }
  return { crop, w, h };
}

// source: Canvas/Bild im Renderer bereits als Quelle gesetzt.
export function developToCanvas(renderer, srcW, srcH, settings, opts = {}) {
  const { crop, w, h } = outputSize(srcW, srcH, settings);
  const img = renderer.renderToImageData(settings, crop, w, h, { seed: settings.seed });
  let canvas, ix = 0, iy = 0;
  if (settings.frame) {
    const L = frameLayout(w, h);
    canvas = document.createElement('canvas');
    canvas.width = L.w;
    canvas.height = L.h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0d0a08';
    ctx.fillRect(0, 0, L.w, L.h);
    ix = L.ix;
    iy = L.iy;
    ctx.putImageData(img, ix, iy);
    drawFrame(ctx, L, w, h, settings, opts.frameNo ?? 1);
  } else {
    canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').putImageData(img, 0, 0);
  }
  if (settings.date) drawDateStamp(canvas.getContext('2d'), ix, iy, w, h, settings.takenAt ?? Date.now());
  return canvas;
}

export async function develop(renderer, srcW, srcH, settings, opts = {}) {
  const canvas = developToCanvas(renderer, srcW, srcH, settings, opts);
  const out = await canvasToBlob(canvas, 'image/jpeg', 0.93);
  const thumb = await canvasToBlob(scaledCanvas(canvas, 480), 'image/jpeg', 0.82);
  const res = { out, thumb, w: canvas.width, h: canvas.height };
  canvas.width = canvas.height = 0; // Speicher sofort freigeben (iOS)
  return res;
}

// ---------------------------------------------------------------------------
// Filmrahmen: Kleinbildstreifen mit Perforation und Randbeschriftung.
// Gezeichnet in Streifenkoordinaten (Streifen waagerecht, x entlang des
// Films); bei Hochformat wird das Koordinatensystem gedreht.

function drawFrame(ctx, L, imgW, imgH, settings, frameNo) {
  const film = getFilm(settings.film);
  const mm = L.mm;
  const SL = L.landscape ? L.w : L.h; // Länge entlang des Films
  const SW = L.landscape ? L.h : L.w; // Filmbreite
  const iL = L.landscape ? imgW : imgH;
  const iS = L.landscape ? imgH : imgW;
  const i0 = (SL - iL) / 2;
  const j0 = (SW - iS) / 2;

  ctx.save();
  if (!L.landscape) {
    // Streifen läuft senkrecht: Streifen-x zeigt nach oben
    ctx.translate(0, L.h);
    ctx.rotate(-Math.PI / 2);
  }

  // Bildfenster leicht abgerundet und mit weicher Kante
  ctx.strokeStyle = 'rgba(13,10,8,0.85)';
  ctx.lineWidth = Math.max(1, mm * 0.18);
  roundRect(ctx, i0, j0, iL, iS, mm * 0.35);
  ctx.stroke();

  // Perforation: 8 Löcher je 36-mm-Bild, Teilung 4,75 mm
  const pitch = 4.75 * mm;
  const hw = 2.79 * mm, hh = 1.98 * mm;
  const edge = 1.0 * mm;
  ctx.fillStyle = 'rgba(238,228,212,0.94)';
  ctx.shadowColor = 'rgba(255,220,180,0.35)';
  ctx.shadowBlur = mm * 0.6;
  const start = (SL / 2) % pitch - pitch;
  for (let x = start; x < SL + pitch; x += pitch) {
    roundRect(ctx, x - hw / 2, edge, hw, hh, mm * 0.45);
    ctx.fill();
    roundRect(ctx, x - hw / 2, SW - edge - hh, hw, hh, mm * 0.45);
    ctx.fill();
  }
  ctx.shadowBlur = 0;

  // Randbeschriftung (belichtet, erscheint im Positiv orange-gelb)
  const textCol = '#f2a23c';
  const band1 = edge + hh + (j0 - edge - hh) / 2; // zwischen Löchern und Bild (oben)
  const band2 = SW - band1;
  const fs = Math.min(1.25 * mm, (j0 - edge - hh) * 0.62);
  if (fs > 3) {
    ctx.fillStyle = textCol;
    ctx.shadowColor = 'rgba(255,140,40,0.55)';
    ctx.shadowBlur = fs * 0.35;
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${fs}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
    const label = `FILMKAMERA  ${film.name.toUpperCase()}  ${film.process}`;
    ctx.textAlign = 'left';
    ctx.fillText(label, i0 + 2 * mm, band1);
    ctx.textAlign = 'right';
    ctx.fillText(String(Math.max(1, frameNo - 1)), i0 - 0.4 * mm, band1);
    // Bildnummern unten: „12  ▸12A“
    ctx.textAlign = 'center';
    ctx.fillText(String(frameNo), i0 + iL * 0.18, band2);
    ctx.fillText(`▸ ${frameNo}A`, i0 + iL * 0.68, band2);
    // DX-Strichcode-artige Markierungen
    ctx.shadowBlur = 0;
    const bx = i0 + iL * 0.32;
    const bits = barcodeBits(film.iso + frameNo * 7);
    for (let i = 0; i < bits.length; i++) {
      if (!bits[i]) continue;
      ctx.fillRect(bx + i * 0.55 * mm, band2 - fs * 0.45, 0.32 * mm, fs * 0.9);
    }
  }
  ctx.restore();
}

function barcodeBits(n) {
  const bits = [1, 0, 1];
  for (let i = 0; i < 16; i++) bits.push((n >> i) & 1, 0);
  bits.push(1, 1, 0, 1);
  return bits;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---------------------------------------------------------------------------
// Datumsstempel: Siebensegmentziffern, vom Rückwand-LED aufbelichtet –
// orange mit leichtem Leuchten.

const SEGMENTS = {
  0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd',
  6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg', ' ': '', "'": "'",
};

export function drawDateStamp(ctx, ix, iy, w, h, ts) {
  const text = dateStampText(ts);
  const short = Math.min(w, h);
  const H = short * 0.034;
  const W = H * 0.52;
  const T = H * 0.13;
  const gap = W * 0.42;
  const advance = (ch) => (ch === "'" ? W * 0.35 : W + gap);
  let total = 0;
  for (const ch of text) total += advance(ch);
  let x = ix + w - short * 0.06 - total;
  const y = iy + h - short * 0.06 - H;

  const segs = (ch, x0) => {
    const s = SEGMENTS[ch] ?? '';
    const r = [];
    const half = H / 2;
    if (s.includes("'")) r.push([x0, y - H * 0.05, T * 0.9, H * 0.3]);
    if (s.includes('a')) r.push([x0 + T * 0.6, y, W - T * 1.2, T]);
    if (s.includes('b')) r.push([x0 + W - T, y + T * 0.6, T, half - T * 0.9]);
    if (s.includes('c')) r.push([x0 + W - T, y + half + T * 0.3, T, half - T * 0.9]);
    if (s.includes('d')) r.push([x0 + T * 0.6, y + H - T, W - T * 1.2, T]);
    if (s.includes('e')) r.push([x0, y + half + T * 0.3, T, half - T * 0.9]);
    if (s.includes('f')) r.push([x0, y + T * 0.6, T, half - T * 0.9]);
    if (s.includes('g')) r.push([x0 + T * 0.6, y + half - T / 2, W - T * 1.2, T]);
    return r;
  };

  const rects = [];
  for (const ch of text) {
    rects.push(...segs(ch, x));
    x += advance(ch);
  }
  ctx.save();
  // leicht kursiv wie die LED-Anzeigen
  ctx.transform(1, 0, -0.08, 1, (y + H) * 0.08, 0);
  ctx.globalCompositeOperation = 'lighter';
  const pass = (color, blur, alpha) => {
    ctx.fillStyle = color;
    ctx.globalAlpha = alpha;
    ctx.shadowColor = color;
    ctx.shadowBlur = blur;
    for (const [rx, ry, rw, rh] of rects) {
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(rx, ry, rw, rh, T * 0.45) : ctx.rect(rx, ry, rw, rh);
      ctx.fill();
    }
  };
  pass('rgb(255,90,20)', H * 0.6, 0.55);
  pass('rgb(255,150,60)', H * 0.15, 0.9);
  // Kern deckend, damit der Stempel auch auf hellem Grund lesbar bleibt
  ctx.globalCompositeOperation = 'source-over';
  pass('rgb(255,170,90)', H * 0.08, 0.92);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Teilen / Sichern

export function photoFileName(ts, i = 0) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `Filmkamera_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${i ? `_${i}` : ''}.jpg`;
}

export function canShareFiles(files) {
  try {
    return !!navigator.canShare && navigator.canShare({ files });
  } catch {
    return false;
  }
}

export async function shareFiles(files) {
  if (canShareFiles(files)) {
    try {
      await navigator.share({ files });
      return 'shared';
    } catch (err) {
      if (err?.name === 'AbortError') return 'aborted';
      throw err;
    }
  }
  for (const f of files) {
    const url = URL.createObjectURL(f);
    const a = document.createElement('a');
    a.href = url;
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  return 'downloaded';
}
