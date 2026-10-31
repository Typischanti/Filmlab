// Laden der 3D-LUTs der spektralen Filme (camera/luts).
// Messdaten: spektrafilm von Andrea Volpato
// (https://github.com/andreavolpato/spektrafilm), CC BY-SA 4.0.

import { registerLut, getLut } from './model.js';
import { FILMS } from './films.js';

let indexPromise = null;
const pending = new Map();

function loadIndex() {
  indexPromise ??= fetch('luts/index.json').then((r) => {
    if (!r.ok) throw new Error('LUT-Verzeichnis nicht gefunden');
    return r.json();
  });
  return indexPromise;
}

export function lutReady(film, renderer) {
  return film.type !== 'lut' || (!!getLut(film.lut) && renderer.luts.has(film.lut));
}

export async function ensureLut(film, renderer) {
  if (film.type !== 'lut') return;
  if (!getLut(film.lut)) {
    if (!pending.has(film.lut)) {
      pending.set(
        film.lut,
        (async () => {
          const idx = await loadIndex();
          const r = await fetch(`luts/${film.lut}.bin`);
          if (!r.ok) throw new Error(`LUT ${film.lut} nicht gefunden`);
          const data = new Uint8Array(await r.arrayBuffer());
          if (data.length !== idx.size ** 3 * 3) throw new Error(`LUT ${film.lut} beschädigt`);
          registerLut(film.lut, { size: idx.size, min: idx.min, max: idx.max, data });
        })().catch((err) => {
          pending.delete(film.lut);
          throw err;
        }),
      );
    }
    await pending.get(film.lut);
  }
  renderer?.setLut(film.lut, getLut(film.lut));
}

// Alle LUTs im Hintergrund laden (auch für den Offline-Zwischenspeicher).
export async function preloadLuts(renderer) {
  for (const f of FILMS) {
    if (f.type !== 'lut') continue;
    try {
      await ensureLut(f, renderer);
    } catch (err) {
      console.warn(err);
    }
  }
}
