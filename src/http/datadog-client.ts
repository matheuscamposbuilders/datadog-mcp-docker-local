/**
 * The Datadog HTTP chokepoint.
 *
 * This is the ONLY place in the codebase (besides src/security/preload.ts)
 * permitted to touch the `fetch` global — see eslint.config.js's
 * `no-restricted-*` overrides for `src/http/datadog-client.ts`. Every byte
 * this server ever sends to or receives from Datadog passes through
 * `performRequest` below. Do not reorder its steps; each one closes a
 * specific class of bug (see inline comments).
 */
import type { AllowedRoute, DatadogClient, DatadogConfig, HttpMethod } from '../contracts.js';
import { assertAllowed, assertAllowedUrl } from '../security/allowlist.js';
import { DatadogApiError, ResponseTooLargeError } from './errors.js';
import { computeRetryDelayMs } from './retry.js';

type QueryValue = string | number | boolean | undefined;
type QueryParams = Record<string, QueryValue>;

/** Simple FIFO semaphore. No external dependency, just a queue of resolvers. */
class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve(() => {
        this.release();
      });
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve(() => {
          this.release();
        });
      });
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) {
      next();
    }
  }
}

/** Appends query params to `url` in place, skipping `undefined` values. */
function appendQuery(url: URL, query: QueryParams | undefined): void {
  if (!query) {
    return;
  }
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) {
      continue;
    }
    url.searchParams.set(key, String(value));
  }
}

function buildHeaders(cfg: DatadogConfig, method: HttpMethod): Headers {
  const headers = new Headers();
  headers.set('DD-API-KEY', cfg.apiKey);
  headers.set('DD-APPLICATION-KEY', cfg.appKey);
  headers.set('Accept', 'application/json');
  if (method === 'POST') {
    headers.set('Content-Type', 'application/json');
  }
  return headers;
}

/** Combines the per-request timeout signal with the caller's signal, if any. */
function buildRequestSignal(cfg: DatadogConfig, callerSignal: AbortSignal | undefined): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(cfg.requestTimeoutMs);
  return callerSignal ? AbortSignal.any([timeoutSignal, callerSignal]) : timeoutSignal;
}

async function fetchOnce(
  fetchImpl: typeof fetch,
  url: URL,
  method: HttpMethod,
  headers: Headers,
  body: string | undefined,
  cfg: DatadogConfig,
  callerSignal: AbortSignal | undefined,
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers,
    // Never follow redirects. A 3xx would otherwise be followed inside
    // fetch itself — re-sending DD-API-KEY/DD-APPLICATION-KEY to whatever
    // host the Location header names, AFTER our allowlist checks (and the
    // L4 global-fetch guard) have already run, with neither able to see
    // the second request because fetch issues it internally. No read-only
    // Datadog endpoint legitimately redirects, so treating 3xx as a hard
    // failure costs nothing and closes a credential-exfiltration path.
    redirect: 'error',
    signal: buildRequestSignal(cfg, callerSignal),
  };
  if (body !== undefined) {
    init.body = body;
  }
  return fetchImpl(url, init);
}

/** Normalizes an AbortSignal's `reason` (typed `any`) to a real `Error`. */
function toAbortError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error('Aborted', { cause: reason });
}

/** Resolves after `delayMs`, or rejects early if `signal` aborts first. */
function waitFor(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(toAbortError(signal.reason as unknown));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    function onAbort(): void {
      clearTimeout(timer);
      reject(toAbortError(signal?.reason as unknown));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Reads the response body as text, enforcing `cfg.maxResponseBytes`.
 *
 * Checks `Content-Length` first (when present) to reject oversized bodies
 * before spending time draining them, then re-checks the actual decoded
 * UTF-8 byte length after reading — `Content-Length` can be absent,
 * wrong, or the stub/server can lie about it.
 */
async function readBodyText(response: Response, cfg: DatadogConfig): Promise<string> {
  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader !== null) {
    const contentLength = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(contentLength) && contentLength > cfg.maxResponseBytes) {
      throw new ResponseTooLargeError(cfg.maxResponseBytes, contentLength);
    }
  }

  const text = await response.text();
  const actualBytes = new TextEncoder().encode(text).byteLength;
  if (actualBytes > cfg.maxResponseBytes) {
    throw new ResponseTooLargeError(cfg.maxResponseBytes, actualBytes);
  }
  return text;
}

function parseJsonOrThrow<T>(text: string, status: number): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    // Never let a raw SyntaxError reach the caller — a 2xx (or any) status
    // with a non-JSON body is itself an API-shape error worth surfacing as
    // such, not a parser crash.
    throw new DatadogApiError({
      status,
      message: `Datadog API returned a non-JSON body for a ${status} response.`,
    });
  }
}

/** Best-effort extraction of Datadog's own `errors: string[]` field, if present. */
function extractDdErrors(text: string): string[] {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object' && 'errors' in parsed) {
      const errors = (parsed as { errors?: unknown }).errors;
      if (Array.isArray(errors)) {
        return errors.filter((entry): entry is string => typeof entry === 'string');
      }
    }
  } catch {
    // Non-JSON (or unexpectedly shaped) error body: nothing structured to extract.
  }
  return [];
}

