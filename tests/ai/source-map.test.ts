import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapSourceCategory } from '../../src/ai/source-map.ts';
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
