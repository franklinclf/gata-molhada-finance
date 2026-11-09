import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupLines } from '../../src/pdf/reader.ts';
import type { PdfDocument, PdfTextItem } from '../../src/pdf/reader.ts';
import { parseStatement, StatementError } from '../../src/pdf/statement.ts';

// Text that is long on purpose. The reader cuts a run at 2000 characters, but a document can also be built by hand, so the parser must not depend on that.

const W = 595;
const it = (x: number, y: number, text: string, size = 8): PdfTextItem => ({ x, y, size, text, width: text.length * size * 0.5 });

function docOf(items: PdfTextItem[]): PdfDocument {
  return { pages: [{ width: W, height: 842, lines: groupLines(items) }], images: [], producer: null, textChars: 1000 };
}

/** Runs the parser and returns how long it took. A StatementError is an acceptable answer, any other error is not. */
function timeParse(doc: PdfDocument): number {
  const start = process.hrtime.bigint();
  try {
    parseStatement(doc);
  } catch (e) {
    assert.ok(e instanceof StatementError, String(e));
  }
  return Number(process.hrtime.bigint() - start) / 1e6;
}

const SPACES = ' '.repeat(80_000);

test('a Bradescard product line with a long run of spaces is read in linear time', () => {
  const ms = timeParse(
    docOf([
      it(40, 800, 'Fatura mensal', 19),
      it(40, 770, `CARTAO${SPACES}x`, 9),
      it(40, 740, 'Total da fatura', 12),
      it(40, 710, 'R$ 10,00 17/03/2026', 12),
    ]),
  );
  assert.ok(ms < 500, `took ${ms} ms`);
});

test('a Bradescard row whose description is a long run of spaces is read in linear time', () => {
  const ms = timeParse(
    docOf([
      it(40, 800, 'Fatura mensal', 19),
      it(40, 740, 'Total da fatura', 12),
      it(40, 710, 'R$ 10,00 17/03/2026', 12),
      it(40, 600, 'Data Histórico Valor R$', 8),
      it(10, 580, '05/03'),
      it(50, 580, `A${SPACES}B`),
      it(220, 580, '10,00'),
    ]),
  );
  assert.ok(ms < 500, `took ${ms} ms`);
});

test('a Bradesco row whose description is a long run of spaces is read in linear time', () => {
  const ms = timeParse(
    docOf([
      it(40, 800, 'Fatura Mensal', 19),
      it(420, 740, 'Total da fatura', 12),
      it(420, 710, 'R$ 10,00 17/03/2026', 12),
      it(40, 650, 'Número do Cartão 1111 XXXX XXXX 2222', 8),
      it(40, 620, 'Histórico de Lançamentos', 8),
      it(10, 580, '05/03'),
      it(50, 580, `A${SPACES}B 01/02`),
      it(220, 580, '10,00'),
    ]),
  );
  assert.ok(ms < 500, `took ${ms} ms`);
});

test('a subtotal line with a very long chain of thousands is read in linear time', () => {
  const chain = `1${'.000'.repeat(30_000)},0x`;
  const ms = timeParse(
    docOf([
      it(40, 800, 'Fatura Mensal', 19),
      it(420, 740, 'Total da fatura', 12),
      it(420, 710, 'R$ 10,00 17/03/2026', 12),
      it(40, 650, 'Número do Cartão 1111 XXXX XXXX 2222', 8),
      it(40, 620, 'Histórico de Lançamentos', 8),
      it(40, 580, `Total para ${chain}`),
    ]),
  );
  assert.ok(ms < 500, `took ${ms} ms`);
});

test('many "Disponível em" labels do not make the closing date search quadratic', () => {
  const items: PdfTextItem[] = [it(40, 800, 'Fatura mensal', 19), it(40, 740, 'Total da fatura', 12), it(40, 710, 'R$ 10,00 17/03/2026', 12)];
  for (let i = 0; i < 20_000; i++) items.push(it(300, 500 - i * 0.01, 'Disponível em', 6), it(10 + (i % 50), 100 + i * 0.01, 'x', 6));
  const ms = timeParse(docOf(items));
  assert.ok(ms < 3000, `took ${ms} ms`);
});
