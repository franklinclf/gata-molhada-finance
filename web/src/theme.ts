/** Color palettes. A palette sets the variables the whole app is painted with; the owner can also pick their own accent. */
export interface Palette {
  id: string;
  name: string;
  vars: Record<string, string>;
  /** `dark` or `light`, for the browser's own widgets (scrollbars, date pickers). */
  scheme: 'dark' | 'light';
}

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
const mix = (a: string, b: string, t: number): string => {
  const x = rgb(a);
  const y = rgb(b);
  return `#${x.map((v, i) => Math.round(v + (y[i]! - v) * t).toString(16).padStart(2, '0')).join('')}`;
};

/** Hues for the charts, in order. The accent always comes first; hues too close to it are dropped so two slices never look alike. */
const CHART_DARK = { violet: '#8b7cff', teal: '#4dd6c4', blue: '#5aa9ff', pink: '#f78fd0', grey: '#9aa4b2' };
// Darker, more saturated versions so slices stay visible on a white card.
const CHART_LIGHT = { violet: '#6d28d9', teal: '#0f766e', blue: '#1d4ed8', pink: '#be185d', grey: '#64748b' };

const distance = (a: string, b: string) => Math.hypot(...rgb(a).map((v, i) => v - rgb(b)[i]!));

/** The --chart-1..8 variables of a palette, built from its accent, its state colors and its scheme. */
export function chartVars(accent: string, scheme: 'dark' | 'light', warn: string, bad: string, good: string): Record<string, string> {
  const hue = scheme === 'light' ? CHART_LIGHT : CHART_DARK;
  const candidates = [hue.violet, warn, bad, hue.teal, hue.blue, hue.pink, hue.grey, good];
  const rest = candidates.filter((c) => distance(c, accent) > 70);
  const colors = [accent, ...rest, ...candidates.filter((c) => !rest.includes(c))].slice(0, 8);
  return Object.fromEntries(colors.map((c, i) => [`--chart-${i + 1}`, c]));
}

/** Shadows and the dimmed backdrop are softer on light palettes, where heavy black looks dirty. */
const depthVars = (scheme: 'dark' | 'light'): Record<string, string> =>
  scheme === 'light'
    ? { '--shadow-1': '0 12px 32px rgb(0 0 0 / 0.14)', '--shadow-2': '0 24px 70px rgb(0 0 0 / 0.25)', '--overlay': 'rgb(0 0 0 / 0.35)' }
    : { '--shadow-1': '0 12px 32px rgb(0 0 0 / 0.5)', '--shadow-2': '0 24px 70px rgb(0 0 0 / 0.65)', '--overlay': 'rgb(0 0 0 / 0.55)' };

/** Adds the variables that depend on the palette's accent and scheme: chart colors, shadows, backdrop. */
const withCharts = (p: Palette): Palette => ({ ...p, vars: { ...p.vars, ...depthVars(p.scheme), ...chartVars(p.vars['--accent']!, p.scheme, p.vars['--warn']!, p.vars['--bad']!, p.vars['--good']!) } });

const dark = (id: string, name: string, accent: string, extra: Record<string, string> = {}): Palette => ({
  id,
  name,
  scheme: 'dark',
  vars: { '--bg': '#0b0d10', '--card': '#14181d', '--card-2': '#1b2027', '--text': '#eef1f5', '--muted': '#8b95a3', '--accent': accent, '--accent-ink': '#11140a', '--good': '#4ade80', '--bad': '#ff6b6b', '--warn': '#ffb547', '--track': '#232a33', ...extra },
});

