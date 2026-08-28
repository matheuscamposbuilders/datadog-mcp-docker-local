import { describe, expect, it } from 'vitest';
import { InMemoryTransport, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/server';
import { createDatadogClient } from '../../src/http/datadog-client.js';
import { ALLOWED_ROUTES } from '../../src/security/allowlist.js';
import { monitorsTools } from '../../src/tools/monitors.js';
import { createServer } from '../../src/server.js';
import { createFetchStub } from '../helpers/fetch-stub.js';
import {
  buildMonitorsListResponse,
  monitorGetResponse,
  monitorsListResponse,
  monitorsSearchResponse,
  monitorsSearchResponseNoMetadata,
} from '../fixtures/monitors-fixtures.js';
import type { DatadogConfig, ToolContext } from '../../src/contracts.js';

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

function makeContext(stub: ReturnType<typeof createFetchStub>): ToolContext {
  const config = makeConfig();
  return { client: createDatadogClient(config, stub.fetch), config };
}

function getTool(name: string) {
  const tool = monitorsTools.find((t) => t.name === name);
  if (!tool) {
    throw new Error(`tool not found: ${name}`);
  }
  return tool;
}

const listTool = getTool('dd_list_monitors');
const getMonitorTool = getTool('dd_get_monitor');
const searchTool = getTool('dd_search_monitors');

describe('dd_list_monitors', () => {
  it('calls GET /api/v1/monitor with correct query params and projects fields', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, body: monitorsListResponse });
    const ctx = makeContext(stub);

    const args = listTool.inputSchema.parse({
      name: 'CPU',
      tags: ['env:prod'],
      monitorTags: ['team:payments'],
      page: 2,
      pageSize: 25,
    });
    const result = await listTool.handler(args, ctx);

    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0]!;
    expect(call.method).toBe('GET');
    const url = new URL(call.url);
    expect(url.pathname).toBe('/api/v1/monitor');
    expect(url.searchParams.get('name')).toBe('CPU');
    expect(url.searchParams.get('tags')).toBe('env:prod');
    expect(url.searchParams.get('monitor_tags')).toBe('team:payments');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('page_size')).toBe('25');

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as { monitors: Array<Record<string, unknown>> };
    expect(structured.monitors).toHaveLength(2);
    expect(structured.monitors[0]).toMatchObject({
      id: 111,
      name: 'High CPU on payments-api',
      type: 'metric alert',
      overall_state: 'Alert',
      tags: ['env:prod', 'service:payments-api', 'team:payments'],
      created: '2023-06-01T09:00:00+00:00',
      modified: '2024-01-15T10:32:00+00:00',
    });
    // dd_list_monitors's own responses never carry a `status` field — the
    // shared projector must not invent one that wasn't in the raw response.
    expect(structured.monitors[0]!.status).toBeUndefined();
  });

  it('applies the default page_size when pageSize is omitted', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, body: [] });
    const ctx = makeContext(stub);

    const args = listTool.inputSchema.parse({});
    await listTool.handler(args, ctx);

    const url = new URL(stub.calls[0]!.url);
    expect(url.searchParams.get('page_size')).toBe('50');
    expect(url.searchParams.has('name')).toBe(false);
    expect(url.searchParams.has('tags')).toBe(false);
    expect(url.searchParams.has('monitor_tags')).toBe(false);
  });

  // Regression: the Datadog v1 monitor list API only honors `page_size` when
  // `page` is ALSO present in the query string. Sending `page_size` alone
  // makes the API ignore it and return every monitor in the org (observed in
  // production: a `{ pageSize: 5 }` call returned 3.1 MB and blew the
  // response-size guardrail).
  //
  // IMPORTANT: this must call `listTool.handler` with the RAW args object,
  // never routed through `listTool.inputSchema.parse(...)` first. The
  // production MCP SDK does NOT parse arguments through the Zod schema
  // before invoking the handler — it hands the handler exactly what the
  // caller sent. Going through `.parse()` in a test applies Zod's
  // `.default(...)` behavior that never actually happens in production,
  // which is exactly how the first version of this fix (and this test)
  // passed in CI while the real, Docker-built server still returned 3.1 MB
  // for the exact same call. `handler`'s declared parameter type says
  // `page`/`pageSize` are always present (because the schema defaults them),
  // but that type is a lie about the runtime shape the SDK actually
  // delivers — the cast below is deliberate: it simulates precisely what a
  // real `tools/call` with `{ pageSize: 5 }` and no `page` hands the
  // handler.
  it('always sends `page` alongside `page_size`, even when only pageSize is passed (raw, un-parsed args — the real SDK path)', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, body: [] });
    const ctx = makeContext(stub);

    const rawArgs = { pageSize: 5 } as unknown as Parameters<typeof listTool.handler>[0];
    await listTool.handler(rawArgs, ctx);

    const url = new URL(stub.calls[0]!.url);
    expect(url.searchParams.has('page')).toBe(true);
    expect(url.searchParams.has('page_size')).toBe(true);
    expect(url.searchParams.get('page')).toBe('0');
    expect(url.searchParams.get('page_size')).toBe('5');
  });

  // Same real-SDK-path concern as above, but for a call with NO pagination
  // arguments at all — both `page` and `pageSize` must fall back inside the
  // handler, not rely on a Zod default that never runs in production.
  it('sends `page` and `page_size` with their defaults when no pagination params are passed at all (raw, un-parsed args)', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, body: [] });
    const ctx = makeContext(stub);

    const rawArgs = {} as unknown as Parameters<typeof listTool.handler>[0];
    await listTool.handler(rawArgs, ctx);

    const url = new URL(stub.calls[0]!.url);
    expect(url.searchParams.get('page')).toBe('0');
    expect(url.searchParams.get('page_size')).toBe('50');
  });

  it('respects an explicit page number alongside pageSize', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, body: [] });
    const ctx = makeContext(stub);

    const args = listTool.inputSchema.parse({ page: 3, pageSize: 10 });
    await listTool.handler(args, ctx);

    const url = new URL(stub.calls[0]!.url);
    expect(url.searchParams.get('page')).toBe('3');
    expect(url.searchParams.get('page_size')).toBe('10');
  });

  it('rejects pageSize above the cap (200) via the input schema', () => {
    expect(() => listTool.inputSchema.parse({ pageSize: 201 })).toThrow();
  });

  it('drops the bulky options/state fields and truncates a long query', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, body: monitorsListResponse });
    const ctx = makeContext(stub);

    const args = listTool.inputSchema.parse({});
    const result = await listTool.handler(args, ctx);

    const structured = result.structuredContent as { monitors: Array<Record<string, unknown>> };
    const first = structured.monitors[0]!;
    expect(first.options).toBeUndefined();
    expect(first.state).toBeUndefined();
    expect(first.message).toBeUndefined();
    expect(first.org_id).toBeUndefined();

    const query = first.query as string;
    expect(query.length).toBeLessThanOrEqual(201); // 200 chars + the ellipsis char
    expect(query.endsWith('…')).toBe(true);
    expect(monitorsListResponse[0]!.query.startsWith(query.slice(0, -1))).toBe(true);
  });

  it('handles a large page of monitors without error', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, body: buildMonitorsListResponse(50) });
    const ctx = makeContext(stub);

    const args = listTool.inputSchema.parse({ pageSize: 50 });
    const result = await listTool.handler(args, ctx);

    const structured = result.structuredContent as { monitors: Array<Record<string, unknown>> };
    expect(structured.monitors).toHaveLength(50);
  });

  it('returns an isError ToolResult (not a throw) on a 403 from the API', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 403, body: { errors: ['Forbidden'] } });
    const ctx = makeContext(stub);

    const args = listTool.inputSchema.parse({});
    const result = await listTool.handler(args, ctx);

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('403');
  });
});

