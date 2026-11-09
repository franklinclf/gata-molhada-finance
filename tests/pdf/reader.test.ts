import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { PdfError, readPdf } from '../../src/pdf/reader.ts';
import { buildPdf } from './fixture-pdf.ts';

const lineTexts = (bytes: Uint8Array, page = 0): string[] => (readPdf(bytes).pages[page]?.lines ?? []).map((l) => l.text);

function failure(fn: () => unknown): PdfError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof PdfError, `expected a PdfError, got ${String(e)}`);
    return e;
  }
  assert.fail('expected a PdfError');
}

test('reads text from Type0 fonts with a ToUnicode CMap, grouped into lines from top to bottom', () => {
  const doc = readPdf(
    buildPdf([
      {
        runs: [
          { x: 50, y: 700, text: 'Second line' },
          { x: 50, y: 750, text: 'First line', size: 12 },
          { x: 200, y: 750, text: 'right side', size: 12 },
        ],
      },
    ]),
  );
  assert.equal(doc.pages.length, 1);
  assert.equal(doc.pages[0]?.width, 595);
  assert.deepEqual(doc.pages[0]?.lines.map((l) => l.text), ['First line right side', 'Second line']);
  assert.equal(doc.pages[0]?.lines[0]?.items.length, 2);
  assert.equal(doc.producer, 'Fixture Writer 1.0');
  assert.equal(doc.textChars, 'First line'.length - 1 + 'right side'.length - 1 + 'Second line'.length - 1);
});

test('decodes the same text through bfrange (ranges and the array form) as through bfchar', () => {
  const runs = [{ x: 40, y: 600, text: 'Compras 12/05: R$ 1.234,56 (ação)' }];
  assert.deepEqual(lineTexts(buildPdf([{ runs }], { toUnicode: 'bfrange' })), ['Compras 12/05: R$ 1.234,56 (ação)']);
  assert.deepEqual(lineTexts(buildPdf([{ runs }], { toUnicode: 'bfchar' })), ['Compras 12/05: R$ 1.234,56 (ação)']);
});

test('reads hex strings, literal strings with escapes and a simple WinAnsi font', () => {
  const bytes = buildPdf([
    {
      runs: [{ x: 40, y: 700, text: 'Olá (mundo) a\\b', font: 'simple' }],
      raw: (s) =>
        [
          `BT /F1 10 Tf 40 650 Td ${s.hex('hex string')} Tj ET`,
          `BT /F1 10 Tf 40 600 Td ${s.lit('lit (a) \\ end')} Tj ET`,
          'BT /F2 10 Tf 40 550 Td (oct \\101\\102 \\(p\\) \\\\) Tj ET',
          'BT /F2 10 Tf 40 500 Td <48656c6C6f> Tj ET',
        ].join('\n'),
    },
  ]);
  assert.deepEqual(lineTexts(bytes), ['Olá (mundo) a\\b', 'hex string', 'lit (a) \\ end', 'oct AB (p) \\', 'Hello']);
});

test('TJ adjustments make a space only where the gap is wide', () => {
  const bytes = buildPdf([{ raw: (s) => `BT /F1 10 Tf 40 700 Td [${s.lit('Hel')} -30 ${s.lit('lo')} -600 ${s.lit('World')}] TJ ET` }]);
  assert.deepEqual(lineTexts(bytes), ['Hello World']);
});

test('follows Tm, Td, TD, T* and the quote operators for positions', () => {
  const bytes = buildPdf([
    {
      raw: (s) =>
        [
          `BT /F1 10 Tf 12 TL 1 0 0 1 100 700 Tm ${s.hex('A1')} Tj`,
          `0 -50 Td ${s.hex('B2')} Tj`,
          `T* ${s.hex('C3')} Tj`,
          `${s.hex('D4')} '`,
          `0 0 ${s.hex('E5')} "`,
          `10 -100 TD ${s.hex('F6')} Tj`,
          'ET',
          `q 1 0 0 1 300 0 cm BT /F1 10 Tf 0 0 Td ${s.hex('G7')} Tj ET Q`,
        ].join('\n'),
    },
  ]);
  const page = readPdf(bytes).pages[0];
  const at = (t: string) => page?.lines.flatMap((l) => l.items).find((i) => i.text === t);
  assert.deepEqual([at('A1')?.x, at('A1')?.y], [100, 700]);
  assert.deepEqual([at('B2')?.x, at('B2')?.y], [100, 650]);
  assert.deepEqual([at('C3')?.x, at('C3')?.y], [100, 638]);
  assert.deepEqual([at('D4')?.x, at('D4')?.y], [100, 626]);
  assert.deepEqual([at('E5')?.x, at('E5')?.y], [100, 614]);
  assert.deepEqual([at('F6')?.x, at('F6')?.y], [110, 514]);
  assert.deepEqual([at('G7')?.x, at('G7')?.y], [300, 0]);
});

