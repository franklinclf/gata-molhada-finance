import { useState } from 'preact/hooks';
import { api } from '../api.ts';
import type { NetWorthView } from '../api.ts';
import { LineChart } from '../charts.tsx';
import { brl, dayMonth, localDay } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { Loading } from '../ui.tsx';

const toCents = (text: string): number | null => {
  const n = Number(text.trim().replace(/\./g, '').replace(',', '.'));
  return text.trim() !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};

function ManualRow({ item, now, hidden, onChanged, onError }: { item: NetWorthView['manual'][number]; now: Date; hidden: boolean; onChanged: () => void; onError: (m: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [day, setDay] = useState(localDay(now.toISOString()));
  const last = item.values.at(-1);
  const run = async (work: () => Promise<unknown>) => {
    try {
      await work();
      setEditing(false);
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Não foi possível concluir.');
    }
  };
  return (
    <li class="budget-line">
      <div class="budget-head">
        <span class="grow clip">
          {item.name} <span class="badge muted">{item.kind === 'asset' ? 'bem' : 'dívida'}</span> {item.archived && <span class="badge muted">arquivado</span>}
        </span>
        <strong>{last ? brl(last.value, hidden) : '—'}</strong>
        {last && <span class="muted">em {dayMonth(last.day)}</span>}
        <button class="link" onClick={() => setEditing(!editing)}>
          Atualizar valor
        </button>
        <button class="link" onClick={() => void run(() => api.updateAsset(item.id, { archived: !item.archived }))}>
          {item.archived ? 'Reativar' : 'Arquivar'}
        </button>
        <button class="link" onClick={() => window.confirm(`Excluir “${item.name}” e todo o histórico de valores?`) && void run(() => api.deleteAsset(item.id))}>
          Excluir
        </button>
      </div>
      {editing && (
        <div class="recat">
          <input type="date" aria-label="Data do valor" value={day} max={localDay(now.toISOString())} onInput={(e) => setDay((e.currentTarget as HTMLInputElement).value)} />
          <input inputMode="decimal" aria-label="Valor em reais" placeholder="Valor" value={text} onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)} />
          <button class="primary small" disabled={toCents(text) === null || day === ''} onClick={() => void run(() => api.setAssetValue(item.id, day, toCents(text)))}>
            Salvar
          </button>
        </div>
      )}
    </li>
  );
}

export function NetWorthPage({ now, hidden }: { now: Date; hidden: boolean }) {
  const { data, error, loading, reload } = useLoad(() => api.netWorth(), []);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'asset' | 'liability'>('asset');
  const [value, setValue] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  if (error || (loading && !data)) return <div class="page-body"><h1 class="page-title">Patrimônio</h1><Loading error={error} /></div>;
  if (!data) return null;
  const add = async () => {
    try {
      await api.addAsset(name, kind, toCents(value));
      setName('');
      setValue('');
      setMessage(null);
      reload();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Não foi possível adicionar.');
    }
  };
  return (
    <div class="page-body">
      <h1 class="page-title">Patrimônio</h1>
      <div class="panel">
        <div class="big">{brl(data.net, hidden)}</div>
        <div class="muted">
          {brl(data.assets, hidden)} em bens e saldos, menos {brl(data.liabilities, hidden)} em dívidas
        </div>
        <LineChart points={data.history.map((p) => p.net)} days={data.history.map((p) => p.day)} hidden={hidden} label="Patrimônio" />
        <div class="note">O histórico é reconstruído: parte do saldo e da fatura de hoje e desfaz as transações lançadas depois de cada fim de mês. Bens e dívidas lançados à mão valem a partir da primeira data informada.</div>
      </div>
      <section class="panel">
        <h2>De onde vem</h2>
        <ul class="rows">
          {data.items.map((i) => (
            <li key={`${i.kind}${i.name}`}>
              <span class="grow clip">{i.name}</span>
              <strong class={i.liability ? 'bad-text' : ''}>{i.liability ? '−' : ''}{brl(i.value, hidden)}</strong>
            </li>
          ))}
        </ul>
      </section>
      <section class="panel">
        <h2>Bens e dívidas lançados à mão</h2>
        <div class="muted">Investimentos, imóvel, carro, empréstimo: o que as fontes bancárias não trazem. Cada valor tem uma data, e vale até o próximo ser informado.</div>
        {message && <div class="error">{message}</div>}
        {data.manual.length === 0 ? (
          <div class="empty">Nada lançado ainda.</div>
        ) : (
          <ul class="rows tall">
            {data.manual.map((m) => (
              <ManualRow key={m.id} item={m} now={now} hidden={hidden} onChanged={reload} onError={setMessage} />
            ))}
          </ul>
        )}
        <div class="recat">
          <select class="select" aria-label="Tipo" value={kind} onChange={(e) => setKind((e.currentTarget as HTMLSelectElement).value as 'asset' | 'liability')}>
            <option value="asset">Bem</option>
            <option value="liability">Dívida</option>
          </select>
          <input aria-label="Nome" placeholder="Nome (Carro, Tesouro Direto...)" maxLength={60} value={name} onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} />
          <input inputMode="decimal" aria-label="Valor de hoje em reais" placeholder="Valor hoje" value={value} onInput={(e) => setValue((e.currentTarget as HTMLInputElement).value)} />
          <button class="primary small" disabled={name.trim() === ''} onClick={() => void add()}>
            Adicionar
          </button>
        </div>
      </section>
    </div>
  );
}
