import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildFixtures, realFixtures, type FixtureVariant } from './fixtures.ts';

/**
 * Photographs the app at several screen sizes with the Chrome installed on the machine, using invented data.
 * No server and no login are needed.
 * Usage: npm run shots [-- <route> ...] [--size desktop,laptop,tablet,phone] [--scenario <name>] [--db <file>]
 * Scenarios: `default` (values hidden, as a new device opens), `visible` (values shown), `light` (light palette),
 * `empty` (nothing connected yet), `dense` (more cards, long names, large values).
 * Photos go to shots/<scenario>/ (not committed). Tall pages are photographed with a tall window.
 * `--db` photographs the real data of a database copy instead (values shown unless a scenario is given), into shots/real/
 * or shots/real-<scenario>/. Those photos hold real data: keep them out of the repository and of anything shared.
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
const SCENARIOS: Record<string, { fixtures: FixtureVariant; storage: Record<string, string> }> = {
  default: { fixtures: 'default', storage: {} },
  visible: { fixtures: 'default', storage: { 'gmf.hidden': '0' } },
  light: { fixtures: 'default', storage: { 'gmf.hidden': '0', 'gmf-palette': 'claro' } },
  empty: { fixtures: 'empty', storage: { 'gmf.hidden': '0' } },
  dense: { fixtures: 'dense', storage: { 'gmf.hidden': '0' } },
};
const ROUTES: Array<[string, string, number]> = [
  ['painel', '', 1500],
  ['painel-personalizar', '?customize=1', 1500],
  ['painel-calendario-dia', `?__click=${encodeURIComponent('.mini-day[aria-label^="15/"]')}`, 3200],
  ['transacoes', 'transactions', 1300],
  ['gastos', 'spending', 1500],
  ['gastos-tendencia', 'spending?by=trend', 1300],
  ['cartoes', 'cards', 1500],
  ['cartoes-conferir', 'cards?tab=check', 1300],
  ['cartoes-futuras', 'cards?tab=forecast', 1500],
  ['orcamento', 'budgets', 1300],
  ['patrimonio', 'accounts?view=networth', 1200],
  ['metas', 'goals', 1200],
  ['analista', 'chat?c=1', 1100],
  ['calendario', 'calendar', 1500],
  ['contas', 'accounts', 1200],
  ['fluxo', 'accounts?view=cashflow', 1500],
  ['transacoes-selecao', `transactions?__clickText=${encodeURIComponent('Selecionar')}`, 1300],
  ['ajustes-contas', 'settings', 1100],
  ['ajustes-categorias', 'settings?tab=categories', 1600],
  ['ajustes-regras', 'settings?tab=rules', 1100],
  ['ajustes-ia', 'settings?tab=ai', 1500],
  ['ajustes-dados', 'settings?tab=data', 2200],
  ['ajustes-aparencia', 'settings?tab=appearance', 1300],
  ['ajustes-seguranca', 'settings?tab=security', 1100],
  ['detalhe', 'transactions?tx=detail', 1300],
  ['seletor-categoria', `transactions?tx=detail&__click=${encodeURIComponent('.select-btn[aria-label="Categoria"]')}`, 1300],
  ['seletor-grupo', `settings?tab=categories&__click=${encodeURIComponent('.select-btn[aria-label^="Grupo de"]')}`, 1200],
];

const args = process.argv.slice(2);
const flag = (name: string) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined);
const sizes = flag('--size') ? flag('--size')!.split(',') : Object.keys(SIZES);
const dbFile = flag('--db');
const scenarioName = flag('--scenario') ?? (dbFile ? 'visible' : 'default');
const scenario = SCENARIOS[scenarioName];
if (!scenario) throw new Error(`unknown scenario ${scenarioName}; use ${Object.keys(SCENARIOS).join(', ')}`);
if (dbFile && scenario.fixtures !== 'default') throw new Error('--db shows the data of the file, so only the default, visible and light scenarios apply');
if (dbFile && !existsSync(dbFile)) throw new Error(`database not found: ${dbFile}`);
const flagValues = new Set(['--size', '--scenario', '--db'].map((f) => args.indexOf(f) + 1).filter((i) => i > 0));
const wanted = args.filter((a, i) => !a.startsWith('--') && !flagValues.has(i));

console.log('building the app for photos...');
execFileSync('npx', ['vite', 'build', '--config', 'web/vite.config.ts', '--base', './', '--outDir', '../dist/shots', '--emptyOutDir'], { cwd: root, stdio: 'ignore' });
const fixtures = dbFile ? realFixtures(resolve(dbFile), new Date()) : buildFixtures(new Date(), scenario.fixtures);
// The preferences a device would have saved (values shown, palette), set before the app reads them.
const storage = `<script>localStorage.clear();${Object.entries(scenario.storage).map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)},${JSON.stringify(v)});`).join('')}</script>`;
const html = readFileSync(resolve(site, 'index.html'), 'utf8').replace('<head>', `<head>${storage}<script>window.__FIXTURES__=${JSON.stringify(fixtures).replace(/</g, '\\u003c')};</script><script>${readFileSync(resolve(import.meta.dirname, 'mock.js'), 'utf8')}</script>`);
writeFileSync(resolve(site, 'index.html'), html);
if (fixtures.pastCycle) ROUTES.push(['cartoes-ciclo-passado', `cards?cycle=${fixtures.pastCycle}`, 1500]);
const analyst = ROUTES.find(([name]) => name === 'analista');
if (analyst && fixtures.chatId !== null) analyst[1] = `chat?c=${fixtures.chatId}`;

const dir = resolve(out, dbFile ? (scenarioName === 'visible' ? 'real' : `real-${scenarioName}`) : scenarioName);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
let count = 0;
for (const size of sizes) {
  const [width, baseHeight] = SIZES[size]!;
  for (const [name, route, tall] of ROUTES) {
    if (wanted.length > 0 && !wanted.includes(name)) continue;
    const file = resolve(dir, `${name}-${size}.png`);
    const height = size === 'phone' || size === 'tablet' ? Math.max(baseHeight, tall + 700) : Math.max(baseHeight, tall);
    try {
      execFileSync(chrome, ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files', '--force-device-scale-factor=1', `--window-size=${width},${height}`, '--virtual-time-budget=6000', `--screenshot=${file}`, `file://${site}/index.html#/${route}`], { stdio: 'ignore', timeout: 60_000 });
      count++;
    } catch {
      console.warn(`failed: ${name} ${size}`);
    }
  }
}
console.log(`${count} photos in ${dir}`);
// The built page carries the data inline; with real data it should not outlive the photos.
if (dbFile) rmSync(site, { recursive: true, force: true });
