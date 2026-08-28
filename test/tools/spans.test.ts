import { describe, expect, it } from 'vitest';
import { buildSpansSearchBody, spansTools } from '../../src/tools/spans.js';
import type { SpansSearchParams } from '../../src/tools/spans.js';
import { createDatadogClient } from '../../src/http/datadog-client.js';
import { ALLOWED_ROUTES } from '../../src/security/allowlist.js';
import { createFetchStub } from '../helpers/fetch-stub.js';
import type { DatadogConfig, ToolContext } from '../../src/contracts.js';
import {
  spansSearchResponseFixture,
  spansSearchResponseNoNextPageFixture,
} from '../fixtures/spans-search-response.js';

const tool = spansTools[0]!;

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
    maxResponseBytes: 200000,
    logLevel: 'silent',
    ...overrides,
  };
}

function makeContext(fetchImpl: typeof fetch, overrides: Partial<DatadogConfig> = {}): ToolContext {
  const config = makeConfig(overrides);
  return { client: createDatadogClient(config, fetchImpl), config };
}

/** Recursively collects every own-enumerable key path in `value`, sorted. */
function collectKeysDeep(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }
  const keys: string[] = [];
  for (const key of Object.keys(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    keys.push(path);
    keys.push(...collectKeysDeep((value as Record<string, unknown>)[key], path));
  }
  return keys.sort();
}

const validParams: SpansSearchParams = {
  query: 'service:api operation_name:http.request',
  from: 'now-15m',
  to: 'now',
  limit: 25,
  sort: '-timestamp',
};

describe('dd_search_spans — transversal contract', () => {
  it('is read-only, has non-empty routeIds, and every routeId is allowlisted', () => {
    expect(spansTools).toHaveLength(1);
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(tool.annotations.destructiveHint).toBe(false);
    expect(tool.routeIds.length).toBeGreaterThan(0);
    for (const routeId of tool.routeIds) {
      expect(ALLOWED_ROUTES.some((route) => route.id === routeId)).toBe(true);
    }
    expect(tool.routeIds).toContain('search_spans');
  });
});

describe('buildSpansSearchBody — nested under data.attributes, built field-by-field', () => {
  it('produces exactly the expected key set for minimal params', () => {
    const body = buildSpansSearchBody(validParams);
    expect(collectKeysDeep(body)).toEqual(
      [
        'data',
        'data.type',
        'data.attributes',
        'data.attributes.filter',
        'data.attributes.filter.query',
        'data.attributes.filter.from',
        'data.attributes.filter.to',
        'data.attributes.page',
        'data.attributes.page.limit',
        'data.attributes.sort',
      ].sort(),
    );
    expect(body).toEqual({
      data: {
        type: 'search_request',
        attributes: {
          filter: { query: validParams.query, from: validParams.from, to: validParams.to },
          page: { limit: validParams.limit },
          sort: validParams.sort,
        },
      },
    });
  });

  it('includes cursor only when provided, still with an exact key set', () => {
    const body = buildSpansSearchBody({ ...validParams, cursor: 'cursor-xyz' });
    expect(collectKeysDeep(body)).toContain('data.attributes.page.cursor');
    const attrs = (body as { data: { attributes: { page: { cursor?: string } } } }).data.attributes;
    expect(attrs.page.cursor).toBe('cursor-xyz');
  });

  it('discards extra/unexpected properties on params, including a real own "__proto__" data property', () => {
    const raw =
      '{"query":"service:api","from":"now-15m","to":"now","limit":25,"sort":"-timestamp",' +
      '"evil":"x","extraBody":{"free":"form"},"__proto__":{"polluted":true}}';
    const maliciousParams = JSON.parse(raw) as SpansSearchParams;

    const body = buildSpansSearchBody(maliciousParams);

    expect(collectKeysDeep(body)).toEqual(
      [
        'data',
        'data.type',
        'data.attributes',
        'data.attributes.filter',
        'data.attributes.filter.query',
        'data.attributes.filter.from',
        'data.attributes.filter.to',
        'data.attributes.page',
        'data.attributes.page.limit',
        'data.attributes.sort',
      ].sort(),
    );
    expect(JSON.stringify(body)).not.toContain('evil');
    expect(JSON.stringify(body)).not.toContain('extraBody');
    expect(JSON.stringify(body)).not.toContain('polluted');
    expect((({} as Record<string, unknown>).polluted)).toBeUndefined();
  });

  it('never produces a body that is a raw string', () => {
    const body = buildSpansSearchBody(validParams);
    expect(typeof body).toBe('object');
    expect(body).not.toBeNull();
    expect(Array.isArray(body)).toBe(false);
  });

  // Regression: from/to/limit/sort all carry a Zod `.default(...)` on their
  // schema fields, but the production MCP SDK invokes the handler with the
  // caller's RAW args, never routed through `inputSchema.parse(...)` first —
  // so those defaults never actually apply at runtime (see the identical
  // dd_list_monitors page/pageSize regression in test/tools/monitors.test.ts,
  // and dd_search_logs' equivalent in test/tools/logs.test.ts). Left
  // un-defaulted, an omitted `from`/`to` would make JSON.stringify drop those
  // keys from the POST body entirely, turning "search the last 15 minutes"
  // into "search with no time bound at all". This test passes a raw,
  // un-parsed params object (only `query` set) directly to
  // `buildSpansSearchBody`, simulating exactly what a real `tools/call` with
  // `{ query: "..." }` and nothing else hands the handler.
  it('fills in from/to/limit/sort defaults when they are genuinely absent (raw, un-parsed params — the real SDK path)', () => {
    const rawParams = { query: 'service:api' } as unknown as SpansSearchParams;
    const body = buildSpansSearchBody(rawParams);

    expect(body).toEqual({
      data: {
        type: 'search_request',
        attributes: {
          filter: { query: 'service:api', from: 'now-15m', to: 'now' },
          page: { limit: 25 },
          sort: '-timestamp',
        },
      },
    });
  });
});

