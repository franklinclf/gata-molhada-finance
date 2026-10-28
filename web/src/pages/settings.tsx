import { useState } from 'preact/hooks';
import { api, ApiError } from '../api.ts';
import { ago } from '../format.ts';
import { createPasskey, guessDeviceName, passkeysSupported } from '../passkey.ts';
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
              {c.builtin && c.count === 0 && <span class="badge muted">padrão</span>}
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

function SecurityTab({ now }: { now: Date }) {
  const { data, error, reload } = useLoad(() => api.security(), []);
  const [message, setMessage] = useState<string | null>(null);
  const [name, setName] = useState(guessDeviceName());
  if (!data) return <Loading error={error} />;
  const full = data.strength !== 'device';
  const run = async (work: () => Promise<unknown>, done?: string) => {
    setMessage(null);
    try {
      await work();
      reload();
      if (done) setMessage(done);
    } catch (e) {
      if (e instanceof ApiError && e.message === 'reauth_required') setMessage('Para mexer nisso, entre de novo com a senha e o código ou com uma passkey (use "Sair" e entre).');
      else if (e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError')) setMessage('A criação da passkey foi cancelada.');
      else if (e instanceof DOMException && e.name === 'InvalidStateError') setMessage('Este aparelho já tem uma passkey para este site.');
      else setMessage(e instanceof Error ? e.message : 'Não foi possível concluir.');
    }
  };
  const addPasskey = () =>
    run(async () => {
      const credential = await createPasskey(await api.passkeyRegisterOptions());
      await api.registerPasskey(credential, name);
    }, 'Passkey criada. Na próxima vez, use "Entrar com passkey".');
  const here = data.devices.find((d) => d.current);
  return (
    <>
      {!full && <div class="note">Você entrou por um aparelho confiável. Para criar ou remover passkeys e aparelhos, saia e entre de novo com a senha e o código ou com uma passkey.</div>}
      <section class="panel">
        <h2>Passkeys</h2>
        <div class="muted">
          Entrar com a biometria do aparelho (Touch ID, impressão digital do celular, Windows Hello) ou PIN, sem digitar senha. Ficam no gerenciador do navegador ou do sistema (iCloud, Google), então uma passkey criada no Mac pode valer no Chrome do celular logado na mesma conta.
        </div>
        {!data.passkeysAvailable || !passkeysSupported() ? (
          <div class="note">{data.passkeysAvailable ? 'Este navegador não oferece passkeys.' : 'Passkeys ainda não foram ligadas no servidor (falta PUBLIC_ORIGIN com https).'}</div>
        ) : (
          <div class="recat">
            <input value={name} maxLength={40} onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} aria-label="Nome do aparelho" />
            <button class="primary" disabled={!full} onClick={() => void addPasskey()}>
              Criar passkey neste aparelho
            </button>
          </div>
        )}
        <ul class="rows tall">
          {data.passkeys.length === 0 && <li class="muted">Nenhuma passkey criada.</li>}
          {data.passkeys.map((p) => (
            <li key={p.id}>
              <div class="grow">
                <div>{p.name}</div>
                <div class="muted">criada {ago(p.createdAt, now)} · {p.lastUsedAt ? `usada ${ago(p.lastUsedAt, now)}` : 'nunca usada'}</div>
              </div>
              <button class="link" disabled={!full} onClick={() => void run(() => api.deletePasskey(p.id))}>
                Remover
              </button>
            </li>
          ))}
        </ul>
        <div class="note">Remover aqui apaga só o registro do servidor. Apague também a passkey no gerenciador do aparelho, se quiser.</div>
      </section>
      <section class="panel">
        <h2>Aparelhos confiáveis</h2>
        <div class="muted">Um aparelho confiável fica conectado por até 30 dias sem uso (e no máximo 90 dias desde que foi marcado), sem pedir senha de novo. Marque só aparelhos seus. "Sair" tira o aparelho da lista.</div>
        {!here && (
          <div class="recat">
            <button class="icon" disabled={!full} onClick={() => void run(() => api.trustDevice(guessDeviceName()), 'Este aparelho agora é confiável.')}>
              Confiar neste aparelho ({guessDeviceName()})
            </button>
          </div>
        )}
        <ul class="rows tall">
          {data.devices.length === 0 && <li class="muted">Nenhum aparelho confiável.</li>}
          {data.devices.map((d) => (
            <li key={d.id}>
              <div class="grow">
                <div>
                  {d.name} {d.current && <span class="badge info">este aparelho</span>}
                </div>
                <div class="muted">usado {ago(d.lastUsedAt, now)} · vale até {d.expiresAt.slice(0, 10).split('-').reverse().join('/')}</div>
              </div>
              <button class="link" disabled={!full} onClick={() => void run(() => api.forgetDevice(d.id))}>
                Esquecer
              </button>
            </li>
          ))}
        </ul>
      </section>
      {message && <div class="note" role="status">{message}</div>}
    </>
  );
}

