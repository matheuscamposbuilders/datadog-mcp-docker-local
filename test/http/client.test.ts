import { describe, expect, it, vi } from 'vitest';
import { createDatadogClient } from '../../src/http/datadog-client.js';
import { DatadogApiError, ForbiddenRequestError, ResponseTooLargeError } from '../../src/http/errors.js';
import { createFetchStub } from '../helpers/fetch-stub.js';
import type { DatadogConfig } from '../../src/contracts.js';

function makeConfig(overrides: Partial<DatadogConfig> = {}): DatadogConfig {
  return {
    site: 'datadoghq.com',
    baseUrl: 'https://api.datadoghq.com',
    apiKey: 'test-api-key-0123456789',
    appKey: 'test-app-key-0123456789',
    requestTimeoutMs: 30000,
    maxRetries: 3,
    maxRetryWaitMs: 30000,
    maxConcurrency: 4,
    maxResponseBytes: 100000,
    logLevel: 'silent',
    ...overrides,
  };
}

describe('createDatadogClient — headers', () => {
  it('sends the correct headers on GET (no Content-Type)', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, body: {} });
    const cfg = makeConfig();
    const client = createDatadogClient(cfg, stub.fetch);

    await client.get('/api/v1/validate');

    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0]!;
    expect(call.method).toBe('GET');
    expect(call.headers['dd-api-key']).toBe(cfg.apiKey);
    expect(call.headers['dd-application-key']).toBe(cfg.appKey);
    expect(call.headers['accept']).toBe('application/json');
    expect(call.headers['content-type']).toBeUndefined();
  });

  it('sends the correct headers on POST (including Content-Type)', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, body: { data: [] } });
    const cfg = makeConfig();
    const client = createDatadogClient(cfg, stub.fetch);

    await client.postSearch('/api/v2/logs/events/search', { filter: {} });

    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.headers['dd-api-key']).toBe(cfg.apiKey);
    expect(call.headers['dd-application-key']).toBe(cfg.appKey);
    expect(call.headers['accept']).toBe('application/json');
    expect(call.headers['content-type']).toBe('application/json');
  });
});

describe('createDatadogClient — query params', () => {
  it('encodes query values and omits keys whose value is undefined', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, body: {} });
    const cfg = makeConfig();
    const client = createDatadogClient(cfg, stub.fetch);

    await client.get('/api/v1/query', {
      query: 'avg:system.cpu{*}',
      from: 100,
      to: undefined,
      exact: true,
    });

    expect(stub.calls).toHaveLength(1);
    const url = new URL(stub.calls[0]!.url);
    expect(url.searchParams.get('query')).toBe('avg:system.cpu{*}');
    expect(url.searchParams.get('from')).toBe('100');
    expect(url.searchParams.has('to')).toBe(false);
    expect(url.searchParams.get('exact')).toBe('true');
  });
});

describe('createDatadogClient — postSearch body', () => {
  it('serializes exactly the given body, nothing merged in', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, body: { data: [] } });
    const cfg = makeConfig();
    const client = createDatadogClient(cfg, stub.fetch);

    const body = {
      filter: { query: 'service:foo', from: 'now-15m', to: 'now' },
      page: { limit: 10 },
    };
    await client.postSearch('/api/v2/logs/events/search', body);

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.body).toEqual(body);
  });
});

describe('createDatadogClient — allowlist enforcement', () => {
  it('postSearch on a route that is not POST-allowlisted throws before any network call', async () => {
    const stub = createFetchStub();
    const cfg = makeConfig();
    const client = createDatadogClient(cfg, stub.fetch);

    await expect(client.postSearch('/api/v1/monitor', { foo: 'bar' })).rejects.toThrow(
      ForbiddenRequestError,
    );
    expect(stub.calls).toHaveLength(0);
  });

  it('get on a route that is not allowlisted at all throws before any network call', async () => {
    const stub = createFetchStub();
    const cfg = makeConfig();
    const client = createDatadogClient(cfg, stub.fetch);

    await expect(client.get('/api/v1/user')).rejects.toThrow(ForbiddenRequestError);
    expect(stub.calls).toHaveLength(0);
  });
});

describe('createDatadogClient — error mapping', () => {
  it('403 cites the route scopes in the error message', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 403, body: { errors: ['Forbidden'] } });
    const cfg = makeConfig({ maxRetries: 0 });
    const client = createDatadogClient(cfg, stub.fetch);

    await expect(client.get('/api/v1/query')).rejects.toThrow(/timeseries_query/);
  });

  it.each([400, 404])('status %i is a DatadogApiError with no retry', async (status) => {
    const stub = createFetchStub();
    stub.enqueue({ status });
    const cfg = makeConfig({ maxRetries: 3 });
    const client = createDatadogClient(cfg, stub.fetch);

    await expect(client.get('/api/v1/validate')).rejects.toThrow(DatadogApiError);
    expect(stub.calls).toHaveLength(1);
  });

  it('a non-JSON 200 body becomes a DatadogApiError, never a raw SyntaxError', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, bodyText: 'not json' });
    const cfg = makeConfig({ maxRetries: 0 });
    const client = createDatadogClient(cfg, stub.fetch);

    let caught: unknown;
    try {
      await client.get('/api/v1/validate');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DatadogApiError);
    expect(caught).not.toBeInstanceOf(SyntaxError);
  });

  it('throws ResponseTooLargeError when the body exceeds maxResponseBytes', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, bodyText: 'x'.repeat(200) });
    const cfg = makeConfig({ maxResponseBytes: 50, maxRetries: 0 });
    const client = createDatadogClient(cfg, stub.fetch);

    await expect(client.get('/api/v1/validate')).rejects.toThrow(ResponseTooLargeError);
  });
});

