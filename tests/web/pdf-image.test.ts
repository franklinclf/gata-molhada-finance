import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { findImages } from '../../web/src/pdf-image.ts';
import { buildPdf, buildRawPdf } from '../pdf/fixture-pdf.ts';

test('finds the page image of an image-only statement, largest first, with its bytes as stored', () => {
  const big = new Uint8Array(40 * 60 * 3).map((_, i) => i % 251);
  const small = new Uint8Array(4 * 4);
  const found = findImages(buildPdf([{ images: [{ width: 4, height: 4, data: small, colorSpace: 'gray' }] }, { images: [{ width: 40, height: 60, data: big }] }]));
  assert.deepEqual(found.map((i) => [i.width, i.height, i.colorSpace, i.filter, i.bitsPerComponent, i.data.length]), [[40, 60, 'rgb', 'none', 8, big.length], [4, 4, 'gray', 'none', 8, 16]]);
  assert.deepEqual([...found[0]!.data.subarray(0, 5)], [0, 1, 2, 3, 4]);
});

test('reads an indirect length up to endstream, and marks a Flate image with a predictor as one it cannot decode', () => {
  const samples = deflateSync(Buffer.alloc(2 * 2 * 3, 7));
  const pdf = buildRawPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [] /Count 0 >>',
    `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length 5 0 R >>\nstream\n${samples.toString('latin1')}\nendstream`,
    { dict: '/Type /XObject /Subtype /Image /Width 3 /Height 3 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /DecodeParms << /Predictor 15 /Columns 3 >>', data: samples },
    String(samples.length),
  ]);
  const found = findImages(pdf);
  assert.deepEqual(found.map((i) => [i.width, i.filter]), [[3, 'other'], [2, 'flate']]);
  assert.deepEqual(Buffer.from(found[1]!.data), samples);
});

test('a file with no image gives nothing', () => {
  assert.deepEqual(findImages(buildPdf([{ runs: [{ x: 10, y: 10, text: 'Fatura mensal' }] }])), []);
});
