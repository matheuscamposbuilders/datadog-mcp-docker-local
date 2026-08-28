/**
 * Cross-layer adversarial suite: attacks a REAL `DatadogClient`
 * (`createDatadogClient` from `src/http/datadog-client.ts`), not the
 * allowlist functions in isolation — those already have dedicated unit
 * coverage in `test/security/allowlist.test.ts` and
 * `test/security/fetch-guard.test.ts`, which this file does not duplicate.
 *
 * Every negative case here asserts TWO things: the call rejects, AND
 * `stub.calls.length === 0` — nothing left the process. A test that only
 * checked "it rejected" could pass even if the rejection happened after an
 * outbound request had already been issued (e.g. a bug caught late by
 * response handling instead of by the allowlist). Checking `stub.calls`
 * is what actually proves "nothing hit the network."
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createDatadogClient } from '../../src/http/datadog-client.js';
import { ForbiddenRequestError } from '../../src/http/errors.js';
import { ALLOWED_ROUTES } from '../../src/security/allowlist.js';
import { installFetchGuard, uninstallFetchGuard } from '../../src/security/preload.js';
import { createFetchStub } from '../helpers/fetch-stub.js';
import type { DatadogConfig } from '../../src/contracts.js';

function makeConfig(overrides: Partial<DatadogConfig> = {}): DatadogConfig {
  return {
    site: 'datadoghq.com',
    baseUrl: 'https://api.datadoghq.com',
    apiKey: 'test-api-key-0123456789',
    appKey: 'test-app-key-0123456789',
    requestTimeoutMs: 30000,
    maxRetries: 0,
    maxRetryWaitMs: 30000,
    maxConcurrency: 4,
    maxResponseBytes: 100000,
    logLevel: 'silent',
    ...overrides,
  };
}

/**
 * Derives a concrete, matching example path from an `AllowedRoute`'s
 * pattern, so the method x route matrix below is generated FROM
 * `ALLOWED_ROUTES` itself rather than from a hand-maintained parallel list —
 * a route added in the future is picked up automatically as long as it
 * reuses the two parameterized segment shapes this codebase already has
 * (`MONITOR_ID`'s `\d{1,20}` and `METRIC_NAME`'s `[A-Za-z0-9_.]{1,200}`, see
 * src/security/allowlist.ts). Routes built from a plain regex literal store
 * escaped `\/` in `.source`; routes built via `new RegExp(templateString)`
 * store plain `/`. Both are normalized to `/` here before the fixed-length
 * segments are substituted.
 */
