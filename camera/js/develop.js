// Entwickeln in voller Auflösung, Datumsstempel, Filmrahmen, Dateien.

import { cropRect, fitArea, dateStampText, rng, MAX_CANVAS_AREA } from './model.js';
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
const GATE_H = 24;
const SIDE_GAP = 2.2;

export function frameLayout(imgW, imgH) {
  const landscape = imgW >= imgH;
  const long = landscape ? imgW : imgH;
  const short = landscape ? imgH : imgW;
  // Die kurze Bildseite füllt immer das 24-mm-Fenster; breitere Formate
  // werden länger (wie bei Panoramakameras auf Kleinbild, z. B. 24 × 65 mm).
  const mm = Math.min(short / GATE_H, long / FRAME_LEN);
  const L = Math.round(long + 2 * SIDE_GAP * mm);
  const S = Math.round(FILM_W * mm);
  return landscape
    ? { w: L, h: S, ix: Math.round((L - imgW) / 2), iy: Math.round((S - imgH) / 2), mm, landscape }
    : { w: S, h: L, ix: Math.round((S - imgW) / 2), iy: Math.round((L - imgH) / 2), mm, landscape };
}

// Rahmenarten: Lage des Bildes im fertigen Abzug (alle Maße in Pixeln).
//  strip:   gescannter Kleinbildstreifen
//  print:   Laborabzug mit schmalem weißem Papierrand
//  instant: Sofortbild mit breiterem Rand unten
export function borderLayout(kind, imgW, imgH) {
  const S = Math.min(imgW, imgH);
  if (kind === 'strip') return { kind, ...frameLayout(imgW, imgH) };
  if (kind === 'print') {
    const b = Math.round(S * 0.045);
    return { kind, w: imgW + 2 * b, h: imgH + 2 * b, ix: b, iy: b };
  }
  if (kind === 'instant') {
    const side = Math.round(S * 0.065), top = Math.round(S * 0.075), bottom = Math.round(S * 0.27);
    return { kind, w: imgW + 2 * side, h: imgH + top + bottom, ix: side, iy: top };
  }
  return { kind: 'none', w: imgW, h: imgH, ix: 0, iy: 0 };
}

// Ausgabegröße so wählen, dass das fertige Bild (ggf. mit Rahmen) in die
// Größengrenze von Safari passt.
export function outputSize(srcW, srcH, settings) {
  const crop = cropRect(srcW, srcH, settings.aspect);
  let w = crop.w, h = crop.h;
  const k = borderLayout(settings.border, w, h);
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
  const L = borderLayout(settings.border, w, h);
  const canvas = document.createElement('canvas');
  canvas.width = L.w;
  canvas.height = L.h;
  const ctx = canvas.getContext('2d');
  drawBorderBack(ctx, L, w, h, settings);
  ctx.putImageData(img, L.ix, L.iy);
  drawBorderFront(ctx, L, w, h, settings, opts.frameNo ?? 1);
  if (settings.date) drawDateStamp(ctx, L.ix, L.iy, w, h, settings.takenAt ?? Date.now());
  return canvas;
}

// Rahmen für den Sucher: Bildbereich bleibt durchsichtig, darunter liegt
// die Live-Vorschau.
export function drawBorderPreview(canvas, kind, imgW, imgH, settings, frameNo = 1) {
  const L = borderLayout(kind, imgW, imgH);
  if (canvas.width !== L.w || canvas.height !== L.h) {
    canvas.width = L.w;
    canvas.height = L.h;
  }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, L.w, L.h);
  if (kind === 'none') return L;
  drawBorderBack(ctx, L, imgW, imgH, settings);
  ctx.clearRect(L.ix, L.iy, imgW, imgH);
  drawBorderFront(ctx, L, imgW, imgH, settings, frameNo);
  return L;
}

