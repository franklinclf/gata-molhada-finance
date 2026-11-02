import { merchantName } from './merchant.ts';
import { normalizeName } from './names.ts';

export interface TitleInput {
  description: string;
  /** Cents with the sign of cash flow: negative is money out. */
  amount: number;
  role: 'card_payment' | 'own_transfer' | 'investment' | null;
  /** PIX, TED, DOC or BOLETO when the source says. */
  operation: string | null;
  counterparty: { name: string | null } | null;
}

/** Charges banks write in their own words, shown the same way everywhere. */
const FIXED: Array<[RegExp, string]> = [
  [/custo trans.*exterior|^iof\b|imposto.*operacoes financeiras/, 'IOF'],
  [/anuidade/, 'Anuidade do cartão'],
  [/estorno.*multa/, 'Estorno de multa'],
  [/multa contratual|multa por atraso/, 'Multa por atraso'],
  [/juros e encargos|encargos financeiros|juros de mora/, 'Juros e encargos'],
  [/tarifa|tar\.? /, 'Tarifa bancária'],
  [/saldo adicionado/, 'Saldo adicionado na conta'],
];

const OPERATIONS: Record<string, [out: string, in_: string]> = {
  pix: ['Pix enviado', 'Pix recebido'],
  ted: ['TED enviada', 'TED recebida'],
  doc: ['DOC enviado', 'DOC recebido'],
  boleto: ['Pagamento de boleto', 'Recebimento de boleto'],
};

/** The operation behind a bank description when the source did not say it. */
function operationOf(text: string): string | null {
  if (/\bpix\b/.test(text)) return 'pix';
  if (/\bted\b/.test(text)) return 'ted';
  if (/\bdoc\b/.test(text) && /enviad|recebid|transfer/.test(text)) return 'doc';
  if (/boleto/.test(text) && /pagamento|pagto|pgto/.test(text)) return 'boleto';
  return null;
}

/**
 * One name for each kind of transaction, so a Pix, a card bill payment or an investment reads the same whatever the bank
 * wrote ("PAGTO. POR DEB EM C/C", "Pagamento recebido", "GASTOS CARTAO DE CREDITO - DOCTO: 3990288" are all "Pagamento
 * de fatura"). A shop or a person keeps its cleaned name. The original text is kept next to it and is what rules and
 * searches also match.
 */
export function titleOf(t: TitleInput): string {
  const out = t.amount < 0;
  if (t.role === 'card_payment') return 'Pagamento de fatura';
  if (t.role === 'own_transfer') return out ? 'Transferência para suas contas' : 'Transferência de suas contas';
  if (t.role === 'investment') {
    if (/rendimento|lucro|dividendo|juros/.test(normalizeName(t.description))) return 'Rendimento';
    return out ? 'Aplicação' : 'Resgate';
  }
  const text = normalizeName(t.description);
  for (const [pattern, title] of FIXED) if (pattern.test(text)) return title;
  const operation = (t.operation ? t.operation.toLowerCase() : null) ?? operationOf(text);
  const known = operation ? OPERATIONS[operation] : undefined;
  if (known) {
    // "Pagamento de boleto Receita Federal": what comes after the phrase is who was paid.
    const spoken = t.description.replace(/^(pagamento|pagto|pgto)( de| do| da)? (boleto|titulo)\s*/i, '');
    const who = t.counterparty?.name ? merchantName(t.counterparty.name) : spoken.trim() === '' ? '' : merchantName(spoken);
    const generic = /^(pix|ted|doc|boleto|pagamento|transferencia|enviad|recebid|key|chave)( |$)/.test(normalizeName(who));
    const label = out ? known[0] : known[1];
    return who && !generic && who.length > 1 ? `${label} · ${who}` : label;
  }
  const name = merchantName(t.description);
  return name.length > 0 ? name : t.description;
}
