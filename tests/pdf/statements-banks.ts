/** Builders of synthetic Nubank, Itaú and 99Pay documents, drawn at the positions the real layouts use. Every name, merchant, card and number here is invented. */
import { CHAR, Page } from './statements.ts';

// --- Nubank ----------------------------------------------------------------------------------------------------------

export interface NuRow {
  date: string;
  card?: string;
  desc: string;
  /** With the sign and currency as printed: "R$ 159,82" or "−R$ 1,47". */
  amount: string;
}

export interface NuSpec {
  due: string;
  emission: string;
  previous: string;
  payment: string;
  /** "Total de compras de todos os cartões". */
  purchases: string;
  total: string;
  sections: Array<{ name: string; total: string; rows: NuRow[] }>;
  payments: NuRow[];
}

export function nubank(spec: NuSpec): Page[] {
  const p1 = new Page();
  p1.put(50, 780, 'Olá, Pessoa Ficticia.', 12);
  p1.put(50, 700, `Data de vencimento: ${spec.due}`, 10);
  const p2 = new Page();
  p2.put(300, 800, `FATURA ${spec.due}   EMISSÃO E ENVIO ${spec.emission}`, 8);
  p2.put(50, 760, 'RESUMO DA FATURA ATUAL', 10);
  const line = (y: number, label: string, amount: string, size = 10): void => {
    p2.put(140, y, label, size);
    p2.right(543, y, amount, size);
  };
  line(740, 'Fatura anterior', `R$ ${spec.previous}`);
  line(720, 'Pagamento recebido', `−R$ ${spec.payment}`);
  line(700, 'Total de compras de todos os cartões, 14 JUL a 14 AGO', `R$ ${spec.purchases}`);
  line(670, 'Total a pagar', `R$ ${spec.total}`, 16);
  p2.put(50, 600, 'PRÓXIMAS FATURAS', 10);
  line(580, 'Saldo em aberto da próxima fatura', 'R$ 99,99');
  const p3 = new Page();
  p3.put(50, 780, 'TRANSAÇÕES', 10);
  p3.put(130, 780, 'DE 14 JUL A 14 AGO', 7);
  let y = 750;
  const row = (r: NuRow): void => {
    p3.put(123, y, r.date, 6);
    if (r.card) p3.put(172, y, `•••• ${r.card}`, 8);
    p3.put(r.card ? 214 : 185, y, r.desc, 8);
    p3.right(535, y, r.amount, 8);
    y -= 20;
  };
  for (const s of spec.sections) {
    p3.put(119, y, s.name, 8);
    p3.right(535, y, `R$ ${s.total}`, 8);
    y -= 24;
    s.rows.forEach(row);
    // a note under a row, as the app prints under a refund
    y -= 6;
  }
  p3.put(119, y, 'Pagamentos', 8);
  p3.right(535, y, `-R$ ${spec.payment}`, 8);
  y -= 24;
  spec.payments.forEach(row);
  p3.put(60, 80, 'Em cumprimento à regulação do Banco Central, as operações de crédito serão comunicadas ao SCR.', 7);
  p3.put(400, 40, '3 de 3', 7);
  return [p1, p2, p3];
}

// --- Itaú ------------------------------------------------------------------------------------------------------------

export interface ItRow {
  date: string;
  desc: string;
  /** As printed: "276,90", or "-12,00" for a credit. */
  amount: string;
}

export interface ItSpec {
  due: string;
  emission: string;
  previous: string;
  /** Payment of the previous bill, printed negative in the summary. */
  paid: string;
  financed: string;
  current: string;
  total: string;
  payments: ItRow[];
  purchases: ItRow[];
  /** Charges of the bank itself (dated rows in a section of their own). */
  charges?: ItRow[];
  /** Draw every word as small pieces, the way a few exporters do. */
  spaced?: boolean;
}

