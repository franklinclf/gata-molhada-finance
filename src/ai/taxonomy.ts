/** The categories the categorizer may answer with. The meaning helps small models tell similar ones apart. */
export const TAXONOMY: Array<[name: string, meaning: string]> = [
  ['Supermercado', 'supermarkets, groceries, wholesale clubs, bakeries bought as groceries'],
  ['Restaurantes e bares', 'eating out: restaurants, bars, cafes, snack bars, fast food in person'],
  ['Delivery de comida', 'food delivery apps and orders (iFood, Rappi, delivery marketplaces)'],
  ['Transporte por aplicativo', 'taxi and ride-hailing: Uber, 99, Cabify'],
  ['Transporte público', 'bus, metro, train, bike sharing, transit cards'],
  ['Combustível e carro', 'fuel, parking, tolls, car services, car insurance, vehicle taxes'],
  ['Saúde', 'doctors, labs, hospitals, health plans, therapy, psychologists, orthodontic treatment paid to a clinic that is not dental'],
  ['Dentista', 'dentists, dental clinics, orthodontics, dental labs, aligners'],
  ['Academia', 'gyms and fitness: Selfit, SmartFit, TotalPass, Gympass or Wellhub, personal trainers, pilates and crossfit boxes'],
  ['Farmácia', 'pharmacies and drugstores'],
  ['Assinaturas e streaming', 'recurring digital subscriptions: video, music, cloud storage, apps, news'],
  ['Telecomunicação', 'mobile and internet providers, prepaid top-ups'],
  ['Compras online', 'online marketplaces and general web shopping (Amazon, Shopee, Mercado Livre)'],
  ['Vestuário e acessórios', 'clothes, shoes, accessories'],
  ['Casa e utilidades', 'furniture, appliances, hardware stores, repairs, construction material, office supplies and stationery'],
  ['Utensílios para casa', 'kitchenware, tableware, cleaning products, decoration, bedding and small household items; department and variety stores (Havan, Lojas Americanas, Tok&Stok, Camicado)'],
  ['Presentes', 'gifts, gift shops, flowers, party items'],
  ['Eletrônicos', 'electronics and gadgets: phones, computers, accessories, consoles bought as goods'],
  ['Crianças e brinquedos', 'toys, baby and kids items'],
  ['Aluguel', 'monthly rent, usually a Pix or boleto to a landlord or a real estate agency'],
  ['Moradia', 'condo fees, electricity, water, gas, property tax, building maintenance'],
  ['Lazer e esportes', 'cinema, shows, games, gyms, sports, hobbies, parks'],
  ['Educação', 'schools, courses, books, tuition, certification exams'],
  ['Viagens', 'flights, hotels, travel agencies, mileage programs, car rental'],
  ['Pets', 'pet shops, vets, pet food'],
  ['Cuidados pessoais', 'barbers, salons, cosmetics, perfume, spa'],
  ['Seguros', 'insurance that is not car or health'],
  ['Impostos e taxas', 'government taxes, fees, bank fees, card annuity, fines, interest, late payment charges'],
  ['Empréstimos e financiamentos', 'loan and financing installments, interest charged on loans, overdraft'],
  ['Jogos e apostas', 'lotteries, online betting, casinos'],
  ['Pensão e obrigações legais', 'alimony and court-ordered payments'],
  ['Transferências', 'money sent to or received from another person or company by Pix, TED or boleto'],
  ['Transferência entre minhas contas', 'moves between accounts of the same owner'],
  ['Pagamento de fatura', 'payment of a credit card bill (on the card side or the bank side)'],
  ['Investimentos', 'investment, redemption, yield, savings bucket moves, brokerage'],
  ['Renda', 'salary, freelance income, reimbursements from employers, rewards and cashback'],
  ['Estorno', 'refunds and reversals of a charge'],
  ['Saque', 'cash withdrawal'],
  ['Doações', 'donations and charity'],
  ['Outros', 'only when nothing above fits'],
];
export const CATEGORY_NAMES = TAXONOMY.map(([name]) => name);

/** Changes whenever the category list changes, so descriptions are asked again with the new list. */
export function taxonomyId(extra: string[] = []): string {
  // The first word changes when the prompt or its context changes, so earlier answers that were not confirmed are asked again.
  const text = ['prompt-v6', ...CATEGORY_NAMES, ...[...extra].sort()].join('|');
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash.toString(16);
}
