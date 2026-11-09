import { useState } from 'preact/hooks';
import { api, ApiError, type ApplyResult, type BillPreview, type ImageOnly, type PreviewLine } from './api.ts';
import { gapText } from './bill-check.ts';
import { Badge, Button } from './ds.tsx';
import { brl, dayMonth } from './format.ts';
import { useLoad } from './hooks.ts';
import { cardName } from './names.ts';
import { imageForAi } from './pdf-image.ts';
import { Select } from './Select.tsx';

/** The server reads files up to this size. The captures of the open bill that the bank's app saves are images of 20 MB and more. */
const MAX_BYTES = 6 * 1024 * 1024;
/** The page sent to the AI, as base64 JPEG. */
const MAX_IMAGE_CHARS = 1.5 * 1024 * 1024;

const ISSUER: Record<string, string> = { bradescard: 'Bradescard', bradesco: 'Bradesco' };
const MATCH: Record<PreviewLine['match'], { label: string; tone: 'muted' | 'good' | 'warn' }> = {
  already_there: { label: 'já existe', tone: 'muted' },
  new: { label: 'nova', tone: 'good' },
  possible_duplicate: { label: 'possível duplicada', tone: 'warn' },
  outside: { label: 'fora do período', tone: 'muted' },
};
const STATUS: Record<string, string> = { applied: 'aplicada', replaced: 'substituída por outra cópia', undone: 'desfeita' };

const fullDay = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;
const messageOf = (e: unknown) => (e instanceof ApiError && e.status === 401 ? 'Sua sessão terminou. Entre de novo e envie o arquivo outra vez.' : e instanceof Error ? e.message : 'Não foi possível ler o arquivo.');
const gapLine = (gap: BillPreview['gap'], hidden: boolean) => (gap === null ? 'a fatura não é conferida' : Math.abs(gap.gap) <= 1 ? 'a fatura fecha' : gapText(gap.gap, hidden));

interface Item {
  key: number;
  name: string;
  file: File;
  state: 'waiting' | 'reading' | 'ready' | 'image' | 'error' | 'applying' | 'applied' | 'undone';
  error?: string;
  preview?: BillPreview;
  image?: ImageOnly;
  /** The app card picked for each card of the statement (last 4 digits). */
  picks: Record<string, string>;
  removeManual: string[];
  applied?: ApplyResult;
  note?: string;
}

let nextKey = 1;