export function itau(spec: ItSpec): Page[] {
  const page = new Page();
  const put = (x: number, y: number, text: string, size = 7.1): void => {
    if (!spec.spaced) return page.put(x, y, text, size);
    let at = x;
    for (const word of text.split(' ')) {
      // pieces of 2 or 3 letters; a number keeps its pieces touching
      const numeric = /^[-\d.,/]+$/.test(word);
      for (let i = 0; i < word.length; i += i % 5 === 0 ? 3 : 2) {
        const piece = word.slice(i, i + (i % 5 === 0 ? 3 : 2));
        page.put(at, y, piece, size);
        at += piece.length * size * CHAR + (numeric ? 0 : 0.2 * size);
      }
      at += 0.5 * size;
    }
  };
  const right = (end: number, y: number, text: string, size = 7.1): void => put(end - text.length * size * CHAR * (spec.spaced ? 1.1 : 1), y, text, size);

  put(500, 820, 'Platinum', 9);
  put(60, 800, 'TITULAR FICTICIA', 8);
  put(230, 770, `Vencimento: ${spec.due}`);
  put(230, 760, `Emissão: ${spec.emission}`);
  put(60, 740, 'Cartão 4000.XXXX.XXXX.4321');
  put(360, 800, 'Resumo da fatura em R$', 8);
  const box = (y: number, label: string, amount: string): void => {
    put(360, y, label);
    right(560, y, amount);
  };
  box(780, 'Total da fatura anterior', spec.previous);
  box(768, `Pagamento efetuado em ${spec.payments[0]?.date ?? '15/10'}/2026`, `-${spec.paid}`);
  box(756, 'Saldo financiado', spec.financed);
  box(744, 'Lançamentos atuais', spec.current);
  box(732, '= Total desta fatura', spec.total);
  // payment options and the boleto, at the right and below, which are not statement lines
  put(360, 700, 'Valor total financiado R$262,81');
  box(688, 'Encargos', 'R$ 41,42');
  put(100, 330, 'Banco Itaú S.A. 341-7 34191752804737972585083717483336616320000028090');
  put(100, 320, 'Nosso Número 11223344');

  let y = 660;
  put(133, y, 'Pagamentos efetuados', 8);
  y -= 12;
  put(133, y, 'DATA');
  put(289, y, 'VALOR EM R$');
  y -= 10;
  const row = (r: ItRow): void => {
    put(133, y, r.date);
    put(160, y, r.desc);
    right(331, y, r.amount);
    y -= 9;
    put(160, y, 'categoria CIDADE');
    y -= 10;
  };
  for (const r of spec.payments) {
    put(133, y, r.date.slice(0, 5));
    put(160, y, r.desc);
    right(331, y, `-${r.amount}`);
    y -= 12;
  }
  put(133, y, 'Total dos pagamentos', 8);
  right(331, y, `-${spec.paid}`, 8);
  y -= 24;
  // the table of future installments sits at the right of the purchases
  put(351, y, 'Compras parceladas - próximas faturas');
  put(351, y - 10, '28/11');
  put(390, y - 10, 'LOJA FUTURA 11/12');
  right(560, y - 10, '555,55');
  put(133, y, 'Lançamentos: compras e saques', 8);
  y -= 12;
  put(133, y, 'TITULAR FICTICIA');
  y -= 10;
  put(133, y, 'DATA');
  put(160, y, 'ESTABELECIMENTO');
  put(289, y, 'VALOR EM R$');
  y -= 12;
  spec.purchases.forEach(row);
  if (spec.charges?.length) {
    put(133, y, 'Lançamentos: produtos e serviços', 8);
    y -= 12;
    spec.charges.forEach(row);
  }
  put(133, y, 'Lançamentos no cartão', 8);
  right(331, y, spec.current, 8);
  y -= 12;
  put(133, y, 'Total dos lançamentos atuais', 8);
  y -= 24;
  put(133, y, 'Limites de crédito', 8);
  put(133, y - 12, 'Limite total de crédito');
  right(331, y - 12, '5.285,00');
  put(351, y, 'Encargos cobrados nesta fatura');
  put(351, y - 10, 'Juros do rotativo 14,99 %');
  right(560, y - 10, '0,00');
  return [page];
}

// --- 99Pay -----------------------------------------------------------------------------------------------------------

export interface PayRow {
  id: string;
  type: string;
  amount: string;
  when: string;
  /** Print the type above and below the id line (a Pix), the way the real file does. */
  pix?: 'enviado' | 'recebido';
}

export function pay99(rows: PayRow[], period = 'Período: 01/01/2026 até 09/11/2026', perPage = 30): Page[] {
  const pages: Page[] = [];
  for (let i = 0; i < Math.max(rows.length, 1); i += perPage) {
    const p = new Page();
    if (i === 0) {
      p.put(211, 746, 'EXTRATO', 30);
      p.put(373, 746, period, 9);
      p.put(71, 709, 'Nome: PESSOA FICTICIA', 8);
      p.put(71, 672, 'ID DA CONTA: 100000001', 8);
    }
    p.put(79, 642, 'ID', 8);
    p.put(252, 642, 'TIPO', 8);
    p.put(394, 642, 'VALOR', 8);
    p.put(438, 642, 'HORÁRIO', 8);
    let y = 618;
    for (const r of rows.slice(i, i + perPage)) {
      p.put(79, y, r.id, 7.5);
      if (r.pix) {
        p.put(252, y + 4.4, 'Pagamento com Pix', 7.5);
        p.put(252, y - 4.3, r.pix, 7.5);
      } else p.put(252, y, r.type, 7.5);
      p.right(424.5, y, r.amount, 7.5);
      p.put(438, y, r.when, 7.5);
      y -= 24.5;
    }
    pages.push(p);
  }
  return pages;
}
