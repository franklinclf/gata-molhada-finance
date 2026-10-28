/** The categories the categorizer may answer with. The meaning helps small models tell similar ones apart. */
export const TAXONOMY: Array<[name: string, meaning: string]> = [
  ['Supermercado', 'supermarkets, groceries, wholesale clubs, bakeries bought as groceries'],
  ['Restaurantes e bares', 'eating out: restaurants, bars, cafes, snack bars, fast food in person'],
  ['Delivery de comida', 'food delivery apps and orders (iFood, Rappi, delivery marketplaces)'],
  ['Transporte por aplicativo', 'taxi and ride-hailing: Uber, 99, Cabify'],
  ['Combustível e carro', 'fuel, parking, tolls, car services, car insurance, vehicle taxes'],
  ['Saúde', 'doctors, dentists, labs, hospitals, health plans, therapy, gyms count as Lazer'],
  ['Farmácia', 'pharmacies and drugstores'],
  ['Assinaturas e streaming', 'recurring digital subscriptions: video, music, cloud storage, apps, news'],
  ['Telecomunicação', 'mobile and internet providers, prepaid top-ups'],
  ['Compras online', 'online marketplaces and general web shopping (Amazon, Shopee, Mercado Livre)'],
  ['Vestuário e acessórios', 'clothes, shoes, accessories'],
  ['Casa e utilidades', 'home goods, furniture, hardware stores, appliances, electronics for the house'],
  ['Moradia', 'rent, condo fees, electricity, water, gas, property tax'],
  ['Lazer e esportes', 'cinema, shows, games, gyms, sports, hobbies, parks'],
  ['Educação', 'schools, courses, books, tuition, certification exams'],
  ['Viagens', 'flights, hotels, travel agencies, mileage programs, car rental'],
  ['Pets', 'pet shops, vets, pet food'],
  ['Cuidados pessoais', 'barbers, salons, cosmetics, perfume, spa'],
  ['Seguros', 'insurance that is not car or health'],
  ['Impostos e taxas', 'government taxes, fees, bank fees, card annuity, fines, interest, late payment charges'],
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
  const text = [...CATEGORY_NAMES, ...[...extra].sort()].join('|');
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash.toString(16);
}
