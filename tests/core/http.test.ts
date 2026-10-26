import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryingClient, SourceHttpError, type HttpClient } from '../../src/core/http.ts';

function scripted(responses: Array<number | Error>, calls: string[]): HttpClient {
  let index = 0;
  return {
    async request(method, url) {
      calls.push(`${method} ${url}`);
      const next = responses[Math.min(index++, responses.length - 1)];
      if (next instanceof Error) throw next;
      return { status: next as number, body: { ok: next === 200 } };
    },
  };
}

const noSleep = async () => {};

test('retries a GET on 503 and returns the first good answer', async () => {
  const calls: string[] = [];
  const client = retryingClient(scripted([503, 503, 200], calls), { sleep: noSleep });
  const res = await client.request('GET', 'https://x.test/a');
  assert.equal(res.status, 200);
  assert.equal(calls.length, 3);
});

test('returns the last response when every attempt fails with 5xx', async () => {
  const calls: string[] = [];
  const client = retryingClient(scripted([500], calls), { attempts: 3, sleep: noSleep });
  const res = await client.request('GET', 'https://x.test/a');
  assert.equal(res.status, 500);
  assert.equal(calls.length, 3);
});

test('retries network errors and finally throws the last one', async () => {
  const calls: string[] = [];
  const client = retryingClient(scripted([new Error('reset')], calls), { attempts: 2, sleep: noSleep });
  await assert.rejects(client.request('GET', 'https://x.test/a'), /reset/);
  assert.equal(calls.length, 2);
});

test('does not retry client errors', async () => {
  const calls: string[] = [];
  const client = retryingClient(scripted([404], calls), { sleep: noSleep });
  const res = await client.request('GET', 'https://x.test/a');
  assert.equal(res.status, 404);
  assert.equal(calls.length, 1);
});

test('never retries non-GET requests', async () => {
  const calls: string[] = [];
  const client = retryingClient(scripted([503, 200], calls), { sleep: noSleep });
  const res = await client.request('POST', 'https://x.test/refresh');
  assert.equal(res.status, 503);
  assert.equal(calls.length, 1);
});

test('waits longer after each failed attempt', async () => {
  const waits: number[] = [];
  const client = retryingClient(scripted([500, 500, 200], []), {
    baseDelayMs: 100,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  await client.request('GET', 'https://x.test/a');
  assert.deepEqual(waits, [100, 200]);
});

test('SourceHttpError carries the status and url', () => {
  const error = new SourceHttpError(401, 'https://x.test/a');
  assert.equal(error.status, 401);
  assert.match(error.message, /HTTP 401/);
});
