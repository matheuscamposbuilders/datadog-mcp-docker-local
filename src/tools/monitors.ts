/**
 * Monitor tools: `dd_list_monitors`, `dd_get_monitor`, `dd_search_monitors`.
 *
 * Backed by the `list_monitors`, `get_monitor`, and `search_monitors` routes
 * in `src/security/allowlist.ts`.
 */
import * as z from 'zod/v4';
import type { ToolDef } from '../contracts.js';
import { defineTool } from './define-tool.js';
import { projectFields, toErrorResult, toToolResult, truncateString } from '../format.js';
import { zLimit, zMonitorId, zQueryString, zTags } from '../schemas/common.js';

/** Max characters kept from a monitor's `query` field before truncation. */
const QUERY_MAX_CHARS = 200;

/** Default / max page size for dd_list_monitors (v1 `page`/`page_size`, 0-based). */
const LIST_MONITORS_DEFAULT_PAGE_SIZE = 50;
const LIST_MONITORS_MAX_PAGE_SIZE = 200;

/** Default / max results per page for dd_search_monitors. */
const SEARCH_MONITORS_DEFAULT_PER_PAGE = 30;
const SEARCH_MONITORS_MAX_PER_PAGE = 100;

/**
 * Fields kept from each raw Datadog monitor when listing/searching. A full
 * monitor object carries a large nested `options` block and a per-scope
 * `state` history — dumping those for every monitor in a list would blow
 * the model's context window, so only a compact summary is projected here.
 * Use `dd_get_monitor` for the full object.
 */
const MONITOR_SUMMARY_FIELDS = [
  'id',
  'name',
  'type',
  'overall_state',
  'status',
  'tags',
  'query',
  'created',
  'modified',
] as const;

interface RawMonitor {
  readonly id?: number;
  readonly name?: string;
  readonly type?: string;
  /** Present on `GET /api/v1/monitor` and `GET /api/v1/monitor/{id}` results. */
  readonly overall_state?: string;
  /** Present on `GET /api/v1/monitor/search` results instead of `overall_state`. */
  readonly status?: string;
  readonly tags?: readonly string[];
  readonly query?: string;
  readonly created?: string;
  readonly modified?: string;
}

interface MonitorSearchResponse {
  readonly monitors?: readonly RawMonitor[];
  readonly metadata?: { readonly total_count?: number };
}

/** Projects a raw monitor down to `MONITOR_SUMMARY_FIELDS`, truncating `query`. */
function summarizeMonitor(monitor: RawMonitor): Partial<RawMonitor> {
  const projected = projectFields(monitor, MONITOR_SUMMARY_FIELDS);
  if (typeof projected.query === 'string') {
    return { ...projected, query: truncateString(projected.query, QUERY_MAX_CHARS) };
  }
  return projected;
}

const zPage = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe(
    'Zero-based page number. Datadog monitor list/search pagination uses page/page_size, NOT a cursor ' +
      '(this differs from the cursor-based pagination used elsewhere in this server). Omit to fetch the first page.',
  );

/**
 * `page` for `dd_list_monitors`, defaulted to 0 (not merely optional).
 *
 * `GET /api/v1/monitor` only honors `page_size` when `page` is ALSO present
 * in the query string — sending `page_size` alone makes the API ignore it
 * and return every monitor in the org (observed: a 5-monitor request without
 * `page` returned 3.1 MB and blew the response-size guardrail). Giving this
 * field a schema default means `page` is always present in `args`, so the
 * handler always sends it, and the default is visible to the model in the
 * generated JSON Schema. Do NOT special-case this in the handler instead
 * (e.g. injecting `page: 0` only when `pageSize` is set) — that would make
 * the query's shape depend on which fields happen to be passed, invisible to
 * anyone reading the schema.
 */
const zListPage = zPage.default(0);

const zListMonitorsInput = z.object({
  name: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Optional case-insensitive substring filter on monitor name.'),
  tags: zTags.describe(
    'Optional list of tags (each "key:value") to filter monitors by scope, e.g. ["env:prod"]. Sent to the ' +
      'API as a comma-separated list.',
  ),
  monitorTags: zTags.describe(
    'Optional list of tags (each "key:value") set directly on the monitor definition itself, as opposed to ' +
      'its scope. Sent to the API as a comma-separated list.',
  ),
  page: zListPage,
  pageSize: zLimit(LIST_MONITORS_MAX_PAGE_SIZE, LIST_MONITORS_DEFAULT_PAGE_SIZE).describe(
    `Number of monitors per page, an integer between 1 and ${LIST_MONITORS_MAX_PAGE_SIZE} (default ${LIST_MONITORS_DEFAULT_PAGE_SIZE}).`,
  ),
});

