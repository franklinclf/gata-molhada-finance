/** An invented month-end summary of the kind the analyst would be given, plus questions whose answers follow from it. */
export const SUMMARY = {
  today: '2026-10-28',
  currency: 'BRL, values in reais',
  balances: [
    { institution: 'Banco Alfa', account: 'conta corrente', balance: 4210.35 },
    { institution: 'Banco Beta', account: 'conta corrente', balance: 1890.0 },
    { institution: 'Banco Beta', account: 'poupança', balance: 2500.0 },
  ],
  cardBills: [
    { card: 'Alfa Gold final 1111', due: '2026-09-15', total: 2300.0, status: 'paga' },
    { card: 'Alfa Gold final 1111', due: '2026-10-15', total: 1980.5, status: 'paga' },
    { card: 'Alfa Gold final 1111', due: '2026-11-15', total: 1420.0, status: 'em aberto (ciclo atual, fecha em 08/11)' },
    { card: 'Beta Platinum final 2222', due: '2026-10-15', total: 890.0, status: 'fechada, não paga, vence em 15/10 (vencida)' },
    { card: 'Beta Platinum final 2222', due: '2026-11-15', total: 610.0, status: 'em aberto (ciclo atual, fecha em 08/11)' },
  ],
  spendingByCategory: {
    '2026-09': { Supermercado: 1850.4, 'Restaurantes e bares': 640.0, 'Delivery de comida': 520.3, 'Transporte por aplicativo': 310.0, 'Assinaturas e streaming': 189.7, Saúde: 420.0 },
    '2026-10': { Supermercado: 2105.9, 'Restaurantes e bares': 720.5, 'Delivery de comida': 390.0, 'Transporte por aplicativo': 455.6, 'Assinaturas e streaming': 189.7, Saúde: 90.0 },
  },
  subscriptions: [
    { name: 'Streaming de vídeo', monthly: 55.9, since: '2025-03' },
    { name: 'Streaming de música', monthly: 23.9, since: '2024-11' },
    { name: 'Nuvem', monthly: 9.9, since: '2025-08' },
    { name: 'Assistente de IA', monthly: 100.0, since: '2026-02' },
  ],
  installments: [
    { purchase: 'Celular', cardLast4: '1111', perInstallment: 450.0, remaining: [{ bill: '2026-11', n: 7 }, { bill: '2026-12', n: 8 }, { bill: '2027-01', n: 9 }, { bill: '2027-02', n: 10 }] },
    { purchase: 'Sofá', cardLast4: '2222', perInstallment: 280.0, remaining: [{ bill: '2026-11', n: 3 }, { bill: '2026-12', n: 4 }] },
  ],
  dataAvailableFrom: '2026-01-01',
};

export interface Question {
  ask: string;
  /** Numbers (reais) that a correct answer states. */
  numbers?: number[];
  /** A correct answer says the data does not have this, instead of inventing it. */
  unknown?: boolean;
  /** Words that must appear (lower case, accents removed). */
  words?: string[];
}

const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
const sep = sum(SUMMARY.spendingByCategory['2026-09']);
const oct = sum(SUMMARY.spendingByCategory['2026-10']);

export const QUESTIONS: Question[] = [
  { ask: 'Quanto gastei em Supermercado em setembro?', numbers: [1850.4] },
  { ask: 'Qual categoria mais pesou em outubro e quanto foi?', numbers: [2105.9], words: ['supermercado'] },
  { ask: 'Qual é o meu saldo total somando todas as contas?', numbers: [4210.35 + 1890 + 2500] },
  { ask: 'Gastei mais em setembro ou em outubro, considerando só as categorias informadas? De quanto foi a diferença?', numbers: [Math.abs(oct - sep)], words: ['outubro'] },
  { ask: 'Quanto de parcelas vai pesar na fatura de dezembro de 2026, somando todos os cartões?', numbers: [450 + 280] },
  { ask: 'Tenho alguma fatura fechada sem pagar? De qual cartão e de quanto?', numbers: [890], words: ['beta'] },
  { ask: 'Se eu cancelar todas as assinaturas, quanto economizo por ano?', numbers: [(55.9 + 23.9 + 9.9 + 100) * 12] },
  { ask: 'Quanto gastei com viagens em 2025?', unknown: true },
  { ask: 'Qual é o saldo da minha conta no Banco Gama?', unknown: true },
  { ask: 'Se eu pagar agora a fatura vencida da Beta Platinum usando o saldo da conta corrente do Banco Beta, quanto sobra nessa conta?', numbers: [1890 - 890] },
  { ask: 'Se eu pagar a fatura vencida e depois as duas faturas em aberto de novembro, quanto sobra do saldo total de todas as contas?', numbers: [4210.35 + 1890 + 2500 - 890 - 1420 - 610] },
  { ask: 'Quando cai a última parcela do celular e quanto ainda falta pagar dele?', numbers: [1800], words: ['2027'] },
  { ask: 'Que parte (em %) do total das assinaturas é a do assistente de IA?', numbers: [Math.round((100 / 189.7) * 1000) / 10] },
  { ask: 'Qual foi a média mensal de gasto com delivery de comida e restaurantes e bares somados, nos dois meses?', numbers: [(520.3 + 640 + 390 + 720.5) / 2] },
  { ask: 'Quanto gastei com Saúde em agosto?', unknown: true },
  { ask: 'Quais categorias aumentaram de setembro para outubro e em quanto?', numbers: [255.5, 145.6, 105.6, 120.5].slice(0, 0).concat([2105.9 - 1850.4, 720.5 - 640, 455.6 - 310]) },
];

/** Numbers the text states, read in Brazilian ("1.234,56") or plain ("1234.56") notation. */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const match of text.matchAll(/\d[\d.,]*/g)) {
    const raw = match[0].replace(/[.,]+$/, '');
    const br = raw.includes(',') ? Number(raw.replace(/\./g, '').replace(',', '.')) : Number(raw.replace(/\.(?=\d{3}(\D|$))/g, ''));
    const us = Number(raw.replace(/,/g, ''));
    for (const n of [br, us]) if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

const plain = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const NOT_AVAILABLE = /(nao (ha|tenho|consta|existe|encontr|possuo|foram|ha dados)|sem dados|nao (esta|estao) (disponivel|disponiveis|nos dados)|indisponivel|nao foi informad|nao aparece|nao tem|nao posso)/;

export function score(q: Question, answer: string): boolean {
  const text = plain(answer);
  if (q.unknown) return NOT_AVAILABLE.test(text);
  const found = numbersIn(answer);
  const numbersOk = (q.numbers ?? []).every((want) => found.some((n) => Math.abs(n - want) < 0.51));
  const wordsOk = (q.words ?? []).every((w) => text.includes(w));
  return numbersOk && wordsOk;
}
