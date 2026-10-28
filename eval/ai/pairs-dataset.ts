import type { Pair } from '../../src/ai/pair-prompt.ts';

export interface LabeledPair extends Pair {
  /** What a careful person would say: are these two records the same real transaction? */
  same: boolean;
  hard?: boolean;
}

const r = (source: string, text: string, date: string, status: 'pending' | 'posted' = 'posted', category: string | null = null) => ({ source, text, date, status, category });
const P = (a: ReturnType<typeof r>, b: ReturnType<typeof r>, daysApart: number, same: boolean, extra: Partial<LabeledPair> = {}): LabeledPair => ({ a, b, daysApart, accountKind: 'card', direction: 'out', sameCounterpartyDocument: 'unknown', same, ...extra });

/** Invented pairs of the kind the matching leaves open. Half are the same transaction, half are not. */
export const PAIRS: LabeledPair[] = [
  P(r('pierre', 'IFD*PIZZARIA DO ZE', '2026-10-10', 'pending'), r('pluggy', 'Ifood *Pizzaria do Ze', '2026-10-12', 'posted', 'Food delivery'), 2, true),
  P(r('pierre', 'UBER *TRIP HELP.U SA', '2026-10-03'), r('pluggy', 'Uber Trip', '2026-10-05', 'posted', 'Taxi and ride-hailing'), 2, true),
  P(r('pierre', 'AMAZON BR SA', '2026-09-20', 'pending'), r('pluggy', 'Amazon Marketplace', '2026-09-23', 'posted', 'Shopping'), 3, true),
  P(r('pierre', 'EBN*SPOTIFY CU', '2026-10-01'), r('pluggy', 'Spotify', '2026-10-03', 'posted', 'Music streaming'), 2, true),
  P(r('pierre', 'DROGASIL 1203', '2026-10-08', 'pending'), r('pluggy', 'RAIA DROGASIL SA', '2026-10-11', 'posted', 'Pharmacy'), 3, true),
  P(r('pierre', 'POSTO SHELL AV BRASIL', '2026-10-14'), r('pluggy', 'Shell Posto', '2026-10-16', 'posted', 'Gas stations'), 2, true),
  P(r('pierre', 'MERCADOLIVRE*CASA DOS CABOS', '2026-09-02', 'pending'), r('pluggy', 'Mercado Livre', '2026-09-06', 'posted', 'Online shopping'), 4, true),
  P(r('pierre', 'CARREFOUR HIPER', '2026-10-17'), r('pluggy', 'Carrefour', '2026-10-18', 'posted', 'Supermarkets'), 1, true),
  P(r('pierre', 'NETFLIX.COM', '2026-10-05'), r('pluggy', 'Netflix', '2026-10-07', 'posted', 'Video streaming'), 2, true),
  P(r('pierre', 'LATAM AIRLINES', '2026-08-12', 'pending'), r('pluggy', 'Latam Airlines Brasil', '2026-08-16', 'posted', 'Airlines'), 4, true),
  P(r('pierre', 'PAGAMENTO RECEBIDO - OBRIGADO', '2026-09-14'), r('pluggy', 'Pagamento recebido', '2026-09-15', 'pending', 'Credit card payment'), 1, true, { direction: 'in' }),
  P(r('pierre', 'PAGAMENTO FATURA CARTAO', '2026-10-15'), r('pluggy', 'Credit card payment', '2026-10-15', 'posted', 'Credit card payment'), 0, true, { direction: 'in' }),
  P(r('pierre', 'Pix enviado', '2026-10-09', 'posted', 'Transferências'), r('pluggy', 'Transferência enviada pelo Pix|Maria Souza', '2026-10-10', 'posted', 'Transfers'), 1, true, { accountKind: 'bank', hard: true }),
  P(r('pierre', 'Transferência Recebida|Carlos Lima', '2026-10-02'), r('pluggy', 'pix receive', '2026-10-04', 'posted', 'Transfers'), 2, true, { accountKind: 'bank', direction: 'in', hard: true }),
  P(r('pierre', 'TED RECEBIDA ACME LTDA', '2026-09-28'), r('pluggy', 'Transferência recebida|ACME LTDA', '2026-09-29', 'posted', 'Transfers'), 1, true, { accountKind: 'bank', direction: 'in' }),
  P(r('pierre', 'Pix enviado', '2026-10-11', 'posted', 'Transferências'), r('pluggy', 'Transferência enviada pelo Pix', '2026-10-12', 'posted', 'Transfers'), 1, true, { accountKind: 'bank', sameCounterpartyDocument: 'yes', hard: true }),
  P(r('pierre', 'Pix enviado', '2026-10-13', 'posted', 'Transferências'), r('pluggy', 'Transferência enviada pelo Pix|João Pereira', '2026-10-14', 'posted', 'Transfers'), 1, false, { accountKind: 'bank', sameCounterpartyDocument: 'no', hard: true }),
  P(r('pierre', 'Aplicação RDB', '2026-10-06'), r('pluggy', 'Automatic investment', '2026-10-07', 'posted', 'Automatic investment'), 1, true, { accountKind: 'bank', hard: true }),
  P(r('pierre', 'Corridas', '2026-10-17', 'posted', 'Táxi'), r('pluggy', '99 *99app', '2026-10-18', 'posted', 'Taxi and ride-hailing'), 1, true, { accountKind: 'bank', hard: true }),
  P(r('pierre', 'DL*UberRides', '2026-10-04', 'pending'), r('pluggy', 'UBER * PENDING', '2026-10-07', 'pending', 'Taxi and ride-hailing'), 3, true, { hard: true }),
  P(r('pierre', 'SHOPEE *MillsUtensilio', '2026-09-12', 'pending'), r('pluggy', 'Shopee', '2026-09-16', 'posted', 'Shopping'), 4, true, { hard: true }),
  P(r('pierre', 'BAR DO ALEMAO', '2026-10-11'), r('pluggy', 'Bar do Alemão Ltda', '2026-10-12', 'posted', 'Restaurants'), 1, true),
  P(r('pierre', 'GOOGLE *YouTube Premium', '2026-10-09'), r('pluggy', 'Google YouTube', '2026-10-10', 'posted', 'Video streaming'), 1, true),
  P(r('pierre', 'FARMACIAS PA*paguemeno', '2026-10-13', 'pending'), r('pluggy', 'Pague Menos', '2026-10-15', 'posted', 'Pharmacy'), 2, true),
  P(r('pierre', 'IFD*BURGER HOUSE', '2026-10-19'), r('pluggy', 'Rappi *Burger House', '2026-10-21', 'posted', 'Food delivery'), 2, true, { hard: true }),
  P(r('pierre', 'TIM*00000000000 RI', '2026-10-14'), r('pluggy', 'TIM S.A.', '2026-10-16', 'posted', 'Telecommunications'), 2, true),

  P(r('pierre', 'IFD*PIZZARIA DO ZE', '2026-10-10'), r('pluggy', 'Uber Trip', '2026-10-12', 'posted', 'Taxi and ride-hailing'), 2, false),
  P(r('pierre', 'AMAZON BR SA', '2026-09-20'), r('pluggy', 'Netflix', '2026-09-23', 'posted', 'Video streaming'), 3, false),
  P(r('pierre', 'DROGASIL 1203', '2026-10-08'), r('pluggy', 'Cinemark', '2026-10-11', 'posted', 'Movies'), 3, false),
  P(r('pierre', 'POSTO SHELL AV BRASIL', '2026-10-14'), r('pluggy', 'Carrefour Hiper', '2026-10-16', 'posted', 'Supermarkets'), 2, false),
  P(r('pierre', 'SPOTIFY AB', '2026-09-03'), r('pluggy', 'Spotify', '2026-10-03', 'posted', 'Music streaming'), 30, false, { hard: true }),
  P(r('pierre', 'NETFLIX.COM', '2026-08-05'), r('pluggy', 'Netflix', '2026-09-04', 'posted', 'Video streaming'), 30, false, { hard: true }),
  P(r('pierre', 'LATAM AIRLINES', '2026-08-12'), r('pluggy', 'Booking.com Hotel', '2026-08-14', 'posted', 'Travel'), 2, false),
  P(r('pierre', 'MERCADOLIVRE*LOJA A', '2026-09-02'), r('pluggy', 'Amazon Prime', '2026-09-05', 'posted', 'Streaming'), 3, false),
  P(r('pierre', 'Transferência enviada|Maria Souza', '2026-10-09'), r('pluggy', 'Aluguel apt 302', '2026-10-10', 'posted', 'Rent'), 1, false, { accountKind: 'bank', hard: true }),
  P(r('pierre', 'Transferência Recebida|Carlos Lima', '2026-10-02'), r('pluggy', 'Salário empresa xyz', '2026-10-04', 'posted', 'Income'), 2, false, { accountKind: 'bank', direction: 'in' }),
  P(r('pierre', 'Aplicação RDB', '2026-10-06'), r('pluggy', 'Pix enviado João Pereira', '2026-10-07', 'posted', 'Transfers'), 1, false, { accountKind: 'bank' }),
  P(r('pierre', 'Resgate CDB', '2026-10-06'), r('pluggy', 'Transferência recebida|Ana Paula', '2026-10-08', 'posted', 'Transfers'), 2, false, { accountKind: 'bank', direction: 'in', hard: true }),
  P(r('pierre', 'PAGAMENTO RECEBIDO - OBRIGADO', '2026-09-14'), r('pluggy', 'Estorno compra Amazon', '2026-09-16', 'posted', 'Refund'), 2, false, { direction: 'in', hard: true }),
  P(r('pierre', 'ESTORNO AUTOMATICO MULTA', '2026-10-17'), r('pluggy', 'Pagamento recebido', '2026-10-18', 'posted', 'Credit card payment'), 1, false, { direction: 'in', hard: true }),
  P(r('pierre', 'SMART FIT ACADEMIA', '2026-10-05'), r('pluggy', 'Starbucks', '2026-10-06', 'posted', 'Restaurants'), 1, false),
  P(r('pierre', 'PETZ LOJA', '2026-10-12'), r('pluggy', 'Cobasi', '2026-10-13', 'posted', 'Pet shops'), 1, false, { hard: true }),
  P(r('pierre', 'RESTAURANTE SABOR CASEIRO', '2026-10-11'), r('pluggy', 'Restaurante Sabor do Mar', '2026-10-12', 'posted', 'Restaurants'), 1, false, { hard: true }),
  P(r('pierre', 'DL*UberRides', '2026-10-04'), r('pluggy', 'Uber Eats', '2026-10-06', 'posted', 'Food delivery'), 2, false, { hard: true }),
  P(r('pierre', 'UDEMY CURSOS ONLINE', '2026-10-03'), r('pluggy', 'Google Play', '2026-10-05', 'posted', 'Apps'), 2, false),
  P(r('pierre', 'DROGARIA SAO PAULO', '2026-10-09'), r('pluggy', 'Drogaria Pacheco', '2026-10-11', 'posted', 'Pharmacy'), 2, false, { hard: true }),
  P(r('pierre', 'RENNER 0345 SHOPPING', '2026-09-27'), r('pluggy', 'Zara', '2026-09-29', 'posted', 'Clothing'), 2, false),
  P(r('pierre', 'IOF COMPRA INTERNACIONAL', '2026-10-01'), r('pluggy', 'Anuidade', '2026-10-03', 'posted', 'Fees'), 2, false, { hard: true }),
  P(r('pierre', 'CLARO RECARGA', '2026-10-02'), r('pluggy', 'Vivo Fixo', '2026-10-04', 'posted', 'Telecommunications'), 2, false, { hard: true }),
  P(r('pierre', 'ESTACIONAMENTO SHOPPING', '2026-10-15'), r('pluggy', 'Sem Parar', '2026-10-17', 'posted', 'Tolls'), 2, false),
];