const CONFIDENCE: Record<string, string> = { high: 'alta', medium: 'média', low: 'baixa' };

function AiTab({ hidden }: { hidden: boolean }) {
  const { data, error, reload } = useLoad(() => api.ai(), []);
  const categories = useLoad(() => api.categories(), []);
  const [message, setMessage] = useState<string | null>(null);
  const [choice, setChoice] = useState<Record<string, string>>({});
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
  const { job } = data;
  return (
    <>
      <section class="panel">
        <h2>Categorização automática</h2>
        <dl class="facts">
          <dt>Situação</dt>
          <dd>{job.enabled ? `ligada (${job.model})` : 'desligada (precisa de AI_ENABLED=on e da chave da OpenRouter no servidor)'}</dd>
          <dt>Última execução</dt>
          <dd>{job.lastRunAt ? `${job.lastRunAt.slice(0, 16).replace('T', ' ')} · ${job.lastResult}` : (job.lastResult ?? 'nunca')}</dd>
          <dt>Gasto no mês</dt>
          <dd>
            US$ {data.spentThisMonth.toFixed(3)}
            {data.monthlyBudget !== null ? ` de US$ ${data.monthlyBudget.toFixed(2)}` : ''}
          </dd>
          <dt>Já aplicadas</dt>
          <dd>{data.applied} descrições, com confiança alta</dd>
        </dl>
        <div class="note">
          O modelo recebe só o texto da descrição, se entrou ou saiu dinheiro e a categoria que a fonte deu, nunca valores, contas nem nomes de bancos. Categorias que você escolher ou regras que você criar sempre valem mais que a IA, e sugestões de confiança média ou baixa só valem depois que você aceita.
        </div>
      </section>
      <section class="panel">
        <div class="row-head">
          <h2>Para você decidir ({data.suggestions.length})</h2>
          {data.suggestions.some((s) => s.confidence === 'medium') && (
            <button class="primary small" onClick={() => void run(() => api.acceptAllAi())}>
              Aceitar todas as de confiança média
            </button>
          )}
        </div>
        {data.suggestions.length === 0 ? (
          <div class="empty">Nenhuma sugestão esperando.</div>
        ) : (
          <ul class="rows tall">
            {data.suggestions.map((s) => (
              <li key={s.key} class="suggestion">
                <div class="grow">
                  <div class="clip">{s.sample}</div>
                  <div class="muted">
                    {s.count} transação(ões){s.sourceCategory ? ` · a fonte diz: ${s.sourceCategory}` : ''} · confiança {CONFIDENCE[s.confidence]}
                  </div>
                </div>
                <select class="select" value={choice[s.key] ?? s.category} onChange={(e) => setChoice({ ...choice, [s.key]: (e.currentTarget as HTMLSelectElement).value })} aria-label="Categoria">
                  {[...new Set([s.category, ...(categories.data?.items.map((c) => c.name) ?? [])])].map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
                <div class="links" data-no-nav>
                  <button class="primary small" onClick={() => void run(() => api.acceptAi(s.key, choice[s.key] ?? s.category))}>
                    Aceitar
                  </button>
                  <button class="icon small" onClick={() => void run(() => api.rejectAi(s.key))}>
                    Não
                  </button>
                  {s.sampleTransactionId && (
                    <button class="link" onClick={() => patchParams({ tx: s.sampleTransactionId })}>
                      Ver
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {message && <div class="error">{message}</div>}
      </section>
    </>
  );
}

export function SettingsPage({ route, hidden, now }: { route: Route; hidden: boolean; now: Date }) {
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
        <button class={tab === 'ai' ? 'tab on' : 'tab'} onClick={() => patchParams({ tab: 'ai' })}>
          IA
        </button>
        <button class={tab === 'security' ? 'tab on' : 'tab'} onClick={() => patchParams({ tab: 'security' })}>
          Segurança
        </button>
      </div>
      {tab === 'categories' ? <CategoriesTab hidden={hidden} /> : tab === 'ai' ? <AiTab hidden={hidden} /> : tab === 'security' ? <SecurityTab now={now} /> : <AccountsTab hidden={hidden} />}
    </div>
  );
}
