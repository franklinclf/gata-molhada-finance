export interface ChatResult {
  content: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  latencyMs: number;
}

export class BudgetExceeded extends Error {}

/** A call that was paid for but gave nothing usable (empty answer, for example). The cost still counts against the budget. */
export class ChatError extends Error {
  readonly costUsd: number;
  constructor(message: string, costUsd: number) {
    super(message);
    this.name = 'ChatError';
    this.costUsd = costUsd;
  }
}

/** What a failed call cost, so the caller can record it. Zero for errors that were never billed. */
export function costOfFailure(error: unknown): number {
  return error instanceof ChatError ? error.costUsd : 0;
}

export interface KeyUsage {
  /** Spent this UTC month by every request made with the key, whoever made it. */
  monthlyUsd: number;
  dailyUsd: number;
}

/** Asks OpenRouter what the key spent. This is the number its dashboard shows, including calls made outside this app. */
export async function fetchKeyUsage(apiKey: string, http: typeof fetch = fetch): Promise<KeyUsage> {
  const response = await http('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = ((await response.json()) as { data?: { usage_monthly?: unknown; usage_daily?: unknown } }).data;
  if (typeof data?.usage_monthly !== 'number') throw new Error('no usage_monthly in the answer');
  return { monthlyUsd: data.usage_monthly, dailyUsd: typeof data.usage_daily === 'number' ? data.usage_daily : 0 };
}

/** Keeps a running total of what the calls cost and stops when the cap is reached. */
export class Budget {
  spent = 0;
  readonly cap: number;
  constructor(cap: number) {
    this.cap = cap;
  }
  add(usd: number): void {
    this.spent += usd;
    if (this.spent > this.cap) throw new BudgetExceeded(`budget of US$ ${this.cap.toFixed(2)} reached (spent US$ ${this.spent.toFixed(4)})`);
  }
}

export interface ChatOptions {
  model: string;
  system: string;
  user: string;
  /** JSON schema of the answer. Models that cannot use it are asked for JSON in the prompt instead. */
  schema?: { name: string; schema: Record<string, unknown> };
  maxTokens?: number;
  /** Models that think before answering get a small budget for it, so the test measures the cheap setting. */
  reasoning?: boolean | 'low' | 'medium';
}

/** One chat call through OpenRouter. The providers are told not to keep or train on the data. */
/** What the app needs from a model: send a prompt, get text and its cost. Tests supply a fake one. */
export type AiClient = (options: ChatOptions) => Promise<ChatResult>;

export function openRouterClient(apiKey: string): AiClient {
  return (options) => chat(apiKey, options);
}

export async function chat(apiKey: string, options: ChatOptions): Promise<ChatResult> {
  const body: Record<string, unknown> = {
    model: options.model,
    messages: [
      { role: 'system', content: options.system },
      { role: 'user', content: options.user },
    ],
    temperature: 0,
    max_tokens: options.maxTokens ?? 4000,
    usage: { include: true },
    provider: { data_collection: 'deny', require_parameters: false },
  };
  if (options.schema) body.response_format = { type: 'json_schema', json_schema: { name: options.schema.name, strict: true, schema: options.schema.schema } };
  if (options.reasoning) body.reasoning = { effort: options.reasoning === true ? 'low' : options.reasoning };

  const started = Date.now();
  let response = await send(apiKey, body);
  // Some models refuse the reasoning or schema settings; ask again without them rather than losing the data point.
  if (response.status === 400 && (body.reasoning !== undefined || body.response_format !== undefined)) {
    delete body.reasoning;
    delete body.response_format;
    body.messages = [{ role: 'system', content: `${options.system}\nAnswer with JSON only.` }, { role: 'user', content: options.user }];
    response = await send(apiKey, body);
  }
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} ${text.slice(0, 200)}`);
  const data = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number } };
  const content = data.choices?.[0]?.message?.content ?? '';
  // A model that spends its whole allowance thinking returns nothing, and OpenRouter still bills the thinking.
  if (!content) throw new ChatError('empty answer', data.usage?.cost ?? 0);
  return {
    content,
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
    costUsd: data.usage?.cost ?? 0,
    latencyMs: Date.now() - started,
  };
}

/** Asks again, waiting a little longer each time, when the provider says it is busy (429) or fails (5xx). */
async function send(apiKey: string, body: Record<string, unknown>): Promise<Response> {
  for (const wait of [2000, 6000, 15000, 0]) {
    const response = await once(apiKey, body);
    if (wait === 0 || (response.status !== 429 && response.status < 500)) return response;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  throw new Error('unreachable');
}

function once(apiKey: string, body: Record<string, unknown>): Promise<Response> {
  return fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'Gata Molhada Finance evaluation' },
    body: JSON.stringify(body),
  });
}

/** Takes the first JSON object out of an answer, even when the model wrapped it in a code fence or text. */
export function parseJson<T>(content: string): T {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('no JSON in the answer');
  return JSON.parse(content.slice(start, end + 1)) as T;
}
