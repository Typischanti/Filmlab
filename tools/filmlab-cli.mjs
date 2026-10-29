#!/usr/bin/env node
// Kommandozeile: Negativ-TIFFs stapelweise umwandeln.
//
//   node tools/filmlab-cli.mjs scan.tif [weitere.tif ...] [Optionen]
//
// Optionen:
//   --out <ordner>        Ausgabeordner (Standard: neben der Eingabe)
//   --format png|png16|tif  Ausgabeformat (Standard: tif = 16-Bit-TIFF)
//   --settings <datei>    Einstellungen (JSON aus der App, "Einstellungen exportieren")
//   --type color|bw|positive
//   --exposure <EV>  --contrast <n>
//   --no-auto             keine automatische Belichtung (Standard: wie in der App)
//   --no-crop             Bildfeld nicht automatisch erkennen
//   --max <px>            längste Kante begrenzen
import fs from 'node:fs';
import path from 'node:path';
import { decodeTiff, encodeTiff16 } from '../js/core/tiff.js';
import { defaultSettings, normalizeSettings, floatToU16, autoExposure } from '../js/core/pipeline.js';
import { renderFull, resolveLevels, analysisImage } from '../js/core/render.js';
import { detectFrame } from '../js/core/autocrop.js';
import { encodePNG } from './png.mjs';

function parseArgs(argv) {
  const files = [];
  const opt = { format: 'tif' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (key === 'no-auto') opt.noAuto = true;
      else if (key === 'no-crop') opt.noCrop = true;
      else opt[key] = argv[++i];
    } else files.push(a);
  }
  return { files, opt };
}

const { files, opt } = parseArgs(process.argv.slice(2));
if (!files.length) {
  console.log('Aufruf: node tools/filmlab-cli.mjs scan.tif [...] [--format png|png16|tif] [--settings s.json] [--out ordner]');
  process.exit(1);
}

let base = defaultSettings();
if (opt.settings) base = normalizeSettings(JSON.parse(fs.readFileSync(opt.settings, 'utf8')));
if (opt.type) {
  base.film.type = opt.type;
  base.film.linked = opt.type === 'positive';
}
if (opt.exposure) base.tone.exposure = Number(opt.exposure);
if (opt.contrast) base.tone.contrast = Number(opt.contrast);

for (const file of files) {
  const t0 = Date.now();
  const buf = fs.readFileSync(file);
  const src = await decodeTiff(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const settings = structuredClone(base);
  if (!opt.noCrop && !settings.geometry.crop) settings.geometry.crop = detectFrame(src, settings);
  const levels = resolveLevels(src, settings);
  // wie die App: automatische Belichtung, sofern nichts vorgegeben ist
  if (!opt.noAuto && !opt.settings && opt.exposure == null) settings.tone.exposure = autoExposure(analysisImage(src, settings), settings, levels);
  const res = await renderFull(src, settings, { levels, maxDim: opt.max ? Number(opt.max) : 0 });
  const dir = opt.out || path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const stem = path.join(dir, path.basename(file).replace(/\.[^.]+$/, '') + '_positiv');
  let outFile;
  if (opt.format === 'tif') {
    outFile = stem + '.tif';
    fs.writeFileSync(outFile, Buffer.from(encodeTiff16(res.width, res.height, floatToU16(res.rgb))));
  } else {
    outFile = stem + '.png';
    fs.writeFileSync(outFile, encodePNG(res.width, res.height, res.rgb, opt.format === 'png16' ? 16 : 8));
  }
  console.log(`${file} -> ${outFile} (${res.width}×${res.height}, ${Date.now() - t0} ms, EV ${settings.tone.exposure})`);
}
