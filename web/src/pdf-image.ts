/**
 * The page image of an image-only statement PDF, made small enough to send to the AI reader: found in the file in the
 * browser (no PDF library), decoded, scaled to at most 1600 px on the longer side and encoded as a JPEG. Only images the
 * app can decode without a library are taken: JPEG (DCT), and 8-bit RGB or gray samples, raw or Flate without a predictor.
 */

export interface FoundImage {
  width: number;
  height: number;
  bitsPerComponent: number;
  colorSpace: 'rgb' | 'gray' | 'other';
  filter: 'none' | 'flate' | 'dct' | 'other';
  /** The stream as stored in the file. */
  data: Uint8Array;
}

const MAX_SIDE = 1600;
const QUALITY = 0.8;

const num = (dict: string, key: string): number | null => {
  const m = new RegExp(`/${key}\\s+(\\d+)(\\s+0\\s+R)?`).exec(dict);
  return m ? Number(m[1]) : null;
};

/** The /Length of a stream dictionary, direct or as a reference to an object that holds the number. -1 when it cannot be read. */
function lengthOf(text: string, dict: string): number {
  const direct = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
  if (direct) return Number(direct[1]);
  const ref = /\/Length\s+(\d+)\s+(\d+)\s+R/.exec(dict);
  const held = ref ? new RegExp(`(?:^|\\s)${ref[1]}\\s+${ref[2]}\\s+obj\\s*(\\d+)\\s*endobj`).exec(text) : null;
  return held ? Number(held[1]) : -1;
}

/** Image XObjects of a PDF, largest first. */
export function findImages(bytes: Uint8Array): FoundImage[] {
  const text = new TextDecoder('latin1').decode(bytes);
  const found: FoundImage[] = [];
  const objects = /\d+\s+\d+\s+obj\b/g;
  for (let m = objects.exec(text); m !== null && found.length < 20; m = objects.exec(text)) {
    const start = m.index + m[0].length;
    const streamAt = text.indexOf('stream', start);
    const endObject = text.indexOf('endobj', start);
    if (streamAt < 0 || (endObject >= 0 && endObject < streamAt)) continue;
    const dict = text.slice(start, streamAt);
    if (!/\/Subtype\s*\/Image\b/.test(dict)) continue;
    const width = num(dict, 'Width');
    const height = num(dict, 'Height');
    if (!width || !height) continue;
    let dataStart = streamAt + 'stream'.length;
    if (text[dataStart] === '\r') dataStart++;
    if (text[dataStart] === '\n') dataStart++;
    let end = dataStart + lengthOf(text, dict);
    if (end === dataStart - 1) {
      // No length to read: the stream ends at "endstream", less the line break the writer put before it.
      end = text.indexOf('endstream', dataStart);
      while (end > dataStart && (text[end - 1] === '\n' || text[end - 1] === '\r')) end--;
    }
    if (end < dataStart || end > bytes.length) continue;
    const filter = /\/DCTDecode/.test(dict) ? 'dct' : /\/FlateDecode/.test(dict) ? (/\/Predictor\s+([2-9]|\d\d)/.test(dict) ? 'other' : 'flate') : /\/Filter/.test(dict) ? 'other' : 'none';
    const colorSpace = /\/DeviceRGB|\/CalRGB/.test(dict) ? 'rgb' : /\/DeviceGray|\/CalGray/.test(dict) ? 'gray' : 'other';
    found.push({ width, height, bitsPerComponent: num(dict, 'BitsPerComponent') ?? 8, colorSpace, filter, data: bytes.subarray(dataStart, end) });
  }
  return found.sort((a, b) => b.width * b.height - a.width * a.height);
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Draws the image on a canvas at its own size. */
async function drawn(image: FoundImage): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('O navegador não deixou desenhar a imagem.');
  if (image.filter === 'dct') {
    const bitmap = await createImageBitmap(new Blob([image.data as BlobPart], { type: 'image/jpeg' }));
    context.drawImage(bitmap, 0, 0);
    return canvas;
  }
  const channels = image.colorSpace === 'rgb' ? 3 : 1;
  const samples = image.filter === 'flate' ? await inflate(image.data) : image.data;
  if (samples.length < image.width * image.height * channels) throw new Error('A imagem do PDF está incompleta.');
  const pixels = context.createImageData(image.width, image.height);
  for (let i = 0, j = 0; i < image.width * image.height; i++, j += channels) {
    pixels.data[i * 4] = samples[j] as number;
    pixels.data[i * 4 + 1] = samples[j + (channels === 3 ? 1 : 0)] as number;
    pixels.data[i * 4 + 2] = samples[j + (channels === 3 ? 2 : 0)] as number;
    pixels.data[i * 4 + 3] = 255;
  }
  context.putImageData(pixels, 0, 0);
  return canvas;
}

/** The largest page image of the file as a JPEG in base64, at most 1600 px on the longer side. Throws with a message for the owner when it cannot be made. */
export async function imageForAi(file: Blob): Promise<string> {
  const image = findImages(new Uint8Array(await file.arrayBuffer()))[0];
  if (!image) throw new Error('Não achei a imagem da fatura dentro do PDF.');
  const plain = image.filter === 'dct' || ((image.filter === 'none' || image.filter === 'flate') && image.bitsPerComponent === 8 && image.colorSpace !== 'other');
  if (!plain) throw new Error('A imagem deste PDF está num formato que o app não sabe reduzir.');
  const full = await drawn(image);
  const scale = Math.min(1, MAX_SIDE / Math.max(image.width, image.height));
  const small = document.createElement('canvas');
  small.width = Math.round(image.width * scale);
  small.height = Math.round(image.height * scale);
  small.getContext('2d')?.drawImage(full, 0, 0, small.width, small.height);
  return small.toDataURL('image/jpeg', QUALITY).split(',')[1] ?? '';
}
