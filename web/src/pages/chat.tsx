import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../api.ts';
import type { ChatConversation, ChatMessage } from '../api.ts';
import { useLoad } from '../hooks.ts';
import { patchParams, type Route } from '../router.ts';
import { Loading } from '../ui.tsx';

const EXAMPLES = ['Quanto gastei este mês e com o quê?', 'O que mudou nos meus gastos em relação ao mês passado?', 'Quanto vou pagar nas próximas faturas?', 'Quais contas se repetem todo mês?'];

const TOOL_LABEL: Record<string, string> = {
  summary: 'visão geral', spending: 'gastos', cashflow: 'fluxo de caixa', transactions: 'transações', cards: 'cartões', card_forecast: 'faturas futuras', budgets: 'orçamento', recurring: 'recorrentes', net_worth: 'patrimônio', goals: 'metas', trend: 'tendência',
};

function Bubble({ m }: { m: ChatMessage }) {
  return (
    <div class={m.role === 'user' ? 'chat-msg user' : 'chat-msg'}>
      <div class="chat-text">{m.content}</div>
      {m.role === 'assistant' && m.steps && m.steps.length > 0 && (
        <details class="chat-steps">
          <summary>Consultei {m.steps.length} {m.steps.length === 1 ? 'fonte' : 'fontes'}</summary>
          <ul>
            {m.steps.map((s, i) => (
              <li key={i}>
                {TOOL_LABEL[s.tool] ?? s.tool} <span class="muted">{Object.keys(s.args).length > 0 ? JSON.stringify(s.args) : ''} {s.summary !== 'ok' ? `· ${s.summary}` : ''}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function ChatPage({ route }: { route: Route; hidden: boolean }) {
  const status = useLoad(() => api.chatStatus(), []);
  const conversations = useLoad(() => api.chatConversations(), []);
  const current = route.params.get('c') ? Number(route.params.get('c')) : null;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
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
    const asked: ChatMessage = { id: -1, conversationId: current ?? 0, role: 'user', content: question, steps: null, model: null, costUsd: null, createdAt: new Date().toISOString() };
    setMessages((m) => [...m, asked]);
    try {
      const reply = await api.ask(question, current ?? undefined);
      setMessages((m) => [...m, { id: -2, conversationId: reply.conversationId, role: 'assistant', content: reply.answer, steps: reply.steps, model: reply.model, costUsd: reply.costUsd, createdAt: new Date().toISOString() }]);
      if (current === null) patchParams({ c: String(reply.conversationId) });
      conversations.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível perguntar.');
    } finally {
      setBusy(false);
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
                <button class={c.id === current ? 'link on' : 'link'} onClick={() => patchParams({ c: String(c.id) })}>
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
                <p class="muted">Pergunte sobre as suas finanças. O analista consulta os seus dados por ferramentas que só leem, mostra o que consultou e não altera nada. As descrições e os valores das transações que ele consulta vão ao modelo de IA; documentos e números de conta não.</p>
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
              <Bubble key={`${m.id}-${i}`} m={m} />
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
