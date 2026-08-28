/**
 * `dd_search_spans` — the tool backed by the `search_spans` route
 * (`POST /api/v2/spans/events/search`).
 *
 * This is one of exactly two POST routes this server is permitted to call
 * (the other being `search_logs`). As with logs, the request body is built
 * field-by-field by `buildSpansSearchBody` from explicitly named,
 * already-Zod-validated properties — never a spread of the raw args — so
 * the body sent to Datadog can never carry a key the model wasn't meant to
 * control.
 *
 * DIVERGENCE FROM THE LOGS SHAPE (verified against Datadog's official docs
 * for this endpoint, not assumed by analogy): the Datadog Spans Events API
 * (`SpansListRequest`) wraps its filter/page/sort payload inside
 * `data.attributes`, with `data.type` fixed to `"search_request"` — unlike
 * the flat `{filter, page, sort}` body the Logs Events API uses. This
 * mirrors the same envelope Datadog uses for its other v2 Events-search
 * endpoints (e.g. RUM). `buildSpansSearchBody` follows that real shape.
 *
 * The RESPONSE shape also diverges from what a logs-shaped mental model
 * would predict — confirmed against the documented example response.
 * `data[].attributes` carries `name` (not `operation_name`), `start` (not
 * `start_timestamp`), `duration` directly (not nested under a further
 * `attributes.attributes` tag bag), and `resource: { name }` (a nested
 * object, not a flat `resource_name` string). `trace_id`/`span_id` are
 * numeric in the documented example. See `projectSpanEntry` below.
 */
import * as z from 'zod/v4';
import type { ToolContext, ToolDef, ToolResult } from '../contracts.js';
import { defineTool } from './define-tool.js';
import { toErrorResult, toToolResult } from '../format.js';
import { zCursor, zLimit, zQueryString } from '../schemas/common.js';

const MAX_SPANS_LIMIT = 200;
const DEFAULT_SPANS_LIMIT = 25;
const DEFAULT_FROM = 'now-15m';
const DEFAULT_TO = 'now';
const DEFAULT_SORT = '-timestamp';

const RELATIVE_TIME_PATTERN = /^now(-\d{1,10}[smhdw])?$/;
/** See logs.ts for why this mirrors (rather than imports) common.ts's private helper. */
const ISO_8601_SHAPE_PATTERN =
  /^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/;

function isValidIsoDateTime(value: string): boolean {
  return ISO_8601_SHAPE_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}

function zIsoOrRelativeTimeWithDefault(defaultValue: string, boundLabel: string) {
  return z
    .string()
    .min(1)
    .max(64)
    .refine((value) => RELATIVE_TIME_PATTERN.test(value) || isValidIsoDateTime(value), {
      message:
        'Must be an ISO-8601 timestamp (e.g. "2024-01-01T00:00:00Z") or a Datadog relative time term (e.g. "now", "now-15m", "now-1h").',
    })
    .default(defaultValue)
    .describe(
      `${boundLabel} of the search window: an ISO-8601 timestamp (e.g. "2024-01-01T00:00:00Z") or a Datadog relative time term (e.g. "now-15m", "now"). Defaults to "${defaultValue}".`,
    );
}

const zSort = z
  .enum(['timestamp', '-timestamp'])
  .default(DEFAULT_SORT)
  .describe(
    'Sort order for results by timestamp: "timestamp" for oldest first, "-timestamp" for newest first (default).',
  );

const inputSchema = z
  .object({
    query: zQueryString.describe(
      'Datadog span search query using standard trace search syntax (facets, tags, boolean operators), ' +
        'e.g. "service:api operation_name:http.request" or "service:checkout status:error".',
    ),
    from: zIsoOrRelativeTimeWithDefault(DEFAULT_FROM, 'Start'),
    to: zIsoOrRelativeTimeWithDefault(DEFAULT_TO, 'End'),
    limit: zLimit(MAX_SPANS_LIMIT, DEFAULT_SPANS_LIMIT),
    cursor: zCursor,
    sort: zSort,
  })
  .strict();

export type SpansSearchParams = z.infer<typeof inputSchema>;

/**
 * Builds the `POST /api/v2/spans/events/search` request body field-by-field
 * from `params`. Deliberately does NOT spread `params` or use
 * `Object.assign` from it — only the named properties below are ever read.
 */
export function buildSpansSearchBody(params: SpansSearchParams): Record<string, unknown> {
  // Same trap as dd_list_monitors' page/pageSize and dd_search_logs' body
  // (see src/tools/monitors.ts / src/tools/logs.ts): the MCP SDK hands
  // handlers the caller's raw args, not `inputSchema.parse()`'s output, so
  // Zod's `.default(...)` on from/to/limit/sort never runs in production. An
  // omitted field left un-defaulted here becomes `undefined`, which
  // `JSON.stringify` silently drops from the POST body — turning "use the
  // default" into "send no value at all" for a Datadog search request.
  const filter: Record<string, unknown> = {
    query: params.query,
    from: params.from ?? DEFAULT_FROM,
    to: params.to ?? DEFAULT_TO,
  };

  const page: Record<string, unknown> = {
    limit: params.limit ?? DEFAULT_SPANS_LIMIT,
  };
  if (params.cursor !== undefined) {
    page.cursor = params.cursor;
  }

  const attributes: Record<string, unknown> = {
    filter,
    page,
    sort: params.sort ?? DEFAULT_SORT,
  };

  return {
    data: {
      type: 'search_request',
      attributes,
    },
  };
}

