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
  [['Serviços digitais', 'Digital services', 'Streaming de vídeo', 'Video streaming', 'Streaming de música', 'Music streaming'], 'Assinaturas e streaming'],
  [['Livraria', 'Bookstore'], 'Educação'],
  [['Bem-estar e fitness', 'Wellness and fitness', 'Ingressos', 'Tickets'], 'Lazer e esportes'],

  // The rest of the Meu Pluggy category tree (docs.pluggy.ai, "Category Tree"), so every label it can send has a home.
  [['Income', 'Retirement', 'Entrepreneurial activities', 'Government aid', 'Non-recurring income'], 'Renda'],
  [['Loans and Financing', 'Loans', 'Interests charged', 'Financing', 'Real estate financing', 'Vehicle Financing', 'Student loan'], 'Empréstimos e financiamentos'],
  [['Mutual funds', 'Variable income', 'Margin', 'Pension'], 'Investimentos'],
  [['Same person transfer - Cash', 'Same person transfer - PIX', 'Same person transfer - TED'], 'Transferência entre minhas contas'],
  [['Transfer - Bank slip (Boleto)', 'Transfer - Cash', 'Transfer - Check', 'Transfer - DOC', 'Transfer - Foreign exchange', 'Transfer - Internal', 'Third-party transfers', 'Third-party transfers - Bank slip', 'Third-party transfers - Debt card', 'Third-party transfers - DOC', 'Third-party transfers - PIX', 'Third-party transfers - TED'], 'Transferências'],
  [['Legal obligations', 'Blocked balances', 'Alimony'], 'Pensão e obrigações legais'],
  [['Internet', 'TV'], 'Telecomunicação'],
  [['Education', 'Online Courses', 'University', 'School', 'Kindergarten'], 'Educação'],
  [['Sports practice', 'Wellness', 'Stadiums and arenas', 'Landmarks and museums', 'Sports goods', 'Gaming'], 'Lazer e esportes'],
  [['Electronics'], 'Eletrônicos'],
  [['Kids and toys'], 'Crianças e brinquedos'],
  [['Office Supplies'], 'Casa e utilidades'],
  [['Travel', 'Airport and airlines', 'Mileage programs', 'Bus tickets', 'Car rental'], 'Viagens'],
  [['Gambling', 'Lottery', 'Online bet'], 'Jogos e apostas'],
  [['Taxes', 'Income taxes', 'Taxes on investments', 'Bank fees', 'Account fees', 'Wire transfer fees and ATM fees'], 'Impostos e taxas'],
  [['Rent', 'Urban land and building tax', 'Utilities', 'Water', 'Electricity', 'Gas'], 'Moradia'],
  [['Optometry', 'Hospital clinics and labs'], 'Saúde'],
  [['Public transportation', 'Bicycle'], 'Transporte público'],
  [['Automotive', 'Gas stations', 'Parking', 'Tolls and in-vehicle payment', 'Vehicle ownership taxes and fees', 'Vehicle maintenance', 'Traffic tickets', 'Vehicle insurance'], 'Combustível e carro'],
  [['Life insurance', 'Home Insurance'], 'Seguros'],
];

/**
 * Labels of the Meu Pluggy tree that name only a broad area. They stay out of the table on purpose and go to the model,
 * which sees what was bought. `npm test` checks that every other label of the tree has a home.
 */
export const GENERIC_SOURCE_LABELS = ['Shopping', 'Services', 'Food and drinks'];

const TABLE = new Map<string, string>();
for (const [labels, category] of ENTRIES) for (const label of labels) TABLE.set(normalizeName(label), category);

/** Our category for a source label, or null when the label is too generic or unknown. */
export function mapSourceCategory(label: string | null): string | null {
  return label ? (TABLE.get(normalizeName(label)) ?? null) : null;
}
