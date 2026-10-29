// Minimaler TIFF-Decoder/-Encoder für Filmscans.
// Lesen: 8/16/32(float)-Bit, Graustufen/RGB(A), Strips oder Kacheln,
// unkomprimiert, LZW, Deflate, PackBits, Prädiktor 2, Chunky oder Planar.
// Schreiben: 16-Bit-RGB, unkomprimiert.

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8 };

function readIFDs(view, little) {
  const ifds = [];
  let off = view.getUint32(4, little);
  const seen = new Set();
  while (off && !seen.has(off) && off < view.byteLength) {
    seen.add(off);
    const n = view.getUint16(off, little);
    const tags = {};
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      const tag = view.getUint16(e, little);
      const type = view.getUint16(e + 2, little);
      const count = view.getUint32(e + 4, little);
      const size = (TYPE_SIZE[type] || 1) * count;
      const vo = size <= 4 ? e + 8 : view.getUint32(e + 8, little);
      const vals = [];
      if (vo + size > view.byteLength) continue;
      for (let k = 0; k < count && k < 1e7; k++) {
        switch (type) {
          case 3: vals.push(view.getUint16(vo + k * 2, little)); break;
          case 4: case 13: vals.push(view.getUint32(vo + k * 4, little)); break;
          case 8: vals.push(view.getInt16(vo + k * 2, little)); break;
          case 9: vals.push(view.getInt32(vo + k * 4, little)); break;
          case 5: vals.push(view.getUint32(vo + k * 8, little) / (view.getUint32(vo + k * 8 + 4, little) || 1)); break;
          case 11: vals.push(view.getFloat32(vo + k * 4, little)); break;
          case 12: vals.push(view.getFloat64(vo + k * 8, little)); break;
          default: vals.push(view.getUint8(vo + k));
        }
      }
      tags[tag] = vals;
    }
    ifds.push(tags);
    off = view.getUint32(off + 2 + n * 12, little);
  }
  return ifds;
}

function lzwDecode(input, expected) {
  const out = new Uint8Array(expected);
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const first = new Uint8Array(4096);
  const length = new Uint16Array(4096);
  for (let i = 0; i < 256; i++) { prefix[i] = -1; suffix[i] = i; first[i] = i; length[i] = 1; }
  let next = 258;
  let width = 9;
  let prev = -1;
  let op = 0;
  let bitPos = 0;
  const totalBits = input.length * 8;
  const emit = (code) => {
    const len = length[code];
    let p = op + len - 1;
    let c = code;
    while (c >= 0) {
      if (p < expected) out[p] = suffix[c];
      p--;
      c = prefix[c];
    }
    op += len;
  };
  while (bitPos + width <= totalBits && op < expected) {
    // MSB-first lesen
    const byte = bitPos >> 3;
    const word = (input[byte] << 16) | ((input[byte + 1] || 0) << 8) | (input[byte + 2] || 0);
    const code = (word >> (24 - (bitPos & 7) - width)) & ((1 << width) - 1);
    bitPos += width;
    if (code === 257) break;
    if (code === 256) {
      next = 258;
      width = 9;
      prev = -1;
      continue;
    }
    if (prev < 0) {
      emit(code);
      prev = code;
      continue;
    }
    if (code < next) {
      emit(code);
      if (next < 4096) {
        prefix[next] = prev; suffix[next] = first[code]; first[next] = first[prev]; length[next] = length[prev] + 1;
        next++;
      }
    } else {
      if (next < 4096) {
        prefix[next] = prev; suffix[next] = first[prev]; first[next] = first[prev]; length[next] = length[prev] + 1;
        next++;
      }
      emit(code);
    }
    prev = code;
    if (next + 1 >= 1 << width && width < 12) width++;
  }
  return out;
}

function packBitsDecode(input, expected) {
  const out = new Uint8Array(expected);
  let ip = 0, op = 0;
  while (ip < input.length && op < expected) {
    const n = (input[ip++] << 24) >> 24;
    if (n >= 0) {
      for (let i = 0; i <= n && op < expected; i++) out[op++] = input[ip++];
    } else if (n !== -128) {
      const v = input[ip++];
      for (let i = 0; i < 1 - n && op < expected; i++) out[op++] = v;
    }
  }
  return out;
}

