import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../api.ts';
import type { ChangeView, ChatConversation, ChatMessageView } from '../api.ts';
import { maskMoney } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { invalidateData } from '../invalidate.ts';
import { patchParams, type Route } from '../router.ts';
import { Loading } from '../ui.tsx';

const EXAMPLES = ['Quanto gastei por categoria em cada um dos últimos 3 meses?', 'Corrija a categoria das compras de mercado que estão sem categoria', 'Quais sugestões do app posso aplicar agora?', 'Quanto vou pagar nas próximas faturas?'];

const TOOL_LABEL: Record<string, string> = {
  summary: 'visão geral', spending: 'gastos', cashflow: 'fluxo de caixa', transactions: 'transações', cards: 'cartões', card_forecast: 'faturas futuras', budgets: 'orçamento', recurring: 'recorrentes', net_worth: 'patrimônio', goals: 'metas', trend: 'tendência', outlook: 'o mês em curso',
  aggregate: 'agrupamento', suggestions: 'sugestões', categories: 'categorias', accounts: 'contas', rules: 'regras', income_items: 'rendas cadastradas',
  set_category: 'mudar categoria', set_ignored: 'ignorar transações', create_rule: 'criar regra', delete_rule: 'apagar regra', link_reversal: 'vincular estorno', unlink_reversal: 'desvincular estorno', resolve_finding: 'possível duplicata', set_budget: 'orçamento', upsert_income: 'renda', delete_income: 'apagar renda',
};

const CHANGE_STATUS: Record<ChangeView['status'], string> = {
  applied: 'Aplicada', undone: 'Desfeita', pending: 'Espera o seu toque', declined: 'Cancelada', expired: 'Expirou sem confirmação', conflict: 'Não foi desfeita: os dados mudaram depois',
};

