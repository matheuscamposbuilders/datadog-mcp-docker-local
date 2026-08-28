import { describe, expect, it } from 'vitest';
import { buildLogsSearchBody, logsTools } from '../../src/tools/logs.js';
import type { LogsSearchParams } from '../../src/tools/logs.js';
import { createDatadogClient } from '../../src/http/datadog-client.js';
import { ALLOWED_ROUTES } from '../../src/security/allowlist.js';
import { createFetchStub } from '../helpers/fetch-stub.js';
import type { DatadogConfig, ToolContext } from '../../src/contracts.js';
import {
  logsSearchResponseFixture,
  logsSearchResponseLongMessageFixture,
  logsSearchResponseNoNextPageFixture,
} from '../fixtures/logs-search-response.js';

const tool = logsTools[0]!;

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

const validParams: LogsSearchParams = {
  query: 'service:api status:error',
  from: 'now-15m',
  to: 'now',
  limit: 25,
  sort: '-timestamp',
};

describe('dd_search_logs — transversal contract', () => {
  it('is read-only, has non-empty routeIds, and every routeId is allowlisted', () => {
    expect(logsTools).toHaveLength(1);
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(tool.annotations.destructiveHint).toBe(false);
    expect(tool.routeIds.length).toBeGreaterThan(0);
    for (const routeId of tool.routeIds) {
      expect(ALLOWED_ROUTES.some((route) => route.id === routeId)).toBe(true);
    }
    expect(tool.routeIds).toContain('search_logs');
  });
});

describe('buildLogsSearchBody — body is built field-by-field, never spread', () => {
  it('produces exactly the expected key set for minimal params', () => {
    const body = buildLogsSearchBody(validParams);
    expect(collectKeysDeep(body)).toEqual(
      ['filter', 'filter.from', 'filter.query', 'filter.to', 'page', 'page.limit', 'sort'].sort(),
    );
  });

  it('includes indexes/cursor only when provided, still with an exact key set', () => {
    const body = buildLogsSearchBody({
      ...validParams,
      indexes: ['main', 'test'],
      cursor: 'cursor-abc',
    });
    expect(collectKeysDeep(body)).toEqual(
      [
        'filter',
        'filter.from',
        'filter.query',
        'filter.to',
        'filter.indexes',
        'page',
        'page.limit',
        'page.cursor',
        'sort',
      ].sort(),
    );
    expect(body).toEqual({
      filter: {
        query: validParams.query,
        from: validParams.from,
        to: validParams.to,
        indexes: ['main', 'test'],
      },
      page: { limit: validParams.limit, cursor: 'cursor-abc' },
      sort: validParams.sort,
    });
  });

  it('discards extra/unexpected properties on params, including a real own "__proto__" data property', () => {
    // Simulates what a tool call actually looks like over JSON-RPC: JSON.parse
    // creates a genuine OWN property literally named "__proto__" (a plain data
    // property), not a prototype mutation via object-literal syntax.
    const raw =
      '{"query":"service:api","from":"now-15m","to":"now","limit":25,"sort":"-timestamp",' +
      '"evil":"x","extraBody":{"free":"form"},"__proto__":{"polluted":true}}';
    const maliciousParams = JSON.parse(raw) as LogsSearchParams;

    const body = buildLogsSearchBody(maliciousParams);

    expect(collectKeysDeep(body)).toEqual(
      ['filter', 'filter.from', 'filter.query', 'filter.to', 'page', 'page.limit', 'sort'].sort(),
    );
    expect(body).toEqual({
      filter: { query: 'service:api', from: 'now-15m', to: 'now' },
      page: { limit: 25 },
      sort: '-timestamp',
    });
    expect(JSON.stringify(body)).not.toContain('evil');
    expect(JSON.stringify(body)).not.toContain('extraBody');
    expect(JSON.stringify(body)).not.toContain('polluted');
    // Global prototype pollution assertion, as required by the task brief.
    expect((({} as Record<string, unknown>).polluted)).toBeUndefined();
  });

  it('never produces a body that is a raw string', () => {
    const body = buildLogsSearchBody(validParams);
    expect(typeof body).toBe('object');
    expect(body).not.toBeNull();
    expect(Array.isArray(body)).toBe(false);
  });

  // Regression: from/to/limit/sort all carry a Zod `.default(...)` on their
  // schema fields, but the production MCP SDK invokes the handler with the
  // caller's RAW args, never routed through `inputSchema.parse(...)` first —
  // so those defaults never actually apply at runtime (see the identical
  // dd_list_monitors page/pageSize regression in test/tools/monitors.test.ts
  // for the full explanation). Left un-defaulted, `params.from`/`to` being
  // `undefined` would make JSON.stringify drop those keys from the POST body
  // entirely, turning "search the last 15 minutes" into "search with no time
  // bound at all"; an undefined `limit` would drop the cap; an undefined
  // `sort` would drop the explicit ordering. This test passes a raw,
  // un-parsed params object (only `query` set) directly to
  // `buildLogsSearchBody`, simulating exactly what a real `tools/call` with
  // `{ query: "..." }` and nothing else hands the handler.
  it('fills in from/to/limit/sort defaults when they are genuinely absent (raw, un-parsed params — the real SDK path)', () => {
    const rawParams = { query: 'service:api' } as unknown as LogsSearchParams;
    const body = buildLogsSearchBody(rawParams);

    expect(body).toEqual({
      filter: { query: 'service:api', from: 'now-15m', to: 'now' },
      page: { limit: 25 },
      sort: '-timestamp',
    });
  });
});

