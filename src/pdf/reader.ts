/**
 * A small PDF text reader with no dependency. It reads what bank statements use: classic or stream xref (with a scan
 * fallback), Flate streams, Type0/Identity-H and simple fonts, text operators with their positions, and the list of
 * image XObjects. It does not render, decode images, decrypt or run scripts.
 */
import { constants, inflateSync } from 'node:zlib';

export class PdfError extends Error {
  readonly code: 'not_pdf' | 'encrypted' | 'unsupported' | 'too_large' | 'damaged';
  constructor(code: PdfError['code'], message: string) {
    super(message);
    this.name = 'PdfError';
    this.code = code;
  }
}

export interface PdfTextItem {
  x: number;
  y: number;
  size: number;
  text: string;
  /** Width of the run in points, used to find the gap to the next run. */
  width?: number;
}
/** Items that share a baseline (within a tolerance), left to right. `text` joins them, with a space where the gap is wide. */
export interface PdfLine {
  y: number;
  items: PdfTextItem[];
  text: string;
}
export interface PdfPage {
  width: number;
  height: number;
  lines: PdfLine[];
}
/** An image XObject. `data` is the stream as stored (raw samples, Flate-compressed samples or a JPEG for DCT). Each image object is listed once, on the first page that draws it. */
export interface PdfImage {
  page: number;
  width: number;
  height: number;
  bitsPerComponent: number;
  colorSpace: 'rgb' | 'gray' | 'cmyk' | 'other';
  filter: 'none' | 'flate' | 'dct' | 'other';
  data: Uint8Array;
}
export interface PdfDocument {
  pages: PdfPage[];
  images: PdfImage[];
  producer: string | null;
  /** Characters of readable text in all pages (spaces and unmapped glyphs not counted). */
  textChars: number;
}
export interface PdfLimits {
  maxBytes?: number;
  maxPages?: number;
  maxInflatedBytes?: number;
}

const DEFAULT_LIMITS: Required<PdfLimits> = { maxBytes: 30 * 1024 * 1024, maxPages: 30, maxInflatedBytes: 64 * 1024 * 1024 };

/** Work a file may ask for besides its size: values read from content streams, text runs and their characters, xref entries, images, and CMap or width table entries written. A statement uses a few percent of each. */
const MAX_STEPS = 4_000_000;
const MAX_ITEMS = 200_000;
const MAX_TEXT_CHARS = 4_000_000;
const MAX_XREF_ENTRIES = 1_000_000;
const MAX_IMAGES = 2_000;
const MAX_CMAP_WORK = 4_000_000;
/** The longest text of one run; a longer string is cut, since no statement cell comes close. */
const MAX_ITEM_CHARS = 2_000;
/** Bytes of one ToUnicode map that are read. */
const MAX_CMAP_BYTES = 2 * 1024 * 1024;

/** Share of the font size that two runs may be apart vertically and still sit on one line. The detached minus sign of a credit is drawn about 1.2 pt lower. */
const LINE_TOLERANCE = 0.5;
/** Share of the font size above which the gap between two runs reads as a space. */
const SPACE_GAP = 0.1;

// --- objects -----------------------------------------------------------------------------------------------------

interface Name { t: 'name'; v: string }
interface Str { t: 'str'; v: Uint8Array }
interface Ref { t: 'ref'; n: number }
interface Dict { t: 'dict'; m: Map<string, Obj> }
interface Stream { t: 'stream'; dict: Dict; data: Uint8Array; end: number }
interface Kw { t: 'kw'; v: string }
type Obj = null | boolean | number | Name | Str | Ref | Dict | Stream | Kw | Obj[];

const isDict = (o: Obj): o is Dict => typeof o === 'object' && o !== null && !Array.isArray(o) && o.t === 'dict';
const isStream = (o: Obj): o is Stream => typeof o === 'object' && o !== null && !Array.isArray(o) && o.t === 'stream';
const isName = (o: Obj): o is Name => typeof o === 'object' && o !== null && !Array.isArray(o) && o.t === 'name';
const isStr = (o: Obj): o is Str => typeof o === 'object' && o !== null && !Array.isArray(o) && o.t === 'str';
const isRef = (o: Obj): o is Ref => typeof o === 'object' && o !== null && !Array.isArray(o) && o.t === 'ref';
const isKw = (o: Obj): o is Kw => typeof o === 'object' && o !== null && !Array.isArray(o) && o.t === 'kw';

// --- lexer -------------------------------------------------------------------------------------------------------

type Tok =
  | { k: 'eof' }
  | { k: 'num'; v: number }
  | { k: 'name'; v: string }
  | { k: 'str'; v: Uint8Array }
  | { k: 'kw'; v: string };

const EOF: Tok = { k: 'eof' };
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/;

function isSpace(c: number): boolean {
  return c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
}
function isDelim(c: number): boolean {
  return c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;
}
function hexValue(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  return -1;
}
function latin1(b: Uint8Array, start: number, end: number): string {
  let s = '';
  for (let i = start; i < end; i++) s += String.fromCharCode(b[i] ?? 0);
  return s;
}

class Lexer {
  readonly b: Uint8Array;
  readonly end: number;
  pos: number;

  constructor(b: Uint8Array, pos = 0, end = b.length) {
    this.b = b;
    this.pos = pos;
    this.end = end;
  }

  private byte(i: number): number {
    return i < this.end ? (this.b[i] ?? 0) : -1;
  }

  private skip(): void {
    for (;;) {
      const c = this.byte(this.pos);
      if (c === -1) return;
      if (isSpace(c)) this.pos++;
      else if (c === 0x25) {
        while (this.pos < this.end && this.byte(this.pos) !== 10 && this.byte(this.pos) !== 13) this.pos++;
      } else return;
    }
  }

  next(): Tok {
    this.skip();
    const c = this.byte(this.pos);
    if (c === -1) return EOF;
    if (c === 0x2f) return this.name();
    if (c === 0x28) return this.literal();
    if (c === 0x3c) {
      if (this.byte(this.pos + 1) === 0x3c) {
        this.pos += 2;
        return { k: 'kw', v: '<<' };
      }
      return this.hex();
    }
    if (c === 0x3e) {
      if (this.byte(this.pos + 1) === 0x3e) {
        this.pos += 2;
        return { k: 'kw', v: '>>' };
      }
      this.pos++;
      return { k: 'kw', v: '>' };
    }
    if (c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x29) {
      this.pos++;
      return { k: 'kw', v: String.fromCharCode(c) };
    }
    const start = this.pos;
    while (this.pos < this.end) {
      const d = this.byte(this.pos);
      if (isSpace(d) || isDelim(d)) break;
      this.pos++;
    }
    const text = latin1(this.b, start, this.pos);
    return NUMBER.test(text) ? { k: 'num', v: Number(text) } : { k: 'kw', v: text };
  }

