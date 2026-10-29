import type { ExplorerRow } from './explorer.ts';

export type CsvStyle = 'br' | 'intl';

/** A text cell that starts with one of these is read as a formula by spreadsheets, so it gets a leading apostrophe. */
const FORMULA = /^[=+\-@\t\r]/;

function cell(value: string, delimiter: string): string {
  const safe = FORMULA.test(value) ? `'${value}` : value;
  return safe.includes(delimiter) || /["\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const money = (cents: number, style: CsvStyle): string => {
  const abs = Math.abs(cents);
  const text = `${cents < 0 ? '-' : ''}${Math.floor(abs / 100)}${style === 'br' ? ',' : '.'}${String(abs % 100).padStart(2, '0')}`;
  return text;
};

const STATE: Record<string, string> = { confirmed: 'confirmada', single_source: 'uma fonte', conflict: 'fontes discordam', stale_pending: 'fora dos totais', billed: 'confirmada pela fatura', ignored: 'ignorada' };

/** Rows as CSV with a byte order mark so Excel reads the accents. Brazilian style uses ";" and a decimal comma. */
export function transactionsCsv(rows: ExplorerRow[], localDay: (iso: string) => string, style: CsvStyle = 'br'): string {
  const d = style === 'br' ? ';' : ',';
  const header = ['Data', 'Instituição', 'Conta', 'Descrição', 'Categoria', 'Valor', 'Status', 'Parcela', 'Situação', 'Pessoa ou empresa'];
  const lines = rows.map((t) =>
    [
      localDay(t.occurredAt),
      cell(t.account.institution, d),
      cell(`${t.account.name}${t.account.last4 ? ` ${t.account.last4}` : ''}`, d),
      cell(t.description, d),
      cell(t.category ?? '', d),
      money(t.amount, style),
      t.status === 'pending' ? 'pendente' : 'lançada',
      t.installment ? `${t.installment.number}/${t.installment.total}` : '',
      STATE[t.state] ?? t.state,
      cell(t.counterparty?.name ?? '', d),
    ].join(d),
  );
  return `\uFEFF${[header.join(d), ...lines].join('\r\n')}\r\n`;
}