/** "Importar fatura em PDF": a queue of statement files, a preview of each with the card to put it on, and the past imports, each with Desfazer. */
export function BillImportPanel({ hidden }: { hidden: boolean }) {
  const [items, setItems] = useState<Item[]>([]);
  const imports = useLoad(() => api.billImports(), []);
  const [message, setMessage] = useState<string | null>(null);
  const patch = (key: number, change: Partial<Item>) => setItems((list) => list.map((i) => (i.key === key ? { ...i, ...change } : i)));

  const choose = async (files: File[]) => {
    const added: Item[] = files.map((file) => ({
      key: nextKey++,
      name: file.name,
      file,
      picks: {},
      removeManual: [],
      ...(file.size > MAX_BYTES
        ? { state: 'error' as const, error: `O arquivo tem ${(file.size / 1024 / 1024).toFixed(1).replace('.', ',')} MB e o limite é 6 MB. As capturas da fatura aberta que o app do banco salva são uma imagem e ficam grandes assim; baixe a fatura mensal em PDF, que tem texto.` }
        : { state: 'waiting' as const }),
    }));
    setItems((list) => [...list, ...added]);
    // One file at a time: each is read on the server, and the rows fill in the order chosen.
    for (const item of added) {
      if (item.state === 'error') continue;
      patch(item.key, { state: 'reading' });
      try {
        const answer = await api.uploadBill(item.file, item.name);
        if (answer.readable) patch(item.key, { state: 'ready', preview: answer, picks: Object.fromEntries(answer.cards.filter((c) => c.targetId).map((c) => [c.final, c.targetId as string])) });
        else patch(item.key, { state: 'image', image: answer });
      } catch (e) {
        patch(item.key, { state: 'error', error: messageOf(e) });
      }
    }
  };

  const pick = async (item: Item, final: string, accountId: string) => {
    const picks = { ...item.picks, [final]: accountId };
    patch(item.key, { picks, note: undefined });
    try {
      patch(item.key, { preview: await api.previewBill({ fileHash: item.preview!.fileHash, targets: picks }), picks, removeManual: [] });
    } catch (e) {
      patch(item.key, { note: messageOf(e) });
    }
  };

  const apply = async (item: Item) => {
    patch(item.key, { state: 'applying', note: undefined });
    try {
      const applied = await api.applyBill({ fileHash: item.preview!.fileHash, targets: item.picks, removeManual: item.removeManual });
      patch(item.key, { state: 'applied', applied });
      imports.reload();
    } catch (e) {
      patch(item.key, { state: 'ready', note: messageOf(e) });
    }
  };

  const undo = async (id: number, key?: number) => {
    if (!window.confirm('Desfazer a importação apaga os lançamentos desta fatura que vieram do PDF e devolve as transações digitadas que ela substituiu. Continuar?')) return;
    setMessage(null);
    try {
      const done = await api.undoBillImport(id);
      if (key !== undefined) patch(key, { state: 'undone' });
      setMessage(`Importação desfeita: ${done.removed} lançamentos saíram${done.restoredManual > 0 ? ` e ${done.restoredManual} transações digitadas voltaram` : ''}.`);
      imports.reload();
    } catch (e) {
      setMessage(messageOf(e));
    }
  };

  const readWithAi = async (item: Item) => {
    const ok = window.confirm('Para ler uma fatura que é só imagem, a página inteira vai para o provedor de IA (OpenRouter), com o seu nome e o seu endereço visíveis nela. Continuar?');
    if (!ok) return;
    patch(item.key, { note: 'Preparando a imagem…' });
    try {
      const image = await imageForAi(item.file);
      if (image.length > MAX_IMAGE_CHARS) throw new Error('A imagem reduzida ainda passa de 1,5 MB.');
      const answer = await api.readBillWithAi({ fileHash: item.image!.fileHash, image });
      patch(item.key, { state: 'ready', preview: answer, image: undefined, note: undefined });
    } catch (e) {
      patch(item.key, { note: messageOf(e) });
    }
  };

  const accounts = (p: BillPreview) => p.accounts.map((a) => ({ value: a.id, label: `${cardName(a.institution, a.name)}${a.last4 ? ` •••• ${a.last4}` : ''}` }));
  const stateText = (item: Item): string => {
    if (item.state === 'waiting') return 'na fila';
    if (item.state === 'reading') return 'lendo…';
    if (item.state === 'error') return 'não deu para ler';
    if (item.state === 'image') return 'só imagem, sem texto';
    if (item.state === 'applying') return 'aplicando…';
    if (item.state === 'undone') return 'importação desfeita';
    const lines = item.preview?.lineCount ?? 0;
    return `${item.state === 'applied' ? 'aplicada' : 'ok'}, ${lines} ${lines === 1 ? 'lançamento' : 'lançamentos'}`;
  };

  const past = imports.data?.items ?? [];
  return (
    <section class="panel">
      <h2>Importar fatura em PDF</h2>
      <p class="muted">
        Envie a fatura mensal em PDF do Bradescard ou do Bradesco (a que tem texto, até 6 MB). O app lê o arquivo aqui mesmo, mostra o que entraria e só grava quando você aplica: as compras que o Meu Pluggy já tem continuam valendo uma vez, e as que faltam passam a contar. Do arquivo ficam só os lançamentos e uma impressão digital (hash); o PDF, seu nome, CPF e endereço não são guardados.
      </p>
      <div class="links">
        <label class="primary small file-pick">
          Escolher PDFs
          <input type="file" accept="application/pdf,.pdf" multiple hidden onChange={(e) => { const input = e.currentTarget as HTMLInputElement; const files = [...(input.files ?? [])]; input.value = ''; if (files.length > 0) void choose(files); }} />
        </label>
        {items.length > 0 && items.every((i) => i.state !== 'reading' && i.state !== 'waiting' && i.state !== 'applying') && (
          <button class="icon small" onClick={() => setItems([])}>
            Limpar a fila
          </button>
        )}
      </div>
      {message && <div class="note">{message}</div>}
      {items.length > 0 && (
        <ul class="rows tall">
          {items.map((item) => {
            const p = item.preview;
            return (
              <li key={item.key} class="suggestion">
                <div class="grow">
                  <div>
                    <strong class="clip">{item.name}</strong> <span class="muted">· {stateText(item)}</span>
                  </div>
                  {item.error && <div class="error">{item.error}</div>}
                  {item.image && (
                    <>
                      <div class="muted">{item.image.message}</div>
                      <div class="links">
                        <Button size="sm" onClick={() => void readWithAi(item)}>
                          Ler com IA
                        </Button>
                      </div>
                    </>
                  )}
                  {p && item.state !== 'undone' && (
                    <>
                      <div>
                        {ISSUER[p.issuer] ?? p.issuer} {p.product} · vence {fullDay(p.dueDate)}
                        {p.closingDate ? ` · fechou em ${fullDay(p.closingDate)}` : ''} · total {brl(p.total, hidden)}
                      </div>
                      <div class="muted">
                        {p.tieOut.ok ? 'A soma dos lançamentos confere com o total da fatura.' : 'A soma dos lançamentos não confere com o total da fatura.'}
                        {p.tieOut.note ? ` ${p.tieOut.note}` : ''}
                        {p.skipped.payments > 0 ? ` O pagamento da fatura anterior não entra: ele já está na conta de onde saiu.` : ''}
                      </div>
                      {p.warnings.map((w) => (
                        <div class="note" key={w}>
                          {w}
                        </div>
                      ))}
                      {p.previous && <div class="note">Esta fatura já foi importada em {fullDay(p.previous.appliedAt.slice(0, 10))}{p.previous.sameFile ? ' com este mesmo arquivo' : ''}. Aplicar de novo substitui os lançamentos dela.</div>}
                      {p.cards.map((c) => (
                        <div class="links" key={c.final}>
                          <span>
                            Cartão •••• {c.final} ({c.lines} {c.lines === 1 ? 'lançamento' : 'lançamentos'}{c.bill ? ', recebe o total da fatura' : ''})
                          </span>
                          {item.state === 'applied' ? (
                            <span class="muted">{accounts(p).find((a) => a.value === item.picks[c.final])?.label}</span>
                          ) : (
                            <Select ariaLabel={`Cartão do app para o final ${c.final}`} value={item.picks[c.final] ?? ''} placeholder="Escolha o cartão" options={accounts(p)} onChange={(value) => value !== '' && void pick(item, c.final, value)} />
                          )}
                        </div>
                      ))}
                      <div>
                        {p.counts.new} {p.counts.new === 1 ? 'nova' : 'novas'} · {p.counts.already_there} já {p.counts.already_there === 1 ? 'existente' : 'existentes'} · {p.counts.possible_duplicate} {p.counts.possible_duplicate === 1 ? 'possível duplicada' : 'possíveis duplicadas'}
                        {p.counts.outside > 0 ? ` · ${p.counts.outside} fora do período do app` : ''}
                      </div>
                      {item.state !== 'applied' && <div class="muted">Conferir hoje: {gapLine(p.gap, hidden)}.{p.otherBill && p.otherBill.total === p.total ? ' O Meu Pluggy tem esta fatura com o mesmo total.' : ''}</div>}
                      {item.state !== 'applied' && p.manualCandidates.length > 0 && (
                        <div>
                          <div class="muted">Transações que você digitou e que esta fatura parece trazer. Marque as que devem sair para não contar duas vezes:</div>
                          {p.manualCandidates.map((m) => (
                            <label class="check" key={m.id}>
                              <input type="checkbox" checked={item.removeManual.includes(m.id)} onChange={(e) => patch(item.key, { removeManual: (e.currentTarget as HTMLInputElement).checked ? [...item.removeManual, m.id] : item.removeManual.filter((x) => x !== m.id) })} /> {dayMonth(m.day)} · {m.description} · {brl(m.amount, hidden)}
                            </label>
                          ))}
                        </div>
                      )}
                      <details>
                        <summary class="muted">Ver os lançamentos ({p.lineCount})</summary>
                        <ul class="rows">
                          {p.lines.map((l, n) => (
                            <li key={n}>
                              <div class="grow clip">
                                {dayMonth(l.day)} · {l.description}
                                {l.installment ? ` ${l.installment.number}/${l.installment.total}` : ''}
                                {l.note && <div class="muted">{l.note}</div>}
                              </div>
                              <span>{brl(l.amount, hidden)}</span>
                              <Badge tone={MATCH[l.match].tone}>{MATCH[l.match].label}</Badge>
                            </li>
                          ))}
                        </ul>
                        {p.lineCount > p.lines.length && <div class="muted">Mostrando {p.lines.length} de {p.lineCount}.</div>}
                      </details>
                      {item.note && <div class="error">{item.note}</div>}
                      {item.state === 'applied' && item.applied ? (
                        <div class="note">
                          Fatura importada: {item.applied.lines} lançamentos{item.applied.removedManual > 0 ? `, ${item.applied.removedManual} transações digitadas removidas` : ''}.{' '}
                          {item.applied.gaps.map((g) => `Conferir antes: ${gapLine(g.before, hidden)}; depois: ${gapLine(g.after, hidden)}.`).join(' ')}{' '}
                          <button class="link" onClick={() => void undo(item.applied!.importId, item.key)}>
                            Desfazer
                          </button>
                        </div>
                      ) : (
                        <div class="links">
                          <Button size="sm" variant="primary" disabled={!p.ready || item.state === 'applying'} onClick={() => void apply(item)}>
                            {item.state === 'applying' ? 'Aplicando…' : 'Aplicar'}
                          </Button>
                          {!p.ready && <span class="muted">Escolha o cartão do app para cada cartão da fatura.</span>}
                        </div>
                      )}
                    </>
                  )}
                  {!p && item.note && <div class="error">{item.note}</div>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {past.length > 0 && (
        <details>
          <summary class="muted">Faturas importadas ({past.filter((i) => i.status === 'applied').length})</summary>
          <ul class="rows">
            {past.map((i) => (
              <li key={i.id}>
                <div class="grow">
                  {ISSUER[i.issuer] ?? i.issuer} · vence {fullDay(i.dueDate)} · {i.cardFinals.map((f) => `•••• ${f}`).join(', ')} · {i.lineCount} lançamentos · total {brl(i.total, hidden)}
                  <div class="muted">
                    {STATUS[i.status] ?? i.status} em {fullDay((i.resolvedAt ?? i.appliedAt).slice(0, 10))}
                  </div>
                </div>
                {i.status === 'applied' && (
                  <button class="link" onClick={() => void undo(i.id)}>
                    Desfazer importação
                  </button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
