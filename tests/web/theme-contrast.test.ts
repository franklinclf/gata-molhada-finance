import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PALETTES, contrast, paletteFromColors, type CustomColors, type Palette } from '../../web/src/theme.ts';

// Samples of what an owner could create: light, dark and mid-tone custom palettes.
const custom: CustomColors[] = [
  { bg: '#f3f5f8', card: '#ffffff', text: '#161a20', accent: '#4d7c0f', good: '#15803d', bad: '#c92a2a', warn: '#b45309' },
  { bg: '#faf7f2', card: '#ffffff', text: '#2a2622', accent: '#b45309', good: '#15803d', bad: '#b91c1c', warn: '#a16207' },
  { bg: '#0b0d10', card: '#14181d', text: '#eef1f5', accent: '#c6f432', good: '#4ade80', bad: '#ff6b6b', warn: '#ffb547' },
  { bg: '#1e2a38', card: '#27374a', text: '#d8e2ee', accent: '#ffd166', good: '#4ade80', bad: '#ff6b6b', warn: '#ffb547' },
  { bg: '#e8d9c0', card: '#f4ead8', text: '#3a2f22', accent: '#8a4b12', good: '#2f6f3a', bad: '#a32020', warn: '#8a5a00' },
];
const all: Palette[] = [...PALETTES, ...custom.map((c, i) => paletteFromColors(`custom-${i}`, `Personalizada ${i}`, c))];

test('text and muted reach 4.5:1 on the background and the cards, in every palette', () => {
  for (const p of all) {
    for (const fg of ['--text', '--muted']) {
      for (const bg of ['--bg', '--card', '--card-2']) {
        const ratio = contrast(p.vars[fg]!, p.vars[bg]!);
        assert.ok(ratio >= 4.5, `${p.id}: ${fg} on ${bg} is ${ratio.toFixed(2)}`);
      }
    }
  }
});

test('accent-ink reads on the accent in every palette', () => {
  for (const p of all) {
    const ratio = contrast(p.vars['--accent-ink']!, p.vars['--accent']!);
    assert.ok(ratio >= 4.5, `${p.id}: accent-ink on accent is ${ratio.toFixed(2)}`);
  }
});

test('every palette defines eight chart colors, starting with the accent', () => {
  for (const p of all) {
    for (let i = 1; i <= 8; i++) assert.match(p.vars[`--chart-${i}`] ?? '', /^#[0-9a-f]{6}$/i, `${p.id}: --chart-${i}`);
    assert.equal(p.vars['--chart-1'], p.vars['--accent']);
  }
});

test('chart colors are visible on the card of light palettes', () => {
  for (const p of all.filter((x) => x.scheme === 'light')) {
    for (let i = 2; i <= 8; i++) {
      const ratio = contrast(p.vars[`--chart-${i}`]!, p.vars['--card']!);
      assert.ok(ratio >= 3, `${p.id}: --chart-${i} on card is ${ratio.toFixed(2)}`);
    }
  }
});
