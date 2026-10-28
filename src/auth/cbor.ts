/** A small CBOR reader, enough for WebAuthn attestation objects and COSE keys. Indefinite lengths and floats are refused. */
export type CborValue = number | bigint | Uint8Array | string | boolean | null | CborValue[] | Map<CborValue, CborValue>;

export function decodeCbor(input: Uint8Array): CborValue {
  const { value, end } = read(input, 0, 0);
  if (end !== input.length) throw new Error('CBOR: extra bytes after the value');
  return value;
}

/** Decodes the first value and says where it ended, for data that has more after it (authenticator data). */
export function decodeCborPrefix(input: Uint8Array, start: number): { value: CborValue; end: number } {
  return read(input, start, 0);
}

const MAX_DEPTH = 8;
const MAX_ITEMS = 256;

function read(b: Uint8Array, at: number, depth: number): { value: CborValue; end: number } {
  if (depth > MAX_DEPTH) throw new Error('CBOR: nested too deep');
  if (at >= b.length) throw new Error('CBOR: unexpected end');
  const initial = b[at]!;
  const major = initial >> 5;
  const info = initial & 31;
  let pos = at + 1;

  let length: number;
  if (info < 24) length = info;
  else if (info === 24) {
    length = need(b, pos, 1)[0]!;
    pos += 1;
  } else if (info === 25) {
    const v = need(b, pos, 2);
    length = (v[0]! << 8) | v[1]!;
    pos += 2;
  } else if (info === 26) {
    const v = need(b, pos, 4);
    length = v[0]! * 2 ** 24 + (v[1]! << 16) + (v[2]! << 8) + v[3]!;
    pos += 4;
  } else if (info === 27 && major <= 1) {
    const v = need(b, pos, 8);
    const big = Buffer.from(v).readBigUInt64BE();
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('CBOR: integer too large');
    length = Number(big);
    pos += 8;
  } else if (major === 7 && info >= 20 && info <= 22) {
    length = 0;
  } else throw new Error('CBOR: unsupported encoding');

  switch (major) {
    case 0:
      return { value: length, end: pos };
    case 1:
      return { value: -1 - length, end: pos };
    case 2: {
      const bytes = need(b, pos, length);
      return { value: new Uint8Array(bytes), end: pos + length };
    }
    case 3: {
      const bytes = need(b, pos, length);
      return { value: Buffer.from(bytes).toString('utf8'), end: pos + length };
    }
    case 4: {
      if (length > MAX_ITEMS) throw new Error('CBOR: array too long');
      const items: CborValue[] = [];
      for (let i = 0; i < length; i++) {
        const item = read(b, pos, depth + 1);
        items.push(item.value);
        pos = item.end;
      }
      return { value: items, end: pos };
    }
    case 5: {
      if (length > MAX_ITEMS) throw new Error('CBOR: map too long');
      const map = new Map<CborValue, CborValue>();
      for (let i = 0; i < length; i++) {
        const key = read(b, pos, depth + 1);
        const val = read(b, key.end, depth + 1);
        map.set(key.value, val.value);
        pos = val.end;
      }
      return { value: map, end: pos };
    }
    case 7:
      return { value: info === 20 ? false : info === 21 ? true : null, end: pos };
    default:
      throw new Error('CBOR: unsupported major type');
  }
}

function need(b: Uint8Array, at: number, n: number): Uint8Array {
  if (at + n > b.length) throw new Error('CBOR: unexpected end');
  return b.subarray(at, at + n);
}

/** Encoder for the few shapes tests need: ints, byte strings, text, maps. */
export function encodeCbor(value: CborValue): Buffer {
  const head = (major: number, n: number): Buffer => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
    const out = Buffer.alloc(5);
    out[0] = (major << 5) | 26;
    out.writeUInt32BE(n, 1);
    return out;
  };
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value]);
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(encodeCbor)]);
  if (value instanceof Map) return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [encodeCbor(k), encodeCbor(v)])]);
  throw new Error('CBOR: cannot encode this value');
}
