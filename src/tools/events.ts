/**
 * `dd_list_events` — the single tool backed by the `list_events` route
 * (`GET /api/v1/events`).
 */
import * as z from 'zod/v4';
import type { ToolDef } from '../contracts.js';
import { defineTool } from './define-tool.js';
import { toErrorResult, toToolResult, projectFields, truncateString } from '../format.js';
import { zLimit, zTags, zTimestampSeconds } from '../schemas/common.js';

/** Max characters kept from an event's `text` field before truncation. */
const TEXT_MAX_CHARS = 300;

/** Default and max number of events returned by a single call. */
const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_LIMIT = 500;

/** Max length of a single free-text `sources` entry (Datadog source names are short). */
const MAX_SOURCE_CHARS = 200;
const MAX_SOURCES = 100;

/** Fields kept from each raw Datadog event. Everything else (e.g. large nested payloads) is dropped. */
const EVENT_FIELDS = [
  'id',
  'date_happened',
  'title',
  'text',
  'priority',
  'source',
  'host',
  'tags',
  'alert_type',
] as const;

const inputSchema = z
  .object({
    from: zTimestampSeconds.describe(
      'Start of the time window to list events for, as a Unix epoch timestamp in seconds.',
    ),
    to: zTimestampSeconds.describe(
      'End of the time window to list events for, as a Unix epoch timestamp in seconds. Must be strictly greater than `from`.',
    ),
    priority: z
      .enum(['normal', 'low'])
      .optional()
      .describe('Optional filter: only return events of this priority ("normal" or "low").'),
    sources: z
      .array(
        z
          .string()
          .min(1)
          .max(MAX_SOURCE_CHARS)
          .describe('A single Datadog event source, e.g. "deploy", "chef", "nagios".'),
      )
      .max(MAX_SOURCES)
      .optional()
      .describe(
        'Optional list of event sources to filter by (e.g. ["deploy", "nagios"]). Sent to the API as a comma-separated list.',
      ),
    tags: zTags,
    unaggregated: z
      .boolean()
      .optional()
      .describe('Optional. When true, disables event aggregation in the response.'),
    excludeAggregate: z
      .boolean()
      .optional()
      .describe('Optional. When true, excludes aggregate events from the response.'),
    limit: zLimit(MAX_EVENT_LIMIT, DEFAULT_EVENT_LIMIT),
  })
  .refine((value) => value.to > value.from, {
    message: 'to must be strictly greater than from',
    path: ['to'],
  });

interface RawEvent {
  readonly id?: number | string;
  readonly date_happened?: number;
  readonly title?: string;
  readonly text?: string;
  readonly priority?: string;
  readonly source?: string;
  readonly host?: string;
  readonly tags?: readonly string[];
  readonly alert_type?: string;
}

interface EventsResponse {
  readonly events?: readonly RawEvent[];
}

function projectEvent(event: RawEvent): Partial<RawEvent> {
  const projected = projectFields(event, EVENT_FIELDS);
  if (typeof projected.text === 'string') {
    return { ...projected, text: truncateString(projected.text, TEXT_MAX_CHARS) };
  }
  return projected;
}

export const eventsTools: readonly ToolDef[] = [
  defineTool({
    name: 'dd_list_events',
    title: 'List Datadog Events',
    description:
      'Lists Datadog events (deploys, alerts, comments, config changes, etc.) that occurred within a given ' +
      'time window, by calling GET /api/v1/events. Use this to investigate what happened around an incident — ' +
      'e.g. "what deploys or alerts fired between 14:00 and 15:00 today". `from` and `to` are REQUIRED Unix ' +
      'epoch timestamps IN SECONDS (not milliseconds, not ISO strings), with `to` strictly after `from`. ' +
      'Optionally narrow results by ' +
      '`priority` ("normal" or "low"), `sources` (e.g. "deploy", "nagios"), or `tags` (e.g. "env:prod"). ' +
      'Results are capped (default 100, max 500 events per call) and the event `text` field is truncated to ' +
      'keep responses compact — if more events matched than the cap, the result says so explicitly; narrow the ' +
      'time range or raise `limit` to see more.',
    routeIds: ['list_events'],
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema,
    handler: async (args, ctx) => {
      try {
        const query: Record<string, string | number | boolean | undefined> = {
          start: args.from,
          end: args.to,
        };
        if (args.priority !== undefined) {
          query.priority = args.priority;
        }
        if (args.sources !== undefined && args.sources.length > 0) {
          query.sources = args.sources.join(',');
        }
        if (args.tags !== undefined && args.tags.length > 0) {
          query.tags = args.tags.join(',');
        }
        if (args.unaggregated !== undefined) {
          query.unaggregated = args.unaggregated;
        }
        if (args.excludeAggregate !== undefined) {
          query.exclude_aggregate = args.excludeAggregate;
        }

        const response = await ctx.client.get<EventsResponse>('/api/v1/events', query);
        const events = response.events ?? [];
        // `args.limit` is typed as always-present (the schema field carries
        // `.default(...)`), but the MCP SDK hands this handler the caller's
        // raw args, not `inputSchema.parse()`'s output — the default never
        // actually applies. Left un-defaulted, `events.length > undefined`
        // is always false and `events.slice(0, undefined)` returns every
        // event unsliced, silently disabling the cap this tool documents.
        const limit = args.limit ?? DEFAULT_EVENT_LIMIT;
        const wasLimited = events.length > limit;
        const projected = events.slice(0, limit).map(projectEvent);

        const note = wasLimited
          ? `Returned ${limit} of ${events.length} matching events (limit=${limit}). This result is INCOMPLETE — narrow the time range, add filters, or raise \`limit\` (max ${MAX_EVENT_LIMIT}) to see the rest.`
          : undefined;

        return toToolResult({ events: projected }, note !== undefined ? { note } : undefined);
      } catch (err) {
        return toErrorResult(err);
      }
    },
  }),
];
