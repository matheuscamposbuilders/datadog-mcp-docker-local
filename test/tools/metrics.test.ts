import { describe, expect, it } from 'vitest';
import { createDatadogClient } from '../../src/http/datadog-client.js';
import { ALLOWED_ROUTES } from '../../src/security/allowlist.js';
import { metricsTools } from '../../src/tools/metrics.js';
import { createFetchStub } from '../helpers/fetch-stub.js';
import {
  metricsListLarge,
  metricsListSmall,
  metricsMetadata,
  metricsQueryTimeseriesExactlyAtLimit,
  metricsQueryTimeseriesExactlyAtLimitPointlist,
  metricsQueryTimeseriesHuge,
  metricsQueryTimeseriesHugePointlist,
  metricsQueryTimeseriesLarge,
  metricsQueryTimeseriesSmall,
} from '../fixtures/metrics-fixtures.js';
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
    maxResponseBytes: 1000000,
    logLevel: 'silent',
    ...overrides,
  };
}

function makeContext(stub: ReturnType<typeof createFetchStub>): ToolContext {
  const config = makeConfig();
  return { client: createDatadogClient(config, stub.fetch), config };
}

const queryTimeseries = metricsTools.find((t) => t.name === 'dd_query_timeseries')!;
const listMetrics = metricsTools.find((t) => t.name === 'dd_list_metrics')!;
const getMetricMetadata = metricsTools.find((t) => t.name === 'dd_get_metric_metadata')!;

