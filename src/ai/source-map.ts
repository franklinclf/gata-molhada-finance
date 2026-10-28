import { normalizeName } from '../core/names.ts';

/**
 * The sources (Pierre in Portuguese, Meu Pluggy in English) use one fixed list of categories. Most of them say the same
 * thing as one of ours, so they are translated by a table instead of asked of a model. The labels that are too generic to
 * mean one thing (Shopping, Services, Food and drinks...) are left out and go to the model.
 */
const ENTRIES: Array<[string[], string]> = [
  [['Transferência mesma titularidade', 'Same person transfer'], 'Transferência entre minhas contas'],
  [['Pagamento de cartão de crédito', 'Credit card payment'], 'Pagamento de fatura'],
  [['Táxi e transporte privado urbano', 'Taxi and ride-hailing'], 'Transporte por aplicativo'],
  [['Supermercado', 'Groceries'], 'Supermercado'],
  [['Delivery de alimentos', 'Food delivery'], 'Delivery de comida'],
  [['Farmácia', 'Pharmacy'], 'Farmácia'],
  [['Estorno', 'Refund'], 'Estorno'],
  [['Saúde', 'Healthcare', 'Dentista', 'Dentist', 'Seguro saúde', 'Health insurance'], 'Saúde'],
  [['Vestuário', 'Clothing'], 'Vestuário e acessórios'],
  [['Restaurantes, bares e lanchonetes', 'Eating out'], 'Restaurantes e bares'],
  [['Compras online', 'Online shopping'], 'Compras online'],
  [['Cuidados pessoais', 'Personal care'], 'Cuidados pessoais'],
  [['Lazer', 'Leisure', 'Academia e centros de lazer', 'Gyms and fitness centers', 'Cinema, Teatro e Concertos', 'Cinema, theater and concerts'], 'Lazer e esportes'],
  [['Telecomunicação', 'Telecommunications', 'Celular', 'Mobile'], 'Telecomunicação'],
  [['Transferências', 'Transfers', 'Transferência - PIX', 'Transfer - PIX', 'Transferência - TED', 'Transfer - TED', 'Transferência - Boleto bancário', 'Transfer - Bank Slip'], 'Transferências'],
  [['Investimentos', 'Investments', 'Automatic investment', 'Renda fixa', 'Fixed income', 'Juros de rendimentos de dividendos', 'Proceeds interests and dividends'], 'Investimentos'],
  [['Pet Shops e veterinários', 'Pet supplies and vet'], 'Pets'],
  [['Aluguel', 'Moradia', 'Housing', 'Contas da casa'], 'Moradia'],
  [['Taxas de cartão de crédito', 'Credit card fees', 'Atraso no pagamento e custos de cheque especial', 'Late payment and overdraft costs', 'Impostos sobre operações financeiras', 'Tax on financial operations'], 'Impostos e taxas'],
  [['Doações', 'Donations'], 'Doações'],
  [['Seguros', 'Insurance'], 'Seguros'],
  [['Utensílios para casa', 'Houseware'], 'Casa e utilidades'],
  [['Hospedagem', 'Accomodation', 'Accommodation'], 'Viagens'],
  [['Salário', 'Salary', 'Cashback'], 'Renda'],
];

const TABLE = new Map<string, string>();
for (const [labels, category] of ENTRIES) for (const label of labels) TABLE.set(normalizeName(label), category);

/** Our category for a source label, or null when the label is too generic or unknown. */
export function mapSourceCategory(label: string | null): string | null {
  return label ? (TABLE.get(normalizeName(label)) ?? null) : null;
}
