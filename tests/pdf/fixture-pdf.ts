import { deflateSync } from 'node:zlib';

/** A tiny PDF writer for tests: Type0/Identity-H text with a ToUnicode CMap, a simple Helvetica font, Flate content streams and image XObjects. All text is invented by the tests. */

export interface FixtureRun {
  x: number;
  y: number;
  text: string;
  size?: number;
  /** 'cid' (default) is the Type0 font, 'simple' is Helvetica with WinAnsiEncoding. */
  font?: 'cid' | 'simple';
}

export interface FixtureImage {
  width: number;
  height: number;
  data: Uint8Array;
  filter?: 'none' | 'flate' | 'dct';
  colorSpace?: 'rgb' | 'gray';
}

/** Hands out the string forms a raw content stream needs for the two fonts. */
export interface FixtureStrings {
  /** Hex string with two-byte glyph ids for the Type0 font (font name /F1). */
  hex(text: string): string;
  /** Literal string with two-byte glyph ids, escaping what a literal needs. */
  lit(text: string): string;
}

export interface FixturePage {
  runs?: FixtureRun[];
  /** Raw content stream text, appended after the runs. Fonts are /F1 (Type0) and /F2 (Helvetica); images are /Im1, /Im2... in order. */
  raw?: (s: FixtureStrings) => string;
  images?: FixtureImage[];
  width?: number;
  height?: number;
}

export interface FixtureOptions {
  /** How the Type0 font maps glyph ids back to text. */
  toUnicode?: 'bfchar' | 'bfrange';
  /** 'none' writes no xref, trailer or startxref; 'bad-offsets' writes a table whose offsets are wrong. 'stream' writes an xref stream and puts the catalog and page objects in an object stream. */
  xref?: 'classic' | 'none' | 'bad-offsets' | 'stream';
  /** With xref 'stream', the filter named on the object stream. Anything but Flate is not supported by the reader. */
  objStmFilter?: 'flate' | 'lzw';
  compress?: boolean;
  producer?: string;
  encrypt?: boolean;
  /** Put /Resources on the Pages node, so the pages inherit it. */
  inheritResources?: boolean;
  /** Write the content stream length as an indirect object. */
  indirectLength?: boolean;
}

const WIDTH_EM = 0.5;

class Recorder implements FixtureStrings {
  readonly chars = new Set<string>();
  hex(text: string): string {
    for (const c of text) this.chars.add(c);
    return '<>';
  }
  lit(text: string): string {
    for (const c of text) this.chars.add(c);
    return '()';
  }
}

class Glyphs implements FixtureStrings {
  readonly ids = new Map<string, number>();
  constructor(chars: Iterable<string>) {
    [...new Set(chars)].sort().forEach((c, i) => this.ids.set(c, i + 1));
  }
  private codes(text: string): number[] {
    return [...text].map((c) => this.ids.get(c) ?? 0);
  }
  hex(text: string): string {
    return `<${this.codes(text).map((g) => g.toString(16).padStart(4, '0')).join('')}>`;
  }
  lit(text: string): string {
    let out = '(';
    for (const g of this.codes(text)) {
      for (const b of [g >> 8, g & 255]) {
        if (b === 0x28 || b === 0x29 || b === 0x5c) out += `\\${String.fromCharCode(b)}`;
        else if (b === 10) out += '\\n';
        else if (b === 13) out += '\\r';
        else if (b < 32 || b > 126) out += `\\${b.toString(8).padStart(3, '0')}`;
        else out += String.fromCharCode(b);
      }
    }
    return `${out})`;
  }
}

const hex4 = (n: number): string => n.toString(16).padStart(4, '0').toUpperCase();
const num = (n: number): string => String(Math.round(n * 1000) / 1000);

