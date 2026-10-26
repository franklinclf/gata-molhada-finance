export type Cents = number;

export function toCents(value: number | string): Cents {
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof value === 'string' && value.trim() === '') throw new Error('Invalid money value: empty string');
  if (!Number.isFinite(n)) throw new Error(`Invalid money value: ${String(value)}`);
  const cents = Math.round(n * 100);
  return cents === 0 ? 0 : cents;
}

export function sumCents(values: readonly Cents[]): Cents {
  return values.reduce((total, v) => total + v, 0);
}

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export function formatBRL(cents: Cents): string {
  return brl.format(cents / 100);
}
