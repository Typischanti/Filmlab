// Erzeugt die 3D-LUTs der spektralen Filme für die Filmkamera.
//
//   node tools/spectral/bake-luts.mjs --profiles <spektrafilm>/src/spektrafilm/data/profiles
//
// Die Profile (Messdaten) stammen aus spektrafilm von Andrea Volpato
// (https://github.com/andreavolpato/spektrafilm, CC BY-SA 4.0); die
// erzeugten LUTs stehen deshalb ebenfalls unter CC BY-SA 4.0 (siehe
// camera/luts/LICENSE.txt und CHANGELOG.txt).
//
// LUT-Format: 33³ Knoten, Achsen = log10(Belichtung / Mittelgrau) je Kanal
// (lineares Szenenlicht in sRGB-Primärfarben) von LUT_MIN bis LUT_MAX;
// Inhalt = sRGB-codierte Ausgabe, 8 Bit, Rot läuft am schnellsten.

import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadProfile, makeChain } from './spectral.mjs';

export const LUT_SIZE = 33;
export const LUT_MIN = -3.6; // ≈ 12 Blenden unter Mittelgrau
export const LUT_MAX = 2.1; // ≈ 7 Blenden über Mittelgrau

// Film, Abzugsmaterial und Abstimmung. print: Papier bzw. Kopierfilm wie im
// Labor üblich (Messdaten), dir: Stärke der DIR-Kuppler (nicht in den
// Profilen enthalten, nach dem bekannten Charakter des Films abgestimmt),
// balanceCCT: Farbtemperatur, auf die das Labor filtert.
export const STOCK_CONFIG = [
  { stock: 'kodak_portra_160', print: 'kodak_portra_endura', dir: 0.12 },
  { stock: 'kodak_portra_400', print: 'kodak_portra_endura', dir: 0.22 },
  { stock: 'kodak_portra_800', print: 'kodak_supra_endura', dir: 0.3 },
  { stock: 'kodak_ektar_100', print: 'kodak_ultra_endura', dir: 0.42 },
  { stock: 'kodak_gold_200', print: 'kodak_supra_endura', dir: 0.45, balanceCCT: 8000 },
  { stock: 'kodak_ultramax_400', print: 'kodak_ektacolor_edge', dir: 0.38 },
  { stock: 'fujifilm_pro_400h', print: 'fujifilm_crystal_archive_typeii', dir: 0.18 },
  { stock: 'fujifilm_c200', print: 'fujifilm_crystal_archive_typeii', dir: 0.3 },
  { stock: 'kodak_vision3_250d', print: 'kodak_2383', dir: 0.15 },
  { stock: 'kodak_vision3_500t', print: 'kodak_2383', dir: 0.15, balanceCCT: 3300 },
  { stock: 'fujifilm_velvia_100', dir: 0.38 },
  { stock: 'fujifilm_provia_100f', dir: 0.12 },
  { stock: 'kodak_ektachrome_100', dir: 0.22 },
  { stock: 'kodak_kodachrome_64', dir: 0.3 },
];
export const STOCKS = STOCK_CONFIG.map((c) => c.stock);
export const BALANCE = 0.5; // halbe Graubalance: Filmcharakter bleibt teilweise

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '../../camera/luts');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

const srgb = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

function bake(dir, stock) {
  const read = (n) => JSON.parse(fs.readFileSync(path.join(dir, `${n}.json`), 'utf8'));
  const filmJson = read(stock);
  const film = loadProfile(filmJson);
  const cfg = STOCK_CONFIG.find((c) => c.stock === stock) ?? {};
  const printId = film.type === 'negative' ? cfg.print ?? film.targetPrint : null;
  const print = printId ? loadProfile(read(printId)) : null;
  const chain = makeChain(film, print, { dir: cfg.dir ?? 0, balance: BALANCE, balanceCCT: cfg.balanceCCT });
  const N = LUT_SIZE;
  const data = new Uint8Array(N * N * N * 3);
  const ax = Array.from({ length: N }, (_, i) => 0.18 * Math.pow(10, LUT_MIN + ((LUT_MAX - LUT_MIN) * i) / (N - 1)));
  let o = 0;
  for (let b = 0; b < N; b++) {
    for (let g = 0; g < N; g++) {
      for (let r = 0; r < N; r++) {
        const out = chain.render([ax[r], ax[g], ax[b]]);
        for (let k = 0; k < 3; k++) data[o++] = Math.round(255 * srgb(Math.min(1, Math.max(0, out[k]))));
      }
    }
  }
  fs.writeFileSync(path.join(OUT, `${stock}.bin`), data);
  return { stock, name: film.name, print: printId, printName: print?.name ?? null, type: film.type, use: filmJson.info.use };
}

const dir = arg('--profiles');
if (process.argv.includes('--worker')) {
  const only = arg('--only').split(',');
  for (const s of only) process.send(bake(dir, s));
  process.exit(0);
} else if (import.meta.url === `file://${process.argv[1]}`) {
  if (!dir) {
    console.error('Aufruf: node tools/spectral/bake-luts.mjs --profiles <ordner mit spektrafilm-profilen>');
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const jobs = Number(arg('--jobs') ?? 4);
  const groups = Array.from({ length: jobs }, () => []);
  STOCKS.forEach((s, i) => groups[i % jobs].push(s));
  const results = [];
  const t0 = Date.now();
  await Promise.all(
    groups.filter((g) => g.length).map(
      (g) =>
        new Promise((resolve, reject) => {
          const p = fork(fileURLToPath(import.meta.url), ['--worker', '--profiles', dir, '--only', g.join(',')]);
          p.on('message', (m) => {
            results.push(m);
            console.log(`${m.name}${m.printName ? ` -> ${m.printName}` : ''}  (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
          });
          p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Worker ${code}`))));
        }),
    ),
  );
  results.sort((a, b) => STOCKS.indexOf(a.stock) - STOCKS.indexOf(b.stock));
  const index = {
    size: LUT_SIZE,
    min: LUT_MIN,
    max: LUT_MAX,
    encoding: 'srgb8',
    source: 'Derived from spektrafilm profiles by Andrea Volpato (https://github.com/andreavolpato/spektrafilm), CC BY-SA 4.0',
    luts: Object.fromEntries(results.map((r) => [r.stock, r])),
  };
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 2) + '\n');
  console.log(`fertig: ${results.length} LUTs in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
