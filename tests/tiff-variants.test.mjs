// Prüft den TIFF-Decoder gegen Dateien von tifffile (falls vorhanden):
//   python3 tools/make_test_negatives.py test-negatives
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { decodeTiff } from '../js/core/tiff.js';

const dir = process.env.FILMLAB_TEST_DIR || 'test-negatives';
const ref = path.join(dir, 'coffee_neg16.tif');

const load = async (f) => {
  const b = fs.readFileSync(path.join(dir, f));
  return decodeTiff(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};

test('TIFF-Varianten ergeben identische Pixel', { skip: !fs.existsSync(ref) && 'keine Testdateien' }, async () => {
  const base = await load('coffee_neg16.tif');
  for (const f of ['coffee_neg16_lzw.tif', 'coffee_neg16_zip_pred.tif', 'coffee_neg16_tiled.tif', 'coffee_neg16_planar.tif', 'coffee_neg16_be.tif']) {
    const img = await load(f);
    assert.equal(img.width, base.width, f);
    assert.equal(img.height, base.height, f);
    let diff = 0;
    for (let i = 0; i < img.data.length; i++) diff = Math.max(diff, Math.abs(img.data[i] - base.data[i]));
    assert.equal(diff, 0, f);
  }
  const p8 = await load('coffee_neg8_packbits.tif');
  let diff = 0;
  for (let i = 0; i < p8.data.length; i++) diff = Math.max(diff, Math.abs(p8.data[i] - (base.data[i] >> 8) * 257));
  assert.equal(diff, 0);
});