function examplePathFor(pattern: RegExp): string {
  let src = pattern.source;
  if (src.startsWith('^')) {
    src = src.slice(1);
  }
  if (src.endsWith('$')) {
    src = src.slice(0, -1);
  }
  src = src.replace(/\\\//g, '/');
  src = src.replace(/\\d\{1,20\}/g, '1');
  src = src.replace(/\[A-Za-z0-9_.\]\{1,200\}/g, 'metric.name');
  return src;
}

describe('matrix: every ALLOWED_ROUTES entry x every client method (derived programmatically)', () => {
  for (const route of ALLOWED_ROUTES) {
    const path = examplePathFor(route.pattern);
    const wrongMethod = route.method === 'GET' ? 'postSearch' : 'get';

    it(`${route.id}: ${route.method} ${path} via its own client method succeeds`, async () => {
      const stub = createFetchStub();
      stub.enqueue({ status: 200, body: {} });
      const client = createDatadogClient(makeConfig(), stub.fetch);

      if (route.method === 'GET') {
        await expect(client.get(path)).resolves.toBeDefined();
      } else {
        await expect(client.postSearch(path, {})).resolves.toBeDefined();
      }
      expect(stub.calls).toHaveLength(1);
    });

    it(`${route.id}: ${path} via the WRONG client method (${wrongMethod}) is rejected with zero network calls`, async () => {
      const stub = createFetchStub();
      const client = createDatadogClient(makeConfig(), stub.fetch);

      if (wrongMethod === 'get') {
        await expect(client.get(path)).rejects.toThrow(ForbiddenRequestError);
      } else {
        await expect(client.postSearch(path, {})).rejects.toThrow(ForbiddenRequestError);
      }
      expect(stub.calls).toHaveLength(0);
    });
  }
});

describe('matrix: real Datadog write routes an attacker would try via postSearch', () => {
  const WRITE_ROUTES: readonly string[] = [
    '/api/v1/monitor',
    '/api/v1/dashboard',
    '/api/v2/logs/config/indexes',
    '/api/v1/downtime',
    '/api/v1/user',
    '/api/v2/api_keys',
  ];

  it.each(WRITE_ROUTES)('POST %s is rejected with zero network calls', async (path) => {
    const stub = createFetchStub();
    const client = createDatadogClient(makeConfig(), stub.fetch);

    await expect(client.postSearch(path, { name: 'evil', message: 'pwned' })).rejects.toThrow(
      ForbiddenRequestError,
    );
    expect(stub.calls).toHaveLength(0);
  });
});

describe('matrix: legitimate-but-out-of-scope Datadog read routes (closed allowlist, not a blocklist)', () => {
  const OUT_OF_SCOPE_GET_ROUTES: readonly string[] = [
    '/api/v1/dashboard',
    '/api/v1/hosts',
    '/api/v2/incidents',
    '/api/v1/slo',
    '/api/v1/user',
  ];

  it.each(OUT_OF_SCOPE_GET_ROUTES)('GET %s is rejected with zero network calls', async (path) => {
    const stub = createFetchStub();
    const client = createDatadogClient(makeConfig(), stub.fetch);

    await expect(client.get(path)).rejects.toThrow(ForbiddenRequestError);
    expect(stub.calls).toHaveLength(0);
  });
});

describe('matrix: path smuggling combined with an allowlisted route as prefix or suffix', () => {
  const SMUGGLING_CASES: ReadonlyArray<[label: string, method: 'GET' | 'POST', path: string]> = [
    ['literal traversal out of query into user', 'GET', '/api/v1/query/../../v1/user'],
    ['literal traversal out of monitor id into user', 'GET', '/api/v1/monitor/1/../../user'],
    ['encoded traversal under an allowlisted prefix', 'GET', '/api/v1/monitor/%2e%2e%2f%2e%2e%2fuser'],
    ['doubled separator after an allowlisted prefix', 'GET', '/api/v1/monitor//1'],
    ['null byte appended to an allowlisted path', 'GET', '/api/v1/query\0'],
    ['embedded CRLF log-injection appended to an allowlisted path', 'GET', '/api/v1/query\r\nGET /api/v1/user'],
    ['backslash smuggling after an allowlisted prefix', 'GET', '/api/v1/monitor\\..\\user'],
    ['protocol-relative host smuggling disguised as a path', 'GET', '//evil.com/api/v1/query'],
    ['traversal out of the search_logs POST route into a write route', 'POST', '/api/v2/logs/events/search/../../v1/user'],
    ['traversal out of the search_spans POST route into monitor create', 'POST', '/api/v2/spans/events/search/../../v1/monitor'],
  ];

  it.each(SMUGGLING_CASES)('%s (%s %s) is rejected with zero network calls', async (_label, method, path) => {
    const stub = createFetchStub();
    const client = createDatadogClient(makeConfig(), stub.fetch);

    if (method === 'GET') {
      await expect(client.get(path)).rejects.toThrow(ForbiddenRequestError);
    } else {
      await expect(client.postSearch(path, {})).rejects.toThrow(ForbiddenRequestError);
    }
    expect(stub.calls).toHaveLength(0);
  });
});

describe('matrix: hostile query-string values never change the resolved route', () => {
  it('a request with hostile characters in query VALUES still hits the exact allowlisted route/host, unmodified', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, body: {} });
    const client = createDatadogClient(makeConfig(), stub.fetch);

    await client.get('/api/v1/query', {
      query: 'a?b#c/d..%00e',
      from: 'https://evil.com/api/v1/user',
      to: '../../../v1/user',
    });

    expect(stub.calls).toHaveLength(1);
    const requestedUrl = new URL(stub.calls[0]!.url);
    expect(requestedUrl.pathname).toBe('/api/v1/query');
    expect(requestedUrl.host).toBe('api.datadoghq.com');
    expect(requestedUrl.protocol).toBe('https:');
  });

  it('hostile values in a POST search body do not change the request path either', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, body: { data: [] } });
    const client = createDatadogClient(makeConfig(), stub.fetch);

    await client.postSearch('/api/v2/logs/events/search', {
      filter: { query: '../../v1/user #evil\0' },
    });

    expect(stub.calls).toHaveLength(1);
    const requestedUrl = new URL(stub.calls[0]!.url);
    expect(requestedUrl.pathname).toBe('/api/v2/logs/events/search');
    expect(requestedUrl.host).toBe('api.datadoghq.com');
  });
});

describe('matrix: L4 fetch guard combined with the real client', () => {
  afterEach(() => {
    uninstallFetchGuard();
  });

  it('a client configured for api.datadoghq.com is barred by a guard installed for a different host', async () => {
    installFetchGuard({ allowHosts: ['other.datadoghq.com'] });
    // Deliberately no fetchImpl override: the client resolves globalThis.fetch
    // AT CALL TIME (see createDatadogClient's resolveFetch), so it picks up
    // the guarded fetch installed above.
    const client = createDatadogClient(makeConfig());

    await expect(client.get('/api/v1/query')).rejects.toThrow(ForbiddenRequestError);
  });
});
