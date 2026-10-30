import type { Store } from '../store/store.ts';

/** The groups the built-in categories sit in. A category not listed here stands alone until the user puts it in a group. */
const DEFAULT_GROUPS: Record<string, string[]> = {
  Alimentação: ['Supermercado', 'Restaurantes e bares', 'Delivery de comida'],
  Transporte: ['Transporte por aplicativo', 'Transporte público', 'Combustível e carro'],
  'Saúde e bem-estar': ['Saúde', 'Farmácia', 'Cuidados pessoais'],
  Casa: ['Moradia', 'Casa e utilidades', 'Telecomunicação'],
  Compras: ['Compras online', 'Vestuário e acessórios', 'Eletrônicos', 'Crianças e brinquedos', 'Pets'],
  Lazer: ['Assinaturas e streaming', 'Lazer e esportes', 'Jogos e apostas', 'Viagens'],
  Finanças: ['Seguros', 'Impostos e taxas', 'Empréstimos e financiamentos', 'Pensão e obrigações legais'],
};

const DEFAULT_PARENT = new Map<string, string>(Object.entries(DEFAULT_GROUPS).flatMap(([group, names]) => names.map((name): [string, string] => [name, group])));

/** category name -> group name. The user's choices replace the defaults, and an empty choice removes the default. */
export function categoryParents(store: Store): Map<string, string> {
  const result = new Map(DEFAULT_PARENT);
  for (const [category, parent] of store.listCategoryParents()) {
    if (parent === '') result.delete(category);
    else result.set(category, parent);
  }
  return result;
}
