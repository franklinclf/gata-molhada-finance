import type { HttpClient, HttpRequestOptions, HttpResponse } from '../../src/core/http.ts';

export interface FakeRoute {
  method: string;
  /** Matched against the full URL: a string means "ends with", a RegExp is tested as is. */
  match: string | RegExp;
  respond: (url: string, options?: HttpRequestOptions) => HttpResponse;
}

export interface RecordedCall {
  method: string;
  url: string;
  options?: HttpRequestOptions;
}

/** Scripted network: routes are tried in order, and a request that matches none fails the test. */
export class FakeHttp implements HttpClient {
  readonly calls: RecordedCall[] = [];
  private readonly routes: FakeRoute[];

  constructor(routes: FakeRoute[]) {
    this.routes = routes;
  }

  async request(method: string, url: string, options?: HttpRequestOptions): Promise<HttpResponse> {
    this.calls.push({ method, url, options });
    const route = this.routes.find(
      (r) => r.method === method && (typeof r.match === 'string' ? url.endsWith(r.match) : r.match.test(url)),
    );
    if (!route) throw new Error(`FakeHttp: no route for ${method} ${url}`);
    return route.respond(url, options);
  }

  callsTo(method: string, fragment: string): RecordedCall[] {
    return this.calls.filter((c) => c.method === method && c.url.includes(fragment));
  }
}

export function ok(body: unknown): HttpResponse {
  return { status: 200, body };
}