async function inflate(input) {
  if (typeof DecompressionStream === 'undefined') throw new Error('Deflate-TIFF wird von diesem Browser nicht unterstützt.');
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([input]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function decompress(bytes, compression, expected) {
  switch (compression) {
    case 1: return bytes;
    case 5: return lzwDecode(bytes, expected);
    case 8: case 32946: return inflate(bytes);
    case 32773: return packBitsDecode(bytes, expected);
    default: throw new Error(`TIFF-Kompression ${compression} wird nicht unterstützt (bitte unkomprimiert, LZW oder ZIP speichern).`);
  }
}

export function isTiff(buffer) {
  const b = new Uint8Array(buffer, 0, 4);
  return (b[0] === 0x49 && b[1] === 0x49 && b[2] === 42 && b[3] === 0) ||
    (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 42);
}

// Liefert { width, height, data: Uint16Array (RGB), bitDepth }.
export async function decodeTiff(buffer) {
  const view = new DataView(buffer);
  const little = view.getUint16(0) === 0x4949;
  if (view.getUint16(2, little) !== 42) throw new Error('Keine gültige TIFF-Datei (BigTIFF wird nicht unterstützt).');
  const ifds = readIFDs(view, little).filter((t) => t[256] && t[257]);
  if (!ifds.length) throw new Error('TIFF enthält kein Bild.');
  // Größtes Bild wählen (manche Scanner legen Vorschaubilder ab)
  const tags = ifds.reduce((a, b) => (b[256][0] * b[257][0] > a[256][0] * a[257][0] ? b : a));

  const W = tags[256][0];
  const H = tags[257][0];
  const spp = tags[277]?.[0] ?? 1;
  const bps = tags[258]?.[0] ?? 1;
  const compression = tags[259]?.[0] ?? 1;
  const photometric = tags[262]?.[0] ?? (spp >= 3 ? 2 : 1);
  const planar = tags[284]?.[0] ?? 1;
  const predictor = tags[317]?.[0] ?? 1;
  const sampleFormat = tags[339]?.[0] ?? 1;
  if (![8, 16, 32].includes(bps)) throw new Error(`TIFF mit ${bps} Bit pro Kanal wird nicht unterstützt.`);
  if (bps === 32 && sampleFormat !== 3) throw new Error('32-Bit-TIFF muss Gleitkomma sein.');
  if (![0, 1, 2].includes(photometric)) throw new Error('Nur Graustufen- oder RGB-TIFFs werden unterstützt (kein CMYK/YCbCr/Palette).');
  const bytesPer = bps / 8;

  const tiled = !!tags[322];
  const tw = tiled ? tags[322][0] : W;
  const th = tiled ? tags[323][0] : (tags[278]?.[0] ?? H);
  const offsets = tiled ? tags[324] : tags[273];
  const counts = tiled ? tags[325] : tags[279];
  if (!offsets) throw new Error('TIFF ohne Bilddaten.');
  const tilesAcross = tiled ? Math.ceil(W / tw) : 1;
  const tilesDown = Math.ceil(H / th);
  const tilesPerPlane = tilesAcross * tilesDown;

  const out = new Uint16Array(W * H * 3);
  const chanOut = Math.min(spp, 3);
  const bytes = new Uint8Array(buffer);

  for (let t = 0; t < offsets.length; t++) {
    const plane = planar === 2 ? Math.floor(t / tilesPerPlane) : 0;
    if (planar === 2 && plane >= chanOut) continue;
    const ti = t % tilesPerPlane;
    const tx = (ti % tilesAcross) * tw;
    const ty = Math.floor(ti / tilesAcross) * th;
    const rows = tiled ? th : Math.min(th, H - ty);
    const cols = tw;
    const samplesPerPixel = planar === 2 ? 1 : spp;
    const rowBytes = cols * samplesPerPixel * bytesPer;
    const expected = rowBytes * rows;
    const raw = bytes.subarray(offsets[t], offsets[t] + (counts ? counts[t] : expected));
    let data = await decompress(raw, compression, expected);
    if (data.length < expected) {
      const p = new Uint8Array(expected);
      p.set(data);
      data = p;
    }
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);

    // Werte lesen in eine Zeile Uint16/Float
    for (let y = 0; y < rows; y++) {
      const oy = ty + y;
      if (oy >= H) break;
      const line = new Float64Array(cols * samplesPerPixel);
      const base = y * rowBytes;
      for (let i = 0; i < cols * samplesPerPixel; i++) {
        const p = base + i * bytesPer;
        if (bps === 8) line[i] = data[p];
        else if (bps === 16) line[i] = dv.getUint16(p, little);
        else line[i] = dv.getFloat32(p, little);
      }
      if (predictor === 2 && bps !== 32) {
        const mod = bps === 8 ? 256 : 65536;
        for (let i = samplesPerPixel; i < line.length; i++) line[i] = (line[i] + line[i - samplesPerPixel]) % mod;
      }
      for (let x = 0; x < cols; x++) {
        const ox = tx + x;
        if (ox >= W) break;
        const o = (oy * W + ox) * 3;
        for (let c = 0; c < (planar === 2 ? 1 : chanOut); c++) {
          let v = line[x * samplesPerPixel + c];
          if (bps === 8) v *= 257;
          else if (bps === 32) v = Math.max(0, Math.min(1, v)) * 65535;
          if (photometric === 0) v = 65535 - v;
          const ch = planar === 2 ? plane : c;
          out[o + ch] = v;
        }
      }
    }
  }
  if (chanOut === 1 || spp < 3) {
    for (let i = 0; i < W * H; i++) {
      out[i * 3 + 1] = out[i * 3];
      out[i * 3 + 2] = out[i * 3];
    }
  }
  return { width: W, height: H, data: out, bitDepth: bps };
}

// 16-Bit-RGB-TIFF schreiben (Little Endian, unkomprimiert).
export function encodeTiff16(width, height, rgb16, opts = {}) {
  const software = (opts.software || 'Filmlab') + '\0';
  const entries = [];
  const dataSize = width * height * 6;
  const nTags = 13;
  const ifdOffset = 8;
  const ifdSize = 2 + nTags * 12 + 4;
  let extra = ifdOffset + ifdSize;
  const bpsOff = extra; extra += 6;
  const xresOff = extra; extra += 8;
  const yresOff = extra; extra += 8;
  const swOff = extra; extra += software.length + (software.length & 1);
  const dataOff = extra;
  const buf = new ArrayBuffer(dataOff + dataSize);
  const v = new DataView(buf);
  v.setUint16(0, 0x4949, false);
  v.setUint16(2, 42, true);
  v.setUint32(4, ifdOffset, true);
  const dpi = opts.dpi || 300;
  entries.push([256, 4, 1, width]);
  entries.push([257, 4, 1, height]);
  entries.push([258, 3, 3, bpsOff]);
  entries.push([259, 3, 1, 1]);
  entries.push([262, 3, 1, 2]);
  entries.push([273, 4, 1, dataOff]);
  entries.push([277, 3, 1, 3]);
  entries.push([278, 4, 1, height]);
  entries.push([279, 4, 1, dataSize]);
  entries.push([282, 5, 1, xresOff]);
  entries.push([283, 5, 1, yresOff]);
  entries.push([296, 3, 1, 2]);
  entries.push([305, 2, software.length, swOff]);
  v.setUint16(ifdOffset, nTags, true);
  entries.forEach(([tag, type, count, value], i) => {
    const e = ifdOffset + 2 + i * 12;
    v.setUint16(e, tag, true);
    v.setUint16(e + 2, type, true);
    v.setUint32(e + 4, count, true);
    if (type === 3 && count === 1) v.setUint16(e + 8, value, true);
    else v.setUint32(e + 8, value, true);
  });
  v.setUint32(ifdOffset + 2 + nTags * 12, 0, true);
  for (let i = 0; i < 3; i++) v.setUint16(bpsOff + i * 2, 16, true);
  v.setUint32(xresOff, dpi, true); v.setUint32(xresOff + 4, 1, true);
  v.setUint32(yresOff, dpi, true); v.setUint32(yresOff + 4, 1, true);
  for (let i = 0; i < software.length; i++) v.setUint8(swOff + i, software.charCodeAt(i));
  const px = new Uint16Array(buf, dataOff, width * height * 3);
  px.set(rgb16);
  return buf;
}
