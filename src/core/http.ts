export interface HttpRequestOptions {
  headers?: Record<string, string>;
  body?: unknown;
}

export interface HttpResponse {
  status: number;
  body: unknown;
}

/** Minimal HTTP surface the adapters depend on, so tests can replace the network. */
export interface HttpClient {
  request(method: string, url: string, options?: HttpRequestOptions): Promise<HttpResponse>;
}

/** Receives every raw response an adapter gets, before any normalization. */
export type SnapshotSink = (snapshot: { endpoint: string; httpStatus: number; body: unknown }) => void;

export class SourceHttpError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(status: number, url: string) {
    super(`HTTP ${status} from ${url}`);
    this.name = 'SourceHttpError';
    this.status = status;
    this.url = url;
  }
}

/** The source answered, but not in the shape the adapter expects. */
export class SourceFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceFormatError';
  }
}

export function fetchHttpClient(timeoutMs = 60_000): HttpClient {
  return {
    async request(method, url, options = {}) {
      const headers: Record<string, string> = { ...options.headers };
      let body: string | undefined;
      if (options.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(options.body);
      }
      const response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
      const text = await response.text();
      let parsed: unknown = text;
      try {
        parsed = text === '' ? null : JSON.parse(text);
      } catch {
        // keep the raw text
      }
      return { status: response.status, body: parsed };
    },
  };
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Retries only GET requests, on network errors, 429 and 5xx, with growing waits.
 * Other methods (for example a refresh request) are sent exactly once.
 */
export function retryingClient(inner: HttpClient, options: RetryOptions = {}): HttpClient {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return {
    async request(method, url, requestOptions) {
      if (method !== 'GET') return inner.request(method, url, requestOptions);
      let lastError: unknown;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          const response = await inner.request(method, url, requestOptions);
          const retryable = response.status === 429 || response.status >= 500;
          if (!retryable || attempt === attempts) return response;
        } catch (error) {
          lastError = error;
          if (attempt === attempts) throw error;
        }
        await sleep(baseDelayMs * 2 ** (attempt - 1));
      }
      throw lastError;
    },
  };
}
