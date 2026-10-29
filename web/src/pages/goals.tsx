import { useState } from 'preact/hooks';
import { api } from '../api.ts';
import type { GoalView } from '../api.ts';
import { Meter } from '../charts.tsx';
import { Select } from '../Select.tsx';
import { brl, dayMonth, percent } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { Loading } from '../ui.tsx';

const STATUS: Record<GoalView['status'], [string, string]> = {
  achieved: ['atingida', 'badge good'],
  overdue: ['atrasada', 'badge bad'],
  ahead: ['adiantada', 'badge good'],
  on_track: ['no ritmo', 'badge info'],
  behind: ['atrás do ritmo', 'badge bad'],
  open: ['sem prazo', 'badge muted'],
};

const toCents = (text: string): number | null => {
  const n = Number(text.trim().replace(/\./g, '').replace(',', '.'));
  return text.trim() !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};

function GoalRow({ goal, hidden, onChanged, onError }: { goal: GoalView; hidden: boolean; onChanged: () => void; onError: (m: string) => void }) {
  const [saving, setSaving] = useState(false);
  const [text, setText] = useState(String(goal.saved / 100).replace('.', ','));
  const run = async (work: () => Promise<unknown>) => {
    try {
      await work();
      setSaving(false);
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Não foi possível concluir.');
    }
  };
  const [label, badge] = STATUS[goal.status];
  const base = { id: goal.id, name: goal.name, target: goal.target, targetDay: goal.targetDay, track: goal.track, trackRef: goal.trackRef };
  return (
    <li class="budget-line">
      <div class="budget-head">
        <span class="grow clip">
          {goal.name} <span class={badge}>{label}</span> {goal.archived && <span class="badge muted">arquivada</span>}
        </span>
        <strong>{brl(goal.current, hidden)}</strong>
        <span class="muted">de {brl(goal.target, hidden)}</span>
      </div>
      <Meter fraction={goal.progress} color="var(--good)" tip={`${percent(goal.progress)} da meta`} />
      <div class="muted budget-note">
        {percent(goal.progress)} da meta
        {goal.targetDay ? ` · até ${dayMonth(goal.targetDay)}/${goal.targetDay.slice(0, 4)}` : ''}
        {goal.requiredMonthly !== null ? ` · ${brl(goal.requiredMonthly, hidden)} por mês` : ''}
        {goal.status !== 'achieved' && goal.remaining > 0 ? ` · faltam ${brl(goal.remaining, hidden)}` : ''}
        {goal.track === 'networth' ? ' · acompanha o patrimônio' : goal.track === 'account' ? ' · acompanha uma conta' : goal.track === 'asset' ? ' · acompanha um bem' : ''}
        {goal.linkLost ? ' · o item acompanhado sumiu, vale o valor digitado' : ''}
      </div>
      <div class="links">
        {(goal.track === 'manual' || goal.linkLost) && (
          <button class="link" onClick={() => setSaving(!saving)}>
            Atualizar valor guardado
          </button>
        )}
        <button class="link" onClick={() => void run(() => api.saveGoal({ ...base, archived: !goal.archived }))}>
          {goal.archived ? 'Reativar' : 'Arquivar'}
        </button>
        <button class="link" onClick={() => window.confirm(`Excluir a meta “${goal.name}”?`) && void run(() => api.deleteGoal(goal.id))}>
          Excluir
        </button>
      </div>
      {saving && (
        <div class="recat">
          <input inputMode="decimal" aria-label="Valor guardado em reais" value={text} onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)} />
          <button class="primary small" disabled={toCents(text) === null} onClick={() => void run(() => api.saveGoal({ ...base, saved: toCents(text)! }))}>
            Salvar
          </button>
        </div>
      )}
    </li>
  );
}

export function GoalsPage({ now, hidden }: { now: Date; hidden: boolean }) {
  const goals = useLoad(() => api.goals(), []);
  const accounts = useLoad(() => api.accounts(), []);
  const assets = useLoad(() => api.netWorth(), []);
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [day, setDay] = useState('');
  const [track, setTrack] = useState<'manual' | 'account' | 'asset' | 'networth'>('manual');
  const [ref, setRef] = useState('');
  const [saved, setSaved] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  if (!goals.data) return <div class="page-body"><h1 class="page-title">Metas</h1><Loading error={goals.error} /></div>;
  const add = async () => {
    try {
      await api.saveGoal({ name, target: toCents(target)!, targetDay: day || null, track, trackRef: track === 'account' || track === 'asset' ? ref : null, saved: toCents(saved) ?? 0 });
      setName('');
      setTarget('');
      setDay('');
      setSaved('');
      setMessage(null);
      goals.reload();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Não foi possível criar.');
    }
  };
  const tomorrow = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
  const options = track === 'account' ? (accounts.data?.items ?? []).map((a) => [a.id, `${a.institution} · ${a.name}`] as const) : (assets.data?.manual ?? []).filter((m) => m.kind === 'asset').map((m) => [String(m.id), m.name] as const);
  return (
    <div class="page-body">
      <h1 class="page-title">Metas</h1>
      <section class="panel">
        <h2>Suas metas</h2>
        {message && <div class="error">{message}</div>}
        {goals.data.items.length === 0 ? (
          <div class="empty">Nenhuma meta ainda.</div>
        ) : (
          <ul class="rows tall">
            {goals.data.items.map((g) => (
              <GoalRow key={g.id} goal={g} hidden={hidden} onChanged={goals.reload} onError={setMessage} />
            ))}
          </ul>
        )}
      </section>
      <section class="panel">
        <h2>Nova meta</h2>
        <input class="search" aria-label="Nome da meta" placeholder="Nome (Reserva de emergência, Viagem...)" maxLength={60} value={name} onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} />
        <div class="recat">
          <input inputMode="decimal" aria-label="Valor da meta em reais" placeholder="Quanto quer juntar" value={target} onInput={(e) => setTarget((e.currentTarget as HTMLInputElement).value)} />
          <input type="date" aria-label="Data limite" min={tomorrow} value={day} onInput={(e) => setDay((e.currentTarget as HTMLInputElement).value)} />
        </div>
        <Select ariaLabel="O que acompanha" value={track} onChange={(next) => { setTrack(next as typeof track); setRef(''); }} options={[{ value: 'manual', label: 'Um valor que eu atualizo' }, { value: 'account', label: 'O saldo de uma conta' }, { value: 'asset', label: 'Um bem lançado em Patrimônio' }, { value: 'networth', label: 'O patrimônio total' }]} />
        {(track === 'account' || track === 'asset') && <Select ariaLabel="Qual" value={ref} onChange={setRef} placeholder="Escolher" options={options.map(([id, label]) => ({ value: id, label }))} />}
        {track === 'manual' && <input inputMode="decimal" aria-label="Quanto já tem guardado" placeholder="Quanto já tem guardado (opcional)" value={saved} onInput={(e) => setSaved((e.currentTarget as HTMLInputElement).value)} />}
        <div class="note">O progresso é quanto do valor da meta já está guardado. Com data limite, o ritmo esperado é uma reta entre hoje e a data, e quem começou com dinheiro guardado só está adiantado se andou mais que essa reta a partir do ponto de partida.</div>
        <div class="links">
          <button class="primary small" disabled={name.trim() === '' || toCents(target) === null || toCents(target) === 0 || ((track === 'account' || track === 'asset') && ref === '')} onClick={() => void add()}>
            Criar meta
          </button>
        </div>
      </section>
    </div>
  );
}
