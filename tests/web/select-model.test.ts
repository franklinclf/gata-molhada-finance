import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categoryOptions, groupOptions } from '../../web/src/category-options.ts';
import { canCreate, filterOptions, step, toRows, type Option } from '../../web/src/select-model.ts';

const opts: Option[] = [
  { value: 'a', label: 'Aluguel', group: 'Casa' },
  { value: 'b', label: 'Condomínio', group: 'Casa', keywords: 'taxa' },
  { value: 'c', label: 'Pizzaria', group: 'Alimentação' },
  { value: 'd', label: 'Educação' },
];

test('search ignores accents and case, needs every word, and also looks in the group and the keywords', () => {
  assert.deepEqual(filterOptions(opts, 'CONDOMINIO').map((o) => o.value), ['b']);
  assert.deepEqual(filterOptions(opts, 'casa').map((o) => o.value), ['a', 'b'], 'by group name');
  assert.deepEqual(filterOptions(opts, 'taxa').map((o) => o.value), ['b'], 'by keyword');
  assert.deepEqual(filterOptions(opts, 'casa alu').map((o) => o.value), ['a']);
  assert.deepEqual(filterOptions(opts, '   ').length, 4);
  assert.deepEqual(filterOptions(opts, 'zzz'), []);
});

test('rows put a heading before each group, and options with no group come first', () => {
  const rows = toRows(opts);
  assert.deepEqual(rows.map((r) => (r.kind === 'group' ? `# ${r.label}` : r.option.label)), ['Educação', '# Casa', 'Aluguel', 'Condomínio', '# Alimentação', 'Pizzaria']);
});

test('the highlight wraps at both ends', () => {
  assert.equal(step(0, -1, 4), 3);
  assert.equal(step(3, 1, 4), 0);
  assert.equal(step(1, 1, 4), 2);
  assert.equal(step(0, 1, 0), 0);
});

test('a name can be created only when it is new', () => {
  assert.equal(canCreate(opts, 'Viagem'), true);
  assert.equal(canCreate(opts, 'aluguel'), false, 'already there, whatever the case');
  assert.equal(canCreate(opts, '  '), false);
});

test('categories are grouped by use, with the loose ones last, and groups are listed once', () => {
  const items = [
    { name: 'Supermercado', parent: 'Alimentação', count: 40, custom: false },
    { name: 'Delivery', parent: 'Alimentação', count: 10, custom: false },
    { name: 'Moradia', parent: 'Casa', count: 5, custom: false },
    { name: 'Educação', parent: null, count: 100, custom: false },
    { name: 'Viagem 2027', parent: 'Casa', count: 0, custom: true },
  ];
  const options = categoryOptions(items);
  assert.deepEqual(options.map((o) => `${o.group}/${o.label}`), ['Alimentação/Supermercado', 'Alimentação/Delivery', 'Casa/Moradia', 'Casa/Viagem 2027', 'Sem grupo/Educação']);
  assert.deepEqual(options.map((o) => o.hint), ['40', '10', '5', 'sua', '100']);
  assert.deepEqual(groupOptions(items).map((o) => o.value), ['Alimentação', 'Casa']);
});