const zGetMonitorInput = z.object({
  monitorId: zMonitorId,
});

const zSearchMonitorsInput = z.object({
  query: zQueryString.describe(
    'A Datadog monitor search query, using monitor search syntax. Examples: "status:Alert" (monitors ' +
      'currently alerting), "type:metric alert" (only metric alert monitors), "tag:env:prod" (monitors ' +
      'tagged env:prod), "muted:true" (muted monitors). Combine terms with spaces for AND, e.g. ' +
      '"status:Alert type:metric alert".',
  ),
  page: zPage,
  perPage: zLimit(SEARCH_MONITORS_MAX_PER_PAGE, SEARCH_MONITORS_DEFAULT_PER_PAGE).describe(
    `Number of monitors per page, an integer between 1 and ${SEARCH_MONITORS_MAX_PER_PAGE} (default ${SEARCH_MONITORS_DEFAULT_PER_PAGE}).`,
  ),
  sort: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe('Optional sort order for results, e.g. "name,asc" or "status,desc". Omit for Datadog default ordering.'),
});

const ddListMonitors = defineTool({
    name: 'dd_list_monitors',
    title: 'List Monitors',
    description:
      'Lists Datadog monitors (GET /api/v1/monitor), optionally filtered by name substring or tags. Use this ' +
      'to discover what monitors exist or to scan overall monitor health at a glance. Pagination is 0-based ' +
      '`page`/`pageSize` (different from the cursor-based pagination used by other tools in this server) — ' +
      'pass the next `page` number to fetch more. `page` (default 0) and `pageSize` (default ' +
      `${LIST_MONITORS_DEFAULT_PAGE_SIZE}) are ALWAYS sent to the Datadog API even when omitted ` +
      '(the API only honors `pageSize` when `page` is also present, so this tool never omits either). ' +
      'IMPORTANT: the result is SUMMARIZED — each monitor only ' +
      'includes `id`, `name`, `type`, `overall_state` (this monitor\'s current alert status, e.g. "OK", ' +
      '"Alert", "Warn", "No Data"), `tags`, a truncated `query` (~200 chars), `created`, and `modified`. ' +
      'The full monitor definition (alert options, notification message, per-scope state history, etc.) is ' +
      'much larger; call `dd_get_monitor` with a specific `id` from this list to get it.',
    routeIds: ['list_monitors'],
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: zListMonitorsInput,
    handler: async (args, ctx) => {
      try {
        // `args.page`/`args.pageSize` are typed as always-present (their
        // schema fields carry `.default(...)`), but that's a lie about what
        // actually reaches this handler in production: the MCP SDK invokes
        // this handler with the raw arguments object the caller sent, NOT
        // the result of `inputSchema.parse()` — Zod's `.default()` is never
        // applied. A caller that omits `page`/`pageSize` therefore hands
        // this handler genuinely `undefined` values at runtime despite what
        // the type claims. Falling back explicitly here (never trusting the
        // schema default to have already run) is what keeps `page` on the
        // wire — the field the Datadog API silently requires alongside
        // `page_size` (see the module doc comment / QUERY_MAX_CHARS above);
        // omitting it made a `{ pageSize: 5 }` call return the entire org
        // (3.1 MB) in production. See the regression tests that call this
        // handler with a raw, un-parsed args object to catch exactly this.
        const query: Record<string, string | number | boolean | undefined> = {
          page: args.page ?? 0,
          page_size: args.pageSize ?? LIST_MONITORS_DEFAULT_PAGE_SIZE,
        };
        if (args.name !== undefined) {
          query.name = args.name;
        }
        if (args.tags !== undefined && args.tags.length > 0) {
          query.tags = args.tags.join(',');
        }
        if (args.monitorTags !== undefined && args.monitorTags.length > 0) {
          query.monitor_tags = args.monitorTags.join(',');
        }

        const monitors = await ctx.client.get<readonly RawMonitor[]>('/api/v1/monitor', query);
        const summarized = monitors.map(summarizeMonitor);

        return toToolResult(
          { monitors: summarized },
          {
            note:
              'This is a summarized list: only id, name, type, overall_state, tags, a truncated query, ' +
              'created, and modified are included per monitor. Call dd_get_monitor with a specific id for ' +
              'the full monitor definition.',
          },
        );
      } catch (err) {
        return toErrorResult(err);
      }
    },
  });