function buildApiError(text: string, response: Response, route: AllowedRoute): DatadogApiError {
  const ddErrors = extractDdErrors(text);
  const requestId = response.headers.get('x-request-id');

  if (response.status === 403) {
    const scopesLabel = route.scopes.length > 0 ? route.scopes.join(', ') : '(nenhum escopo específico)';
    return new DatadogApiError({
      status: response.status,
      ddErrors,
      ...(requestId !== null ? { requestId } : {}),
      message: `App Key não tem o scope necessário: ${scopesLabel}. Ver README §Scopes.`,
    });
  }

  return new DatadogApiError({
    status: response.status,
    ddErrors,
    ...(requestId !== null ? { requestId } : {}),
  });
}

interface RequestSpec {
  readonly method: HttpMethod;
  readonly path: string;
  readonly query?: QueryParams;
  readonly body?: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}

async function performRequest<T>(
  cfg: DatadogConfig,
  fetchImpl: typeof fetch,
  semaphore: Semaphore,
  spec: RequestSpec,
): Promise<T> {
  // 1. Allowlist check FIRST, before any URL is assembled. Guard the
  // AllowedRoute so its scopes can be cited in a 403 error message below.
  const route = assertAllowed(spec.method, spec.path);

  // 2. Build the URL. `new URL(path, cfg.baseUrl)` — path is relative to
  // the configured Datadog site's base URL.
  const url = new URL(spec.path, cfg.baseUrl);
  appendQuery(url, spec.query);

  // 3. Re-validate the fully assembled URL as a final check. `expectedHost`
  // is derived from cfg.baseUrl, which never carries a port; `url.host`
  // includes a port when one is present, so this comparison is fail-closed
  // — if a port ever sneaks into baseUrl, requests are blocked rather than
  // silently allowed. That's intentional, not a bug.
  const expectedHost = new URL(cfg.baseUrl).host;
  assertAllowedUrl(spec.method, url.toString(), expectedHost);

  // 4. Headers.
  const headers = buildHeaders(cfg, spec.method);

  // postSearch's sole obligation for the body: serialize exactly what was
  // passed, nothing merged in from elsewhere. This is the only place a
  // request body is ever stringified.
  const serializedBody = spec.body === undefined ? undefined : JSON.stringify(spec.body);

  const release = await semaphore.acquire();
  try {
    let attempt = 0;
    for (;;) {
      const response = await fetchOnce(
        fetchImpl,
        url,
        spec.method,
        headers,
        serializedBody,
        cfg,
        spec.signal,
      );

      // Defensive, explicit gate: with `redirect: 'error'` above, a real
      // `fetch` implementation should already reject before we ever see a
      // 3xx Response object here. This check exists in case some runtime
      // or test double hands back a 3xx Response instead of rejecting —
      // never retry it, and never let it fall through to being parsed as a
      // successful body. `response.ok` is already `false` for 3xx, so this
      // was previously handled correctly further down only as a side
      // effect of `computeRetryDelayMs` returning `null` for a non-429,
      // non-5xx status; making it its own branch turns that into an
      // explicit decision instead of an accident of the retry table.
      if (response.status >= 300 && response.status < 400) {
        throw new DatadogApiError({
          status: response.status,
          message: `Datadog API responded with an unexpected redirect (status ${response.status}). Redirects are never followed.`,
        });
      }

      if (response.ok) {
        const text = await readBodyText(response, cfg);
        return parseJsonOrThrow<T>(text, response.status);
      }

      const text = await readBodyText(response, cfg);
      const apiError = buildApiError(text, response, route);

      const delayMs = computeRetryDelayMs(response.status, response.headers, attempt, cfg);
      if (delayMs === null) {
        throw apiError;
      }
      await waitFor(delayMs, spec.signal);
      attempt += 1;
    }
  } finally {
    release();
  }
}

/**
 * Builds the single Datadog HTTP client instance for this server.
 *
 * `fetchImpl` defaults to `globalThis.fetch` read AT CALL TIME (never
 * captured at construction time) — the bootstrap injects the pre-patch
 * `fetch` reference captured by the L4 preload guard here. If the L4 guard
 * is also active on `globalThis.fetch`, a request gets validated twice
 * (once by this file's own allowlist checks, once by the guard). That is
 * intentional defense-in-depth, not redundancy to "optimize" away.
 */
export function createDatadogClient(cfg: DatadogConfig, fetchImpl?: typeof fetch): DatadogClient {
  const semaphore = new Semaphore(cfg.maxConcurrency);

  function resolveFetch(): typeof fetch {
    return fetchImpl ?? globalThis.fetch;
  }

  return {
    get<T>(
      path: string,
      query?: Record<string, string | number | boolean | undefined>,
      opts?: { signal?: AbortSignal },
    ): Promise<T> {
      return performRequest<T>(cfg, resolveFetch(), semaphore, {
        method: 'GET',
        path,
        ...(query !== undefined ? { query } : {}),
        ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
      });
    },
    postSearch<T>(
      path: string,
      body: Readonly<Record<string, unknown>>,
      opts?: { signal?: AbortSignal },
    ): Promise<T> {
      return performRequest<T>(cfg, resolveFetch(), semaphore, {
        method: 'POST',
        path,
        body,
        ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
      });
    },
  };
}