test('Tc, Tw and Tz change how far the next run starts', () => {
  const bytes = buildPdf([
    {
      raw: (s) =>
        [
          `BT /F1 10 Tf 2 Tc 1 0 0 1 40 700 Tm ${s.hex('ab')} Tj ${s.hex('cd')} Tj ET`,
          `BT /F1 10 Tf 0 Tc 50 Tz 1 0 0 1 40 650 Tm ${s.hex('ab')} Tj ${s.hex('cd')} Tj ET`,
          'BT /F2 10 Tf 100 Tz 10 Tw 1 0 0 1 40 600 Tm (a b) Tj (c) Tj ET',
        ].join('\n'),
    },
  ]);
  const items = readPdf(bytes).pages[0]?.lines.flatMap((l) => l.items) ?? [];
  const cd = items.filter((i) => i.text === 'cd');
  // 'ab' is two glyphs of 5 pt plus 2 pt of character spacing each; at 50 percent the 5 pt becomes 2.5
  assert.equal(cd[0]?.x, 40 + 14);
  assert.equal(cd[1]?.x, 40 + 5);
  // Helvetica without widths: 5 pt a letter, 2.5 pt a space, plus 10 pt of word spacing on the space
  assert.equal(items.find((i) => i.text === 'c')?.x, 40 + 5 + 2.5 + 10 + 5);
});

test('a minus sign drawn a little below its amount stays on the amount line', () => {
  const doc = readPdf(
    buildPdf([
      {
        runs: [
          { x: 40, y: 500, text: '14/09', size: 6 },
          { x: 70, y: 500, text: 'SHOP REFUND', size: 6 },
          { x: 325, y: 500, text: '999,00', size: 6 },
          { x: 347, y: 500 - 1.2, text: '-', size: 6 },
          { x: 40, y: 491, text: '15/09', size: 6 },
          { x: 325, y: 491, text: '10,00', size: 6 },
        ],
      },
    ]),
  );
  assert.deepEqual(doc.pages[0]?.lines.map((l) => l.text), ['14/09 SHOP REFUND 999,00 -', '15/09 10,00']);
});

test('rotated margin text is left out', () => {
  const bytes = buildPdf([{ raw: (s) => `q 0 1 -1 0 595 0 cm BT /F1 8 Tf 20 20 Td ${s.hex('FORM CODE')} Tj ET Q\nBT /F1 8 Tf 40 700 Td ${s.hex('kept')} Tj ET` }]);
  assert.deepEqual(lineTexts(bytes), ['kept']);
});

test('pages inherit resources from the Pages node', () => {
  const bytes = buildPdf([{ runs: [{ x: 10, y: 10, text: 'inherited' }] }], { inheritResources: true });
  assert.deepEqual(lineTexts(bytes), ['inherited']);
});

test('reads a stream whose Length is an indirect object, and an uncompressed one', () => {
  assert.deepEqual(lineTexts(buildPdf([{ runs: [{ x: 10, y: 10, text: 'indirect' }] }], { indirectLength: true })), ['indirect']);
  assert.deepEqual(lineTexts(buildPdf([{ runs: [{ x: 10, y: 10, text: 'plain' }] }], { compress: false })), ['plain']);
});

test('rebuilds the object table by scanning when there is no xref or the offsets are wrong', () => {
  const runs = [{ x: 10, y: 10, text: 'still readable' }];
  assert.deepEqual(lineTexts(buildPdf([{ runs }], { xref: 'none' })), ['still readable']);
  assert.deepEqual(lineTexts(buildPdf([{ runs }], { xref: 'bad-offsets' })), ['still readable']);
  assert.deepEqual(lineTexts(buildPdf([{ runs }, { runs: [{ x: 10, y: 10, text: 'page two' }] }], { xref: 'none' }), 1), ['page two']);
});

test('a truncated file still gives the pages that are complete', () => {
  const bytes = buildPdf([{ runs: [{ x: 10, y: 10, text: 'first' }] }, { runs: [{ x: 10, y: 10, text: 'second' }] }]);
  const cut = bytes.subarray(0, Buffer.from(bytes).lastIndexOf('xref'));
  assert.equal(readPdf(cut).pages[0]?.lines[0]?.text, 'first');
});