function drawBorderBack(ctx, L, imgW, imgH, settings) {
  if (L.kind === 'strip') drawRebate(ctx, L, imgW, imgH, settings);
  else if (L.kind === 'print') drawPaper(ctx, L, '#f4f1eb', 0.035);
  else if (L.kind === 'instant') drawPaper(ctx, L, '#f1eee5', 0.05, true);
}

function drawBorderFront(ctx, L, imgW, imgH, settings, frameNo) {
  if (L.kind === 'strip') drawFrame(ctx, L, imgW, imgH, settings, frameNo);
  else if (L.kind === 'print') drawImageEdge(ctx, L, imgW, imgH, 'rgba(0,0,0,0.16)', 0.0012, 0.002);
  else if (L.kind === 'instant') drawImageEdge(ctx, L, imgW, imgH, 'rgba(28,22,16,0.55)', 0.004, 0.006);
}

// Papier bzw. Sofortbildkarte: leicht strukturiert, mit sanftem Lichtverlauf.
function drawPaper(ctx, L, color, texture, card = false) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, L.w, L.h);
  const gr = ctx.createLinearGradient(0, 0, L.w, L.h);
  gr.addColorStop(0, 'rgba(255,255,255,0.35)');
  gr.addColorStop(1, card ? 'rgba(120,105,80,0.10)' : 'rgba(120,110,95,0.05)');
  ctx.fillStyle = gr;
  ctx.fillRect(0, 0, L.w, L.h);
  const pat = rebateGrain(ctx);
  const k = Math.max(1, Math.min(L.w, L.h) / 900);
  if (pat.setTransform) pat.setTransform(new DOMMatrix().scale(k));
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = texture;
  ctx.fillStyle = pat;
  ctx.fillRect(0, 0, L.w, L.h);
  ctx.restore();
}

// Bildkante: beim Abzug eine feine Papierkante, beim Sofortbild der
// dunkle, leicht unregelmäßige Rand der Entwicklerpaste.
function drawImageEdge(ctx, L, imgW, imgH, color, width, blur) {
  const S = Math.min(imgW, imgH);
  ctx.save();
  ctx.beginPath();
  ctx.rect(L.ix, L.iy, imgW, imgH);
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, S * width);
  ctx.shadowColor = color;
  ctx.shadowBlur = Math.max(1, S * blur);
  ctx.strokeRect(L.ix, L.iy, imgW, imgH);
  ctx.restore();
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
// Filmrahmen: gescannter Kleinbildstreifen (Positiv).
//
// Geometrie nach Kleinbildnorm (mm): Filmbreite 35, Bildfenster 36 × 24,
// KS-Perforation 2,79 × 1,98 mm mit 0,5 mm Eckradius, Teilung 4,75 mm
// (8 Löcher je Bild), Löcher dicht neben dem Bildfenster, Randbeschriftung
// außen zwischen Perforation und Filmkante.
//
// Aussehen je Filmtyp:
//  Negativ (C-41/ECN-2): Der unbelichtete Filmgrund wird im Positiv fast
//    schwarz, die Löcher (volles Scannerlicht) noch dunkler. Die vorbelichtete
//    Randbeschriftung erscheint hell orange.
//  Dia (E-6): Unbelichteter Umkehrfilm ist maximal dicht (tiefschwarz), durch
//    die Löcher scheint das Licht des Leuchtpults.
// Gezeichnet in Streifenkoordinaten (x entlang des Films, y quer); bei
// Hochformat wird das Koordinatensystem gedreht.

const STRIP = {
  width: 35,
  gate: 24,
  perfW: 2.794,
  perfH: 1.981,
  perfR: 0.5,
  pitch: 4.75,
  margin: 2.55, // Filmkante -> Perforation (Platz für die Randbeschriftung)
};