describe('dd_query_timeseries', () => {
  it('sends query/from/to as query params and returns projected series', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, body: metricsQueryTimeseriesSmall });
    const ctx = makeContext(stub);

    const args = queryTimeseries.inputSchema.parse({
      query: 'avg:system.cpu.user{*}',
      from: 1700000000,
      to: 1700003600,
    });
    const result = await queryTimeseries.handler(args, ctx);

    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0]!;
    expect(call.method).toBe('GET');
    const url = new URL(call.url);
    expect(url.pathname).toBe('/api/v1/query');
    expect(url.searchParams.get('query')).toBe('avg:system.cpu.user{*}');
    expect(url.searchParams.get('from')).toBe('1700000000');
    expect(url.searchParams.get('to')).toBe('1700003600');

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as { series: Array<Record<string, unknown>> };
    expect(structured.series).toHaveLength(1);
    expect(structured.series[0]!.metric).toBe('system.cpu.user');
    expect(structured.series[0]!.scope).toBe('host:web-01');
    expect(structured.series[0]!.length).toBe(3);
    expect(structured.series[0]!.sampled).toBe(false);
    expect((structured.series[0]!.pointlist as unknown[]).length).toBe(3);
  });

  it('rejects to <= from at the schema boundary', () => {
    const parsed = queryTimeseries.inputSchema.safeParse({
      query: 'avg:system.cpu.user{*}',
      from: 1700003600,
      to: 1700000000,
    });
    expect(parsed.success).toBe(false);
  });

  it('uniformly downsamples a series over 500 points and declares it in the result note', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, body: metricsQueryTimeseriesLarge });
    const ctx = makeContext(stub);

    const args = queryTimeseries.inputSchema.parse({
      query: 'avg:system.cpu.user{*}',
      from: 1700000000,
      to: 1700100000,
    });
    const result = await queryTimeseries.handler(args, ctx);

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as { series: Array<Record<string, unknown>> };
    const series0 = structured.series[0]!;
    expect(series0.length).toBe(1000); // true original count preserved
    expect(series0.sampled).toBe(true);
    expect((series0.pointlist as unknown[]).length).toBe(500);

    // The note declaring sampling happened must be present in the text output.
    expect(result.content[0]!.text).toMatch(/downsampl/i);
  });

  it('returns an isError ToolResult (not a throw) on a Datadog API error', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 403, body: { errors: ['Missing scope'] } });
    const ctx = makeContext(stub);

    const args = queryTimeseries.inputSchema.parse({
      query: 'avg:system.cpu.user{*}',
      from: 1700000000,
      to: 1700003600,
    });
    const result = await queryTimeseries.handler(args, ctx);

    expect(result.isError).toBe(true);
  });

  describe('downsampling always preserves the first and last point', () => {
    it('the last returned point is identical to the last point of a 5000-point original series', async () => {
      const stub = createFetchStub();
      stub.enqueue({ status: 200, body: metricsQueryTimeseriesHuge });
      const ctx = makeContext(stub);

      const args = queryTimeseries.inputSchema.parse({
        query: 'avg:system.cpu.user{*}',
        from: 1700000000,
        to: 1700100000,
      });
      const result = await queryTimeseries.handler(args, ctx);

      const structured = result.structuredContent as { series: Array<Record<string, unknown>> };
      const pointlist = structured.series[0]!.pointlist as Array<[number, number]>;
      const originalLast = metricsQueryTimeseriesHugePointlist[metricsQueryTimeseriesHugePointlist.length - 1]!;

      expect(structured.series[0]!.sampled).toBe(true);
      expect(structured.series[0]!.length).toBe(5000);
      expect(pointlist[pointlist.length - 1]).toEqual(originalLast);
    });

    it('the first returned point is identical to the first point of the original series', async () => {
      const stub = createFetchStub();
      stub.enqueue({ status: 200, body: metricsQueryTimeseriesHuge });
      const ctx = makeContext(stub);

      const args = queryTimeseries.inputSchema.parse({
        query: 'avg:system.cpu.user{*}',
        from: 1700000000,
        to: 1700100000,
      });
      const result = await queryTimeseries.handler(args, ctx);

      const structured = result.structuredContent as { series: Array<Record<string, unknown>> };
      const pointlist = structured.series[0]!.pointlist as Array<[number, number]>;

      expect(pointlist[0]).toEqual(metricsQueryTimeseriesHugePointlist[0]);
    });

    it('never returns more than maxPoints (500) entries', async () => {
      const stub = createFetchStub();
      stub.enqueue({ status: 200, body: metricsQueryTimeseriesHuge });
      const ctx = makeContext(stub);

      const args = queryTimeseries.inputSchema.parse({
        query: 'avg:system.cpu.user{*}',
        from: 1700000000,
        to: 1700100000,
      });
      const result = await queryTimeseries.handler(args, ctx);

      const structured = result.structuredContent as { series: Array<Record<string, unknown>> };
      const pointlist = structured.series[0]!.pointlist as Array<[number, number]>;

      expect(pointlist.length).toBeLessThanOrEqual(500);
    });

    it('returns timestamps in strictly increasing order with no duplicates', async () => {
      const stub = createFetchStub();
      stub.enqueue({ status: 200, body: metricsQueryTimeseriesHuge });
      const ctx = makeContext(stub);

      const args = queryTimeseries.inputSchema.parse({
        query: 'avg:system.cpu.user{*}',
        from: 1700000000,
        to: 1700100000,
      });
      const result = await queryTimeseries.handler(args, ctx);

      const structured = result.structuredContent as { series: Array<Record<string, unknown>> };
      const pointlist = structured.series[0]!.pointlist as Array<[number, number]>;
      const timestamps = pointlist.map(([ts]) => ts);

      for (let i = 1; i < timestamps.length; i += 1) {
        expect(timestamps[i]).toBeGreaterThan(timestamps[i - 1]!);
      }
    });

    it('a series with exactly maxPoints (500) points is returned intact, unsampled', async () => {
      const stub = createFetchStub();
      stub.enqueue({ status: 200, body: metricsQueryTimeseriesExactlyAtLimit });
      const ctx = makeContext(stub);

      const args = queryTimeseries.inputSchema.parse({
        query: 'avg:system.cpu.user{*}',
        from: 1700000000,
        to: 1700100000,
      });
      const result = await queryTimeseries.handler(args, ctx);

      const structured = result.structuredContent as { series: Array<Record<string, unknown>> };
      expect(structured.series[0]!.sampled).toBe(false);
      expect(structured.series[0]!.length).toBe(500);
      expect(structured.series[0]!.pointlist).toEqual(metricsQueryTimeseriesExactlyAtLimitPointlist);
      expect(result.content[0]!.text).not.toMatch(/downsampl/i);
    });
  });
});