describe('dd_search_spans — inputSchema', () => {
  it('rejects an unknown top-level property (proves .strict())', () => {
    const result = tool.inputSchema.safeParse({ ...validParams, evil: 'x' });
    expect(result.success).toBe(false);
  });

  it('rejects a limit above the cap, and the handler is never reached (no fetch call)', () => {
    const stub = createFetchStub();
    const result = tool.inputSchema.safeParse({ query: 'service:api', limit: 500 });
    expect(result.success).toBe(false);
    expect(stub.calls).toHaveLength(0);
  });

  it('applies defaults for from/to/limit/sort when omitted', () => {
    const result = tool.inputSchema.parse({ query: 'service:api' }) as SpansSearchParams;
    expect(result.from).toBe('now-15m');
    expect(result.to).toBe('now');
    expect(result.limit).toBe(25);
    expect(result.sort).toBe('-timestamp');
  });
});

describe('dd_search_spans — handler happy path', () => {
  it('sends exactly the builder-produced body (nested under data.attributes) and projects the response', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, body: spansSearchResponseFixture });
    const ctx = makeContext(stub.fetch);
    const args = tool.inputSchema.parse(validParams) as SpansSearchParams;

    const result = await tool.handler(args, ctx);

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.method).toBe('POST');
    expect(stub.calls[0]!.url).toContain('/api/v2/spans/events/search');
    expect(stub.calls[0]!.body).toEqual(buildSpansSearchBody(args));

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as { spans: unknown[]; nextCursor?: string };
    expect(structured.spans).toHaveLength(2);
    expect(structured.nextCursor).toBe('gAAAAABspans1');
  });

  it('projects only the documented span fields (all populated, not undefined), dropping full attribute bags', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, body: spansSearchResponseFixture });
    const ctx = makeContext(stub.fetch);
    const args = tool.inputSchema.parse(validParams) as SpansSearchParams;

    const result = await tool.handler(args, ctx);
    const structured = result.structuredContent as { spans: Array<Record<string, unknown>> };

    const allowedKeys = new Set([
      'trace_id',
      'span_id',
      'service',
      'resource_name',
      'operation_name',
      'duration',
      'start',
      'status',
      'error',
    ]);
    for (const span of structured.spans) {
      for (const key of Object.keys(span)) {
        expect(allowedKeys.has(key)).toBe(true);
      }
      // The full `resource`/`http` bags from the fixture must never leak through.
      expect(span.resource).toBeUndefined();
      expect(span.http).toBeUndefined();
      expect(span.name).toBeUndefined();
    }

    // First span: every documented field must come out POPULATED, proving the
    // projection reads from the real (confirmed) response paths rather than
    // paths that happen to both be `undefined` on projector and fixture.
    const first = structured.spans[0]!;
    expect(first.trace_id).toBe(1234567890);
    expect(first.span_id).toBe(9876543210);
    expect(first.service).toBe('api');
    // resource.name is nested in the response but must be read correctly into the flat resource_name output field.
    expect(first.resource_name).toBe('GET /orders/:id');
    expect(first.operation_name).toBe('http.request');
    expect(first.duration).toBe(15234000);
    expect(first.start).toBe(1678886400000);
    expect(first.status).toBe('ok');
    expect(first.error).toBeUndefined();

    const second = structured.spans[1]!;
    expect(second.resource_name).toBe('POST /charge');
    expect(second.operation_name).toBe('payments.charge');
    expect(second.status).toBe('error');
    expect(second.error).toBe(1);
  });

  it('omits nextCursor when meta.page.after is absent', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, body: spansSearchResponseNoNextPageFixture });
    const ctx = makeContext(stub.fetch);
    const args = tool.inputSchema.parse(validParams) as SpansSearchParams;

    const result = await tool.handler(args, ctx);
    const structured = result.structuredContent as Record<string, unknown>;

    expect('nextCursor' in structured).toBe(false);
  });
});

describe('dd_search_spans — errors', () => {
  it('maps a 403 to isError: true with a message citing the required scopes', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 403, body: { errors: ['Missing scope'] } });
    const ctx = makeContext(stub.fetch);
    const args = tool.inputSchema.parse(validParams) as SpansSearchParams;

    const result = await tool.handler(args, ctx);

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/scope/i);
    expect(result.content[0]!.text).toContain('apm_read');
  });

  it('maps a 500 to isError: true without throwing', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 500, body: { errors: ['boom'] } });
    const ctx = makeContext(stub.fetch, { maxRetries: 0 });
    const args = tool.inputSchema.parse(validParams) as SpansSearchParams;

    const result = await tool.handler(args, ctx);

    expect(result.isError).toBe(true);
  });
});