const ddGetMonitor = defineTool({
    name: 'dd_get_monitor',
    title: 'Get Monitor',
    description:
      'Fetches the full definition of a single Datadog monitor by id (GET /api/v1/monitor/{monitor_id}), ' +
      'including its complete alert query, all configured options (thresholds, notification message, ' +
      'evaluation window, etc.), and per-scope state history. Use this after `dd_list_monitors` or ' +
      '`dd_search_monitors` to inspect one monitor in detail. `monitorId` must be the numeric id of an ' +
      'existing monitor (e.g. from a prior list/search result), not its name.',
    routeIds: ['get_monitor'],
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: zGetMonitorInput,
    handler: async (args, ctx) => {
      try {
        // monitorId is validated by zMonitorId as a positive safe integer, so
        // this template string always stringifies to plain digits — exactly
        // what the `get_monitor` allowlist pattern (`\d{1,20}`) expects. No
        // encoding is applied or needed here.
        const monitor = await ctx.client.get<unknown>(`/api/v1/monitor/${args.monitorId}`);
        return toToolResult(monitor);
      } catch (err) {
        return toErrorResult(err);
      }
    },
  });

const ddSearchMonitors = defineTool({
    name: 'dd_search_monitors',
    title: 'Search Monitors',
    description:
      'Searches Datadog monitors using monitor search syntax (GET /api/v1/monitor/search). Use this instead ' +
      'of `dd_list_monitors` when you need to filter by status, type, or tags with a query string, e.g. ' +
      '`query: "status:Alert"` for currently-alerting monitors, `query: "type:metric alert"` for a specific ' +
      'monitor type, or `query: "tag:env:prod"` for monitors tagged env:prod. Results can be paginated with ' +
      '`page` (0-based) and `perPage`, and optionally ordered with `sort` (e.g. "name,asc"). Like ' +
      '`dd_list_monitors`, each result is SUMMARIZED (id, name, type, tags, a truncated query, created, ' +
      'modified) — call `dd_get_monitor` for the full monitor. IMPORTANT for status filtering: this endpoint ' +
      'reports each monitor\'s current alert status in a `status` field (e.g. "OK", "Alert", "Warn", "No ' +
      'Data") — NOT `overall_state`, which is what `dd_list_monitors`/`dd_get_monitor` use for the same ' +
      'concept. The response also includes `totalCount`, the total number of monitors matching the query ' +
      'across all pages, when Datadog reports it.',
    routeIds: ['search_monitors'],
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: zSearchMonitorsInput,
    handler: async (args, ctx) => {
      try {
        const query: Record<string, string | number | boolean | undefined> = {
          query: args.query,
          page: args.page,
          per_page: args.perPage,
        };
        if (args.sort !== undefined) {
          query.sort = args.sort;
        }

        const response = await ctx.client.get<MonitorSearchResponse>('/api/v1/monitor/search', query);
        const monitors = response.monitors ?? [];
        const summarized = monitors.map(summarizeMonitor);

        const result: { monitors: readonly Partial<RawMonitor>[]; totalCount?: number } = {
          monitors: summarized,
        };
        if (typeof response.metadata?.total_count === 'number') {
          result.totalCount = response.metadata.total_count;
        }

        return toToolResult(result, {
          note:
            'This is a summarized list: only id, name, type, status, tags, a truncated query, created, and ' +
            'modified are included per monitor (this endpoint reports alert status as `status`, not ' +
            '`overall_state`). Call dd_get_monitor with a specific id for the full monitor definition.',
        });
      } catch (err) {
        return toErrorResult(err);
      }
    },
  });

export const monitorsTools: readonly ToolDef[] = [ddListMonitors, ddGetMonitor, ddSearchMonitors];