export const PALETTES: Palette[] = ([
  dark('lima', 'Lima (padrão)', '#c6f432'),
  dark('oceano', 'Oceano', '#4cc9f0', { '--bg': '#0a0f14', '--card': '#101820', '--card-2': '#172431', '--track': '#1f3140', '--accent-ink': '#06202b' }),
  dark('violeta', 'Violeta', '#b794f6', { '--bg': '#0d0b12', '--card': '#16131f', '--card-2': '#1f1b2b', '--track': '#2c2640', '--accent-ink': '#170d2b' }),
  dark('rosa', 'Rosa', '#ff7eb6', { '--bg': '#100b0e', '--card': '#1a1317', '--card-2': '#241a20', '--track': '#352630', '--accent-ink': '#2b0d1b' }),
  dark('ambar', 'Âmbar', '#ffb547', { '--bg': '#0f0c08', '--card': '#191510', '--card-2': '#231d15', '--track': '#352b1e', '--accent-ink': '#2b1a05' }),
  dark('esmeralda', 'Esmeralda', '#34d399', { '--bg': '#07110d', '--card': '#0e1a15', '--card-2': '#15251e', '--track': '#1d3329', '--accent-ink': '#052e1c' }),
  dark('turquesa', 'Turquesa', '#2dd4bf', { '--bg': '#081112', '--card': '#0f1b1d', '--card-2': '#162729', '--track': '#1f3639', '--accent-ink': '#042f2e' }),
  dark('carmim', 'Carmim', '#f87171', { '--bg': '#110a0b', '--card': '#1c1214', '--card-2': '#271a1d', '--track': '#3a2429', '--accent-ink': '#2a0a0a' }),
  dark('por-do-sol', 'Pôr do sol', '#fb923c', { '--bg': '#120b0a', '--card': '#1d1311', '--card-2': '#291c18', '--track': '#3b2a23', '--accent-ink': '#2d1204' }),
  dark('indigo', 'Índigo', '#818cf8', { '--bg': '#0a0b14', '--card': '#121422', '--card-2': '#1a1d33', '--track': '#272b4a', '--accent-ink': '#12143a' }),
  dark('grafite', 'Grafite', '#e5e7eb', { '--bg': '#101113', '--card': '#18191c', '--card-2': '#212227', '--track': '#2e3036', '--accent-ink': '#111113' }),
  dark('meia-noite', 'Meia-noite', '#60a5fa', { '--bg': '#05070d', '--card': '#0c111c', '--card-2': '#131a2a', '--track': '#1c2640', '--accent-ink': '#06142e' }),
  {
    id: 'papel',
    name: 'Papel',
    scheme: 'light',
    vars: { '--bg': '#faf7f2', '--card': '#ffffff', '--card-2': '#f1ece3', '--text': '#2a2622', '--muted': '#6b6258', '--accent': '#b45309', '--accent-ink': '#ffffff', '--good': '#15803d', '--bad': '#b91c1c', '--warn': '#a16207', '--track': '#e0d8ca' },
  },
  {
    id: 'menta',
    name: 'Menta clara',
    scheme: 'light',
    vars: { '--bg': '#eef6f2', '--card': '#ffffff', '--card-2': '#e3f0ea', '--text': '#12201a', '--muted': '#52695e', '--accent': '#0f766e', '--accent-ink': '#ffffff', '--good': '#15803d', '--bad': '#c92a2a', '--warn': '#b45309', '--track': '#c9dfd5' },
  },
  {
    id: 'claro',
    name: 'Claro',
    scheme: 'light',
    vars: { '--bg': '#f3f5f8', '--card': '#ffffff', '--card-2': '#eceff4', '--text': '#161a20', '--muted': '#5d6878', '--accent': '#4d7c0f', '--accent-ink': '#ffffff', '--good': '#15803d', '--bad': '#c92a2a', '--warn': '#b45309', '--track': '#d5dbe4' },
  },
] as Palette[]).map(withCharts);

/** The seven colors an owner picks; the other shades are worked out from them. */
export interface CustomColors {
  bg: string;
  card: string;
  text: string;
  accent: string;
  good: string;
  bad: string;
  warn: string;
}
export interface CustomPalette {
  id: string;
  name: string;
  colors: CustomColors;
}

const CUSTOM_KEY = 'gmf-custom-palettes';

