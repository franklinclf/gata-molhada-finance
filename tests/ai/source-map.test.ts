import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GENERIC_SOURCE_LABELS, mapSourceCategory } from '../../src/ai/source-map.ts';
import { CATEGORY_NAMES } from '../../src/ai/taxonomy.ts';

test('source labels are translated whatever the language, case or accents', () => {
  assert.equal(mapSourceCategory('Groceries'), 'Supermercado');
  assert.equal(mapSourceCategory('SUPERMERCADO'), 'Supermercado');
  assert.equal(mapSourceCategory('Digital services'), 'Assinaturas e streaming');
  assert.equal(mapSourceCategory('Music streaming'), 'Assinaturas e streaming');
  assert.equal(mapSourceCategory('Bookstore'), 'Educação');
  assert.equal(mapSourceCategory('Tickets'), 'Lazer e esportes');
});

test('generic labels are left to the model, and every target is one of our categories', () => {
  for (const generic of ['Shopping', 'Services', 'Food and drinks', 'Compras', 'Serviços', null]) assert.equal(mapSourceCategory(generic), null, String(generic));
  for (const label of ['Groceries', 'Digital services', 'Bookstore', 'Wellness and fitness', 'Same person transfer', 'Tax on financial operations', 'Salary', 'Hospedagem']) {
    const target = mapSourceCategory(label);
    assert.ok(target && CATEGORY_NAMES.includes(target), `${label} -> ${target}`);
  }
});

// Every name of the Meu Pluggy category tree (docs.pluggy.ai, "Category Tree"), at every level.
const TREE = [
  'Income', 'Salary', 'Retirement', 'Entrepreneurial activities', 'Government aid', 'Non-recurring income',
  'Loans and Financing', 'Late payment and overdraft costs', 'Interests charged', 'Loans', 'Financing', 'Real estate financing', 'Vehicle Financing', 'Student loan',
  'Investments', 'Automatic investment', 'Fixed income', 'Mutual funds', 'Variable income', 'Margin', 'Proceeds interests and dividends', 'Pension',
  'Same person transfer', 'Same person transfer - Cash', 'Same person transfer - PIX', 'Same person transfer - TED',
  'Transfers', 'Transfer - Bank slip (Boleto)', 'Transfer - Cash', 'Transfer - Check', 'Transfer - DOC', 'Transfer - Foreign exchange', 'Transfer - Internal', 'Transfer - PIX', 'Transfer - TED', 'Credit card payment',
  'Third-party transfers', 'Legal obligations', 'Blocked balances', 'Alimony',
  'Services', 'Telecommunications', 'Internet', 'Mobile', 'TV',
  'Education', 'Online Courses', 'University', 'School', 'Kindergarten',
  'Wellness and fitness', 'Gyms and fitness centers', 'Sports practice', 'Wellness',
  'Tickets', 'Stadiums and arenas', 'Landmarks and museums', 'Cinema, theater and concerts',
  'Shopping', 'Online shopping', 'Electronics', 'Pet supplies and vet', 'Clothing', 'Kids and toys', 'Bookstore', 'Sports goods', 'Office Supplies', 'Cashback',
  'Digital services', 'Gaming', 'Video streaming', 'Music streaming',
  'Groceries', 'Food and drinks', 'Eating out', 'Food delivery',
  'Travel', 'Airport and airlines', 'Accommodation', 'Mileage programs', 'Bus tickets',
  'Donations', 'Gambling', 'Lottery', 'Online bet',
  'Taxes', 'Income taxes', 'Taxes on investments', 'Tax on financial operations',
  'Bank fees', 'Account fees', 'Wire transfer fees and ATM fees', 'Credit card fees',
  'Housing', 'Rent', 'Houseware', 'Urban land and building tax', 'Utilities', 'Water', 'Electricity', 'Gas',
  'Healthcare', 'Dentist', 'Pharmacy', 'Optometry', 'Hospital clinics and labs',
  'Transportation', 'Taxi and ride-hailing', 'Public transportation', 'Car rental', 'Bicycle',
  'Automotive', 'Gas stations', 'Parking', 'Tolls and in-vehicle payment', 'Vehicle ownership taxes and fees', 'Vehicle maintenance', 'Traffic tickets',
  'Insurance', 'Life insurance', 'Home Insurance', 'Health insurance', 'Vehicle insurance',
  'Leisure',
];

// Parents with children of different kinds. Their children are mapped one by one, and the parent label is left to the model.
const PARENT_ONLY = ['Transportation'];

test('every label of the Meu Pluggy tree maps to one of our categories, except the few that are too broad', () => {
  const missing = TREE.filter((label) => mapSourceCategory(label) === null && !GENERIC_SOURCE_LABELS.includes(label) && !PARENT_ONLY.includes(label));
  assert.deepEqual(missing, []);
  for (const label of TREE) {
    const category = mapSourceCategory(label);
    if (category !== null) assert.ok(CATEGORY_NAMES.includes(category), `${label} maps to ${category}, which is not a built-in category`);
  }
});

test('the broad labels are not mapped', () => {
  for (const label of GENERIC_SOURCE_LABELS) assert.equal(mapSourceCategory(label), null);
});