describe('dd_get_monitor', () => {
  it('calls GET /api/v1/monitor/{id} and returns the full monitor object', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, body: monitorGetResponse });
    const ctx = makeContext(stub);

    const args = getMonitorTool.inputSchema.parse({ monitorId: 111 });
    const result = await getMonitorTool.handler(args, ctx);

    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0]!;
    expect(call.method).toBe('GET');
    const url = new URL(call.url);
    expect(url.pathname).toBe('/api/v1/monitor/111');
    expect(url.search).toBe('');

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual(monitorGetResponse);
    // The full object (unlike the list tool) keeps options/state — proving
    // dd_get_monitor does NOT summarize.
    expect((result.structuredContent as Record<string, unknown>).options).toBeDefined();
  });

  it.each([0, -1, '123', 1.5])('rejects an invalid monitorId (%p) without any network call', (bad) => {
    const stub = createFetchStub();

    expect(() => getMonitorTool.inputSchema.parse({ monitorId: bad })).toThrow();
    expect(stub.calls).toHaveLength(0);
  });

  it('returns an isError ToolResult (not a throw) on a 404 from the API', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 404, body: { errors: ['Monitor not found'] } });
    const ctx = makeContext(stub);

    const args = getMonitorTool.inputSchema.parse({ monitorId: 999999 });
    const result = await getMonitorTool.handler(args, ctx);

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('404');
  });
});