function frameStyle(film) {
  if (film.bw) {
    // S/W-Negativ: klarer Träger wird im Positiv schwarz, Randbelichtung hellgrau
    return { base: [10, 10, 10], holes: 'dark', text: '#e9e7e2', glow: 'rgba(255,255,255,0.3)', fog: 'rgba(70,70,70,0.18)', dust: true };
  }
  if (film.type === 'slide') {
    return { base: [7, 6, 9], holes: 'light', text: '#f3e6bd', glow: 'rgba(255,236,190,0.45)', fog: 'rgba(70,45,30,0.0)', dust: false };
  }
  if (film.process === 'ECN-2') {
    return { base: [13, 12, 12], holes: 'dark', text: '#f4ad45', glow: 'rgba(255,150,50,0.5)', fog: 'rgba(110,60,30,0.16)', dust: true, cine: true };
  }
  return { base: [20, 15, 12], holes: 'dark', text: '#f3a53c', glow: 'rgba(255,140,40,0.5)', fog: 'rgba(120,65,28,0.2)', dust: true };
}

function stripGeometry(L, imgW, imgH) {
  const mm = L.mm;
  const SL = L.landscape ? L.w : L.h; // Länge entlang des Films
  const SW = L.landscape ? L.h : L.w; // Filmbreite
  const iL = L.landscape ? imgW : imgH;
  const iS = L.landscape ? imgH : imgW;
  return { mm, SL, SW, iL, iS, i0: (SL - iL) / 2, j0: (SW - iS) / 2 };
}

function toStripCoords(ctx, L) {
  if (!L.landscape) {
    // Streifen läuft senkrecht: Streifen-x zeigt nach oben
    ctx.translate(0, L.h);
    ctx.rotate(-Math.PI / 2);
  }
}

let grainTile = null;
function rebateGrain(ctx) {
  if (!grainTile) {
    grainTile = document.createElement('canvas');
    grainTile.width = grainTile.height = 128;
    const g = grainTile.getContext('2d');
    const id = g.createImageData(128, 128);
    const r = rng(9001);
    for (let i = 0; i < id.data.length; i += 4) {
      const v = Math.pow(r(), 2.2) * 255;
      id.data[i] = v;
      id.data[i + 1] = v * 0.92;
      id.data[i + 2] = v * 0.85;
      id.data[i + 3] = 255;
    }
    g.putImageData(id, 0, 0);
  }
  return ctx.createPattern(grainTile, 'repeat');
}

// Filmgrund (vor dem Bild gezeichnet).
function drawRebate(ctx, L, imgW, imgH, settings) {
  const film = getFilm(settings.film);
  const st = frameStyle(film);
  const G = stripGeometry(L, imgW, imgH);
  const { mm, SL, SW } = G;
  ctx.save();
  ctx.fillStyle = `rgb(${st.base.join(',')})`;
  ctx.fillRect(0, 0, L.w, L.h);
  toStripCoords(ctx, L);

  // Randschleier: Licht, das in der Patrone an der Filmkante eindringt
  if (st.fog) {
    for (const [y0, y1] of [[0, 1.1 * mm], [SW, SW - 1.1 * mm]]) {
      const gr = ctx.createLinearGradient(0, y0, 0, y1);
      gr.addColorStop(0, st.fog);
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gr;
      ctx.fillRect(0, Math.min(y0, y1), SL, Math.abs(y1 - y0));
    }
  }
  // leichte, unregelmäßige Dichteschwankung entlang des Streifens
  const r = rng((settings.seed ?? 1) ^ 0x5bd1);
  for (let i = 0; i < 3; i++) {
    const cx = r() * SL, cy = r() * SW, rad = (8 + r() * 14) * mm;
    const gr = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
    gr.addColorStop(0, `rgba(${st.base.map((v) => v * 2.2 + 6).join(',')},0.10)`);
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gr;
    ctx.fillRect(cx - rad, cy - rad, 2 * rad, 2 * rad);
  }
  // Korn im Filmgrund
  const pat = rebateGrain(ctx);
  const k = Math.max(1, mm * 0.011);
  if (pat.setTransform) pat.setTransform(new DOMMatrix().scale(k));
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.07;
  ctx.fillStyle = pat;
  ctx.fillRect(0, 0, SL, SW);
  ctx.restore();
}

