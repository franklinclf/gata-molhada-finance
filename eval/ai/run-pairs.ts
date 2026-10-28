import { mkdirSync, writeFileSync } from 'node:fs';
import { PAIR_SCHEMA, PAIR_SYSTEM, pairPayload } from '../../src/ai/pair-prompt.ts';
import { Budget, BudgetExceeded, chat, parseJson } from '../../src/ai/openrouter.ts';
import { PAIRS } from './pairs-dataset.ts';

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error('Set OPENROUTER_API_KEY in .env first.');
  process.exit(1);
}
const budget = new Budget(Number(process.env.EVAL_BUDGET_USD ?? '0.3'));
const MODELS = ['anthropic/claude-haiku-5.5', 'openai/gpt-6-luna', 'google/gemini-3.1-flash-lite', 'anthropic/claude-sonnet-5.5'];
const BATCH = 20;

async function evaluate(model: string) {
  const row = { model, costUsd: 0, correct: 0, highWrong: 0, highYesWrong: 0, high: 0, wrong: [] as string[], errors: [] as string[] };
  for (let start = 0; start < PAIRS.length; start += BATCH) {
    const batch = PAIRS.slice(start, start + BATCH);
    try {
      const reply = await chat(apiKey!, { model, system: PAIR_SYSTEM, user: pairPayload(batch), schema: PAIR_SCHEMA, reasoning: true, maxTokens: 6000 });
      budget.add(reply.costUsd);
      row.costUsd += reply.costUsd;
      const answers = new Map(parseJson<{ results: Array<{ i: number; same: string; confidence: string }> }>(reply.content).results.map((x) => [x.i, x]));
      batch.forEach((pair, i) => {
        const a = answers.get(i);
        const said = a?.same === 'yes';
        if (a?.confidence === 'high') row.high++;
        if (a && said === pair.same) row.correct++;
        else {
          row.wrong.push(`${pair.same ? 'is' : 'not'}: ${pair.a.text} | ${pair.b.text} -> ${a?.same}/${a?.confidence}`);
          if (a?.confidence === 'high') {
            row.highWrong++;
            if (said && !pair.same) row.highYesWrong++;
          }
        }
      });
    } catch (error) {
      if (error instanceof BudgetExceeded) throw error;
      row.errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return row;
}

const rows = [];
try {
  rows.push(...(await Promise.all(MODELS.map(evaluate))));
} catch (error) {
  if (!(error instanceof BudgetExceeded)) throw error;
  console.error(error.message);
}
console.log(`\nmodel`.padEnd(36), `right(${PAIRS.length})  sure-answers  sure-and-wrong  false-joins-when-sure  cost`);
for (const r of rows) {
  console.log(r.model.padEnd(35), String(r.correct).padStart(9), String(r.high).padStart(14), String(r.highWrong).padStart(15), String(r.highYesWrong).padStart(21), `$${r.costUsd.toFixed(4)}`.padStart(9), r.errors.length ? ` errors: ${r.errors[0]?.slice(0, 60)}` : '');
  for (const w of r.wrong.slice(0, 6)) console.log('    wrong ->', w);
}
console.log(`\nspent US$ ${budget.spent.toFixed(4)}`);
mkdirSync('eval/results', { recursive: true });
writeFileSync(`eval/results/pairs-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(rows, null, 2));
