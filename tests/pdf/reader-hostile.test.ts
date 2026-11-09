import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { PdfError, readPdf } from '../../src/pdf/reader.ts';
import type { PdfLimits } from '../../src/pdf/reader.ts';
import { buildPdf, buildRawPdf } from './fixture-pdf.ts';
import type { RawObject } from './fixture-pdf.ts';

// Files built to make a reader slow or hungry. Each one must end quickly, with a PdfError or with what could be read.

const LOOSE = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

/** A one-page file: 1 catalog, 2 pages, 3 page, 4 content, 5 font, then `extra` from 6, and `resources` appended to the page resources. */
function onePage(content: RawObject, extra: (string | RawObject)[] = [], resources = '', fontExtra = LOOSE): Uint8Array {
  return buildRawPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> ${resources} >> >>`,
    content,
    fontExtra,
    ...extra,
  ]);
}

function timed<T>(fn: () => T): { ms: number; value?: T; error?: unknown } {
  const start = process.hrtime.bigint();
  try {
    const value = fn();
    return { ms: Number(process.hrtime.bigint() - start) / 1e6, value };
  } catch (error) {
    return { ms: Number(process.hrtime.bigint() - start) / 1e6, error };
  }
}

function tooLarge(bytes: Uint8Array, limits?: PdfLimits): number {
  const r = timed(() => readPdf(bytes, limits));
  assert.ok(r.error instanceof PdfError, `expected a PdfError, got ${r.error === undefined ? 'a result' : String(r.error)}`);
  assert.equal(r.error.code, 'too_large');
  return r.ms;
}

test('a content stream with absurd nesting costs that stream, not the file or the other pages', () => {
  const doc = readPdf(
    buildPdf([
      { raw: () => `BT /F2 10 Tf 10 700 Td (before) Tj ET\n${'['.repeat(200)}\nBT /F2 10 Tf 10 600 Td (after) Tj ET` },
      { runs: [{ x: 10, y: 10, text: 'second page' }] },
    ]),
  );
  assert.equal(doc.pages.length, 2);
  assert.equal(doc.pages[1]?.lines[0]?.text, 'second page');
});

test('a predictor with impossible parameters skips the stream instead of throwing', () => {
  for (const parms of ['/Columns -1', '/Columns 0', '/Columns 1.5', '/Colors -3', '/BitsPerComponent 0', '/Columns 99999999999']) {
    const bytes = onePage({ dict: `/DecodeParms << /Predictor 12 ${parms} >>`, data: 'BT /F1 10 Tf 10 10 Td (x) Tj ET', flate: true });
    const doc = readPdf(bytes);
    assert.equal(doc.pages.length, 1, parms);
  }
});

test('forms that draw forms many times hit a work limit instead of running for hours', () => {
  const N = 60;
  const rep = (name: string): string => `/${name} Do\n`.repeat(N);
  const form = (data: string): RawObject => ({ dict: '/Type /XObject /Subtype /Form /BBox [0 0 10 10]', data });
  const bytes = onePage({ data: rep('X1') }, [form(rep('X2')), form(rep('X3')), form(rep('X4')), form('q Q')], '/XObject << /X1 6 0 R /X2 7 0 R /X3 8 0 R /X4 9 0 R >>');
  assert.ok(bytes.length < 10_000);
  assert.ok(tooLarge(bytes) < 5000);
});

test('a page that makes millions of text items is refused', () => {
  const bytes = onePage({ data: `BT /F1 10 Tf 1 TL 10 10 Td\n${"(a)'\n".repeat(250_000)}ET`, flate: true });
  assert.ok(tooLarge(bytes) < 5000);
});

test('one very long string is cut, so later steps never see a huge item', () => {
  const doc = readPdf(onePage({ data: `BT /F1 10 Tf 10 10 Td (a${' '.repeat(100_000)}b) Tj ET`, flate: true }));
  const item = doc.pages[0]?.lines[0]?.items[0];
  assert.ok(item && item.text.length <= 2000);
});

test('listing the same raw content stream many times counts every copy against the inflate limit', () => {
  const filler = `% ${'x'.repeat(100_000)}\n`;
  const refs = Array.from({ length: 30 }, () => '4 0 R').join(' ');
  const bytes = buildRawPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents [${refs}] /Resources << >> >>`,
    { data: filler },
  ]);
  assert.equal(readPdf(bytes).pages.length, 1);
  tooLarge(bytes, { maxInflatedBytes: 1024 * 1024 });
});

