/**
 * Merchant category codes (ISO 18245) that name one of our categories without doubt. Codes that cover very different
 * shops (5311 department stores, 5399 general merchandise, 5999 specialty retail) and fast food, which delivery apps also
 * use (5814), are left out.
 */
const RANGES: Array<[from: number, to: number, category: string]> = [
  [5411, 5411, 'Supermercado'],
  [5422, 5422, 'Supermercado'],
  [5441, 5441, 'Supermercado'],
  [5451, 5451, 'Supermercado'],
  [5462, 5462, 'Supermercado'],
  [5300, 5300, 'Supermercado'],
  [5812, 5813, 'Restaurantes e bares'],
  [5912, 5912, 'Farmácia'],
  [5541, 5542, 'Combustível e carro'],
  [5532, 5533, 'Combustível e carro'],
  [7512, 7519, 'Viagens'],
  [7523, 7549, 'Combustível e carro'],
  [4121, 4121, 'Transporte por aplicativo'],
  [4812, 4814, 'Telecomunicação'],
  [4899, 4899, 'Assinaturas e streaming'],
  [5815, 5818, 'Assinaturas e streaming'],
  [7829, 7832, 'Lazer e esportes'],
  [7841, 7841, 'Assinaturas e streaming'],
  [7911, 7999, 'Lazer e esportes'],
  [8011, 8099, 'Saúde'],
  [8211, 8299, 'Educação'],
  [4511, 4511, 'Viagens'],
  [4722, 4722, 'Viagens'],
  [7011, 7011, 'Viagens'],
  [3000, 3299, 'Viagens'],
  [3500, 3999, 'Viagens'],
  [5651, 5699, 'Vestuário e acessórios'],
  [5611, 5641, 'Vestuário e acessórios'],
  [5995, 5995, 'Pets'],
  [742, 742, 'Pets'],
  [5977, 5977, 'Cuidados pessoais'],
  [7230, 7299, 'Cuidados pessoais'],
  [6300, 6399, 'Seguros'],
  [9311, 9399, 'Impostos e taxas'],
  [4900, 4900, 'Moradia'],
  [5200, 5251, 'Casa e utilidades'],
  [5712, 5722, 'Casa e utilidades'],
];

export function categoryForMcc(mcc: string | null): string | null {
  if (mcc === null || !/^\d{3,4}$/.test(mcc)) return null;
  const code = Number(mcc);
  for (const [from, to, category] of RANGES) if (code >= from && code <= to) return category;
  return null;
}