  private name(): Tok {
    this.pos++;
    let s = '';
    while (this.pos < this.end) {
      const c = this.byte(this.pos);
      if (isSpace(c) || isDelim(c)) break;
      if (c === 0x23) {
        const h = hexValue(this.byte(this.pos + 1));
        const l = hexValue(this.byte(this.pos + 2));
        if (h >= 0 && l >= 0) {
          s += String.fromCharCode(h * 16 + l);
          this.pos += 3;
          continue;
        }
      }
      s += String.fromCharCode(c);
      this.pos++;
    }
    return { k: 'name', v: s };
  }

  private literal(): Tok {
    this.pos++;
    const out: number[] = [];
    let depth = 1;
    while (this.pos < this.end) {
      const c = this.byte(this.pos++);
      if (c === 0x5c) {
        const e = this.byte(this.pos++);
        if (e === 0x6e) out.push(10);
        else if (e === 0x72) out.push(13);
        else if (e === 0x74) out.push(9);
        else if (e === 0x62) out.push(8);
        else if (e === 0x66) out.push(12);
        else if (e >= 0x30 && e <= 0x37) {
          let v = e - 0x30;
          for (let n = 0; n < 2; n++) {
            const d = this.byte(this.pos);
            if (d < 0x30 || d > 0x37) break;
            v = v * 8 + d - 0x30;
            this.pos++;
          }
          out.push(v & 255);
        } else if (e === 13) {
          if (this.byte(this.pos) === 10) this.pos++;
        } else if (e === 10) {
          // line continuation
        } else if (e >= 0) out.push(e);
      } else if (c === 0x28) {
        depth++;
        out.push(c);
      } else if (c === 0x29) {
        depth--;
        if (depth === 0) break;
        out.push(c);
      } else out.push(c);
    }
    return { k: 'str', v: Uint8Array.from(out) };
  }

  private hex(): Tok {
    this.pos++;
    const digits: number[] = [];
    while (this.pos < this.end) {
      const c = this.byte(this.pos++);
      if (c === 0x3e) break;
      const v = hexValue(c);
      if (v >= 0) digits.push(v);
    }
    if (digits.length % 2) digits.push(0);
    const out = new Uint8Array(digits.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = (digits[2 * i] ?? 0) * 16 + (digits[2 * i + 1] ?? 0);
    return { k: 'str', v: out };
  }
}

/** Keywords that end an object that was left open. Only file objects can hit them; content streams never carry them. */
const OBJECT_END = new Set(['endobj', 'obj', 'trailer', 'startxref', 'xref']);

/** Reads one value. `refs` turns "n g R" into a reference (file objects); content streams do not have them. */
function parseValue(lx: Lexer, refs: boolean, depth = 0): Obj {
  if (depth > 64) throw new Error('nesting too deep');
  const start = lx.pos;
  const t = lx.next();
  switch (t.k) {
    case 'eof':
      return { t: 'kw', v: '' };
    case 'name':
      return { t: 'name', v: t.v };
    case 'str':
      return { t: 'str', v: t.v };
    case 'num': {
      if (refs && Number.isInteger(t.v) && t.v >= 0) {
        const save = lx.pos;
        const g = lx.next();
        if (g.k === 'num' && Number.isInteger(g.v)) {
          const r = lx.next();
          if (r.k === 'kw' && r.v === 'R') return { t: 'ref', n: t.v };
        }
        lx.pos = save;
      }
      return t.v;
    }
    case 'kw': {
      if (refs && OBJECT_END.has(t.v)) {
        lx.pos = start;
        return { t: 'kw', v: t.v };
      }
      if (t.v === 'true') return true;
      if (t.v === 'false') return false;
      if (t.v === 'null') return null;
      if (t.v === '[') {
        const arr: Obj[] = [];
        for (;;) {
          const save = lx.pos;
          const peek = lx.next();
          if (peek.k === 'eof' || (peek.k === 'kw' && peek.v === ']')) return arr;
          if (refs && peek.k === 'kw' && OBJECT_END.has(peek.v)) {
            lx.pos = save;
            return arr;
          }
          lx.pos = save;
          arr.push(parseValue(lx, refs, depth + 1));
        }
      }
      if (t.v === '<<') {
        const m = new Map<string, Obj>();
        for (;;) {
          const save = lx.pos;
          const key = lx.next();
          if (key.k === 'eof' || (key.k === 'kw' && key.v === '>>')) return { t: 'dict', m };
          if (refs && key.k === 'kw' && OBJECT_END.has(key.v)) {
            lx.pos = save;
            return { t: 'dict', m };
          }
          if (key.k !== 'name') continue;
          m.set(key.v, parseValue(lx, refs, depth + 1));
        }
      }
      return { t: 'kw', v: t.v };
    }
  }
}

// --- decoding helpers --------------------------------------------------------------------------------------------

/** Whole positive numbers, with a row that fits in memory. */
function validPredictor(columns: number, colors: number, bpc: number): boolean {
  const whole = (n: number, max: number): boolean => Number.isInteger(n) && n >= 1 && n <= max;
  return whole(columns, 1 << 24) && whole(colors, 32) && whole(bpc, 16) && columns * colors * bpc <= 1 << 28;
}

function unpredictPng(data: Uint8Array, columns: number, colors: number, bpc: number): Uint8Array {
  const rowBytes = Math.ceil((columns * colors * bpc) / 8);
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rows = Math.floor(data.length / (rowBytes + 1));
  const out = new Uint8Array(rows * rowBytes);
  for (let r = 0; r < rows; r++) {
    const filter = data[r * (rowBytes + 1)] ?? 0;
    const src = r * (rowBytes + 1) + 1;
    const dst = r * rowBytes;
    for (let i = 0; i < rowBytes; i++) {
      const x = data[src + i] ?? 0;
      const a = i >= bpp ? (out[dst + i - bpp] ?? 0) : 0;
      const b = r > 0 ? (out[dst - rowBytes + i] ?? 0) : 0;
      const c = r > 0 && i >= bpp ? (out[dst - rowBytes + i - bpp] ?? 0) : 0;
      let v = x;
      if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      out[dst + i] = v & 255;
    }
  }
  return out;
}

const WIN_1252_HIGH = [
  '€', '', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '', 'Ž', '',
  '', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '', 'ž', 'Ÿ',
];

/** Code to character for WinAnsiEncoding. Also the fallback for StandardEncoding and MacRomanEncoding, which differ only in the upper half. */
function winAnsiTable(): string[] {
  const t: string[] = [];
  for (let c = 0; c < 256; c++) {
    if (c < 32) t.push('');
    else if (c < 127) t.push(String.fromCharCode(c));
    else if (c >= 128 && c < 160) t.push(WIN_1252_HIGH[c - 128] ?? '');
    else if (c === 127) t.push('');
    else t.push(String.fromCharCode(c));
  }
  return t;
}

const GLYPH_NAMES: Record<string, string> = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&', quotesingle: "'",
  parenleft: '(', parenright: ')', asterisk: '*', plus: '+', comma: ',', hyphen: '-', minus: '-', period: '.', slash: '/',
  colon: ':', semicolon: ';', less: '<', equal: '=', greater: '>', question: '?', at: '@', bracketleft: '[', backslash: '\\',
  bracketright: ']', underscore: '_', grave: '`', braceleft: '{', bar: '|', braceright: '}', asciitilde: '~', endash: '–',
  emdash: '—', quoteleft: '‘', quoteright: '’', quotedblleft: '“', quotedblright: '”', bullet: '•', ellipsis: '…',
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  ordfeminine: 'ª', ordmasculine: 'º', degree: '°', section: '§', Euro: '€', ccedilla: 'ç', Ccedilla: 'Ç', ntilde: 'ñ', Ntilde: 'Ñ',
  germandbls: 'ß', oe: 'œ', OE: 'Œ',
};
const ACCENTS: Record<string, string> = {
  grave: '̀', acute: '́', circumflex: '̂', tilde: '̃', dieresis: '̈',
};

