import { describe, expect, it } from 'vitest';
import { eventsTools } from '../../src/tools/events.js';
import { createDatadogClient } from '../../src/http/datadog-client.js';
import { createFetchStub } from '../helpers/fetch-stub.js';
import { ALLOWED_ROUTES } from '../../src/security/allowlist.js';
import type { DatadogConfig, ToolContext } from '../../src/contracts.js';
import {
  buildEventsResponse,
  eventsListResponse,
  eventsListResponseShortText,
} from '../fixtures/events-list-response.js';

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
    maxResponseBytes: 1_000_000,
    logLevel: 'silent',
    ...overrides,
  };
}

function makeCtx(stubFetch: typeof fetch, overrides: Partial<DatadogConfig> = {}): ToolContext {
  const config = makeConfig(overrides);
  return { client: createDatadogClient(config, stubFetch), config };
}

const listEvents = eventsTools.find((t) => t.name === 'dd_list_events')!;

describe('dd_list_events — happy path', () => {
  it('issues GET /api/v1/events with start/end in seconds', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, body: eventsListResponse });
    const ctx = makeCtx(stub.fetch);

    const result = await listEvents.handler(
      { from: 1700000000, to: 1700003600, limit: 100 },
      ctx,
    );

    expect(result.isError).toBeUndefined();
    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0]!;
    expect(call.method).toBe('GET');
    const url = new URL(call.url);
    expect(url.pathname).toBe('/api/v1/events');
    expect(url.searchParams.get('start')).toBe('1700000000');
    expect(url.searchParams.get('end')).toBe('1700003600');
  });

  it('serializes sources and tags as comma-separated lists', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, body: eventsListResponse });
    const ctx = makeCtx(stub.fetch);

    await listEvents.handler(
      {
        from: 1700000000,
        to: 1700003600,
        sources: ['deploy', 'nagios'],
        tags: ['env:prod', 'service:payments-api'],
        priority: 'normal',
        limit: 100,
      },
      ctx,
    );

    const url = new URL(stub.calls[0]!.url);
    expect(url.searchParams.get('sources')).toBe('deploy,nagios');
    expect(url.searchParams.get('tags')).toBe('env:prod,service:payments-api');
    expect(url.searchParams.get('priority')).toBe('normal');
  });

  it('omits sources/tags/priority/unaggregated/exclude_aggregate from the query when absent', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, body: eventsListResponse });
    const ctx = makeCtx(stub.fetch);

    await listEvents.handler({ from: 1700000000, to: 1700003600, limit: 100 }, ctx);

    const url = new URL(stub.calls[0]!.url);
    expect(url.searchParams.has('sources')).toBe(false);
    expect(url.searchParams.has('tags')).toBe(false);
    expect(url.searchParams.has('priority')).toBe(false);
    expect(url.searchParams.has('unaggregated')).toBe(false);
    expect(url.searchParams.has('exclude_aggregate')).toBe(false);
  });

  it('passes unaggregated and excludeAggregate through as exclude_aggregate', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, body: eventsListResponse });
    const ctx = makeCtx(stub.fetch);

    await listEvents.handler(
      {
        from: 1700000000,
        to: 1700003600,
        unaggregated: true,
        excludeAggregate: true,
        limit: 100,
      },
      ctx,
    );

    const url = new URL(stub.calls[0]!.url);
    expect(url.searchParams.get('unaggregated')).toBe('true');
    expect(url.searchParams.get('exclude_aggregate')).toBe('true');
  });
});

describe('dd_list_events — input validation', () => {
  it('rejects end <= start before any network call', () => {
    const parsed = listEvents.inputSchema.safeParse({
      from: 1700003600,
      to: 1700003600,
      limit: 100,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects end < start before any network call', () => {
    const parsed = listEvents.inputSchema.safeParse({
      from: 1700003600,
      to: 1700000000,
      limit: 100,
    });
    expect(parsed.success).toBe(false);
  });

  it('never calls fetch when the input schema itself rejects the args', () => {
    const stub = createFetchStub();
    const parsed = listEvents.inputSchema.safeParse({
      from: 1700003600,
      to: 1700000000,
    });
    expect(parsed.success).toBe(false);
    expect(stub.calls).toHaveLength(0);
  });
});

describe('dd_list_events — projection', () => {
  it('keeps only the allowlisted fields and drops bulky/unknown ones', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, body: eventsListResponse });
    const ctx = makeCtx(stub.fetch);

    const result = await listEvents.handler(
      { from: 1700000000, to: 1700003600, limit: 100 },
      ctx,
    );

    const text = result.content[0]!.text;
    expect(text).not.toContain('jump_to');
    expect(text).not.toContain('device_name');

    const parsed = JSON.parse(text.slice(text.indexOf('{'))) as {
      events: Array<Record<string, unknown>>;
    };
    expect(parsed.events).toHaveLength(2);
    const first = parsed.events[0]!;
    expect(Object.keys(first).sort()).toEqual(
      ['alert_type', 'date_happened', 'host', 'id', 'priority', 'source', 'tags', 'text', 'title'].sort(),
    );
  });

  it('truncates text to ~300 chars', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, body: eventsListResponse });
    const ctx = makeCtx(stub.fetch);

    const result = await listEvents.handler(
      { from: 1700000000, to: 1700003600, limit: 100 },
      ctx,
    );
    const text = result.content[0]!.text;
    const parsed = JSON.parse(text.slice(text.indexOf('{'))) as {
      events: Array<{ text: string }>;
    };
    const longEventText = parsed.events[1]!.text;
    expect(longEventText.length).toBeLessThanOrEqual(301);
    expect(longEventText.endsWith('…')).toBe(true);
  });

  it('leaves short text untouched (no truncation marker)', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, body: eventsListResponseShortText });
    const ctx = makeCtx(stub.fetch);

    const result = await listEvents.handler(
      { from: 1700000000, to: 1700003600, limit: 100 },
      ctx,
    );
    const text = result.content[0]!.text;
    const parsed = JSON.parse(text.slice(text.indexOf('{'))) as {
      events: Array<{ text: string }>;
    };
    expect(parsed.events[0]!.text).toBe('Looks resolved, closing.');
  });
});