// Perforation, Bildfensterkante und Randbeschriftung (nach dem Bild).
function drawFrame(ctx, L, imgW, imgH, settings, frameNo) {
  const film = getFilm(settings.film);
  const st = frameStyle(film);
  const G = stripGeometry(L, imgW, imgH);
  const { mm, SL, SW, iL, iS, i0, j0 } = G;
  const r = rng((settings.seed ?? 1) ^ 0x2c1b);
  const base = `rgb(${st.base.join(',')})`;

  ctx.save();
  toStripCoords(ctx, L);

  // Bildfenster: leicht gerundete Ecken und eine weich auslaufende Kante
  // (das Kamerafenster liegt nicht exakt in der Schärfeebene)
  ctx.save();
  ctx.beginPath();
  ctx.rect(i0, j0, iL, iS);
  roundRectPath(ctx, i0, j0, iL, iS, 0.32 * mm);
  ctx.fillStyle = base;
  ctx.fill('evenodd');
  roundRectPath(ctx, i0, j0, iL, iS, 0.32 * mm, true);
  ctx.strokeStyle = base;
  ctx.lineWidth = Math.max(1, 0.08 * mm);
  ctx.shadowColor = base;
  ctx.shadowBlur = Math.max(1, 0.1 * mm);
  ctx.stroke();
  ctx.restore();

  // Perforation (KS): symmetrisch zur Bildmitte, 8 Löcher je Bild
  const pw = STRIP.perfW * mm, ph = STRIP.perfH * mm, pr = STRIP.perfR * mm;
  const pitch = STRIP.pitch * mm;
  const yTop = STRIP.margin * mm;
  const yBot = SW - STRIP.margin * mm - ph;
  const cx0 = i0 + iL / 2 + pitch / 2;
  const first = cx0 - Math.ceil((cx0 + pw) / pitch) * pitch;
  ctx.save();
  if (st.holes === 'light') {
    ctx.shadowColor = 'rgba(255,244,222,0.55)';
    ctx.shadowBlur = 0.45 * mm;
  }
  for (let x = first; x < SL + pw; x += pitch) {
    for (const y of [yTop, yBot]) {
      roundRectPath(ctx, x - pw / 2, y, pw, ph, pr, true);
      if (st.holes === 'light') {
        const gr = ctx.createLinearGradient(0, y, 0, y + ph);
        gr.addColorStop(0, '#f4eee2');
        gr.addColorStop(0.5, '#fbf7ee');
        gr.addColorStop(1, '#ece3d2');
        ctx.fillStyle = gr;
        ctx.fill();
      } else {
        ctx.fillStyle = '#020101';
        ctx.fill();
        // Schnittkante fängt etwas Licht
        ctx.strokeStyle = 'rgba(255,225,190,0.09)';
        ctx.lineWidth = Math.max(1, 0.05 * mm);
        ctx.stroke();
      }
    }
  }
  ctx.restore();

  // Randbeschriftung (vorbelichtet, daher leicht weich)
  const textH = 1.25 * mm;
  if (textH >= 5) {
    ctx.save();
    ctx.fillStyle = st.text;
    ctx.shadowColor = st.glow;
    ctx.shadowBlur = 0.18 * mm;
    ctx.textBaseline = 'middle';
    const yT = (STRIP.margin * mm) / 2; // oberer Rand
    const yB = SW - yT; // unterer Rand
    const name = film.name.toUpperCase();
    const lot = 1 + (((settings.seed ?? 7) >>> 3) % 9);
    if (st.cine) {
      edgeText(ctx, `FILMKAMERA  ${name}  ${film.process}  ${lot}2${lot + 1}`, i0 + 0.04 * iL, yT, textH);
      edgeText(ctx, `${lot}`, i0 + 0.86 * iL, yT, textH);
      // Fußnummer mit Strichcode (wie KeyKode beim Kinofilm)
      const key = `KF ${10 + lot} ${String(1000 + ((settings.seed ?? 0) % 9000)).padStart(4, '0')} ${String((frameNo * 16) % 10000).padStart(4, '0')}+${String(frameNo % 16).padStart(2, '0')}`;
      edgeText(ctx, key, i0 + 0.08 * iL, yB, textH * 0.9);
      drawBarcode(ctx, i0 + 0.52 * iL, yB - textH * 0.42, textH * 0.84, 0.13 * mm, i0 + 0.97 * iL, (settings.seed ?? 3) + frameNo);
    } else {
      edgeText(ctx, `FILMKAMERA  ${name}  ${lot}`, i0 + 0.1 * iL, yT, textH);
      edgeText(ctx, `${name}`, i0 + 0.68 * iL, yT, textH);
      // Bildnummern: „12“ unter dem Bild, „▸12A“ an der halben Bildteilung
      edgeText(ctx, String(frameNo), i0 + 0.2 * iL, yB, textH * 1.05, 'center');
      edgeText(ctx, `▸${frameNo}A`, i0 + 0.46 * iL, yB, textH * 0.95, 'center');
      // DX-Strichcode: Taktspur (außen) und Datenspur
      drawDx(ctx, i0 + 0.6 * iL, SW, mm, film.iso + frameNo);
    }
    ctx.restore();
  }

  // Staub im Filmgrund (nur bei Negativen sichtbar: hell im Positiv)
  if (st.dust) {
    ctx.fillStyle = 'rgba(236,228,214,0.75)';
    const n = 3 + Math.floor(r() * 6);
    for (let i = 0; i < n; i++) {
      const x = r() * SL;
      const y = r() < 0.5 ? r() * (j0 - 0.4 * mm) : SW - r() * (j0 - 0.4 * mm);
      const rad = (0.025 + r() * 0.06) * mm;
      ctx.beginPath();
      ctx.ellipse(x, y, rad * (1 + r()), rad, r() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

// Schmale, gesperrte Schrift wie bei der Randbelichtung.
function edgeText(ctx, text, x, y, h, align = 'left') {
  ctx.save();
  ctx.font = `700 ${h}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.translate(x, y);
  ctx.scale(0.8, 1);
  ctx.textAlign = align;
  let cx = 0;
  const spacing = h * 0.08;
  const widths = [...text].map((ch) => ctx.measureText(ch).width + spacing);
  const total = widths.reduce((a, b) => a + b, 0);
  if (align === 'center') cx = -total / 2;
  ctx.textAlign = 'left';
  [...text].forEach((ch, i) => {
    ctx.fillText(ch, cx, 0);
    cx += widths[i];
  });
  ctx.restore();
}

// DX-Code am unteren Rand: Taktspur (regelmäßig) und Datenspur.
function drawDx(ctx, x0, SW, mm, value) {
  const bw = 0.38 * mm, gap = 0.38 * mm, bh = 0.62 * mm;
  const clockY = SW - 0.35 * mm - bh;
  const dataY = clockY - bh - 0.18 * mm;
  const bits = [1, 0, 1, 1];
  for (let i = 0; i < 12; i++) bits.push((value >> i) & 1);
  bits.push(0, 1, 1, 0, 1, 0, 1);
  for (let i = 0; i < bits.length; i++) {
    const x = x0 + i * (bw + gap) * 0.5;
    if (i % 2 === 0) ctx.fillRect(x, clockY, bw * 0.5, bh);
    if (bits[i]) ctx.fillRect(x, dataY, bw * 0.5, bh);
  }
}

// Fußnummer-Strichcode (feine Module).
function drawBarcode(ctx, x0, y, h, module, xEnd, seed) {
  const r = rng(seed * 31 + 5);
  let x = x0;
  for (let i = 0; x < xEnd; i++) {
    const w = module * (1 + Math.floor(r() * 3));
    if (i % 2 === 0) ctx.fillRect(x, y, Math.min(w, xEnd - x), h);
    x += w;
  }
}

function roundRectPath(ctx, x, y, w, h, r, fresh = false) {
  if (fresh) ctx.beginPath();
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