test('reads an xref stream with an object stream', () => {
  const bytes = buildPdf([{ runs: [{ x: 10, y: 10, text: 'compressed objects' }] }], { xref: 'stream' });
  assert.deepEqual(lineTexts(bytes), ['compressed objects']);
});

test('an object stream with a filter this reader does not know is unsupported', () => {
  const bytes = buildPdf([{ runs: [{ x: 10, y: 10, text: 'x' }] }], { xref: 'stream', objStmFilter: 'lzw' });
  assert.equal(failure(() => readPdf(bytes)).code, 'unsupported');
});

test('refuses what is not a PDF, an encrypted PDF and a PDF without pages', () => {
  assert.equal(failure(() => readPdf(new TextEncoder().encode('hello'))).code, 'not_pdf');
  assert.equal(failure(() => readPdf(buildPdf([{ runs: [{ x: 1, y: 1, text: 'secret' }] }], { encrypt: true }))).code, 'encrypted');
  assert.equal(failure(() => readPdf(buildPdf([{ runs: [{ x: 1, y: 1, text: 'secret' }] }], { encrypt: true, xref: 'none' }))).code, 'encrypted');
  assert.equal(failure(() => readPdf(new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<< /Type /Foo >>\nendobj\n'))).code, 'damaged');
});

test('limits: bytes, pages and inflated size', () => {
  const two = buildPdf([{ runs: [{ x: 1, y: 1, text: 'a' }] }, { runs: [{ x: 1, y: 1, text: 'b' }] }]);
  assert.equal(failure(() => readPdf(two, { maxBytes: 100 })).code, 'too_large');
  assert.equal(failure(() => readPdf(two, { maxPages: 1 })).code, 'too_large');
  assert.equal(readPdf(two, { maxPages: 2 }).pages.length, 2);
  // 4 MB of spaces compresses to a few KB
  const bomb = buildPdf([{ raw: () => ' '.repeat(4 * 1024 * 1024) }]);
  assert.ok(bomb.length < 50_000);
  assert.equal(failure(() => readPdf(bomb, { maxInflatedBytes: 1024 * 1024 })).code, 'too_large');
  assert.equal(readPdf(bomb).pages.length, 1);
});

test('one bad stream is skipped and the other pages are still read', () => {
  const two = Buffer.from(buildPdf([{ runs: [{ x: 10, y: 10, text: 'first page' }] }, { runs: [{ x: 10, y: 10, text: 'second page' }] }], { compress: false })).toString('latin1');
  // the first content stream claims to be Flate but holds plain text
  const firstContent = two.indexOf('/Length', two.indexOf('/Contents'));
  const damaged = `${two.slice(0, firstContent)}/Filter /FlateDecode ${two.slice(firstContent)}`;
  const doc = readPdf(Buffer.from(damaged, 'latin1'));
  assert.equal(doc.pages.length, 2);
  assert.equal(doc.pages[0]?.lines.length, 0);
  assert.equal(doc.pages[1]?.lines[0]?.text, 'second page');
});

test('lists image XObjects once, as stored, without decoding them', () => {
  const pixels = Uint8Array.from({ length: 2 * 2 * 3 }, (_, i) => i);
  const flated = new Uint8Array(deflateSync(pixels));
  const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9);
  const doc = readPdf(
    buildPdf([
      {
        images: [
          { width: 2, height: 2, data: pixels },
          { width: 2, height: 2, data: flated, filter: 'flate' },
          { width: 1, height: 1, data: jpeg, filter: 'dct', colorSpace: 'gray' },
        ],
      },
      { images: [{ width: 1, height: 1, data: pixels, colorSpace: 'gray' }] },
    ]),
  );
  assert.equal(doc.textChars, 0);
  assert.deepEqual(
    doc.images.map((i) => [i.page, i.width, i.height, i.colorSpace, i.filter, i.bitsPerComponent, i.data.length]),
    [
      [1, 2, 2, 'rgb', 'none', 8, 12],
      [1, 2, 2, 'rgb', 'flate', 8, flated.length],
      [1, 1, 1, 'gray', 'dct', 8, 4],
      [2, 1, 1, 'gray', 'none', 8, 12],
    ],
  );
  assert.deepEqual([...(doc.images[0]?.data ?? [])], [...pixels]);
  assert.deepEqual([...(doc.images[2]?.data ?? [])], [...jpeg]);
});