describe('dd_list_events — count cap', () => {
  it('caps output at the requested limit and declares the truncation in the note', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, body: buildEventsResponse(150) });
    const ctx = makeCtx(stub.fetch);

    const result = await listEvents.handler(
      { from: 1700000000, to: 1700003600, limit: 100 },
      ctx,
    );

    const text = result.content[0]!.text;
    expect(text).toContain('100 of 150');
    expect(text).toContain('INCOMPLETE');

    const parsed = JSON.parse(text.slice(text.indexOf('{'))) as {
      events: unknown[];
    };
    expect(parsed.events).toHaveLength(100);
  });

  it('does not mention truncation when the result fits under the cap', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, body: buildEventsResponse(5) });
    const ctx = makeCtx(stub.fetch);

    const result = await listEvents.handler(
      { from: 1700000000, to: 1700003600, limit: 100 },
      ctx,
    );

    const text = result.content[0]!.text;
    expect(text).not.toContain('INCOMPLETE');
  });

  // Regression: `limit`'s schema field carries a Zod `.default(...)`, but the
  // production MCP SDK invokes the handler with the caller's RAW args, never
  // routed through `inputSchema.parse(...)` first — so that default never
  // actually applies at runtime (same trap as dd_list_monitors' page/pageSize;
  // see test/tools/monitors.test.ts). Left un-defaulted, `args.limit` being
  // `undefined` makes `events.length > undefined` always false and
  // `events.slice(0, undefined)` return every event unsliced, silently
  // disabling the cap. This test passes a raw, un-parsed args object (no
  // `limit` at all) directly to the handler, simulating exactly what a real
  // `tools/call` omitting `limit` hands it.
  it('applies the default limit when omitted entirely (raw, un-parsed args — the real SDK path)', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, body: buildEventsResponse(150) });
    const ctx = makeCtx(stub.fetch);

    const rawArgs = { from: 1700000000, to: 1700003600 } as unknown as Parameters<
      typeof listEvents.handler
    >[0];
    const result = await listEvents.handler(rawArgs, ctx);

    const text = result.content[0]!.text;
    expect(text).toContain('100 of 150');
    expect(text).toContain('INCOMPLETE');

    const parsed = JSON.parse(text.slice(text.indexOf('{'))) as { events: unknown[] };
    expect(parsed.events).toHaveLength(100);
  });
});

describe('dd_list_events — API errors', () => {
  it('maps a 403 to an isError ToolResult instead of throwing', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 403, body: { errors: ['Forbidden'] } });
    const ctx = makeCtx(stub.fetch);

    const result = await listEvents.handler(
      { from: 1700000000, to: 1700003600, limit: 100 },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('403');
  });

  it('maps a 404 to an isError ToolResult instead of throwing', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 404, body: { errors: ['Not found'] } });
    const ctx = makeCtx(stub.fetch);

    const result = await listEvents.handler(
      { from: 1700000000, to: 1700003600, limit: 100 },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('404');
  });
});

describe('dd_list_events — cross-cutting tool contract', () => {
  for (const tool of eventsTools) {
    describe(tool.name, () => {
      it('is marked read-only and non-destructive', () => {
        expect(tool.annotations.readOnlyHint).toBe(true);
        expect(tool.annotations.destructiveHint).toBe(false);
      });

      it('declares at least one routeId', () => {
        expect(tool.routeIds.length).toBeGreaterThan(0);
      });

      it('every routeId is present in ALLOWED_ROUTES', () => {
        const allowedIds = new Set(ALLOWED_ROUTES.map((r) => r.id));
        for (const routeId of tool.routeIds) {
          expect(allowedIds.has(routeId)).toBe(true);
        }
      });
    });
  }
});
