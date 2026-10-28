import { mkdirSync, writeFileSync } from 'node:fs';
import { QUESTIONS, SUMMARY, score } from './analyst-data.ts';
import { ANALYST_MODELS } from './models.ts';
import { Budget, BudgetExceeded, chat } from './openrouter.ts';

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error('Set OPENROUTER_API_KEY in .env first.');
  process.exit(1);
}
const budget = new Budget(Number(process.env.EVAL_BUDGET_USD ?? '0.5'));

const system = `Você é o analista financeiro pessoal do usuário. Responda em português, de forma curta e direta, só com base nos dados abaixo.
Faça as contas com cuidado e mostre o valor em reais. Se a informação pedida não estiver nos dados, diga claramente que não há esses dados, sem estimar nem inventar.

DADOS:
${JSON.stringify(SUMMARY, null, 1)}`;

interface Row {
  model: string;
  correct: number;
  traps: number;
  costUsd: number;
  latencyMs: number;
  wrong: Array<{ ask: string; answer: string }>;
  errors: string[];
}

async function evaluate(model: string): Promise<Row> {
  const row: Row = { model, correct: 0, traps: 0, costUsd: 0, latencyMs: 0, wrong: [], errors: [] };
  for (const q of QUESTIONS) {
    try {
      const reply = await chat(apiKey!, { model, system, user: q.ask, reasoning: 'medium', maxTokens: 3000 });
      budget.add(reply.costUsd);
      row.costUsd += reply.costUsd;
      row.latencyMs += reply.latencyMs;
      if (score(q, reply.content)) {
        row.correct++;
        if (q.unknown) row.traps++;
      } else row.wrong.push({ ask: q.ask, answer: reply.content.slice(0, 300) });
    } catch (error) {
      if (error instanceof BudgetExceeded) throw error;
      row.errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return row;
}

const only = process.argv.slice(2);
const models = only.length > 0 ? only : ANALYST_MODELS;
const rows: Row[] = [];
try {
  for (let i = 0; i < models.length; i += 3) rows.push(...(await Promise.all(models.slice(i, i + 3).map(evaluate))));
} catch (error) {
  if (!(error instanceof BudgetExceeded)) throw error;
  console.error(error.message);
}
const traps = QUESTIONS.filter((q) => q.unknown).length;
rows.sort((a, b) => b.correct - a.correct || a.costUsd - b.costUsd);
console.log(`\nmodel`.padEnd(40), `right(${QUESTIONS.length})  traps(${traps})  cost/question  latency`);
for (const r of rows) {
  console.log(
    r.model.padEnd(39),
    String(r.correct).padStart(9),
    String(r.traps).padStart(8),
    `$${(r.costUsd / QUESTIONS.length).toFixed(4)}`.padStart(14),
    `${Math.round(r.latencyMs / QUESTIONS.length)} ms`.padStart(10),
    r.errors.length > 0 ? `  errors: ${r.errors.length} (${r.errors[0]?.slice(0, 60)})` : '',
  );
}
console.log(`\nspent US$ ${budget.spent.toFixed(4)} of US$ ${budget.cap.toFixed(2)}`);
mkdirSync('eval/results', { recursive: true });
writeFileSync(`eval/results/analyst-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(rows, null, 2));