describe('createDatadogClient — retries', () => {
  it('retries a 429 with Retry-After and succeeds on the second attempt', async () => {
    vi.useFakeTimers();
    try {
      const stub = createFetchStub();
      stub.enqueue({ status: 429, headers: { 'Retry-After': '1' } });
      stub.enqueue({ status: 200, body: { ok: true } });
      const cfg = makeConfig({ maxRetries: 3 });
      const client = createDatadogClient(cfg, stub.fetch);

      const promise = client.get<{ ok: boolean }>('/api/v1/validate');
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;

      expect(result).toEqual({ ok: true });
      expect(stub.calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('exhausts maxRetries on repeated 5xx and throws', async () => {
    vi.useFakeTimers();
    try {
      const stub = createFetchStub();
      stub.setDefault({ status: 503 });
      const cfg = makeConfig({ maxRetries: 2 });
      const client = createDatadogClient(cfg, stub.fetch);

      const promise = client.get('/api/v1/validate');
      const assertion = expect(promise).rejects.toThrow(DatadogApiError);
      await vi.runAllTimersAsync();
      await assertion;

      // attempts 0, 1, 2 => 2 retries after the first failure => 3 calls total.
      expect(stub.calls).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createDatadogClient — concurrency', () => {
  it('never exceeds maxConcurrency in-flight requests', async () => {
    const stub = createFetchStub();
    stub.setDefault({ status: 200, body: {} });

    let active = 0;
    let maxActive = 0;
    const trackingFetch: typeof fetch = async (input, init) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      try {
        return await stub.fetch(input, init);
      } finally {
        active -= 1;
      }
    };

    const cfg = makeConfig({ maxConcurrency: 4, maxRetries: 0 });
    const client = createDatadogClient(cfg, trackingFetch);

    await Promise.all(Array.from({ length: 10 }, () => client.get('/api/v1/validate')));

    expect(maxActive).toBeLessThanOrEqual(4);
    expect(maxActive).toBeGreaterThan(1);
    expect(stub.calls).toHaveLength(10);
  });
});

describe('createDatadogClient — redirects', () => {
  it('passes redirect: "error" to fetchImpl so redirects are never followed internally', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, body: {} });
    const recordedInits: RequestInit[] = [];
    const recordingFetch: typeof fetch = (input, init) => {
      recordedInits.push(init ?? {});
      return stub.fetch(input, init);
    };
    const cfg = makeConfig();
    const client = createDatadogClient(cfg, recordingFetch);

    await client.get('/api/v1/validate');

    expect(recordedInits).toHaveLength(1);
    expect(recordedInits[0]!.redirect).toBe('error');
  });

  it('propagates a fetchImpl redirect rejection without retrying', async () => {
    let calls = 0;
    const redirectRejectingFetch: typeof fetch = () => {
      calls += 1;
      // Mirrors what a real fetch does with redirect: 'error' on a 3xx.
      return Promise.reject(new TypeError('Failed to fetch: unsafe redirect'));
    };
    const cfg = makeConfig({ maxRetries: 3 });
    const client = createDatadogClient(cfg, redirectRejectingFetch);

    await expect(client.get('/api/v1/validate')).rejects.toThrow(TypeError);
    expect(calls).toBe(1);
  });

  it('a 3xx Response handed back by the stub becomes a DatadogApiError, not a followed redirect', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 302, headers: { Location: 'https://evil.example/steal' } });
    const cfg = makeConfig({ maxRetries: 3 });
    const client = createDatadogClient(cfg, stub.fetch);

    await expect(client.get('/api/v1/validate')).rejects.toThrow(DatadogApiError);
    // No retry for a redirect status, and the stub only ever recorded the
    // single original request — nothing was sent to the Location host.
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.url).toContain('api.datadoghq.com');
  });
});

describe('createDatadogClient — timeout', () => {
  function toRejectionError(reason: unknown): Error {
    return reason instanceof Error ? reason : new Error('Aborted', { cause: reason });
  }

  it('rejects via abort when requestTimeoutMs elapses before the response arrives', async () => {
    const hangingFetch: typeof fetch = (_input, init) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          if (signal.aborted) {
            reject(toRejectionError(signal.reason as unknown));
            return;
          }
          signal.addEventListener(
            'abort',
            () => {
              reject(toRejectionError(signal.reason as unknown));
            },
            { once: true },
          );
        }
      });
    };

    const cfg = makeConfig({ requestTimeoutMs: 20, maxRetries: 0 });
    const client = createDatadogClient(cfg, hangingFetch);

    await expect(client.get('/api/v1/validate')).rejects.toThrow();
  });
});