describe('dd_search_logs — inputSchema', () => {
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
    const result = tool.inputSchema.parse({ query: 'service:api' }) as LogsSearchParams;
    expect(result.from).toBe('now-15m');
    expect(result.to).toBe('now');
    expect(result.limit).toBe(25);
    expect(result.sort).toBe('-timestamp');
  });
});

describe('dd_search_logs — handler happy path', () => {
  it('sends exactly the builder-produced body and projects the response', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, body: logsSearchResponseFixture });
    const ctx = makeContext(stub.fetch);

    const args = tool.inputSchema.parse(validParams) as LogsSearchParams;
    const result = await tool.handler(args, ctx);

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.method).toBe('POST');
    expect(stub.calls[0]!.url).toContain('/api/v2/logs/events/search');
    expect(stub.calls[0]!.body).toEqual(buildLogsSearchBody(args));

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as { logs: unknown[]; nextCursor?: string };
    expect(structured.logs).toHaveLength(2);
    expect(structured.nextCursor).toBe('eyJhZnRlciI6ImN1cnNvci1sb2dzLTEifQ==');
  });

  it('projects only timestamp/service/status/host/message, dropping tags and nested attributes', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, body: logsSearchResponseFixture });
    const ctx = makeContext(stub.fetch);
    const args = tool.inputSchema.parse(validParams) as LogsSearchParams;

    const result = await tool.handler(args, ctx);
    const structured = result.structuredContent as {
      logs: Array<Record<string, unknown>>;
    };

    for (const log of structured.logs) {
      expect(Object.keys(log).sort()).toEqual(['host', 'message', 'service', 'status', 'timestamp'].sort());
      expect(log.tags).toBeUndefined();
      expect(log.attributes).toBeUndefined();
    }
    expect(structured.logs[0]!.service).toBe('api');
    expect(structured.logs[0]!.host).toBe('web-01');
  });

  it('truncates message to 500 characters', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, body: logsSearchResponseLongMessageFixture });
    const ctx = makeContext(stub.fetch);
    const args = tool.inputSchema.parse(validParams) as LogsSearchParams;

    const result = await tool.handler(args, ctx);
    const structured = result.structuredContent as { logs: Array<{ message: string }> };

    expect(structured.logs[0]!.message.length).toBe(501); // 500 chars + '…'
    expect(structured.logs[0]!.message.endsWith('…')).toBe(true);
  });

  it('omits nextCursor when meta.page.after is absent', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, body: logsSearchResponseNoNextPageFixture });
    const ctx = makeContext(stub.fetch);
    const args = tool.inputSchema.parse(validParams) as LogsSearchParams;

    const result = await tool.handler(args, ctx);
    const structured = result.structuredContent as Record<string, unknown>;

    expect('nextCursor' in structured).toBe(false);
  });
});

describe('dd_search_logs — errors', () => {
  it('maps a 403 to isError: true with a message citing the required scopes', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 403, body: { errors: ['Missing scope'] } });
    const ctx = makeContext(stub.fetch);
    const args = tool.inputSchema.parse(validParams) as LogsSearchParams;

    const result = await tool.handler(args, ctx);

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/scope/i);
    expect(result.content[0]!.text).toContain('logs_read_data');
  });

  it('maps a 500 to isError: true without throwing', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 500, body: { errors: ['boom'] } });
    const ctx = makeContext(stub.fetch, { maxRetries: 0 });
    const args = tool.inputSchema.parse(validParams) as LogsSearchParams;

    const result = await tool.handler(args, ctx);

    expect(result.isError).toBe(true);
  });
});