/** Glyph name to text, for the Differences of simple fonts: letters, accented Latin letters, a few symbols and uniXXXX. */
function glyphText(name: string): string {
  const known = GLYPH_NAMES[name];
  if (known !== undefined) return known;
  if (/^[A-Za-z]$/.test(name)) return name;
  const uni = /^uni([0-9A-Fa-f]{4})$/.exec(name);
  if (uni) return String.fromCharCode(parseInt(uni[1] ?? '0', 16));
  const accented = /^([A-Za-z])(grave|acute|circumflex|tilde|dieresis)$/.exec(name);
  if (accented) return ((accented[1] ?? '') + (ACCENTS[accented[2] ?? ''] ?? '')).normalize('NFC');
  return '';
}

// --- fonts -------------------------------------------------------------------------------------------------------

interface Glyph { text: string; adv: number; space: boolean }
interface Font {
  decode(s: Uint8Array): Glyph[];
}

/** Most entries one font's map may hold; a map this large is already far beyond any real font. */
const MAX_CMAP = 300_000;

function utf16(hex: string): string {
  let s = '';
  for (let i = 0; i + 4 <= hex.length; i += 4) s += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  return s;
}

/** The text between each `begin` keyword and the next `end` keyword. It stops at the first `begin` that has no `end`, so a map that repeats `begin` is read once, not once per repeat. */
function* blocks(text: string, begin: string, end: string): Generator<string> {
  let from = 0;
  for (;;) {
    const start = text.indexOf(begin, from);
    if (start < 0) return;
    const bodyStart = start + begin.length;
    const stop = text.indexOf(end, bodyStart);
    if (stop < 0) return;
    yield text.slice(bodyStart, stop);
    from = stop + end.length;
  }
}

/**
 * Reads bfchar and bfrange (also the array form) blocks and the code length from the codespace. `spend` takes from the
 * document's CMap budget and says false once it is gone; the map then stays as far as it got.
 */
function parseToUnicode(data: Uint8Array, spend: (n: number) => boolean): { map: Map<number, string>; codeBytes: number } {
  const text = latin1(data, 0, Math.min(data.length, MAX_CMAP_BYTES));
  const map = new Map<number, string>();
  let codeBytes = 0;
  for (const block of blocks(text, 'begincodespacerange', 'endcodespacerange')) {
    for (const h of block.matchAll(/<([0-9A-Fa-f\s]+)>/g)) codeBytes = Math.max(codeBytes, Math.ceil((h[1] ?? '').replace(/\s/g, '').length / 2));
  }
  for (const block of blocks(text, 'beginbfchar', 'endbfchar')) {
    const hexes = [...block.matchAll(/<([0-9A-Fa-f\s]*)>/g)].map((m) => (m[1] ?? '').replace(/\s/g, ''));
    if (!spend(hexes.length)) return { map, codeBytes };
    for (let i = 0; i + 1 < hexes.length; i += 2) map.set(parseInt(hexes[i] ?? '0', 16), utf16(hexes[i + 1] ?? ''));
  }
  for (const block of blocks(text, 'beginbfrange', 'endbfrange')) {
    const toks = [...block.matchAll(/<([0-9A-Fa-f\s]*)>|\[|\]/g)];
    if (!spend(toks.length)) return { map, codeBytes };
    for (let i = 0; i < toks.length; ) {
      const lo = toks[i];
      const hi = toks[i + 1];
      const dst = toks[i + 2];
      if (!lo || !hi || !dst || lo[1] === undefined || hi[1] === undefined) {
        i++;
        continue;
      }
      const from = parseInt(lo[1].replace(/\s/g, '') || '0', 16);
      const to = Math.min(parseInt(hi[1].replace(/\s/g, '') || '0', 16), from + 0xffff);
      if (dst[0] === '[') {
        let j = i + 3;
        let code = from;
        while (j < toks.length && toks[j]?.[0] !== ']') {
          if (code <= to && map.size < MAX_CMAP) map.set(code, utf16((toks[j]?.[1] ?? '').replace(/\s/g, '')));
          code++;
          j++;
        }
        i = j + 1;
      } else {
        const base = (dst[1] ?? '').replace(/\s/g, '');
        const head = base.slice(0, Math.max(0, base.length - 4));
        const last = parseInt(base.slice(-4) || '0', 16);
        if (to >= from && !spend(to - from + 1)) return { map, codeBytes };
        for (let code = from; code <= to && map.size < MAX_CMAP; code++) map.set(code, utf16(head) + String.fromCharCode(last + code - from));
        i += 3;
      }
    }
  }
  return { map, codeBytes };
}

// --- document ----------------------------------------------------------------------------------------------------

