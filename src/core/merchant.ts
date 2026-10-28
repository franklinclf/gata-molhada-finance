import { normalizeName } from './names.ts';

/** Well-known names that banks write many ways. The pattern is tested on the text without spaces or punctuation. */
const KNOWN: Array<[RegExp, string]> = [
  [/uber(?!one)|^dluber/, 'Uber'],
  [/99(ride|pay|taxi|food)|99tecnologia/, '99'],
  [/ifood|^ifd/, 'iFood'],
  [/rappi/, 'Rappi'],
  [/amazon|amzn/, 'Amazon'],
  [/shopee/, 'Shopee'],
  [/mercadolivre/, 'Mercado Livre'],
  [/netflix/, 'Netflix'],
  [/spotify/, 'Spotify'],
  [/nespresso/, 'Nespresso'],
  [/wellhub|gympass/, 'Wellhub'],
];

/** Words banks append that say nothing about the shop. */
const NOISE = new Set(['sa', 'na', 'ltda', 'me', 'epp', 'eireli', 'cia', 'bra', 'br', 'brasil', 'sao', 'paulo', 'pending', 'docto', 's', 'a']);

const PREFIXES = ['transferencia enviada pelo pix', 'transferencia enviada', 'transferencia recebida pelo pix', 'transferencia recebida', 'pix enviado', 'pix recebido', 'compra no debito', 'compra no credito'];

const PARTICLES = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);

function titleCase(text: string): string {
  return text.replace(/\S+/g, (word, at: number) => (at > 0 && PARTICLES.has(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)));
}

/**
 * One name for the shop or person behind a bank description, so "DL*UberRidesSao PauloBRA", "Uber UBER *TRIP HELP.U SA"
 * and "UBER * PENDING" count as Uber. It is plain text rules and a short list of known names, with no model involved.
 */
export function merchantName(description: string): string {
  let text = description.trim();
  // "Transferência enviada|Maria Souza": the part after the bar is who got the money.
  const bar = text.lastIndexOf('|');
  if (bar >= 0) text = text.slice(bar + 1);
  const compact = normalizeName(text).replace(/ /g, '');
  for (const [pattern, name] of KNOWN) if (pattern.test(compact)) return name;

  // "MP*62338350DHONA", "ASA*GestaoBestBarbers": a short processor code before the star is not the shop.
  const star = text.indexOf('*');
  if (star > 0 && star <= 4) {
    const after = text.slice(star + 1).trim();
    if (/[a-z]{3}/i.test(after)) text = after;
  }

  let words = normalizeName(text).split(' ').filter(Boolean);
  for (const prefix of PREFIXES) {
    const parts = prefix.split(' ');
    if (parts.every((p, i) => words[i] === p) && words.length > parts.length) {
      words = words.slice(parts.length);
      break;
    }
  }
  // Store numbers, branch codes and installment counters ("HIPER 1365", "AMERICANAS 226", "5 6") are not part of the name.
  while (words.length > 1 && (/^\d+$/.test(words[words.length - 1]!) || NOISE.has(words[words.length - 1]!))) words.pop();
  words = words.filter((w, i) => i === 0 || w !== words[i - 1]);
  const name = words.join(' ');
  return name === '' ? description.trim() : titleCase(name);
}
