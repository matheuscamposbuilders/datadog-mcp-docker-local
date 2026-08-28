/**
 * Reusable Zod building blocks composed by the tool input schemas.
 *
 * These schemas serve a dual purpose: they validate model input at runtime,
 * and the JSON Schema generated from them is what the LLM actually sees when
 * deciding how to call a tool. Every field therefore carries a `.describe()`
 * written in English (the language the model consumes), phrased as actionable
 * guidance rather than a bare type label.
 *
 * `zMetricName` and `zMonitorId` are deliberately kept byte-for-byte aligned
 * with the route patterns in `src/security/allowlist.ts` (`METRIC_NAME` and
 * `MONITOR_ID`). If they drift apart, a value that passes schema validation
 * can still be rejected by the allowlist chokepoint — the caller then sees a
 * confusing `ForbiddenRequestError` instead of a clear validation error at
 * the schema boundary. See `test/schemas/common.test.ts` for the alignment
 * check.
 */
import * as z from 'zod/v4';

/**
 * Matches `allowlist.ts`'s `METRIC_NAME = '[A-Za-z0-9_.]{1,200}'` exactly.
 * Do not change this without also updating the allowlist pattern.
 */
const METRIC_NAME_PATTERN = /^[A-Za-z0-9_.]{1,200}$/;

/**
 * Matches `allowlist.ts`'s `MONITOR_ID = '\\d{1,20}'` in spirit: `.int()` in
 * zod v4 only accepts values within the JS safe integer range (max
 * 9007199254740991, 16 digits), which is a strict subset of `\d{1,20}`. A
 * positive safe integer therefore always stringifies to something the
 * allowlist pattern also accepts.
 */
const MAX_CURSOR_CHARS = 4096;
const MAX_QUERY_CHARS = 2000;
const MAX_TAG_CHARS = 200;
const MAX_TAGS = 100;

/** Epoch timestamp in seconds (not milliseconds). Positive integer. */
export const zTimestampSeconds = z
  .number()
  .int()
  .positive()
  .describe(
    'Unix epoch timestamp in seconds (NOT milliseconds). Must be a positive integer, e.g. 1700000000.',
  );

/** A time range expressed as epoch seconds, with `to` required to be after `from`. */
export const zTimeRangeSeconds = z
  .object({
    from: zTimestampSeconds.describe(
      'Start of the time range, as a Unix epoch timestamp in seconds.',
    ),
    to: zTimestampSeconds.describe(
      'End of the time range, as a Unix epoch timestamp in seconds. Must be strictly greater than `from`.',
    ),
  })
  .refine((range) => range.to > range.from, {
    message: 'to must be strictly greater than from',
    path: ['to'],
  })
  .describe('A time range expressed as Unix epoch seconds, where `to` must be after `from`.');

const RELATIVE_TIME_PATTERN = /^now(-\d{1,10}[smhdw])?$/;

/**
 * Loosely validates ISO-8601 shape (date, optional time, optional
 * offset/`Z`) without pulling in a date library. `Date.parse` alone is too
 * permissive (it also accepts non-ISO formats like "Jan 1, 2024"), so both
 * checks run together.
 */
const ISO_8601_SHAPE_PATTERN =
  /^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/;

function isValidIsoDateTime(value: string): boolean {
  return ISO_8601_SHAPE_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}

const zIsoOrRelativeTime = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => RELATIVE_TIME_PATTERN.test(value) || isValidIsoDateTime(value), {
    message:
      'Must be an ISO-8601 timestamp (e.g. "2024-01-01T00:00:00Z") or a Datadog relative time term (e.g. "now", "now-15m", "now-1h").',
  });

/**
 * A time range where each bound is either an ISO-8601 timestamp or a
 * Datadog relative time term (`now`, `now-15m`, `now-1h`, ...). Ordering is
 * only checked when BOTH bounds are absolute timestamps — comparing a
 * relative term against an absolute one would require guessing how Datadog
 * resolves "now" server-side, which this schema deliberately does not do.
 */
export const zIsoTimeRange = z
  .object({
    from: zIsoOrRelativeTime.describe(
      'Start of the time range: an ISO-8601 timestamp (e.g. "2024-01-01T00:00:00Z") or a Datadog relative time term (e.g. "now-15m").',
    ),
    to: zIsoOrRelativeTime.describe(
      'End of the time range: an ISO-8601 timestamp (e.g. "2024-01-01T01:00:00Z") or a Datadog relative time term (e.g. "now").',
    ),
  })
  .refine(
    (range) => {
      const fromMs = Date.parse(range.from);
      const toMs = Date.parse(range.to);
      if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
        return true;
      }
      return toMs > fromMs;
    },
    { message: 'to must be after from when both are absolute timestamps', path: ['to'] },
  )
  .describe(
    'A time range where each bound is either an ISO-8601 timestamp or a Datadog relative time term such as "now-15m".',
  );

/** Result page size, bounded to `[1, max]` with a default of `def`. */
export function zLimit(max: number, def: number) {
  return z
    .number()
    .int()
    .min(1)
    .max(max)
    .default(def)
    .describe(`Maximum number of results to return, an integer between 1 and ${max} (default ${def}).`);
}

/** Opaque pagination cursor from a previous page. Size-capped, not otherwise parsed. */
export const zCursor = z
  .string()
  .max(MAX_CURSOR_CHARS)
  .describe(
    'Opaque pagination cursor returned by a previous call to this tool. Pass it back unmodified to fetch the next page. Omit it to fetch the first page.',
  )
  .optional();

/** A Datadog search/query string (log query, span query, monitor query, ...). */
export const zQueryString = z
  .string()
  .min(1)
  .max(MAX_QUERY_CHARS)
  .describe(
    `A Datadog query string (e.g. a log search query, span search query, or monitor search query), between 1 and ${MAX_QUERY_CHARS} characters.`,
  );

/**
 * A Datadog metric name. Letters, digits, underscores, and dots only, up to
 * 200 characters (e.g. "system.cpu.idle"). Must stay aligned with
 * `METRIC_NAME` in `src/security/allowlist.ts`.
 */
export const zMetricName = z
  .string()
  .regex(
    METRIC_NAME_PATTERN,
    'Metric name must contain only letters, digits, underscores, and dots (1-200 characters), e.g. "system.cpu.idle".',
  )
  .describe(
    'A dot-delimited Datadog metric name (e.g. "system.cpu.idle"). Letters, digits, underscores, and dots only, 1-200 characters.',
  );

/**
 * A Datadog monitor id. Must stay aligned with `MONITOR_ID` in
 * `src/security/allowlist.ts` (`\d{1,20}`) — see the module doc comment.
 */
export const zMonitorId = z
  .number()
  .int()
  .positive()
  .describe('The numeric id of a Datadog monitor, e.g. 123456. Must be a positive integer.');

/** Optional list of Datadog tags (`key:value` form) to filter or scope a request by. */
export const zTags = z
  .array(
    z
      .string()
      .min(1)
      .max(MAX_TAG_CHARS)
      .describe('A single Datadog tag in "key:value" form, e.g. "env:prod".'),
  )
  .max(MAX_TAGS)
  .describe(
    `Optional list of Datadog tags (each in "key:value" form) to filter or scope the request by. Up to ${MAX_TAGS} tags.`,
  )
  .optional();