type XEntry = { k: 'off'; off: number } | { k: 'cmp'; stm: number; idx: number } | { k: 'free' };
type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function mul(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

const BAD = Symbol('bad object');

class Doc {
  readonly bytes: Uint8Array;
  readonly buf: Buffer;
  readonly limits: Required<PdfLimits>;
  private xref = new Map<number, XEntry>();
  private cache = new Map<number, Obj>();
  private loading = new Set<number>();
  private objStms = new Map<number, { nums: number[]; data: Uint8Array; first: number; offs: number[] } | null>();
  private fonts = new Map<object, Font>();
  trailer: Dict = { t: 'dict', m: new Map() };
  private scanned = false;
  private inflated = 0;
  private contentBytes = 0;
  private cmapWork = MAX_CMAP_WORK;

  constructor(bytes: Uint8Array, limits: Required<PdfLimits>) {
    this.bytes = bytes;
    this.buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.limits = limits;
  }

  // -- structure

  open(): void {
    try {
      this.readXrefChain();
    } catch (e) {
      if (e instanceof PdfError) throw e;
      this.scan();
    }
    if (!isDict(this.resolve(this.trailer.m.get('Root') ?? null))) this.scan();
    this.checkEncrypted();
  }

  private checkEncrypted(): void {
    if (this.trailer.m.has('Encrypt')) throw new PdfError('encrypted', 'The PDF is encrypted');
  }

  private mergeTrailer(d: Dict): void {
    for (const [k, v] of d.m) if (!this.trailer.m.has(k)) this.trailer.m.set(k, v);
  }

  private readXrefChain(): void {
    const from = Math.max(0, this.bytes.length - 2048);
    const tail = this.buf.toString('latin1', from);
    const at = tail.lastIndexOf('startxref');
    if (at < 0) throw new Error('no startxref');
    const first = Number(/\d+/.exec(tail.slice(at + 9))?.[0]);
    if (!Number.isFinite(first)) throw new Error('bad startxref');
    const queue = [first];
    const seen = new Set<number>();
    while (queue.length) {
      const off = queue.shift() ?? 0;
      if (seen.has(off) || off >= this.bytes.length) continue;
      seen.add(off);
      const lx = new Lexer(this.bytes, off);
      const head = lx.next();
      let trailer: Dict;
      if (head.k === 'kw' && head.v === 'xref') trailer = this.readXrefTable(lx);
      else if (head.k === 'num') trailer = this.readXrefStream(off);
      else throw new Error('bad xref');
      this.mergeTrailer(trailer);
      const prev = trailer.m.get('Prev');
      const stm = trailer.m.get('XRefStm');
      if (typeof stm === 'number') queue.unshift(stm);
      if (typeof prev === 'number') queue.push(prev);
    }
  }

  private readXrefTable(lx: Lexer): Dict {
    for (;;) {
      const t = lx.next();
      if (t.k === 'kw' && t.v === 'trailer') {
        const d = parseValue(lx, true);
        if (!isDict(d)) throw new Error('bad trailer');
        return d;
      }
      if (t.k !== 'num') throw new Error('bad xref table');
      const countTok = lx.next();
      if (countTok.k !== 'num') throw new Error('bad xref table');
      for (let i = 0; i < countTok.v; i++) {
        const off = lx.next();
        const gen = lx.next();
        const flag = lx.next();
        if (off.k !== 'num' || gen.k !== 'num' || flag.k !== 'kw') throw new Error('bad xref entry');
        const n = t.v + i;
        if (this.xref.has(n)) continue;
        if (flag.v === 'n' && off.v > 0) this.xref.set(n, { k: 'off', off: off.v });
        else if (flag.v === 'f') this.xref.set(n, { k: 'free' });
        this.checkXrefSize();
      }
    }
  }

  private checkXrefSize(): void {
    if (this.xref.size > MAX_XREF_ENTRIES) throw new PdfError('too_large', 'The PDF has more objects than allowed');
  }

  private readXrefStream(off: number): Dict {
    const parsed = this.parseIndirectAt(off, -1);
    if (parsed === BAD || !isStream(parsed.obj) || (this.dictName(parsed.obj.dict, 'Type') !== 'XRef')) throw new Error('bad xref stream');
    const s = parsed.obj;
    const data = this.decode(s, true);
    if (!data) throw new Error('bad xref stream data');
    const w = (s.dict.m.get('W') as Obj[] | undefined)?.map((n) => (typeof n === 'number' ? n : 0)) ?? [];
    const [w0 = 0, w1 = 0, w2 = 0] = w;
    const size = typeof s.dict.m.get('Size') === 'number' ? (s.dict.m.get('Size') as number) : 0;
    const indexRaw = s.dict.m.get('Index');
    const index = Array.isArray(indexRaw) ? indexRaw.map((n) => (typeof n === 'number' ? n : 0)) : [0, size];
    const rec = w0 + w1 + w2;
    if (rec === 0) throw new Error('bad xref stream widths');
    const field = (p: number, n: number): number => {
      let v = 0;
      for (let i = 0; i < n; i++) v = v * 256 + (data[p + i] ?? 0);
      return v;
    };
    let p = 0;
    for (let i = 0; i + 1 < index.length; i += 2) {
      const start = index[i] ?? 0;
      const count = index[i + 1] ?? 0;
      for (let j = 0; j < count && p + rec <= data.length; j++, p += rec) {
        const type = w0 === 0 ? 1 : field(p, w0);
        const f2 = field(p + w0, w1);
        const f3 = field(p + w0 + w1, w2);
        const n = start + j;
        if (this.xref.has(n)) continue;
        if (type === 0) this.xref.set(n, { k: 'free' });
        else if (type === 1) this.xref.set(n, { k: 'off', off: f2 });
        else if (type === 2) this.xref.set(n, { k: 'cmp', stm: f2, idx: f3 });
        this.checkXrefSize();
      }
    }
    return s.dict;
  }

  /** Rebuilds the object table by looking for "N G obj" headers. Used when the xref is missing or wrong. */
  private scan(): void {
    this.scanned = true;
    this.xref.clear();
    this.cache.clear();
    this.objStms.clear();
    const text = this.buf.toString('latin1');
    const re = /(?<![0-9])(\d{1,10})[ \t\r\n\f\0]+(\d{1,5})[ \t\r\n\f\0]+obj(?![A-Za-z])/g;
    // A second copy of the pattern finds the header after the current one, which is where the current object must end.
    const ahead = new RegExp(re.source, 'g');
    const stms: number[] = [];
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const n = Number(m[1]);
      this.xref.set(n, { k: 'off', off: m.index });
      this.checkXrefSize();
      ahead.lastIndex = m.index + m[0].length;
      const limit = ahead.exec(text)?.index ?? text.length;
      try {
        const parsed = this.parseIndirectAt(m.index, n, limit);
        if (parsed === BAD) continue;
        // an encryption dictionary, for files whose trailer is gone
        if (isDict(parsed.obj) && this.dictName(parsed.obj, 'Filter') === 'Standard' && parsed.obj.m.has('O') && parsed.obj.m.has('U')) {
          this.trailer.m.set('Encrypt', { t: 'ref', n });
        }
        if (isStream(parsed.obj)) {
          re.lastIndex = Math.max(re.lastIndex, parsed.obj.end);
          const type = this.dictName(parsed.obj.dict, 'Type');
          if (type === 'ObjStm') stms.push(n);
          if (type === 'XRef') this.mergeTrailer(parsed.obj.dict);
        }
      } catch (e) {
        if (e instanceof PdfError) throw e;
        // an unreadable object is left to the lookup that needs it
      }
    }
    for (let at = text.indexOf('trailer'); at >= 0; ) {
      const next = text.indexOf('trailer', at + 7);
      try {
        const d = parseValue(new Lexer(this.bytes, at + 7, next < 0 ? this.bytes.length : next), true);
        if (isDict(d)) this.mergeTrailer(d);
      } catch {
        // keep scanning
      }
      at = next;
    }
    for (const stm of stms) {
      const info = this.objStm(stm);
      if (!info) continue;
      info.nums.forEach((n, idx) => {
        if (!this.xref.has(n)) this.xref.set(n, { k: 'cmp', stm, idx });
      });
    }
    if (!isDict(this.resolve(this.trailer.m.get('Root') ?? null))) {
      for (const n of [...this.xref.keys()]) {
        const o = this.load(n);
        if (isDict(o) && this.dictName(o, 'Type') === 'Catalog') {
          this.trailer.m.set('Root', { t: 'ref', n });
          break;
        }
      }
    }
    this.checkEncrypted();
  }

  // -- objects

  /** `limit` is where the object text may reach at most (the next object header, when scanning); the stream data after it is not limited. */
  private parseIndirectAt(off: number, expect: number, limit = this.bytes.length): { obj: Obj; end: number } | typeof BAD {
    const lx = new Lexer(this.bytes, off, limit);
    const n = lx.next();
    const g = lx.next();
    const kw = lx.next();
    if (n.k !== 'num' || g.k !== 'num' || kw.k !== 'kw' || kw.v !== 'obj') return BAD;
    if (expect >= 0 && n.v !== expect) return BAD;
    const value = parseValue(lx, true);
    if (!isDict(value)) return { obj: value, end: lx.pos };
    const save = lx.pos;
    const t = lx.next();
    if (t.k !== 'kw' || t.v !== 'stream') {
      lx.pos = save;
      return { obj: value, end: save };
    }
    let start = lx.pos;
    if (this.bytes[start] === 13 && this.bytes[start + 1] === 10) start += 2;
    else if (this.bytes[start] === 10 || this.bytes[start] === 13) start += 1;
    const lenObj = this.resolve(value.m.get('Length') ?? null);
    let end = -1;
    if (typeof lenObj === 'number' && Number.isInteger(lenObj) && lenObj >= 0 && start + lenObj <= this.bytes.length) {
      const after = new Lexer(this.bytes, start + lenObj).next();
      if (after.k === 'kw' && after.v === 'endstream') end = start + lenObj;
    }
    if (end < 0) {
      const at = this.buf.indexOf('endstream', start, 'latin1');
      end = at < 0 ? this.bytes.length : at;
      if (this.bytes[end - 1] === 10) end--;
      if (this.bytes[end - 1] === 13) end--;
      if (end < start) end = start;
    }
    return { obj: { t: 'stream', dict: value, data: this.bytes.subarray(start, end), end }, end };
  }

  load(n: number): Obj {
    const hit = this.cache.get(n);
    if (hit !== undefined) return hit;
    if (this.cache.has(n)) return null;
    const e = this.xref.get(n);
    if (!e || e.k === 'free' || this.loading.has(n)) return null;
    this.loading.add(n);
    try {
      let v: Obj = null;
      if (e.k === 'off') {
        const parsed = this.parseIndirectAt(e.off, n);
        if (parsed === BAD) {
          if (this.scanned) return null;
          this.loading.delete(n);
          this.scan();
          return this.load(n);
        }
        v = parsed.obj;
      } else {
        v = this.fromObjStm(e.stm, n, e.idx);
      }
      this.cache.set(n, v);
      return v;
    } catch (err) {
      if (err instanceof PdfError) throw err;
      return null;
    } finally {
      this.loading.delete(n);
    }
  }

  resolve(o: Obj): Obj {
    let cur = o;
    for (let i = 0; i < 16 && isRef(cur); i++) cur = this.load(cur.n);
    return isRef(cur) ? null : cur;
  }

  /** Value of a dictionary key with references followed. */
  get(d: Dict | null | undefined, key: string): Obj {
    return d ? this.resolve(d.m.get(key) ?? null) : null;
  }
  getDict(d: Dict | null | undefined, key: string): Dict | null {
    const o = this.get(d, key);
    return isDict(o) ? o : isStream(o) ? o.dict : null;
  }
  getNum(d: Dict | null | undefined, key: string): number | null {
    const o = this.get(d, key);
    return typeof o === 'number' ? o : null;
  }
  getArray(d: Dict | null | undefined, key: string): Obj[] | null {
    const o = this.get(d, key);
    return Array.isArray(o) ? o : null;
  }
  private dictName(d: Dict, key: string): string | null {
    const o = this.resolve(d.m.get(key) ?? null);
    return isName(o) ? o.v : null;
  }

  private objStm(stm: number): { nums: number[]; data: Uint8Array; first: number; offs: number[] } | null {
    const known = this.objStms.get(stm);
    if (known !== undefined) return known;
    this.objStms.set(stm, null);
    const s = this.load(stm);
    if (!isStream(s)) return null;
    const data = this.decode(s, true);
    const n = this.getNum(s.dict, 'N');
    const first = this.getNum(s.dict, 'First');
    if (!data || n === null || first === null) return null;
    const lx = new Lexer(data);
    const nums: number[] = [];
    const offs: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = lx.next();
      const b = lx.next();
      if (a.k !== 'num' || b.k !== 'num') break;
      nums.push(a.v);
      offs.push(b.v);
    }
    const info = { nums, data, first, offs };
    this.objStms.set(stm, info);
    return info;
  }

  private fromObjStm(stm: number, n: number, idx: number): Obj {
    const info = this.objStm(stm);
    if (!info) return null;
    const i = info.nums[idx] === n ? idx : info.nums.indexOf(n);
    if (i < 0) return null;
    return parseValue(new Lexer(info.data, info.first + (info.offs[i] ?? 0)), true);
  }

  // -- streams

  private inflate(data: Uint8Array): Uint8Array | null {
    const room = Math.max(1, this.limits.maxInflatedBytes - this.inflated);
    try {
      const out = inflateSync(data, { maxOutputLength: room, finishFlush: constants.Z_SYNC_FLUSH });
      this.inflated += out.length;
      if (this.inflated > this.limits.maxInflatedBytes) throw new PdfError('too_large', 'The PDF inflates to more data than allowed');
      return out;
    } catch (e) {
      if (e instanceof PdfError) throw e;
      if ((e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw new PdfError('too_large', 'The PDF inflates to more data than allowed');
      return null;
    }
  }

  /** Counts bytes of content that are about to be read, raw or inflated, so a stream listed or drawn many times cannot get around the inflate limit. */
  chargeContent(n: number): void {
    this.contentBytes += n;
    if (this.contentBytes > this.limits.maxInflatedBytes) throw new PdfError('too_large', 'The PDF has more page content than allowed');
  }

  /** Takes `n` units of the budget for CMap and width tables. False when it is spent, so the table stays as far as it got. */
  spendCmap(n: number): boolean {
    if (n > this.cmapWork) {
      this.cmapWork = 0;
      return false;
    }
    this.cmapWork -= n;
    return true;
  }

  /**
   * The stream with its filters applied. Returns null for a stream that cannot be read, so one bad stream is skipped.
   * `structural` streams (xref and object streams) throw 'unsupported' for a filter or predictor this reader does not know.
   */
  decode(s: Stream, structural = false): Uint8Array | null {
    const f = this.get(s.dict, 'Filter');
    const filters = (Array.isArray(f) ? f.map((x) => this.resolve(x)) : f === null ? [] : [f]).map((x) => (isName(x) ? x.v : ''));
    const p = this.get(s.dict, 'DecodeParms') ?? this.get(s.dict, 'DP');
    const params = Array.isArray(p) ? p.map((x) => this.resolve(x)) : [p];
    let data: Uint8Array | null = s.data;
    for (let i = 0; i < filters.length && data; i++) {
      if (filters[i] !== 'FlateDecode' && filters[i] !== 'Fl') {
        if (structural) throw new PdfError('unsupported', `Stream filter ${filters[i]} is not supported`);
        return null;
      }
      data = this.inflate(data);
      const pd = params[i] ?? null;
      const predictor = isDict(pd) ? this.getNum(pd, 'Predictor') : null;
      if (data && predictor !== null && predictor > 1) {
        if (predictor < 10) {
          if (structural) throw new PdfError('unsupported', 'Stream predictor is not supported');
          return null;
        }
        const columns = this.getNum(pd as Dict, 'Columns') ?? 1;
        const colors = this.getNum(pd as Dict, 'Colors') ?? 1;
        const bpc = this.getNum(pd as Dict, 'BitsPerComponent') ?? 8;
        if (!validPredictor(columns, colors, bpc)) {
          if (structural) throw new PdfError('unsupported', 'Stream predictor parameters are not valid');
          return null;
        }
        data = unpredictPng(data, columns, colors, bpc);
      }
    }
    return data;
  }

  // -- pages

  pageNodes(): { dict: Dict; resources: Dict | null; mediaBox: Obj[] | null }[] {
    const root = this.getDict(this.trailer, 'Root');
    const out: { dict: Dict; resources: Dict | null; mediaBox: Obj[] | null }[] = [];
    const seen = new Set<Dict>();
    const walk = (o: Obj, resources: Dict | null, mediaBox: Obj[] | null, depth: number): void => {
      const node = this.resolve(o);
      if (!isDict(node) || seen.has(node) || depth > 32) return;
      seen.add(node);
      const res = this.getDict(node, 'Resources') ?? resources;
      const box = this.getArray(node, 'MediaBox') ?? mediaBox;
      const kids = this.getArray(node, 'Kids');
      if (kids) {
        for (const k of kids) {
          walk(k, res, box, depth + 1);
          if (out.length > this.limits.maxPages) return;
        }
      } else out.push({ dict: node, resources: res, mediaBox: box });
    };
    if (root) walk(root.m.get('Pages') ?? null, null, null, 0);
    return out;
  }

  /** Every page object in file order, for files whose page tree is broken. */
  loosePages(): { dict: Dict; resources: Dict | null; mediaBox: Obj[] | null }[] {
    const out: { dict: Dict; resources: Dict | null; mediaBox: Obj[] | null }[] = [];
    for (const n of [...this.xref.keys()].sort((a, b) => a - b)) {
      const o = this.load(n);
      if (isDict(o) && this.dictName(o, 'Type') === 'Page') out.push({ dict: o, resources: this.getDict(o, 'Resources'), mediaBox: this.getArray(o, 'MediaBox') });
    }
    return out;
  }

  rescan(): boolean {
    if (this.scanned) return false;
    this.scan();
    return true;
  }

  producer(): string | null {
    const info = this.getDict(this.trailer, 'Info');
    const p = this.get(info, 'Producer');
    if (!isStr(p)) return null;
    const b = p.v;
    if (b[0] === 0xfe && b[1] === 0xff) {
      let s = '';
      for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode(((b[i] ?? 0) << 8) | (b[i + 1] ?? 0));
      return s;
    }
    return latin1(b, 0, b.length);
  }

  // -- fonts

  font(dict: Dict): Font {
    const hit = this.fonts.get(dict);
    if (hit) return hit;
    const f = this.buildFont(dict);
    this.fonts.set(dict, f);
    return f;
  }

  private buildFont(dict: Dict): Font {
    const tu = this.get(dict, 'ToUnicode');
    let uni: ReturnType<typeof parseToUnicode> | null = null;
    if (isStream(tu)) {
      const data = this.decode(tu);
      if (data) uni = parseToUnicode(data, (n) => this.spendCmap(n));
    }
    const subtype = this.dictName(dict, 'Subtype');
    if (subtype === 'Type0') {
      const desc = this.getArray(dict, 'DescendantFonts');
      const cid = desc ? this.resolve(desc[0] ?? null) : null;
      const cidDict = isDict(cid) ? cid : null;
      const dw = this.getNum(cidDict, 'DW') ?? 1000;
      const widths = new Map<number, number>();
      const w = this.getArray(cidDict, 'W') ?? [];
      for (let i = 0; i < w.length; ) {
        const first = this.resolve(w[i] ?? null);
        const second = this.resolve(w[i + 1] ?? null);
        if (typeof first !== 'number') {
          i++;
          continue;
        }
        if (Array.isArray(second)) {
          second.forEach((x, k) => {
            const v = this.resolve(x);
            if (typeof v === 'number') widths.set(first + k, v);
          });
          i += 2;
        } else {
          const width = this.resolve(w[i + 2] ?? null);
          if (typeof second === 'number' && typeof width === 'number') {
            const last = Math.min(second, first + 0xffff);
            if (last >= first && !this.spendCmap(last - first + 1)) break;
            for (let c = first; c <= last && widths.size < MAX_CMAP; c++) widths.set(c, width);
          }
          i += 3;
        }
      }
      const enc = this.get(dict, 'Encoding');
      const identity = isName(enc) && enc.v.startsWith('Identity');
      const codeBytes = identity || !uni || uni.codeBytes === 0 ? 2 : uni.codeBytes;
      const map = uni?.map ?? new Map<number, string>();
      return {
        decode(s) {
          const out: Glyph[] = [];
          for (let i = 0; i + codeBytes <= s.length; i += codeBytes) {
            let code = 0;
            for (let k = 0; k < codeBytes; k++) code = code * 256 + (s[i + k] ?? 0);
            out.push({ text: map.get(code) ?? '', adv: (widths.get(code) ?? dw) / 1000, space: codeBytes === 1 && code === 32 });
          }
          return out;
        },
      };
    }
    // simple font: one byte per code
    const table = winAnsiTable();
    const enc = this.get(dict, 'Encoding');
    if (isDict(enc)) {
      const diffs = this.getArray(enc, 'Differences') ?? [];
      let code = 0;
      for (const d of diffs) {
        const v = this.resolve(d);
        if (typeof v === 'number') code = v;
        else if (isName(v)) table[code++] = glyphText(v.v);
      }
    }
    const first = this.getNum(dict, 'FirstChar') ?? 0;
    const widthArr = this.getArray(dict, 'Widths');
    const missing = this.getNum(this.getDict(dict, 'FontDescriptor'), 'MissingWidth');
    const widths = widthArr?.map((x) => {
      const v = this.resolve(x);
      return typeof v === 'number' ? v : 0;
    });
    const map = uni?.map ?? null;
    return {
      decode(s) {
        const out: Glyph[] = [];
        for (const code of s) {
          const idx = code - first;
          const width = widths ? (idx >= 0 && idx < widths.length ? (widths[idx] ?? 0) : (missing ?? 0)) : code === 32 ? 250 : 500;
          out.push({ text: map?.get(code) ?? table[code] ?? '', adv: width / 1000, space: code === 32 });
        }
        return out;
      },
    };
  }
}

// --- content streams ---------------------------------------------------------------------------------------------

interface GState {
  ctm: Matrix;
  font: Font | null;
  size: number;
  tc: number;
  tw: number;
  th: number;
  tl: number;
  rise: number;
}

interface Collector {
  items: PdfTextItem[];
  images: PdfImage[];
  seenImages: Set<number | Stream>;
  forms: Set<Dict>;
  /** Work done over the whole document: values read, text runs and their characters. */
  steps: number;
  runs: number;
  chars: number;
}

const tooMuchWork = (): PdfError => new PdfError('too_large', 'The PDF asks for more work than allowed');

function colorSpace(doc: Doc, cs: Obj): PdfImage['colorSpace'] {
  const o = doc.resolve(cs);
  const byName = (n: string): PdfImage['colorSpace'] => {
    if (n === 'DeviceRGB' || n === 'RGB' || n === 'CalRGB') return 'rgb';
    if (n === 'DeviceGray' || n === 'G' || n === 'CalGray') return 'gray';
    if (n === 'DeviceCMYK' || n === 'CMYK') return 'cmyk';
    return 'other';
  };
  if (isName(o)) return byName(o.v);
  if (Array.isArray(o)) {
    const head = doc.resolve(o[0] ?? null);
    if (isName(head) && head.v === 'ICCBased') {
      const icc = doc.resolve(o[1] ?? null);
      const n = isStream(icc) ? doc.getNum(icc.dict, 'N') : null;
      return n === 3 ? 'rgb' : n === 1 ? 'gray' : n === 4 ? 'cmyk' : 'other';
    }
    if (isName(head)) return byName(head.v);
  }
  return 'other';
}

function imageFilter(doc: Doc, d: Dict): PdfImage['filter'] {
  const f = doc.get(d, 'Filter');
  const list = (Array.isArray(f) ? f : f === null ? [] : [f]).map((x) => doc.resolve(x)).map((x) => (isName(x) ? x.v : ''));
  if (list.length === 0) return 'none';
  if (list.length > 1) return 'other';
  if (list[0] === 'FlateDecode' || list[0] === 'Fl') return 'flate';
  if (list[0] === 'DCTDecode' || list[0] === 'DCT') return 'dct';
  return 'other';
}

function runContent(doc: Doc, data: Uint8Array, resources: Dict | null, ctm0: Matrix, page: number, out: Collector, depth: number): void {
  const lx = new Lexer(data);
  const stack: GState[] = [];
  let g: GState = { ctm: ctm0, font: null, size: 0, tc: 0, tw: 0, th: 1, tl: 0, rise: 0 };
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  let operands: Obj[] = [];

  const arg = (i: number): Obj => operands[i] ?? null;
  const num = (i: number): number => {
    const v = operands[i];
    return typeof v === 'number' ? v : 0;
  };
  const move = (tx: number, ty: number): void => {
    tlm = mul([1, 0, 0, 1, tx, ty], tlm);
    tm = tlm;
  };
  const show = (s: Uint8Array): void => {
    if (!g.font) return;
    const m = mul(tm, g.ctm);
    let text = '';
    let adv = 0;
    for (const gl of g.font.decode(s)) {
      text += gl.text;
      adv += (gl.adv * g.size + g.tc + (gl.space ? g.tw : 0)) * g.th;
    }
    const rotated = Math.abs(m[1]) + Math.abs(m[2]) > Math.abs(m[0]) + Math.abs(m[3]);
    if (!rotated && text.trim() !== '') {
      if (text.length > MAX_ITEM_CHARS) text = text.slice(0, MAX_ITEM_CHARS);
      out.runs++;
      out.chars += text.length;
      if (out.runs > MAX_ITEMS || out.chars > MAX_TEXT_CHARS) throw tooMuchWork();
      out.items.push({
        x: m[2] * g.rise + m[4],
        y: m[3] * g.rise + m[5],
        size: g.size * Math.hypot(m[2], m[3]),
        text,
        width: adv * Math.hypot(m[0], m[1]),
      });
    }
    tm = mul([1, 0, 0, 1, adv, 0], tm);
  };
  const nextLine = (): void => move(0, -g.tl);

  for (;;) {
    if (++out.steps > MAX_STEPS) throw tooMuchWork();
    let v: Obj;
    try {
      v = parseValue(lx, false);
    } catch {
      // nesting too deep: the rest of this stream cannot be told apart from its operators
      break;
    }
    if (!isKw(v)) {
      operands.push(v);
      if (operands.length > 512) operands = operands.slice(-64);
      continue;
    }
    if (v.v === '' && lx.pos >= lx.end) break;
    try {
      switch (v.v) {
        case 'q':
          stack.push({ ...g });
          break;
        case 'Q':
          g = stack.pop() ?? g;
          break;
        case 'cm':
          g = { ...g, ctm: mul([num(0), num(1), num(2), num(3), num(4), num(5)], g.ctm) };
          break;
        case 'BT':
          tm = IDENTITY;
          tlm = IDENTITY;
          break;
        case 'Tf': {
          const name = arg(0);
          const fonts = doc.getDict(resources, 'Font');
          const fd = isName(name) ? doc.get(fonts, name.v) : null;
          g.font = isDict(fd) ? doc.font(fd) : null;
          g.size = num(1);
          break;
        }
        case 'TL':
          g.tl = num(0);
          break;
        case 'Tc':
          g.tc = num(0);
          break;
        case 'Tw':
          g.tw = num(0);
          break;
        case 'Tz':
          g.th = num(0) / 100;
          break;
        case 'Ts':
          g.rise = num(0);
          break;
        case 'Td':
          move(num(0), num(1));
          break;
        case 'TD':
          g.tl = -num(1);
          move(num(0), num(1));
          break;
        case 'Tm':
          tm = [num(0), num(1), num(2), num(3), num(4), num(5)];
          tlm = tm;
          break;
        case 'T*':
          nextLine();
          break;
        case 'Tj': {
          const s = arg(0);
          if (isStr(s)) show(s.v);
          break;
        }
        case "'": {
          nextLine();
          const s = arg(0);
          if (isStr(s)) show(s.v);
          break;
        }
        case '"': {
          g.tw = num(0);
          g.tc = num(1);
          nextLine();
          const s = arg(2);
          if (isStr(s)) show(s.v);
          break;
        }
        case 'TJ': {
          const arr = arg(0);
          if (Array.isArray(arr)) {
            for (const e of arr) {
              if (isStr(e)) show(e.v);
              else if (typeof e === 'number') tm = mul([1, 0, 0, 1, (-e / 1000) * g.size * g.th, 0], tm);
            }
          }
          break;
        }
        case 'Do': {
          const name = arg(0);
          const xobjs = doc.getDict(resources, 'XObject');
          if (!isName(name) || !xobjs) break;
          const ref = xobjs.m.get(name.v) ?? null;
          const x = doc.resolve(ref);
          if (!isStream(x)) break;
          const sub = doc.get(x.dict, 'Subtype');
          if (isName(sub) && sub.v === 'Image') {
            const key = isRef(ref) ? ref.n : x;
            if (out.seenImages.has(key)) break;
            out.seenImages.add(key);
            if (out.images.length >= MAX_IMAGES) throw tooMuchWork();
            const mask = doc.get(x.dict, 'ImageMask') === true;
            out.images.push({
              page,
              width: doc.getNum(x.dict, 'Width') ?? 0,
              height: doc.getNum(x.dict, 'Height') ?? 0,
              bitsPerComponent: mask ? 1 : (doc.getNum(x.dict, 'BitsPerComponent') ?? 8),
              colorSpace: mask ? 'gray' : colorSpace(doc, x.dict.m.get('ColorSpace') ?? null),
              filter: imageFilter(doc, x.dict),
              data: x.data,
            });
          } else if (isName(sub) && sub.v === 'Form' && depth < 4 && !out.forms.has(x.dict)) {
            out.forms.add(x.dict);
            const content = doc.decode(x);
            if (content) doc.chargeContent(content.length);
            const mArr = doc.getArray(x.dict, 'Matrix');
            const fm: Matrix = mArr && mArr.length === 6 ? (mArr.map((n) => (typeof n === 'number' ? n : 0)) as Matrix) : IDENTITY;
            if (content) runContent(doc, content, doc.getDict(x.dict, 'Resources') ?? resources, mul(fm, g.ctm), page, out, depth + 1);
            out.forms.delete(x.dict);
          }
          break;
        }
        case 'BI': {
          // inline image: skip its bytes up to the closing EI
          for (let t = lx.next(); t.k !== 'eof' && !(t.k === 'kw' && t.v === 'ID'); t = lx.next());
          const inline = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
          let at = lx.pos;
          for (;;) {
            at = inline.indexOf('EI', at, 'latin1');
            if (at < 0) {
              at = data.length;
              break;
            }
            if (isSpace(data[at - 1] ?? 32) && (at + 2 >= data.length || isSpace(data[at + 2] ?? 32))) break;
            at += 2;
          }
          lx.pos = Math.min(data.length, at + 2);
          break;
        }
        default:
          break;
      }
    } catch (e) {
      if (e instanceof PdfError) throw e;
    }
    operands = [];
  }
}

// --- lines -------------------------------------------------------------------------------------------------------

/** Joins runs of one line, left to right, with a space where the gap to the previous run is wide. */
export function joinItems(items: PdfTextItem[]): string {
  const row = [...items].sort((a, b) => a.x - b.x);
  let text = '';
  let end = Number.NEGATIVE_INFINITY;
  for (const it of row) {
    if (text !== '' && it.x - end > SPACE_GAP * it.size && !text.endsWith(' ') && !it.text.startsWith(' ')) text += ' ';
    text += it.text;
    end = it.x + (it.width ?? 0);
  }
  return text.trim();
}

/** Groups runs into lines, top to bottom. Runs within half a font size of a line's first run belong to it, so a minus sign drawn a little lower stays with its amount. */
export function groupLines(items: PdfTextItem[]): PdfLine[] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const groups: { y: number; items: PdfTextItem[] }[] = [];
  for (const it of sorted) {
    const g = groups[groups.length - 1];
    if (g && g.y - it.y <= LINE_TOLERANCE * Math.max(it.size, 1)) g.items.push(it);
    else groups.push({ y: it.y, items: [it] });
  }
  return groups.map((g) => {
    const row = g.items.sort((a, b) => a.x - b.x);
    return { y: g.y, items: row, text: joinItems(row) };
  });
}

