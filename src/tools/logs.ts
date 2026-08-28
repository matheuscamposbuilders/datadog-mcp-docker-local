/**
 * `dd_search_logs` — the tool backed by the `search_logs` route
 * (`POST /api/v2/logs/events/search`).
 *
 * This is one of exactly two POST routes this server is permitted to call
 * (the other being `search_spans`; see src/security/allowlist.ts's module
 * doc for why read-only Datadog access still needs POST). Because the
 * allowlist only constrains (method, path), the REQUEST BODY is the other
 * half of what defines a safe request here. `buildLogsSearchBody` therefore
 * builds the body field-by-field from explicitly named, already
 * Zod-validated properties — never a spread of the raw args — so a model
 * cannot smuggle an arbitrary extra key into the JSON sent to Datadog.
 */
import * as z from 'zod/v4';
import type { ToolContext, ToolDef, ToolResult } from '../contracts.js';
import { defineTool } from './define-tool.js';
import { projectFields, toErrorResult, toToolResult, truncateString } from '../format.js';
import { zCursor, zLimit, zQueryString } from '../schemas/common.js';

const MAX_LOGS_LIMIT = 200;
const DEFAULT_LOGS_LIMIT = 25;
const MESSAGE_MAX_CHARS = 500;
const MAX_INDEXES = 50;
const MAX_INDEX_NAME_CHARS = 200;
const DEFAULT_FROM = 'now-15m';
const DEFAULT_TO = 'now';
const DEFAULT_SORT = '-timestamp';

const RELATIVE_TIME_PATTERN = /^now(-\d{1,10}[smhdw])?$/;
/**
 * Loosely validates ISO-8601 shape without pulling in a date library.
 * Mirrors src/schemas/common.ts's (non-exported) `zIsoOrRelativeTime`
 * pattern exactly — that helper can't be imported directly since it isn't
 * exported, and this tool needs `from`/`to` as independently-defaulted
 * top-level params rather than the required, nested `{from, to}` pair
 * `zIsoTimeRange` provides.
 */
const ISO_8601_SHAPE_PATTERN =
  /^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/;

function isValidIsoDateTime(value: string): boolean {
  return ISO_8601_SHAPE_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}

/** A single ISO-8601-or-relative-time bound (`from` or `to`), with a default. */
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

const zIndexes = z
  .array(z.string().min(1).max(MAX_INDEX_NAME_CHARS))
  .max(MAX_INDEXES)
  .optional()
  .describe(
    'Optional list of Datadog log index names to restrict the search to (e.g. ["main"]). Omit to search all indexes the App Key can access.',
  );

const zSort = z
  .enum(['timestamp', '-timestamp'])
  .default(DEFAULT_SORT)
  .describe(
    'Sort order for results by timestamp: "timestamp" for oldest first, "-timestamp" for newest first (default).',
  );

const inputSchema = z
  .object({
    query: zQueryString.describe(
      'Datadog log search query using standard log search syntax (facets, free text, boolean operators), ' +
        'e.g. "service:api status:error" or "host:web-01 AND \\"connection refused\\"".',
    ),
    from: zIsoOrRelativeTimeWithDefault(DEFAULT_FROM, 'Start'),
    to: zIsoOrRelativeTimeWithDefault(DEFAULT_TO, 'End'),
    indexes: zIndexes,
    limit: zLimit(MAX_LOGS_LIMIT, DEFAULT_LOGS_LIMIT),
    cursor: zCursor,
    sort: zSort,
  })
  .strict();

export type LogsSearchParams = z.infer<typeof inputSchema>;

/**
 * Builds the `POST /api/v2/logs/events/search` request body field-by-field
 * from `params`. Deliberately does NOT spread `params` or use
 * `Object.assign` from it — only the named properties below are ever read,
 * so any extra property present on `params` (a stray model-supplied field,
 * a polluted prototype, anything) is structurally discarded rather than
 * forwarded to Datadog.
 */
