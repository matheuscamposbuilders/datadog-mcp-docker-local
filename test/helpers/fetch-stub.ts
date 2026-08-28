/**
 * Shared test infrastructure: a drop-in `fetch` stub for exercising the
 * Datadog HTTP client without any real network I/O.
 *
 * Other slices should import this rather than reinventing a fetch stub.
 */

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface StubResponse {
  /** HTTP status code. Defaults to 200. */
  status?: number;
  /** Serialized as JSON in the response body. */
  body?: unknown;
  headers?: Record<string, string>;
  /** Alternative to `body`, for testing invalid/non-JSON payloads. */
  bodyText?: string;
}

export interface FetchStub {
  readonly calls: readonly RecordedRequest[];
  /** Enqueues a response. Consumed in FIFO order. */
  enqueue(res: StubResponse): void;
  /** Response used once the queue is empty. Throws if unset. */
  setDefault(res: StubResponse): void;
  /** The function to pass as `fetchImpl` to createDatadogClient. */
  readonly fetch: typeof fetch;
  reset(): void;
}

function extractUrl(input: string | URL | Request): string {
  if (input instanceof Request) {
    return input.url;
  }
  return input.toString();
}

function extractHeaders(input: string | URL | Request, init: RequestInit | undefined): Record<string, string> {
  const merged = new Headers();
  if (input instanceof Request) {
    input.headers.forEach((value, key) => merged.set(key, value));
  }
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => merged.set(key, value));
  }
  const headers: Record<string, string> = {};
  merged.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

function extractBody(init: RequestInit | undefined): unknown {
  const raw = init?.body;
  if (typeof raw !== 'string') {
    return raw ?? undefined;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export function createFetchStub(): FetchStub {
  const queue: StubResponse[] = [];
  let defaultResponse: StubResponse | undefined;
  const calls: RecordedRequest[] = [];

  const stubFetch: typeof fetch = (input, init) => {
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const url = extractUrl(input);
    const headers = extractHeaders(input, init);
    const body = extractBody(init);

    const recorded: RecordedRequest = { method, url, headers };
    if (body !== undefined) {
      recorded.body = body;
    }
    calls.push(recorded);

    const next = queue.shift() ?? defaultResponse;
    if (!next) {
      return Promise.reject(
        new Error(`FetchStub: unexpected request ${method} ${url} — no enqueued response and no default set.`),
      );
    }

    const status = next.status ?? 200;
    const responseHeaders = next.headers ?? {};
    const responseBody =
      next.bodyText !== undefined ? next.bodyText : next.body !== undefined ? JSON.stringify(next.body) : null;

    return Promise.resolve(new Response(responseBody, { status, headers: responseHeaders }));
  };

  return {
    get calls() {
      return calls;
    },
    enqueue(res: StubResponse) {
      queue.push(res);
    },
    setDefault(res: StubResponse) {
      defaultResponse = res;
    },
    fetch: stubFetch,
    reset() {
      queue.length = 0;
      defaultResponse = undefined;
      calls.length = 0;
    },
  };
}

/** Installs onto globalThis.fetch and returns a restore function. Prefer injection via fetchImpl. */
export function installGlobalFetchStub(stub: FetchStub): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = stub.fetch;
  return () => {
    globalThis.fetch = original;
  };
}
