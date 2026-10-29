import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from './api.ts';
import type { ExplorerResult } from './api.ts';
import { brl, dayMonth, localDay } from './format.ts';
import { navigate, patchParams } from './router.ts';

interface Action {
  label: string;
  words: string;
  run: () => void;
}

const fold = (text: string): string => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const PAGES: Array<[string, string, string]> = [
  ['', 'Painel', 'inicio home dashboard'],
  ['transactions', 'Transações', 'lancamentos extrato'],
  ['spending', 'Gastos', 'despesas categorias'],
  ['cards', 'Cartões', 'faturas cartao credito'],
  ['budgets', 'Orçamento', 'limites orcamento'],
  ['networth', 'Patrimônio', 'bens dividas'],
  ['goals', 'Metas', 'objetivos economia'],
  ['calendar', 'Calendário', 'agenda recorrentes contas a pagar'],
  ['chat', 'Analista', 'perguntar ia chat'],
  ['accounts', 'Contas', 'saldo bancos'],
  ['cashflow', 'Fluxo de caixa', 'entradas saidas'],
  ['status', 'Fontes e conferência', 'sincronizacao atualizar'],
  ['settings', 'Ajustes', 'configuracoes categorias regras backup seguranca'],
];

/** Ctrl or Cmd + K: jump to a screen, run a shortcut, or find a transaction by its text. */
export function Palette({ hidden }: { hidden: boolean }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [found, setFound] = useState<ExplorerResult['items']>([]);
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (open) {
      setText('');
      setFound([]);
      setAt(0);
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [open]);
  useEffect(() => {
    const q = text.trim();
    if (!open || q.length < 3) {
      setFound([]);
      return;
    }
    const timer = setTimeout(() => {
      api.explore(new URLSearchParams({ q, limit: '6', sort: 'date_desc' })).then((r) => setFound(r.items)).catch(() => setFound([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [text, open]);

  if (!open) return null;
  const go = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  const actions: Action[] = [
    ...PAGES.map(([id, label, words]): Action => ({ label: `Ir para ${label}`, words: `${label} ${words}`, run: go(() => navigate(id)) })),
    { label: 'Nova transação', words: 'adicionar criar digitar lancamento', run: go(() => navigate('transactions', { new: '1' })) },
    { label: 'Perguntar ao analista', words: 'ia chat pergunta', run: go(() => navigate('chat')) },
    { label: 'Fazer backup', words: 'baixar exportar dados', run: go(() => navigate('settings', { tab: 'data' })) },
    { label: 'Atualizar as fontes agora', words: 'sincronizar pluggy atualizar', run: go(() => navigate('status')) },
  ];
  const q = fold(text.trim());
  const matches = q === '' ? actions.slice(0, 8) : actions.filter((a) => q.split(' ').every((w) => fold(`${a.label} ${a.words}`).includes(w))).slice(0, 8);
  const rows: Array<{ key: string; label: string; hint?: string; run: () => void }> = [
    ...matches.map((a) => ({ key: a.label, label: a.label, run: a.run })),
    ...found.map((t) => ({ key: t.id, label: t.description, hint: `${dayMonth(localDay(t.occurredAt))} · ${hidden ? '••••' : brl(t.amount)}`, run: go(() => patchParams({ tx: t.id })) })),
  ];
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setAt((a) => Math.min(rows.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setAt((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') rows[at]?.run();
  };
  return (
    <div class="overlay center" onClick={() => setOpen(false)}>
      <div class="palette" role="dialog" aria-label="Busca rápida" onClick={(e) => e.stopPropagation()}>
        <input ref={input} class="search" aria-label="Buscar" placeholder="Ir para uma tela, ou buscar uma transação (3 letras ou mais)…" value={text} onInput={(e) => { setText((e.currentTarget as HTMLInputElement).value); setAt(0); }} onKeyDown={onKeyDown} />
        <ul class="rows palette-list">
          {rows.map((r, i) => (
            <li key={r.key}>
              <button class={i === at ? 'row-btn on' : 'row-btn'} onMouseEnter={() => setAt(i)} onClick={r.run}>
                <span class="grow clip">{r.label}</span>
                {r.hint && <span class="muted">{r.hint}</span>}
              </button>
            </li>
          ))}
          {rows.length === 0 && <li class="empty">Nada encontrado.</li>}
        </ul>
        <div class="note">Setas para escolher, Enter para abrir, Esc para fechar.</div>
      </div>
    </div>
  );
}