/** `trace_id`/`span_id` are documented as numeric in the example response, but read defensively as string too. */
type SpanId = string | number;

interface SpansSearchResponseEntryAttributes {
  readonly trace_id?: SpanId;
  readonly span_id?: SpanId;
  readonly name?: string;
  readonly start?: number | string;
  readonly duration?: number;
  readonly service?: string;
  readonly resource?: { readonly name?: string };
  readonly status?: string;
  readonly error?: number | boolean;
  readonly [key: string]: unknown;
}

interface SpansSearchResponseEntry {
  readonly id?: string;
  readonly type?: string;
  readonly attributes?: SpansSearchResponseEntryAttributes;
}

interface SpansSearchResponse {
  readonly data?: readonly SpansSearchResponseEntry[];
  readonly meta?: { readonly page?: { readonly after?: string } };
}

interface ProjectedSpan {
  trace_id?: SpanId;
  span_id?: SpanId;
  service?: string;
  resource_name?: string;
  operation_name?: string;
  duration?: number;
  start?: number | string;
  status?: string;
  error?: number | boolean;
}

/**
 * Projects a single Datadog span event down to the small, flat set of
 * fields the model needs, reading from the CONFIRMED response shape (see
 * the module doc comment): `name` (not `operation_name`), `start` (not
 * `start_timestamp`), `duration` directly on `attributes` (not nested), and
 * `resource.name` (a nested object, not a flat `resource_name` string).
 * Full attribute bags (e.g. `http`) are never returned.
 */
function projectSpanEntry(entry: SpansSearchResponseEntry): ProjectedSpan {
  const attrs = entry.attributes ?? {};
  const projected: ProjectedSpan = {};

  if (typeof attrs.trace_id === 'string' || typeof attrs.trace_id === 'number') {
    projected.trace_id = attrs.trace_id;
  }
  if (typeof attrs.span_id === 'string' || typeof attrs.span_id === 'number') {
    projected.span_id = attrs.span_id;
  }
  if (typeof attrs.service === 'string') {
    projected.service = attrs.service;
  }
  if (typeof attrs.resource?.name === 'string') {
    projected.resource_name = attrs.resource.name;
  }
  if (typeof attrs.name === 'string') {
    projected.operation_name = attrs.name;
  }
  if (typeof attrs.duration === 'number') {
    projected.duration = attrs.duration;
  }
  if (typeof attrs.start === 'number' || typeof attrs.start === 'string') {
    projected.start = attrs.start;
  }
  if (typeof attrs.status === 'string') {
    projected.status = attrs.status;
  }
  if (typeof attrs.error === 'number' || typeof attrs.error === 'boolean') {
    projected.error = attrs.error;
  }

  return projected;
}

interface SpansSearchResult {
  spans: ProjectedSpan[];
  nextCursor?: string;
}

async function handleSearchSpans(args: SpansSearchParams, ctx: ToolContext): Promise<ToolResult> {
  try {
    const body = buildSpansSearchBody(args);
    const response = await ctx.client.postSearch<SpansSearchResponse>(
      '/api/v2/spans/events/search',
      body,
      ctx.signal !== undefined ? { signal: ctx.signal } : {},
    );

    const spans = (response.data ?? []).map(projectSpanEntry);
    const result: SpansSearchResult = { spans };
    const nextCursor = response.meta?.page?.after;
    if (nextCursor !== undefined) {
      result.nextCursor = nextCursor;
    }

    return toToolResult(result, {
      note:
        'Only a projected subset of each span is returned (trace_id, span_id, service, resource_name, operation_name, ' +
        'duration, start, status/error) — full span attributes are never included. If `nextCursor` is present, pass it ' +
        'back as the `cursor` parameter to fetch the next page.',
    });
  } catch (err) {
    return toErrorResult(err);
  }
}

const ddSearchSpans = defineTool({
  name: 'dd_search_spans',
  title: 'Search Datadog APM Spans',
  description:
    'Searches Datadog APM span events via POST /api/v2/spans/events/search. Use standard Datadog trace search ' +
    'syntax for `query`, e.g. "service:api operation_name:http.request" to find HTTP request spans from the api ' +
    'service, or "service:checkout status:error" for errored spans. `from`/`to` default to the last 15 minutes ' +
    '("now-15m" to "now") and accept either ISO-8601 timestamps or Datadog relative time terms ("now-1h", "now-1d", ' +
    `...). Results are capped at ${MAX_SPANS_LIMIT} per call (default ${DEFAULT_SPANS_LIMIT}). Each span in the ` +
    'response is projected down to trace_id, span_id, service, resource_name, operation_name, duration (nanoseconds), ' +
    'start, and status/error — full span attributes are never returned. When more results are available, the ' +
    'response includes `nextCursor`: pass it back as `cursor` to fetch the next page. IMPORTANT: this endpoint is ' +
    'rate-limited to 300 requests per hour by Datadog, far tighter than most other routes on this server — avoid ' +
    'calling it in an aggressive pagination loop; fetch only the pages you actually need.',
  routeIds: ['search_spans'],
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema,
  handler: handleSearchSpans,
});

export const spansTools: readonly ToolDef[] = [ddSearchSpans];
