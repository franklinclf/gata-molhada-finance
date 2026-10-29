import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildFixtures } from './fixtures.ts';

/**
 * Photographs the app at several screen sizes with the Chrome installed on the machine, using invented data.
 * No server and no login are needed. Usage: npm run shots [-- <route> ...] [--size desktop|laptop|tablet|phone]
 * Photos go to shots/ (not committed). Tall pages are photographed with a tall window.
 */
const root = resolve(import.meta.dirname, '../..');
const out = resolve(root, 'shots');
const site = resolve(root, 'dist/shots');

/** The headless shell that Playwright keeps in its cache works anywhere; Chrome itself needs to open a socket for its profile, which sandboxes forbid. */
function findBrowser(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = resolve(process.env.HOME ?? '', 'Library/Caches/ms-playwright');
  if (existsSync(cache)) {
    for (const dir of readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell')).sort().reverse()) {
      for (const arch of readdirSync(resolve(cache, dir))) {
        const bin = resolve(cache, dir, arch, 'chrome-headless-shell');
        if (existsSync(bin)) return bin;
      }
    }
  }
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}
const chrome = findBrowser();

const SIZES: Record<string, [number, number]> = { desktop: [1440, 1000], laptop: [1024, 768], tablet: [768, 1024], phone: [390, 844] };
const ROUTES: Array<[string, string, number]> = [
  ['painel', '', 1500],
  ['transacoes', 'transactions', 1300],
  ['gastos', 'spending', 1500],
  ['cartoes', 'cards', 1500],
  ['cartoes-futuras', 'cards?tab=forecast', 1500],
  ['cartoes-parcelas', 'cards?tab=installments', 1500],
  ['orcamento', 'budgets', 1300],
  ['contas', 'accounts', 1200],
  ['fluxo', 'cashflow', 1500],
  ['fontes', 'status', 1300],
  ['ajustes-contas', 'settings', 1100],
  ['ajustes-regras', 'settings?tab=rules', 1100],
  ['ajustes-ia', 'settings?tab=ai', 1500],
  ['ajustes-seguranca', 'settings?tab=security', 1100],
  ['detalhe', 'transactions?tx=detail', 1300],
];

const args = process.argv.slice(2);
const sizeFlag = args.indexOf('--size');
const sizes = sizeFlag >= 0 ? [args[sizeFlag + 1]!] : Object.keys(SIZES);
const wanted = args.filter((a, i) => !a.startsWith('--') && i !== sizeFlag + 1);

console.log('building the app for photos...');
execFileSync('npx', ['vite', 'build', '--config', 'web/vite.config.ts', '--base', './', '--outDir', '../dist/shots', '--emptyOutDir'], { cwd: root, stdio: 'ignore' });
const fixtures = buildFixtures();
const html = readFileSync(resolve(site, 'index.html'), 'utf8').replace('<head>', `<head><script>window.__FIXTURES__=${JSON.stringify(fixtures).replace(/</g, '\\u003c')};</script><script>${readFileSync(resolve(import.meta.dirname, 'mock.js'), 'utf8')}</script>`);
writeFileSync(resolve(site, 'index.html'), html);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
let count = 0;
for (const size of sizes) {
  const [width, baseHeight] = SIZES[size]!;
  for (const [name, route, tall] of ROUTES) {
    if (wanted.length > 0 && !wanted.includes(name)) continue;
    const file = resolve(out, `${name}-${size}.png`);
    const height = size === 'phone' || size === 'tablet' ? Math.max(baseHeight, tall + 700) : Math.max(baseHeight, tall);
    try {
      execFileSync(chrome, ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files', '--force-device-scale-factor=1', `--window-size=${width},${height}`, '--virtual-time-budget=6000', `--screenshot=${file}`, `file://${site}/index.html#/${route}`], { stdio: 'ignore', timeout: 60_000 });
      count++;
    } catch {
      console.warn(`failed: ${name} ${size}`);
    }
  }
}
console.log(`${count} photos in ${out}`);