// --- entry point -------------------------------------------------------------------------------------------------

export function readPdf(bytes: Uint8Array, limits: PdfLimits = {}): PdfDocument {
  const lim: Required<PdfLimits> = { ...DEFAULT_LIMITS, ...limits };
  if (bytes.length > lim.maxBytes) throw new PdfError('too_large', 'The PDF is larger than allowed');
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.length, 1024)).toString('latin1');
  if (!head.includes('%PDF-')) throw new PdfError('not_pdf', 'The file is not a PDF');

  const doc = new Doc(bytes, lim);
  doc.open();
  let nodes = doc.pageNodes();
  if (nodes.length === 0 && doc.rescan()) nodes = doc.pageNodes();
  if (nodes.length === 0) nodes = doc.loosePages();
  if (nodes.length === 0) throw new PdfError('damaged', 'The PDF has no readable pages');
  if (nodes.length > lim.maxPages) throw new PdfError('too_large', 'The PDF has more pages than allowed');

  const collected: Collector = { items: [], images: [], seenImages: new Set(), forms: new Set(), steps: 0, runs: 0, chars: 0 };
  const pages: PdfPage[] = [];
  let textChars = 0;
  nodes.forEach((node, i) => {
    collected.items = [];
    try {
      const contents = doc.get(node.dict, 'Contents');
      const parts = Array.isArray(contents) ? contents : [node.dict.m.get('Contents') ?? null];
      const chunks: Uint8Array[] = [];
      for (const part of parts) {
        const s = doc.resolve(part);
        const data = isStream(s) ? doc.decode(s) : null;
        if (data) {
          doc.chargeContent(data.length + 1);
          chunks.push(data, Uint8Array.of(10));
        }
      }
      runContent(doc, Buffer.concat(chunks), node.resources, IDENTITY, i + 1, collected, 0);
    } catch (e) {
      if (e instanceof PdfError) throw e;
      // a page that cannot be read comes out without lines
      collected.items = [];
    }
    const items = collected.items.map((it) => ({ ...it, text: it.text.replaceAll('\uFFFD', '') })).filter((it) => it.text !== '');
    for (const it of items) textChars += it.text.replace(/\s/g, '').length;
    const box = (node.mediaBox ?? []).map((n) => doc.resolve(n)).map((n) => (typeof n === 'number' ? n : 0));
    pages.push({
      width: Math.abs((box[2] ?? 612) - (box[0] ?? 0)),
      height: Math.abs((box[3] ?? 792) - (box[1] ?? 0)),
      lines: groupLines(items),
    });
  });
  return { pages, images: collected.images, producer: doc.producer(), textChars };
}
