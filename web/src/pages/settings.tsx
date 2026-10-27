import { useState } from 'preact/hooks';
import { api } from '../api.ts';
import { brl } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { patchParams, type Route } from '../router.ts';
import { Go, Loading } from '../ui.tsx';

const KIND: Record<string, string> = { checking: 'Conta corrente', savings: 'Poupança', credit_card: 'Cartão de crédito' };

function AccountsTab({ hidden }: { hidden: boolean }) {
  const { data, error, reload } = useLoad(() => api.accounts(), []);
  if (!data) return <Loading error={error} />;
  const byInstitution = new Map<string, typeof data.items>();
  for (const a of data.items) byInstitution.set(a.institution, [...(byInstitution.get(a.institution) ?? []), a]);
  const toggle = async (id: string, value: boolean) => {
    await api.setHidden(id, value);
    reload();
  };
  return (
    <>
      <p class="muted">Contas e cartões ocultos saem de todos os totais, gráficos e listas. Os dados continuam sendo lidos e você pode voltar a mostrá-los aqui.</p>
      {[...byInstitution].map(([institution, list]) => (
        <section class="panel" key={institution}>
          <h2>{institution}</h2>
          <ul class="rows">
            {list.map((a) => (
              <li key={a.id}>
                <div class="grow">
                  <div class={a.hidden ? 'muted' : ''}>
                    {a.name}
                    {a.last4 ? ` •••• ${a.last4}` : ''}
                  </div>
                  <div class="muted">
                    {KIND[a.kind] ?? a.kind} · {a.kind === 'credit_card' ? `limite ${brl(a.creditLimit ?? 0, hidden)}` : `saldo ${brl(a.balance, hidden)}`}
                  </div>
                </div>
                <label class="switch">
                  <input type="checkbox" checked={!a.hidden} onChange={(e) => void toggle(a.id, !(e.currentTarget as HTMLInputElement).checked)} />
                  <span>{a.hidden ? 'Oculta' : 'Visível'}</span>
                </label>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

function CategoriesTab({ hidden }: { hidden: boolean }) {
  const { data, error, reload } = useLoad(() => api.categories(), []);
  const [name, setName] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  if (!data) return <Loading error={error} />;
  const run = async (work: () => Promise<unknown>) => {
    setMessage(null);
    try {
      await work();
      reload();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Não foi possível concluir.');
    }
  };
  return (
    <>
      <p class="muted">As categorias vêm das fontes (Pierre e Meu Pluggy) e podem ter nomes diferentes para o mesmo assunto. Crie as suas e mova transações para elas pelo painel de detalhes da transação.</p>
      <form
        class="recat"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api.addCategory(name);
            setName('');
          });
        }}
      >
        <input placeholder="Nova categoria" value={name} maxLength={60} onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} />
        <button class="primary" disabled={name.trim() === ''}>
          Criar
        </button>
      </form>
      {message && <div class="error">{message}</div>}
      <section class="panel">
        <h2>Categorias ({data.items.length})</h2>
        <ul class="rows">
          {data.items.map((c) => (
            <li key={c.name}>
              <Go class="grow clip" page="transactions" params={{ category: c.name }}>
                {c.name}
              </Go>
              {c.custom && <span class="badge info">sua</span>}
              <span class="muted">{c.count} transações</span>
              <span>{brl(c.amount, hidden)}</span>
              {c.custom && (
                <button class="link" onClick={() => void run(() => api.deleteCategory(c.name))}>
                  Excluir
                </button>
              )}
            </li>
          ))}
        </ul>
        <div class="note">Excluir uma categoria sua devolve as transações dela à categoria da fonte.</div>
      </section>
      <section class="panel">
        <h2>Regras ({data.rules.length})</h2>
        {data.rules.length === 0 ? (
          <div class="empty">Nenhuma regra. Ao recategorizar uma transação, marque “Aplicar a todas com a mesma descrição” para criar uma.</div>
        ) : (
          <ul class="rows">
            {data.rules.map((r) => (
              <li key={r.match}>
                <span class="grow clip">“{r.match}” vai para {r.category}</span>
                <button class="link" onClick={() => void run(() => api.deleteRule(r.match))}>
                  Remover
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

export function SettingsPage({ route, hidden }: { route: Route; hidden: boolean }) {
  const tab = route.params.get('tab') ?? 'accounts';
  return (
    <div class="page-body">
      <h1 class="page-title">Ajustes</h1>
      <div class="tabs">
        <button class={tab === 'accounts' ? 'tab on' : 'tab'} onClick={() => patchParams({ tab: null })}>
          Contas e cartões
        </button>
        <button class={tab === 'categories' ? 'tab on' : 'tab'} onClick={() => patchParams({ tab: 'categories' })}>
          Categorias
        </button>
      </div>
      {tab === 'categories' ? <CategoriesTab hidden={hidden} /> : <AccountsTab hidden={hidden} />}
    </div>
  );
}
