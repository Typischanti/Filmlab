// Laden von Scans und Speichern von Exporten im Browser.

import { decodeTiff, isTiff, encodeTiff16 } from './core/tiff.js';
import { createImage } from './core/geometry.js';
import { floatToU16 } from './core/pipeline.js';

export async function decodeFile(file) {
  const buffer = await file.arrayBuffer();
  if (buffer.byteLength >= 8 && isTiff(buffer)) {
    try {
      return await decodeTiff(buffer);
    } catch (err) {
      // Safari kann manche TIFF-Varianten selbst dekodieren
      try { return await decodeBitmap(new Blob([buffer])); } catch { throw err; }
    }
  }
  return decodeBitmap(new Blob([buffer], { type: file.type }));
}

async function decodeBitmap(blob) {
  let bmp;
  try {
    bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none', imageOrientation: 'from-image' });
  } catch {
    throw new Error('Dieses Dateiformat kann nicht gelesen werden.');
  }
  const canvas = makeCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const rgba = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
  bmp.close?.();
  const img = createImage(canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    d[j] = rgba[i] * 257;
    d[j + 1] = rgba[i + 1] * 257;
    d[j + 2] = rgba[i + 2] * 257;
  }
  img.bitDepth = 8;
  return img;
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// Float-RGB -> Blob im gewünschten Format.
export async function encodeOutput(res, format, quality = 0.95) {
  if (format === 'tiff') {
    return new Blob([encodeTiff16(res.width, res.height, floatToU16(res.rgb), { software: 'Filmlab' })], { type: 'image/tiff' });
  }
  const canvas = document.createElement('canvas');
  canvas.width = res.width;
  canvas.height = res.height;
  const ctx = canvas.getContext('2d');
  const id = ctx.createImageData(res.width, res.height);
  const o = id.data;
  const s = res.rgb;
  for (let i = 0, j = 0; i < s.length; i += 3, j += 4) {
    // leichtes Dithering gegen Tonwertabrisse in 8 Bit
    const n = (((i * 2654435761) >>> 0) / 4294967296 - 0.5) / 255;
    o[j] = Math.min(1, Math.max(0, s[i] + n)) * 255 + 0.5;
    o[j + 1] = Math.min(1, Math.max(0, s[i + 1] + n)) * 255 + 0.5;
    o[j + 2] = Math.min(1, Math.max(0, s[i + 2] + n)) * 255 + 0.5;
    o[j + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
  const type = format === 'png' ? 'image/png' : 'image/jpeg';
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Export fehlgeschlagen (Bild zu groß für den Browser?)'))), type, quality));
}

export function extensionFor(format) {
  return format === 'tiff' ? '.tif' : format === 'png' ? '.png' : '.jpg';
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// Ordner wählen (Chromium); sonst null -> einzelne Downloads.
export async function pickDirectory() {
  if (!window.showDirectoryPicker) return null;
  try {
    return await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return null;
  }
}

export async function writeToDirectory(dir, name, blob) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(blob);
  await w.close();
}