describe('dd_list_metrics', () => {
  it('sends from as a query param and omits host/tag_filter when not given', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, body: metricsListSmall });
    const ctx = makeContext(stub);

    const args = listMetrics.inputSchema.parse({ from: 1700000000 });
    const result = await listMetrics.handler(args, ctx);

    expect(stub.calls).toHaveLength(1);
    const url = new URL(stub.calls[0]!.url);
    expect(url.pathname).toBe('/api/v1/metrics');
    expect(url.searchParams.get('from')).toBe('1700000000');
    expect(url.searchParams.has('host')).toBe(false);
    expect(url.searchParams.has('tag_filter')).toBe(false);

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as { totalCount: number; returnedCount: number };
    expect(structured.totalCount).toBe(3);
    expect(structured.returnedCount).toBe(3);
    expect(result.content[0]!.text).not.toMatch(/truncat/i);
  });

  it('maps host and tagFilter to host and tag_filter query params', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, body: metricsListSmall });
    const ctx = makeContext(stub);

    const args = listMetrics.inputSchema.parse({
      from: 1700000000,
      host: 'web-01',
      tagFilter: 'env:prod',
    });
    await listMetrics.handler(args, ctx);

    const url = new URL(stub.calls[0]!.url);
    expect(url.searchParams.get('host')).toBe('web-01');
    expect(url.searchParams.get('tag_filter')).toBe('env:prod');
  });

  it('truncates a large metrics list to the default limit and declares it in the result', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, body: metricsListLarge });
    const ctx = makeContext(stub);

    const args = listMetrics.inputSchema.parse({ from: 1700000000 });
    const result = await listMetrics.handler(args, ctx);

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as {
      totalCount: number;
      returnedCount: number;
      metrics: string[];
    };
    expect(structured.totalCount).toBe(250);
    expect(structured.returnedCount).toBe(200);
    expect(structured.metrics).toHaveLength(200);
    expect(result.content[0]!.text).toMatch(/truncat/i);
  });

  it('respects an explicit limit up to the max', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, body: metricsListLarge });
    const ctx = makeContext(stub);

    const args = listMetrics.inputSchema.parse({ from: 1700000000, limit: 1000 });
    const result = await listMetrics.handler(args, ctx);

    const structured = result.structuredContent as { returnedCount: number };
    expect(structured.returnedCount).toBe(250);
    expect(result.content[0]!.text).not.toMatch(/truncat/i);
  });

  it('returns an isError ToolResult (not a throw) on a Datadog API error', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 404, body: { errors: ['not found'] } });
    const ctx = makeContext(stub);

    const args = listMetrics.inputSchema.parse({ from: 1700000000 });
    const result = await listMetrics.handler(args, ctx);

    expect(result.isError).toBe(true);
  });

  // Regression: `limit`'s schema field carries a Zod `.default(...)`, but the
  // production MCP SDK invokes the handler with the caller's RAW args, never
  // routed through `inputSchema.parse(...)` first — so that default never
  // actually applies at runtime (same trap as dd_list_monitors' page/pageSize;
  // see test/tools/monitors.test.ts). Left un-defaulted,
  // `allMetrics.slice(0, undefined)` returns the entire list unsliced instead
  // of applying the documented default cap. This test passes a raw,
  // un-parsed args object (no `limit` at all) directly to the handler,
  // simulating exactly what a real `tools/call` omitting `limit` hands it.
  it('applies the default limit when omitted entirely (raw, un-parsed args — the real SDK path)', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, body: metricsListLarge });
    const ctx = makeContext(stub);

    const rawArgs = { from: 1700000000 } as unknown as Parameters<typeof listMetrics.handler>[0];
    const result = await listMetrics.handler(rawArgs, ctx);

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as {
      totalCount: number;
      returnedCount: number;
      metrics: string[];
    };
    expect(structured.totalCount).toBe(250);
    expect(structured.returnedCount).toBe(200);
    expect(structured.metrics).toHaveLength(200);
    expect(result.content[0]!.text).toMatch(/truncat/i);
  });
});

describe('dd_get_metric_metadata', () => {
  it('builds the path from the validated metric name and returns the metadata', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, body: metricsMetadata });
    const ctx = makeContext(stub);

    const args = getMetricMetadata.inputSchema.parse({ metricName: 'system.cpu.idle' });
    const result = await getMetricMetadata.handler(args, ctx);

    expect(stub.calls).toHaveLength(1);
    const url = new URL(stub.calls[0]!.url);
    expect(url.pathname).toBe('/api/v1/metrics/system.cpu.idle');

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual(metricsMetadata);
  });

  it('rejects an invalid metric name at the schema boundary before any network call', () => {
    const stub = createFetchStub();
    const parsed = getMetricMetadata.inputSchema.safeParse({ metricName: 'bad name!/etc' });

    expect(parsed.success).toBe(false);
    expect(stub.calls).toHaveLength(0);
  });

  it('returns an isError ToolResult (not a throw) on a Datadog API error', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 404, body: { errors: ['Metric not found'] } });
    const ctx = makeContext(stub);

    const args = getMetricMetadata.inputSchema.parse({ metricName: 'no.such.metric' });
    const result = await getMetricMetadata.handler(args, ctx);

    expect(result.isError).toBe(true);
  });
});

describe('metrics tools — cross-cutting tool-def invariants', () => {
  it.each(metricsTools.map((t) => [t.name, t] as const))(
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