function toUnicodeCMap(glyphs: Glyphs, mode: 'bfchar' | 'bfrange'): string {
  const entries = [...glyphs.ids].map(([c, g]) => ({ c: c.codePointAt(0) ?? 0, g })).sort((a, b) => a.g - b.g);
  const body: string[] = [];
  if (mode === 'bfchar') {
    for (let i = 0; i < entries.length; i += 100) {
      const block = entries.slice(i, i + 100);
      body.push(`${block.length} beginbfchar`, ...block.map((e) => `<${hex4(e.g)}> <${hex4(e.c)}>`), 'endbfchar');
    }
  } else {
    // Runs of consecutive code points become <lo> <hi> <first>, a lone glyph uses the array form.
    const ranges: string[] = [];
    for (let i = 0; i < entries.length; ) {
      let j = i;
      while (j + 1 < entries.length && (entries[j + 1] as { c: number }).c === (entries[j] as { c: number }).c + 1) j++;
      const a = entries[i] as { c: number; g: number };
      const b = entries[j] as { c: number; g: number };
      ranges.push(j > i ? `<${hex4(a.g)}> <${hex4(b.g)}> <${hex4(a.c)}>` : `<${hex4(a.g)}> <${hex4(a.g)}> [<${hex4(a.c)}>]`);
      i = j + 1;
    }
    for (let i = 0; i < ranges.length; i += 100) {
      const block = ranges.slice(i, i + 100);
      body.push(`${block.length} beginbfrange`, ...block, 'endbfrange');
    }
  }
  return [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    ...body,
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n');
}

class Writer {
  private chunks: Buffer[] = [];
  private size = 0;
  readonly offsets = new Map<number, number>();
  push(s: string | Buffer): void {
    const b = typeof s === 'string' ? Buffer.from(s, 'latin1') : s;
    this.chunks.push(b);
    this.size += b.length;
  }
  obj(n: number, body: string): void {
    this.offsets.set(n, this.size);
    this.push(`${n} 0 obj\n${body}\nendobj\n`);
  }
  stream(n: number, dict: string, data: Buffer, lengthRef?: number): void {
    this.offsets.set(n, this.size);
    this.push(`${n} 0 obj\n<< ${dict} /Length ${lengthRef ? `${lengthRef} 0 R` : data.length} >>\nstream\n`);
    this.push(data);
    this.push('\nendstream\nendobj\n');
  }
  get length(): number {
    return this.size;
  }
  bytes(): Uint8Array {
    return new Uint8Array(Buffer.concat(this.chunks));
  }
}

function simpleLiteral(text: string): string {
  let out = '(';
  for (const c of text) {
    const code = c.charCodeAt(0);
    if (c === '(' || c === ')' || c === '\\') out += `\\${c}`;
    else if (code < 32 || code > 255) out += '?';
    else out += String.fromCharCode(code);
  }
  return `${out})`;
}

export function buildPdf(pages: FixturePage[], options: FixtureOptions = {}): Uint8Array {
  const opts: FixtureOptions & { toUnicode: 'bfchar' | 'bfrange'; xref: NonNullable<FixtureOptions['xref']>; compress: boolean } = {
    toUnicode: 'bfchar',
    xref: 'classic',
    compress: true,
    ...options,
  };
  const compress = (s: string | Buffer): Buffer => {
    const b = typeof s === 'string' ? Buffer.from(s, 'latin1') : s;
    return opts.compress ? deflateSync(b) : b;
  };
  const flate = opts.compress ? '/Filter /FlateDecode' : '';

  // First pass: which characters the Type0 font needs. The second pass writes the real glyph ids.
  const rec = new Recorder();
  for (const p of pages) {
    for (const r of p.runs ?? []) if ((r.font ?? 'cid') === 'cid') rec.hex(r.text);
    p.raw?.(rec);
  }
  const glyphs = new Glyphs(rec.chars);

  const w = new Writer();
  w.push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');

  // Object numbers: 1 catalog, 2 pages, 3 Type0 font, 4 CID font, 5 ToUnicode, 6 simple font, 7 info, 8 encrypt; then per page.
  const pageBase = 10;
  const perPage = (p: FixturePage): number => 2 + (p.images?.length ?? 0) + (opts.indirectLength ? 1 : 0);
  const pageNums: number[] = [];
  let next = pageBase;
  for (const p of pages) {
    pageNums.push(next);
    next += perPage(p);
  }

  const fonts = '<< /Font << /F1 3 0 R /F2 6 0 R >> >>';

  const structural: { n: number; body: string }[] = [
    { n: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    {
      n: 2,
      body: `<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages.length}${opts.inheritResources ? ` /Resources ${fonts}` : ''} /MediaBox [0 0 595 842] >>`,
    },
  ];
  const pageDicts: { n: number; body: string }[] = [];

  // Fonts
  const fontObjects = (): void => {
    w.obj(3, '<< /Type /Font /Subtype /Type0 /BaseFont /TestSans /Encoding /Identity-H /DescendantFonts [4 0 R] /ToUnicode 5 0 R >>');
    const space = glyphs.ids.get(' ');
    w.obj(
      4,
      `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /TestSans /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW ${WIDTH_EM * 1000}${space ? ` /W [${space} [${WIDTH_EM * 500}]]` : ''} >>`,
    );
    w.stream(5, flate, compress(toUnicodeCMap(glyphs, opts.toUnicode)));
    w.obj(6, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  };

  const content = (p: FixturePage, imgCount: number): string => {
    let c = '';
    for (const r of p.runs ?? []) {
      const size = r.size ?? 10;
      if ((r.font ?? 'cid') === 'cid') c += `BT /F1 ${num(size)} Tf 1 0 0 1 ${num(r.x)} ${num(r.y)} Tm ${glyphs.hex(r.text)} Tj ET\n`;
      else c += `BT /F2 ${num(size)} Tf 1 0 0 1 ${num(r.x)} ${num(r.y)} Tm ${simpleLiteral(r.text)} Tj ET\n`;
    }
    if (p.raw) c += `${p.raw(glyphs)}\n`;
    for (let i = 1; i <= imgCount; i++) c += `q 100 0 0 100 10 ${10 * i} cm /Im${i} Do Q\n`;
    return c;
  };

  const pageObjects: (() => void)[] = [];
  pages.forEach((p, idx) => {
    const base = pageNums[idx] as number;
    const imgs = p.images ?? [];
    const lenObj = opts.indirectLength ? base + 2 + imgs.length : 0;
    const imageNums = imgs.map((_, i) => base + 2 + i);
    const res = `<< /Font << /F1 3 0 R /F2 6 0 R >>${imgs.length ? ` /XObject << ${imageNums.map((n, i) => `/Im${i + 1} ${n} 0 R`).join(' ')} >>` : ''} >>`;
    pageDicts.push({
      n: base,
      body: `<< /Type /Page /Parent 2 0 R${p.width ? ` /MediaBox [0 0 ${p.width} ${p.height ?? 842}]` : ''}${opts.inheritResources && imgs.length === 0 ? '' : ` /Resources ${res}`} /Contents ${base + 1} 0 R >>`,
    });
    pageObjects.push(() => {
      const data = compress(content(p, imgs.length));
      w.stream(base + 1, flate, data, lenObj || undefined);
      imgs.forEach((img, i) => {
        const filter = img.filter ?? 'none';
        const f = filter === 'flate' ? '/Filter /FlateDecode' : filter === 'dct' ? '/Filter /DCTDecode' : '';
        const cs = img.colorSpace === 'gray' ? '/DeviceGray' : '/DeviceRGB';
        w.stream(base + 2 + i, `/Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace ${cs} /BitsPerComponent 8 ${f}`, Buffer.from(img.data));
      });
      if (lenObj) w.obj(lenObj, String(data.length));
    });
  });

  const info = `<< /Producer (${opts.producer ?? 'Fixture Writer 1.0'}) >>`;

  let trailerExtra = ' /Info 7 0 R';
  if (opts.encrypt) trailerExtra += ' /Encrypt 8 0 R';

  if (opts.xref === 'stream') {
    // Catalog, Pages and the page dictionaries live in an object stream; everything else is written plainly.
    const inStm = [...structural, ...pageDicts];
    let offs = '';
    let bodies = '';
    for (const o of inStm) {
      offs += `${o.n} ${bodies.length} `;
      bodies += `${o.body}\n`;
    }
    const stmData = Buffer.from(offs + bodies, 'latin1');
    const stmNum = next + 1;
    fontObjects();
    w.obj(7, info);
    pageObjects.forEach((f) => f());
    const lzw = opts.objStmFilter === 'lzw';
    w.stream(stmNum, `/Type /ObjStm /N ${inStm.length} /First ${offs.length} ${lzw ? '/Filter /LZWDecode' : '/Filter /FlateDecode'}`, lzw ? stmData : deflateSync(stmData));
    // xref stream with entries for objects 0..stmNum+1: type 0 free, 1 offset, 2 compressed.
    const xrefNum = stmNum + 1;
    const total = xrefNum + 1;
    const xrefOffset = w.length;
    const rows = Buffer.alloc(total * 7);
    const put = (n: number, type: number, a: number, b: number): void => {
      rows[n * 7] = type;
      rows.writeUInt32BE(a, n * 7 + 1);
      rows.writeUInt16BE(b, n * 7 + 5);
    };
    for (let n = 0; n < total; n++) {
      const idx = inStm.findIndex((o) => o.n === n);
      if (idx >= 0) put(n, 2, stmNum, idx);
      else if (n === xrefNum) put(n, 1, xrefOffset, 0);
      else if (w.offsets.has(n)) put(n, 1, w.offsets.get(n) as number, 0);
      else put(n, 0, 0, 0);
    }
    w.stream(xrefNum, `/Type /XRef /Size ${total} /W [1 4 2] /Root 1 0 R${trailerExtra} /Filter /FlateDecode`, deflateSync(rows));
    w.push(`startxref\n${xrefOffset}\n%%EOF\n`);
    return w.bytes();
  }

  w.obj(1, (structural[0] as { body: string }).body);
  w.obj(2, (structural[1] as { body: string }).body);
  fontObjects();
  w.obj(7, info);
  if (opts.encrypt) w.obj(8, '<< /Filter /Standard /V 1 /R 2 /O (0000) /U (1111) /P -4 >>');
  pageDicts.forEach((d) => w.obj(d.n, d.body));
  pageObjects.forEach((f) => f());

  if (opts.xref === 'none') return w.bytes();
  const max = next;
  const xrefOffset = w.length;
  let table = `xref\n0 ${max}\n0000000000 65535 f \n`;
  for (let n = 1; n < max; n++) {
    const off = w.offsets.get(n);
    table += off === undefined ? '0000000000 65535 f \n' : `${String((opts.xref === 'bad-offsets' ? off + 7 : off)).padStart(10, '0')} 00000 n \n`;
  }
  w.push(table);
  w.push(`trailer\n<< /Size ${max} /Root 1 0 R${trailerExtra} >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return w.bytes();
}

export interface RawObject {
  /** The dictionary entries without the << >> and without /Length (it is written). Only for stream objects. */
  dict?: string;
  data?: string | Buffer;
  /** The whole body of a plain object. */
  body?: string;
  /** Compress the stream data and add the Flate filter. */
  flate?: boolean;
}

/** Writes objects numbered from 1 in order, with no xref (the reader scans), for tests that need a hand-made structure. Object 1 must be the catalog. */
export function buildRawPdf(objects: (string | RawObject)[]): Uint8Array {
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  objects.forEach((o, i) => {
    const n = i + 1;
    const obj: RawObject = typeof o === 'string' ? { body: o } : o;
    if (obj.body !== undefined) {
      parts.push(Buffer.from(`${n} 0 obj\n${obj.body}\nendobj\n`, 'latin1'));
      return;
    }
    const raw = typeof obj.data === 'string' ? Buffer.from(obj.data, 'latin1') : (obj.data ?? Buffer.alloc(0));
    const data = obj.flate ? deflateSync(raw) : raw;
    parts.push(Buffer.from(`${n} 0 obj\n<< ${obj.dict ?? ''} ${obj.flate ? '/Filter /FlateDecode' : ''} /Length ${data.length} >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream\nendobj\n', 'latin1'));
  });
  parts.push(Buffer.from('trailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1'));
  return new Uint8Array(Buffer.concat(parts));
}
