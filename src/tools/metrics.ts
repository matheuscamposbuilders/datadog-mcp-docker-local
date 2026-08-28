/**
 * Metrics tools: `dd_query_timeseries`, `dd_list_metrics`, `dd_get_metric_metadata`.
 *
 * Backed by the `query_timeseries`, `list_metrics`, and `get_metric_metadata`
 * routes in `src/security/allowlist.ts`.
 */
import * as z from 'zod/v4';
import type { ToolDef } from '../contracts.js';
import { defineTool } from './define-tool.js';
import { toErrorResult, toToolResult } from '../format.js';
import { zLimit, zMetricName, zQueryString, zTimestampSeconds } from '../schemas/common.js';

/** Max points returned per series before uniform downsampling kicks in. */
const MAX_POINTS_PER_SERIES = 500;

/** Default / max page size for dd_list_metrics. */
const LIST_METRICS_DEFAULT_LIMIT = 200;
const LIST_METRICS_MAX_LIMIT = 1000;

type TimeseriesPoint = readonly [number, number | null];

interface DatadogTimeseriesSeries {
  readonly metric?: string;
  readonly scope?: string;
  readonly unit?: unknown;
  readonly pointlist?: readonly TimeseriesPoint[];
}

interface DatadogQueryTimeseriesResponse {
  readonly status?: string;
  readonly error?: string;
  readonly series?: readonly DatadogTimeseriesSeries[];
}

interface DatadogListMetricsResponse {
  readonly from?: string;
  readonly metrics?: readonly string[];
}

/**
 * Uniformly samples `points` down to at most `maxPoints` entries. The first
 * and last point of the original array are always preserved — the last
 * point is the most recent one in the series, and silently dropping it
 * would let the model mistake a stale sample for the current state of the
 * system. When `maxPoints` is `1`, only the last (most recent) point is
 * returned. Returns the original array unchanged (and `sampled: false`)
 * when it is already within budget.
 */
function sampleUniformly(
  points: readonly TimeseriesPoint[],
  maxPoints: number,
): { readonly points: TimeseriesPoint[]; readonly sampled: boolean } {
  if (points.length <= maxPoints || maxPoints < 1) {
    return { points: [...points], sampled: false };
  }

  const lastIndex = points.length - 1;

  if (maxPoints === 1) {
    const last = points[lastIndex];
    return { points: last === undefined ? [] : [last], sampled: true };
  }

  // Stride spans the full [0, lastIndex] range over (maxPoints - 1) steps,
  // so index 0 lands on the first point and index (maxPoints - 1) lands
  // exactly on `lastIndex` — never short of it, regardless of rounding.
  const stride = lastIndex / (maxPoints - 1);
  const result: TimeseriesPoint[] = [];
  for (let i = 0; i < maxPoints; i += 1) {
    const idx = i === maxPoints - 1 ? lastIndex : Math.round(i * stride);
    const point = points[idx];
    if (point !== undefined) {
      result.push(point);
    }
  }
  return { points: result, sampled: true };
}

const zQueryTimeseriesInput = z
  .object({
    query: zQueryString.describe(
      'A Datadog metric query string, e.g. "avg:system.cpu.user{*}" or ' +
        '"sum:aws.elb.request_count{env:prod} by {availability-zone}". ' +
        'Follows the format aggregator:metric.name{tag_filters} [by {grouping_tags}].',
    ),
    from: zTimestampSeconds.describe(
      'Start of the query window, as a Unix epoch timestamp in seconds.',
    ),
    to: zTimestampSeconds.describe(
      'End of the query window, as a Unix epoch timestamp in seconds. Must be strictly greater than `from`.',
    ),
  })
  .refine((value) => value.to > value.from, {
    message: 'to must be strictly greater than from',
    path: ['to'],
  });

const zListMetricsInput = z.object({
  from: zTimestampSeconds.describe(
    'Only return metrics with data since this time. Unix epoch timestamp in seconds. Required by the Datadog API.',
  ),
  host: z
    .string()
    .min(1)
    .max(255)
    .describe('Optional: only return metrics reported by this host name.')
    .optional(),
  tagFilter: z
    .string()
    .min(1)
    .max(200)
    .describe('Optional: only return metrics matching this Datadog tag filter, e.g. "env:prod".')
    .optional(),
  limit: zLimit(LIST_METRICS_MAX_LIMIT, LIST_METRICS_DEFAULT_LIMIT),
});

const zGetMetricMetadataInput = z.object({
  metricName: zMetricName,
});

