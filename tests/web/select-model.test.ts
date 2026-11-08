import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categoryOptions, groupOptions } from '../../web/src/category-options.ts';
import { canCreate, enterChoice, filterOptions, step, toRows, type Option } from '../../web/src/select-model.ts';

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

test('custom categories show their count like the others, and "sua" only while they are unused', () => {
  const options = categoryOptions([
    { name: 'Padaria', parent: null, count: 7, custom: true },
    { name: 'Viagem 2027', parent: null, count: 0, custom: true },
  ]);
  assert.deepEqual(options.map((o) => o.hint), ['7', 'sua']);
});

test('the suggested and most used categories head the list as shortcuts that a search does not repeat', () => {
  const items = [
    { name: 'Transferências', parent: 'Finanças', count: 700, custom: false },
    { name: 'Supermercado', parent: 'Alimentação', count: 40, custom: false },
    { name: 'Delivery', parent: 'Alimentação', count: 10, custom: false },
    { name: 'Moradia', parent: 'Casa', count: 5, custom: false },
    { name: 'Viagem', parent: 'Lazer', count: 0, custom: true },
  ];
  const options = categoryOptions(items, { suggested: ['Viagem'], top: 2 });
  const shortcuts = options.filter((o) => o.shortcut);
  assert.deepEqual(shortcuts.map((o) => o.label), ['Viagem', 'Supermercado', 'Delivery']);
  assert.ok(shortcuts.every((o) => o.group === 'Sugeridas e mais usadas'));
  assert.equal(options[0]!.shortcut, true);
  // Money that only moves does not crowd the "most used" shortcuts, but stays in its own group.
  assert.ok(options.some((o) => o.label === 'Transferências' && o.group === 'Finanças' && !o.shortcut));
  assert.equal(filterOptions(options, '').length, options.length);
  assert.deepEqual(filterOptions(options, 'super').map((o) => o.group), ['Alimentação']);
  assert.equal(categoryOptions(items, { top: 1 }).find((o) => o.shortcut)?.group, 'Mais usadas');
  assert.equal(categoryOptions(items).some((o) => o.shortcut), false);
});

test('Enter picks the highlighted row, creates only from a list that was drawn, and never guesses on stale text', () => {
  // Drawn list: the highlighted row is chosen, and a create row exists only when nothing has that name.
  assert.equal(enterChoice(opts, '', '', 1, true), 'b');
  assert.equal(enterChoice(opts, 'pizz', 'pizz', 0, true), 'c');
  assert.equal(enterChoice(opts, 'xyz', 'xyz', 0, true), 'xyz');
  assert.equal(enterChoice(opts, 'xyz', 'xyz', 0, false), null);
  // The box holds text the list was not redrawn for: the first match of that text, never the first row of the old list, and no creation.
  assert.equal(enterChoice(opts, '', 'edu', 0, true), 'd');
  assert.equal(enterChoice(opts, '', 'xyz', 0, true), null);
});