test('file with many unclosed objects and no xref is rejected fast', () => {
  const bytes = new Uint8Array(Buffer.from(`%PDF-1.4\n${'1 0 obj\n<<\n'.repeat(16_000)}`, 'latin1'));
  const r = timed(() => readPdf(bytes));
  assert.ok(r.error instanceof PdfError && r.error.code === 'damaged');
  assert.ok(r.ms < 3000, `took ${r.ms} ms`);
});

test('many unclosed trailers are read fast', () => {
  const bytes = new Uint8Array(Buffer.from(`%PDF-1.4\n${'trailer <<\n'.repeat(16_000)}`, 'latin1'));
  const r = timed(() => readPdf(bytes));
  assert.ok(r.error instanceof PdfError);
  assert.ok(r.ms < 3000, `took ${r.ms} ms`);
});

function withToUnicode(cmap: string): Uint8Array {
  return onePage(
    { data: 'BT /F1 10 Tf 10 10 Td <0001> Tj ET' },
    [{ data: cmap, flate: true }],
    '',
    '<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [<< /Type /Font /Subtype /CIDFontType2 /DW 500 >>] /ToUnicode 6 0 R >>',
  );
}

test('a ToUnicode map that repeats a begin keyword without its end is read in linear time', () => {
  for (const word of ['begincodespacerange', 'beginbfchar', 'beginbfrange']) {
    const r = timed(() => readPdf(withToUnicode(`${word} `.repeat(60_000))));
    assert.ok(r.error === undefined, word);
    assert.ok(r.ms < 1500, `${word} took ${r.ms} ms`);
  }
});

test('overlapping bfrange entries are charged for the codes they write', () => {
  const r = timed(() => readPdf(withToUnicode(`1 beginbfrange\n${'<0000> <FFFF> <0000>\n'.repeat(3000)}endbfrange`)));
  assert.ok(r.error === undefined);
  assert.ok(r.ms < 1500, `took ${r.ms} ms`);
});

test('overlapping /W ranges are charged too', () => {
  const w = '[0 65535 600 '.repeat(1).concat('0 65535 600 '.repeat(3000), ']');
  const bytes = onePage(
    { data: 'BT /F1 10 Tf 10 10 Td <0001> Tj ET' },
    [],
    '',
    `<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [<< /Type /Font /Subtype /CIDFontType2 /DW 500 /W ${w} >>] >>`,
  );
  const r = timed(() => readPdf(bytes));
  assert.ok(r.error === undefined);
  assert.ok(r.ms < 1500, `took ${r.ms} ms`);
});

test('an xref stream that declares millions of entries is refused', () => {
  const entries = 2_000_000;
  const data = deflateSync(Buffer.alloc(entries, 1));
  const head = Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /XRef /Size ${entries} /W [0 0 1] /Filter /FlateDecode /Length ${data.length} >>\nstream\n`, 'latin1');
  const file = Buffer.concat([head, data, Buffer.from('\nendstream\nendobj\nstartxref\n9\n%%EOF\n', 'latin1')]);
  assert.ok(file.length < 100_000);
  const r = timed(() => readPdf(file));
  assert.ok(r.error instanceof PdfError && r.error.code === 'too_large', String(r.error));
  assert.ok(r.ms < 5000, `took ${r.ms} ms`);
});