function Changes({ changes, hidden, busy, onAct }: { changes: ChangeView[]; hidden: boolean; busy: boolean; onAct: (change: ChangeView, action: 'undo' | 'confirm' | 'decline') => void }) {
  if (changes.length === 0) return null;
  return (
    <div class="chat-changes">
      <div class="chat-changes-title">Alterações</div>
      <ul>
        {changes.map((c) => (
          <li key={c.id} class={c.status === 'pending' ? 'pending' : undefined}>
            <span class="chat-change-label">{maskMoney(c.label, hidden)}</span>
            <span class="muted chat-change-status">{CHANGE_STATUS[c.status]}{c.status === 'pending' && c.destructive ? ' (apaga algo)' : ''}{c.status === 'pending' && !c.undoable ? ' (não dá para desfazer)' : ''}</span>
            {c.status === 'applied' && c.undoable && (
              <button class="link" disabled={busy} onClick={() => onAct(c, 'undo')}>
                Desfazer
              </button>
            )}
            {c.status === 'pending' && (
              <span class="chat-change-actions">
                <button class="primary small" disabled={busy} onClick={() => onAct(c, 'confirm')}>
                  Confirmar
                </button>
                <button class="link" disabled={busy} onClick={() => onAct(c, 'decline')}>
                  Cancelar
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Bubble({ m, hidden, busy, onAct }: { m: ChatMessageView; hidden: boolean; busy: boolean; onAct: (change: ChangeView, action: 'undo' | 'confirm' | 'decline') => void }) {
  return (
    <div class={m.role === 'user' ? 'chat-msg user' : 'chat-msg'}>
      <div class="chat-text">{maskMoney(m.content, hidden)}</div>
      {m.role === 'assistant' && <Changes changes={m.changes} hidden={hidden} busy={busy} onAct={onAct} />}
      {m.role === 'assistant' && m.steps && m.steps.length > 0 && (
        <details class="chat-steps">
          <summary>Consultei {m.steps.length} {m.steps.length === 1 ? 'fonte' : 'fontes'}</summary>
          <ul>
            {m.steps.map((s, i) => (
              <li key={i}>
                {TOOL_LABEL[s.tool] ?? s.tool} <span class="muted">{Object.keys(s.args).length > 0 ? maskMoney(JSON.stringify(s.args), hidden) : ''} {s.summary !== 'ok' ? `· ${maskMoney(s.summary, hidden)}` : ''}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function ChatPage({ route, hidden }: { route: Route; hidden: boolean }) {
  const status = useLoad(() => api.chatStatus(), []);
  const conversations = useLoad(() => api.chatConversations(), []);
  const current = route.params.get('c') ? Number(route.params.get('c')) : null;
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [text, setText] = useState(route.params.get('q') ?? '');
  const [busy, setBusy] = useState(false);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (current === null) {
      setMessages([]);
      return;
    }
    api.chatMessages(current).then((r) => setMessages(r.items)).catch(() => setMessages([]));
  }, [current]);
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [messages.length, busy]);

  if (!status.data) return <div class="page-body"><h1 class="page-title">Analista</h1><Loading error={status.error} /></div>;
  if (!status.data.available) {
    return (
      <div class="page-body">
        <h1 class="page-title">Analista</h1>
        <div class="panel empty">O analista precisa da IA ligada no servidor (AI_ENABLED=on e a chave da OpenRouter).</div>
      </div>
    );
  }

  const send = async (question: string) => {
    if (busy || question.trim() === '') return;
    setBusy(true);
    setError(null);
    setText('');
    const asked: ChatMessageView = { id: -1, conversationId: current ?? 0, role: 'user', content: question, steps: null, model: null, costUsd: null, createdAt: new Date().toISOString(), changes: [] };
    setMessages((m) => [...m, asked]);
    try {
      const reply = await api.ask(question, current ?? undefined);
      setMessages((m) => [...m, { id: reply.messageId, conversationId: reply.conversationId, role: 'assistant', content: reply.answer, steps: reply.steps, model: reply.model, costUsd: reply.costUsd, createdAt: new Date().toISOString(), changes: reply.changes }]);
      // The chat call itself does not refresh the other screens, so a change made by the answer does it here.
      if (reply.changes.some((c) => c.status === 'applied')) invalidateData();
      if (current === null) patchParams({ c: String(reply.conversationId) });
      conversations.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível perguntar.');
    } finally {
      setBusy(false);
    }
  };

  const act = async (change: ChangeView, action: 'undo' | 'confirm' | 'decline') => {
    if (acting) return;
    setActing(true);
    setError(null);
    try {
      const done = await api.changeAction(change.id, action);
      setMessages((all) => all.map((m) => (m.changes.some((c) => c.id === change.id) ? { ...m, changes: m.changes.map((c) => (c.id === change.id ? done.change : c)) } : m)));
      if (action !== 'decline') invalidateData();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível concluir.');
      // The change may have moved on (expired, undone elsewhere), so the list is read again.
      if (current !== null) api.chatMessages(current).then((r) => setMessages(r.items)).catch(() => undefined);
    } finally {
      setActing(false);
    }
  };

  return (
    <div class="page-body">
      <h1 class="page-title">Analista</h1>
      <div class="chat">
        <aside class="chat-list">
          <button class="primary small" onClick={() => patchParams({ c: null })}>
            Nova conversa
          </button>
          <ul class="rows">
            {(conversations.data?.items ?? []).map((c: ChatConversation) => (
              <li key={c.id}>
                <button class={c.id === current ? 'link on chat-title' : 'link chat-title'} title={c.title} onClick={() => patchParams({ c: String(c.id) })}>
                  <span class="clip">{c.title}</span>
                </button>
                <button class="link" aria-label="Excluir conversa" onClick={() => window.confirm('Excluir esta conversa?') && void api.deleteChat(c.id).then(() => { if (c.id === current) patchParams({ c: null }); conversations.reload(); })}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        </aside>
        <section class="panel chat-main">
          <div class="chat-scroll">
            {messages.length === 0 && (
              <div class="chat-empty">
                <p class="muted">Pergunte sobre as suas finanças. O analista consulta os seus dados por ferramentas e mostra o que consultou. Se você pedir uma mudança (trocar a categoria de compras, criar uma regra, ajustar um orçamento), ele aplica as pequenas na hora e lista cada uma abaixo da resposta, com o botão Desfazer. Mudanças em mais de 20 transações, apagar algo e o que não dá para desfazer esperam o seu toque em Confirmar, por até 30 minutos. As descrições e os valores das transações que ele consulta vão ao modelo de IA; documentos e números de conta não.</p>
                <div class="links">
                  {EXAMPLES.map((e) => (
                    <button key={e} class="chip" onClick={() => void send(e)}>
                      {e}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <Bubble key={`${m.id}-${i}`} m={m} hidden={hidden} busy={acting} onAct={(c, a) => void act(c, a)} />
            ))}
            {busy && <div class="chat-msg"><div class="chat-text muted">Consultando seus dados…</div></div>}
            <div ref={end} />
          </div>
          {error && <div class="error">{error}</div>}
          <form
            class="chat-form"
            onSubmit={(e) => {
              e.preventDefault();
              void send(text);
            }}
          >
            <input class="search grow" aria-label="Pergunta" placeholder="Pergunte algo…" maxLength={1000} value={text} disabled={busy} onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)} />
            <button class="primary" disabled={busy || text.trim() === ''}>
              Perguntar
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}
