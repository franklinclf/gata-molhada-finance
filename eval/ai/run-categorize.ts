import { mkdirSync, writeFileSync } from 'node:fs';
import { CATEGORIZER_MODELS } from './models.ts';
import { DATASET, type Item } from './dataset.ts';
import { Budget, BudgetExceeded, chat, parseJson } from './openrouter.ts';
import { CATEGORY_NAMES, TAXONOMY } from './taxonomy.ts';

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error('Set OPENROUTER_API_KEY in .env first.');
  process.exit(1);
}
const budget = new Budget(Number(process.env.EVAL_BUDGET_USD ?? '0.5'));
const BATCH = 25;
const REAL_TRANSACTIONS = 1633;

const system = `You categorize personal bank and credit card transactions from Brazil.
The text is what the bank sent: upper case, truncated, often prefixed by a payment gateway (IFD*, EBN*, DL*, PG *, MERCADOLIVRE*).
Negative amounts are money out, positive are money in. Pick exactly one category per transaction from this list, using the meaning given:
${TAXONOMY.map(([name, meaning]) => `- ${name}: ${meaning}`).join('\n')}
Answer only with JSON: {"results":[{"i":<number>,"category":"<exact name from the list>"}]} with one entry for every input.`;

const schema = {
  name: 'categories',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['results'],
    properties: {
      results: {
        type: 'array',
        items: { type: 'object', additionalProperties: false, required: ['i', 'category'], properties: { i: { type: 'integer' }, category: { type: 'string', enum: CATEGORY_NAMES } } },
      },
    },
  },
};

interface Row {
  model: string;
  correct: number;
  hardCorrect: number;
  total: number;
  invalid: number;
  costUsd: number;
  latencyMs: number;
  errors: string[];
  wrong: Array<{ text: string; got: string; expected: string }>;
}

async function evaluate(model: string): Promise<Row> {
  const row: Row = { model, correct: 0, hardCorrect: 0, total: DATASET.length, invalid: 0, costUsd: 0, latencyMs: 0, errors: [], wrong: [] };
  for (let start = 0; start < DATASET.length; start += BATCH) {
    const batch: Item[] = DATASET.slice(start, start + BATCH);
    const user = JSON.stringify(batch.map((item, i) => ({ i, text: item.text, amount_brl: item.amount / 100 })));
    try {
      const reply = await chat(apiKey!, { model, system, user, schema, reasoning: true, maxTokens: 6000 });
      budget.add(reply.costUsd);
      row.costUsd += reply.costUsd;
      row.latencyMs += reply.latencyMs;
      const answers = new Map(parseJson<{ results: Array<{ i: number; category: string }> }>(reply.content).results.map((r) => [r.i, r.category]));
      batch.forEach((item, i) => {
        const got = answers.get(i) ?? '(missing)';
        if (!CATEGORY_NAMES.includes(got)) row.invalid++;
        if (got === item.expected || item.alt?.includes(got)) {
          row.correct++;
          if (item.hard) row.hardCorrect++;
        }
        else row.wrong.push({ text: item.text, got, expected: item.expected });
      });
    } catch (error) {
      if (error instanceof BudgetExceeded) throw error;
      row.errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return row;
}

const only = process.argv.slice(2);
const models = only.length > 0 ? only : CATEGORIZER_MODELS;
const rows: Row[] = [];
try {
  // Three at a time keeps the run short without hammering one provider.
  for (let i = 0; i < models.length; i += 3) {
    rows.push(...(await Promise.all(models.slice(i, i + 3).map(evaluate))));
  }
} catch (error) {
  if (!(error instanceof BudgetExceeded)) throw error;
  console.error(error.message);
}

const hardTotal = DATASET.filter((i) => i.hard).length;
const easyTotal = DATASET.length - hardTotal;
rows.sort((a, b) => b.correct - a.correct || a.costUsd - b.costUsd);
console.log(`\nmodel`.padEnd(46), `easy(${easyTotal})  hard(${hardTotal})  invalid  cost/run   per 1633 txs  latency/call`);
for (const r of rows) {
  const calls = Math.ceil(DATASET.length / BATCH);
  const projected = (r.costUsd / DATASET.length) * REAL_TRANSACTIONS;
  console.log(
    r.model.padEnd(45),
    `${(((r.correct - r.hardCorrect) / easyTotal) * 100).toFixed(1)}%`.padStart(8),
    `${((r.hardCorrect / hardTotal) * 100).toFixed(1)}%`.padStart(9),
    String(r.invalid).padStart(8),
    `$${r.costUsd.toFixed(4)}`.padStart(9),
    `$${projected.toFixed(3)}`.padStart(13),
    `${Math.round(r.latencyMs / calls)} ms`.padStart(13),
    r.errors.length > 0 ? `  errors: ${r.errors.length} (${r.errors[0]?.slice(0, 70)})` : '',
  );
}
console.log(`\nspent US$ ${budget.spent.toFixed(4)} of US$ ${budget.cap.toFixed(2)}`);
mkdirSync('eval/results', { recursive: true });
writeFileSync(`eval/results/categorize-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(rows, null, 2));