const queryTimeseriesTool = defineTool({
  name: 'dd_query_timeseries',
  title: 'Query Metric Timeseries',
  description:
    'Runs a Datadog metrics timeseries query (GET /api/v1/query) and returns the resulting series. ' +
    'Use this to fetch numeric metric data over a time range, e.g. CPU usage, request counts, or any ' +
    'other Datadog metric. `query` must be a valid Datadog metric query string, for example ' +
    '"avg:system.cpu.user{*}" (average CPU user time across all hosts) or ' +
    '"sum:aws.elb.request_count{env:prod} by {availability-zone}" (request count grouped by AZ, prod only). ' +
    '`from` and `to` are Unix epoch timestamps IN SECONDS (not milliseconds), with `to` after `from`. ' +
    `Each returned series includes \`metric\`, \`scope\`, \`unit\`, \`length\` (the true number of data ` +
    `points Datadog returned), and \`pointlist\` (an array of [timestamp, value] pairs). If a series has ` +
    `more than ${MAX_POINTS_PER_SERIES} points, \`pointlist\` is uniformly downsampled to ` +
    `${MAX_POINTS_PER_SERIES} points and the series is marked \`sampled: true\` — check \`length\` vs the ` +
    '`pointlist` size and the result note to know whether downsampling happened before drawing conclusions ' +
    'about the shape of the data.',
  routeIds: ['query_timeseries'],
  annotations: { readOnlyHint: true, destructiveHint: false },
  inputSchema: zQueryTimeseriesInput,
  handler: async (args, ctx) => {
    try {
      const response = await ctx.client.get<DatadogQueryTimeseriesResponse>('/api/v1/query', {
        query: args.query,
        from: args.from,
        to: args.to,
      });

      let anySampled = false;
      const series = (response.series ?? []).map((s) => {
        const pointlist = s.pointlist ?? [];
        const { points, sampled } = sampleUniformly(pointlist, MAX_POINTS_PER_SERIES);
        if (sampled) {
          anySampled = true;
        }
        return {
          metric: s.metric,
          scope: s.scope,
          unit: s.unit,
          length: pointlist.length,
          sampled,
          pointlist: points,
        };
      });

      return toToolResult(
        { status: response.status, series },
        anySampled
          ? {
              note:
                `One or more series exceeded ${MAX_POINTS_PER_SERIES} points and were downsampled by ` +
                `uniform sampling. Each series' \`length\` field is the true original point count; ` +
                '`sampled: true` marks which series were reduced.',
            }
          : undefined,
      );
    } catch (err) {
      return toErrorResult(err);
    }
  },
});

const listMetricsTool = defineTool({
  name: 'dd_list_metrics',
  title: 'List Active Metrics',
  description:
    'Lists the names of metrics that have reported data since `from` (GET /api/v1/metrics). Use this to ' +
    'discover what metrics exist before querying one with dd_query_timeseries, or to check whether a ' +
    'specific metric name is actually being reported. `from` is a Unix epoch timestamp IN SECONDS and is ' +
    'required by the Datadog API — pick a recent time (e.g. now minus a few hours) to get currently-active ' +
    'metrics. Optionally narrow results with `host` (metrics reported by a specific host) or `tagFilter` ' +
    '(a Datadog tag filter such as "env:prod"). The full metric list can be very large; results are capped ' +
    `by \`limit\` (default ${LIST_METRICS_DEFAULT_LIMIT}, max ${LIST_METRICS_MAX_LIMIT}). When the true ` +
    'list is longer than `limit`, the result is truncated and says so — narrow with `host`/`tagFilter` or ' +
    'raise `limit` to see more.',
  routeIds: ['list_metrics'],
  annotations: { readOnlyHint: true, destructiveHint: false },
  inputSchema: zListMetricsInput,
  handler: async (args, ctx) => {
    try {
      const response = await ctx.client.get<DatadogListMetricsResponse>('/api/v1/metrics', {
        from: args.from,
        host: args.host,
        tag_filter: args.tagFilter,
      });

      const allMetrics = response.metrics ?? [];
      // `args.limit`'s schema default (see zLimit) never actually reaches
      // this handler in production — the MCP SDK invokes handlers with the
      // caller's raw args, not `inputSchema.parse()`'s output (same trap as
      // dd_list_monitors' page/pageSize; see src/tools/monitors.ts). Left
      // un-defaulted, `allMetrics.slice(0, undefined)` returns the whole
      // list unsliced instead of applying the documented cap.
      const limited = allMetrics.slice(0, args.limit ?? LIST_METRICS_DEFAULT_LIMIT);
      const truncated = allMetrics.length > limited.length;

      return toToolResult(
        { totalCount: allMetrics.length, returnedCount: limited.length, metrics: limited },
        truncated
          ? {
              note:
                `Truncated to ${limited.length} of ${allMetrics.length} metrics. Narrow with \`host\` or ` +
                `\`tagFilter\`, or raise \`limit\` (max ${LIST_METRICS_MAX_LIMIT}), to see more.`,
            }
          : undefined,
      );
    } catch (err) {
      return toErrorResult(err);
    }
  },
});

const getMetricMetadataTool = defineTool({
  name: 'dd_get_metric_metadata',
  title: 'Get Metric Metadata',
  description:
    'Fetches metadata for a single metric (GET /api/v1/metrics/{metric_name}) — its description, unit, ' +
    'type (gauge/count/rate/...), and other configured metadata. Use this to understand what a metric ' +
    'means or what unit its values are in before interpreting results from dd_query_timeseries. ' +
    '`metricName` must be an exact, dot-delimited Datadog metric name such as "system.cpu.idle" ' +
    '(letters, digits, underscores, and dots only, 1-200 characters) — wildcards and tag filters are not ' +
    'accepted here, use dd_list_metrics to discover exact names first.',
  routeIds: ['get_metric_metadata'],
  annotations: { readOnlyHint: true, destructiveHint: false },
  inputSchema: zGetMetricMetadataInput,
  handler: async (args, ctx) => {
    try {
      const result = await ctx.client.get<unknown>(`/api/v1/metrics/${args.metricName}`);
      return toToolResult(result);
    } catch (err) {
      return toErrorResult(err);
    }
  },
});

export const metricsTools: readonly ToolDef[] = [
  queryTimeseriesTool,
  listMetricsTool,
  getMetricMetadataTool,
];