export function buildLogsSearchBody(params: LogsSearchParams): Record<string, unknown> {
  // Same trap as dd_list_monitors' page/pageSize (see src/tools/monitors.ts):
  // the MCP SDK hands handlers the caller's raw args, NOT the result of
  // `inputSchema.parse()`, so Zod's `.default(...)` on from/to/limit/sort
  // never actually runs in production. Left un-defaulted here, an omitted
  // field becomes a literal `undefined` in this object, which
  // `JSON.stringify` then drops from the POST body entirely — e.g. omitting
  // `limit` doesn't send "no limit was requested", it sends no `limit` key
  // at all, and omitting `from`/`to` sends a filter with no time bound
  // instead of the intended "last 15 minutes". Every field the model can
  // omit gets its schema default re-applied here explicitly.
  const filter: Record<string, unknown> = {
    query: params.query,
    from: params.from ?? DEFAULT_FROM,
    to: params.to ?? DEFAULT_TO,
  };
  if (params.indexes !== undefined) {
    filter.indexes = params.indexes;
  }

  const page: Record<string, unknown> = {
    limit: params.limit ?? DEFAULT_LOGS_LIMIT,
  };
  if (params.cursor !== undefined) {
    page.cursor = params.cursor;
  }

  return {
    filter,
    page,
    sort: params.sort ?? DEFAULT_SORT,
  };
}

interface LogsSearchResponseEntryAttributes {
  readonly timestamp?: string;
  readonly service?: string;
  readonly status?: string;
  readonly host?: string;
  readonly message?: string;
  readonly [key: string]: unknown;
}

interface LogsSearchResponseEntry {
  readonly id?: string;
  readonly type?: string;
  readonly attributes?: LogsSearchResponseEntryAttributes;
}

interface LogsSearchResponse {
  readonly data?: readonly LogsSearchResponseEntry[];
  readonly meta?: { readonly page?: { readonly after?: string } };
}

interface ProjectedLog {
  timestamp?: string;
  service?: string;
  status?: string;
  host?: string;
  message?: string;
}

const LOG_PROJECTION_FIELDS = ['timestamp', 'service', 'status', 'host', 'message'] as const;

/**
 * Projects a single Datadog log event down to the small, flat set of fields
 * the model needs, discarding the (often large) nested `attributes.attributes`
 * custom-tag bag entirely. `message` is truncated to `MESSAGE_MAX_CHARS`.
 */
function projectLogEntry(entry: LogsSearchResponseEntry): ProjectedLog {
  const attrs = entry.attributes ?? {};
  const projected = projectFields(attrs, LOG_PROJECTION_FIELDS) as ProjectedLog;
  if (typeof projected.message === 'string') {
    projected.message = truncateString(projected.message, MESSAGE_MAX_CHARS);
  }
  return projected;
}

interface LogsSearchResult {
  logs: ProjectedLog[];
  nextCursor?: string;
}

async function handleSearchLogs(args: LogsSearchParams, ctx: ToolContext): Promise<ToolResult> {
  try {
    const body = buildLogsSearchBody(args);
    const response = await ctx.client.postSearch<LogsSearchResponse>(
      '/api/v2/logs/events/search',
      body,
      ctx.signal !== undefined ? { signal: ctx.signal } : {},
    );

    const logs = (response.data ?? []).map(projectLogEntry);
    const result: LogsSearchResult = { logs };
    const nextCursor = response.meta?.page?.after;
    if (nextCursor !== undefined) {
      result.nextCursor = nextCursor;
    }

    return toToolResult(result, {
      note:
        'Each log\'s `message` is truncated to 500 characters. If `nextCursor` is present, pass it back as the `cursor` ' +
        'parameter to fetch the next page.',
    });
  } catch (err) {
    return toErrorResult(err);
  }
}

const ddSearchLogs = defineTool({
  name: 'dd_search_logs',
  title: 'Search Datadog Logs',
  description:
    'Searches Datadog log events via POST /api/v2/logs/events/search. Use standard Datadog log search syntax for ' +
    '`query`, e.g. "service:api status:error" to find error logs from the api service, or "host:web-01 status:warn" ' +
    'for warnings from a specific host. `from`/`to` default to the last 15 minutes ("now-15m" to "now") and accept ' +
    'either ISO-8601 timestamps or Datadog relative time terms ("now-1h", "now-1d", ...). Results are capped at ' +
    `${MAX_LOGS_LIMIT} per call (default ${DEFAULT_LOGS_LIMIT}); each log's \`message\` field in the response is ` +
    `truncated to ${MESSAGE_MAX_CHARS} characters — narrow the query if you need the full message. When more results ` +
    'are available, the response includes `nextCursor`: pass it back as `cursor` to fetch the next page.',
  routeIds: ['search_logs'],
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema,
  handler: handleSearchLogs,
});

export const logsTools: readonly ToolDef[] = [ddSearchLogs];