describe('dd_search_monitors', () => {
  it('calls GET /api/v1/monitor/search with correct query params, projects fields, and includes totalCount', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, body: monitorsSearchResponse });
    const ctx = makeContext(stub);

    const args = searchTool.inputSchema.parse({
      query: 'status:Alert',
      page: 1,
      perPage: 10,
      sort: 'name,asc',
    });
    const result = await searchTool.handler(args, ctx);

    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0]!;
    expect(call.method).toBe('GET');
    const url = new URL(call.url);
    expect(url.pathname).toBe('/api/v1/monitor/search');
    expect(url.searchParams.get('query')).toBe('status:Alert');
    expect(url.searchParams.get('page')).toBe('1');
    expect(url.searchParams.get('per_page')).toBe('10');
    expect(url.searchParams.get('sort')).toBe('name,asc');

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as {
      monitors: Array<Record<string, unknown>>;
      totalCount?: number;
    };
    expect(structured.totalCount).toBe(2);
    expect(structured.monitors).toHaveLength(1);
    expect(structured.monitors[0]).toMatchObject({ id: 111, name: 'High CPU on payments-api' });
    // Fields not in the summary projection must be dropped.
    expect(structured.monitors[0]!.creator).toBeUndefined();
    expect(structured.monitors[0]!.notifications).toBeUndefined();
  });

  it('projects the `status` field (search results use `status`, not `overall_state`)', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, body: monitorsSearchResponse });
    const ctx = makeContext(stub);

    const args = searchTool.inputSchema.parse({ query: 'status:Alert' });
    const result = await searchTool.handler(args, ctx);

    const structured = result.structuredContent as { monitors: Array<Record<string, unknown>> };
    expect(structured.monitors[0]!.status).toBe('Alert');
  });

  it('applies the default perPage (30) when omitted', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, body: monitorsSearchResponse });
    const ctx = makeContext(stub);

    const args = searchTool.inputSchema.parse({ query: 'status:Alert' });
    await searchTool.handler(args, ctx);

    const url = new URL(stub.calls[0]!.url);
    expect(url.searchParams.get('per_page')).toBe('30');
    expect(url.searchParams.has('sort')).toBe(false);
  });

  it('rejects perPage above the cap (100) via the input schema', () => {
    expect(() => searchTool.inputSchema.parse({ query: 'status:Alert', perPage: 101 })).toThrow();
  });

  it('rejects a missing query via the input schema', () => {
    expect(() => searchTool.inputSchema.parse({})).toThrow();
  });

  it('omits totalCount when the API response has no metadata.total_count', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, body: monitorsSearchResponseNoMetadata });
    const ctx = makeContext(stub);

    const args = searchTool.inputSchema.parse({ query: 'status:OK' });
    const result = await searchTool.handler(args, ctx);

    const structured = result.structuredContent as { totalCount?: number };
    expect(structured.totalCount).toBeUndefined();
  });

  it('returns an isError ToolResult (not a throw) on a 403 from the API', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 403, body: { errors: ['Forbidden'] } });
    const ctx = makeContext(stub);

    const args = searchTool.inputSchema.parse({ query: 'status:Alert' });
    const result = await searchTool.handler(args, ctx);

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('403');
  });
});

describe('dd_list_monitors — real MCP tools/call round trip (the path that actually reproduces the production bug)', () => {
  /**
   * Every other test in this file calls `listTool.handler(...)` directly,
   * which is one layer removed from what production actually does:
   * `registerAllTools` (src/tools/index.ts) hands the SDK's own `args`
   * object straight to `tool.handler` with no `inputSchema.parse()` step in
   * between. Driving a real `McpServer` (the same `createServer` production
   * uses) through an in-memory transport and sending a real `tools/call`
   * JSON-RPC request is the only way in this test suite to exercise that
   * exact SDK dispatch path — the path where Zod's `.default(...)` never
   * gets a chance to run. This is the test that would have caught the
   * original bug (489 handler-level tests were green while the real,
   * Docker-built server returned 3.1 MB for `{ pageSize: 5 }`).
   */
  it('calling dd_list_monitors via a real tools/call with only pageSize still sends page=0 to Datadog', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, body: [] });
    const ctx = makeContext(stub);
    const server = createServer(ctx);

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const responses = new Map<number, unknown>();
    let resolveCall: (() => void) | undefined;
    const callArrived = new Promise<void>((resolve) => {
      resolveCall = resolve;
    });

    clientTransport.onmessage = (message: unknown) => {
      const msg = message as { id?: number };
      if (typeof msg.id === 'number') {
        responses.set(msg.id, message);
        if (msg.id === 2) {
          resolveCall?.();
        }
      }
    };
    await clientTransport.start();

    await clientTransport.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0],
        capabilities: {},
        clientInfo: { name: 'monitors-regression-test', version: '0.0.0' },
      },
    });
    await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await clientTransport.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'dd_list_monitors', arguments: { pageSize: 5 } },
    });

    await Promise.race([
      callArrived,
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('tools/call response did not arrive in time')), 5000);
      }),
    ]);

    const callResponse = responses.get(2) as { result?: { isError?: boolean } } | undefined;
    expect(callResponse?.result?.isError).toBeUndefined();

    expect(stub.calls).toHaveLength(1);
    const url = new URL(stub.calls[0]!.url);
    expect(url.searchParams.get('page')).toBe('0');
    expect(url.searchParams.get('page_size')).toBe('5');

    await clientTransport.close();
    await server.close();
  });
});

describe('monitors tools — cross-cutting tool-def invariants', () => {
  it.each(monitorsTools.map((t) => [t.name, t] as const))(
    '%s is read-only and every routeId is allowlisted',
    (_name, def) => {
      expect(def.annotations.readOnlyHint).toBe(true);
      expect(def.annotations.destructiveHint).toBe(false);
      expect(def.routeIds.length).toBeGreaterThan(0);
      const allowedIds = new Set(ALLOWED_ROUTES.map((r) => r.id));
      for (const routeId of def.routeIds) {
        expect(allowedIds.has(routeId)).toBe(true);
      }
    },
  );
});
