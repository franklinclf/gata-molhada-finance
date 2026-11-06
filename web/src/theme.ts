/** Color palettes. A palette sets the variables the whole app is painted with; the owner can also pick their own accent. */
export interface Palette {
  id: string;
  name: string;
  vars: Record<string, string>;
  /** `dark` or `light`, for the browser's own widgets (scrollbars, date pickers). */
  scheme: 'dark' | 'light';
}

const dark = (id: string, name: string, accent: string, extra: Record<string, string> = {}): Palette => ({
  id,
  name,
  scheme: 'dark',
  vars: { '--bg': '#0b0d10', '--card': '#14181d', '--card-2': '#1b2027', '--text': '#eef1f5', '--muted': '#8b95a3', '--accent': accent, '--accent-ink': '#11140a', '--good': '#4ade80', '--bad': '#ff6b6b', '--warn': '#ffb547', '--track': '#232a33', ...extra },
});

export const PALETTES: Palette[] = [
  dark('lima', 'Lima (padrão)', '#c6f432'),
  dark('oceano', 'Oceano', '#4cc9f0', { '--bg': '#0a0f14', '--card': '#101820', '--card-2': '#172431', '--track': '#1f3140', '--accent-ink': '#06202b' }),
  dark('violeta', 'Violeta', '#b794f6', { '--bg': '#0d0b12', '--card': '#16131f', '--card-2': '#1f1b2b', '--track': '#2c2640', '--accent-ink': '#170d2b' }),
  dark('rosa', 'Rosa', '#ff7eb6', { '--bg': '#100b0e', '--card': '#1a1317', '--card-2': '#241a20', '--track': '#352630', '--accent-ink': '#2b0d1b' }),
  dark('ambar', 'Âmbar', '#ffb547', { '--bg': '#0f0c08', '--card': '#191510', '--card-2': '#231d15', '--track': '#352b1e', '--accent-ink': '#2b1a05' }),
  {
    id: 'claro',
    name: 'Claro',
    scheme: 'light',
    vars: { '--bg': '#f3f5f8', '--card': '#ffffff', '--card-2': '#eceff4', '--text': '#161a20', '--muted': '#5d6878', '--accent': '#4d7c0f', '--accent-ink': '#ffffff', '--good': '#15803d', '--bad': '#c92a2a', '--warn': '#b45309', '--track': '#d5dbe4' },
  },
];

const PALETTE_KEY = 'gmf-palette';
const ACCENT_KEY = 'gmf-accent';
const HEX = /^#[0-9a-fA-F]{6}$/;

export function savedPalette(): string {
  const id = localStorage.getItem(PALETTE_KEY);
  return PALETTES.some((p) => p.id === id) ? (id as string) : 'lima';
}

export function savedAccent(): string | null {
  const value = localStorage.getItem(ACCENT_KEY);
  return value && HEX.test(value) ? value : null;
}

/** Black or white, whichever reads better on a color. */
export function inkFor(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.299 * r! + 0.587 * g! + 0.114 * b! > 150 ? '#11140a' : '#ffffff';
}

/** Paints the app with the saved palette and accent. Called before the first render, and again when the owner changes them. */
export function applyTheme(): void {
  const palette = PALETTES.find((p) => p.id === savedPalette())!;
  const root = document.documentElement;
  for (const [name, value] of Object.entries(palette.vars)) root.style.setProperty(name, value);
  const accent = savedAccent();
  if (accent) {
    root.style.setProperty('--accent', accent);
    root.style.setProperty('--accent-ink', inkFor(accent));
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