const luminance = (hex: string) => {
  const [r, g, b] = rgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG contrast ratio between two #rrggbb colors, from 1 to 21. Body text needs at least 4.5. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The full set of variables for a custom palette. */
export function paletteFromColors(id: string, name: string, c: CustomColors): Palette {
  const light = 0.299 * rgb(c.bg)[0] + 0.587 * rgb(c.bg)[1] + 0.114 * rgb(c.bg)[2] > 140;
  const card2 = mix(c.card, c.text, 0.07);
  // Start from a soft grey and move toward the text color until it reads on the background and on card-2.
  let muted = mix(c.text, c.bg, 0.45);
  for (let t = 0.4; t >= 0 && (contrast(muted, c.bg) < 4.5 || contrast(muted, card2) < 4.5); t -= 0.05) muted = mix(c.text, c.bg, t);
  return withCharts({
    id,
    name,
    scheme: light ? 'light' : 'dark',
    vars: { '--bg': c.bg, '--card': c.card, '--card-2': card2, '--track': mix(c.card, c.text, 0.16), '--text': c.text, '--muted': muted, '--accent': c.accent, '--accent-ink': inkFor(c.accent), '--good': c.good, '--bad': c.bad, '--warn': c.warn },
  });
}

export function colorsOf(p: Palette): CustomColors {
  return { bg: p.vars['--bg']!, card: p.vars['--card']!, text: p.vars['--text']!, accent: p.vars['--accent']!, good: p.vars['--good']!, bad: p.vars['--bad']!, warn: p.vars['--warn']! };
}

export function customPalettes(): CustomPalette[] {
  try {
    const value = JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? '[]') as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((p): p is CustomPalette => p && typeof p.id === 'string' && typeof p.name === 'string' && p.colors && Object.values(p.colors as Record<string, unknown>).every((v) => typeof v === 'string' && HEX.test(v)));
  } catch {
    return [];
  }
}

export function saveCustomPalette(p: CustomPalette): void {
  const list = customPalettes().filter((x) => x.id !== p.id);
  localStorage.setItem(CUSTOM_KEY, JSON.stringify([...list, p].slice(-12)));
}

export function deleteCustomPalette(id: string): void {
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(customPalettes().filter((x) => x.id !== id)));
  if (localStorage.getItem(PALETTE_KEY) === id) localStorage.removeItem(PALETTE_KEY);
  applyTheme();
}

/** Every palette the owner can pick: the suggested ones, then their own. */
export function allPalettes(): Palette[] {
  return [...PALETTES, ...customPalettes().map((c) => paletteFromColors(c.id, c.name, c.colors))];
}

const PALETTE_KEY = 'gmf-palette';
const ACCENT_KEY = 'gmf-accent';
const HEX = /^#[0-9a-fA-F]{6}$/;

export function savedPalette(): string {
  const id = localStorage.getItem(PALETTE_KEY);
  return allPalettes().some((p) => p.id === id) ? (id as string) : 'lima';
}

export function savedAccent(): string | null {
  const value = localStorage.getItem(ACCENT_KEY);
  return value && HEX.test(value) ? value : null;
}

/** The text color to put on a color: the soft dark ink or white when either reaches 4.5:1, otherwise pure black. */
export function inkFor(hex: string): string {
  return ['#11140a', '#ffffff'].find((ink) => contrast(ink, hex) >= 4.5) ?? '#000000';
}

/** Paints the app with the saved palette and accent. Called before the first render, and again when the owner changes them. */
export function applyTheme(): void {
  const palette = allPalettes().find((p) => p.id === savedPalette())!;
  const root = document.documentElement;
  for (const [name, value] of Object.entries(palette.vars)) root.style.setProperty(name, value);
  const accent = savedAccent();
  if (accent) {
    root.style.setProperty('--accent', accent);
    root.style.setProperty('--accent-ink', inkFor(accent));
    root.style.setProperty('--chart-1', accent);
  }
  root.style.colorScheme = palette.scheme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', palette.vars['--bg']!);
}

export function choosePalette(id: string): void {
  localStorage.setItem(PALETTE_KEY, id);
  localStorage.removeItem(ACCENT_KEY);
  applyTheme();
}

export function chooseAccent(hex: string | null): void {
  if (hex === null) localStorage.removeItem(ACCENT_KEY);
  else if (HEX.test(hex)) localStorage.setItem(ACCENT_KEY, hex);
  applyTheme();
}
