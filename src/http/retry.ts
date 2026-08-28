/**
 * Retry-delay policy for the Datadog HTTP chokepoint.
 *
 * `computeRetryDelayMs` is the single place that decides whether a failed
 * request is worth retrying and, if so, how long to wait first. It never
 * performs I/O and never sleeps — it is a pure function of
 * (status, headers, attempt, cfg) so it can be exhaustively table-tested.
 */
import type { DatadogConfig } from '../contracts.js';

/** Base delay for exponential backoff, before jitter. */
const BASE_DELAY_MS = 500;

/** Backoff never exceeds this, before jitter is applied. */
const MAX_BACKOFF_MS = 8000;

/** Jitter is applied as ±20% of the computed backoff. */
const JITTER_RATIO = 0.2;

/**
 * Deterministic pseudo-random value in [0, 1) derived from `attempt`.
 *
 * Backoff jitter must not use `Math.random()`: a test asserting an exact
 * delay would be flaky, and a test that only asserts bounds would still be
 * non-reproducible across runs (harder to debug a failure). Deriving the
 * "random" value from `attempt` alone keeps every call for the same attempt
 * number reproducible, while still spreading concurrent retries apart.
 */
function deterministicJitter(attempt: number): number {
  const x = Math.sin((attempt + 1) * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/** `min(2^attempt * 500, 8000)` ms, with deterministic ±20% jitter applied. */
function exponentialBackoffMs(attempt: number): number {
  const base = Math.min(2 ** attempt * BASE_DELAY_MS, MAX_BACKOFF_MS);
  const jitterFactor = 1 + JITTER_RATIO * (2 * deterministicJitter(attempt) - 1);
  return Math.round(base * jitterFactor);
}

/**
 * Parses the `Retry-After` header, which per HTTP spec may be either an
 * integer number of seconds or an HTTP-date. Returns `null` (never `NaN`)
 * for a missing or unparseable value. `nowMs` is injected rather than read
 * internally so the HTTP-date branch is testable without real wall-clock
 * dependence.
 */
export function parseRetryAfterMs(headers: Headers, nowMs: number): number | null {
  const raw = headers.get('retry-after');
  if (raw === null) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    return null;
  }

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    return Number.isFinite(seconds) ? seconds * 1000 : null;
  }

  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) {
    return null;
  }
  const deltaMs = dateMs - nowMs;
  return deltaMs > 0 ? deltaMs : 0;
}

/**
 * Parses `X-RateLimit-Reset`, which Datadog documents as seconds *until*
 * the limit resets (not an epoch timestamp). Returns `null` for a missing
 * or non-integer value.
 */
function parseRateLimitResetMs(headers: Headers): number | null {
  const raw = headers.get('x-ratelimit-reset');
  if (raw === null) {
    return null;
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const seconds = Number.parseInt(trimmed, 10);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

/**
 * Decides whether attempt number `attempt` (0-indexed, the attempt that
 * just failed) should be retried, and if so after how long.
 *
 * Order of evaluation is significant — see README/task spec:
 *   1. `attempt >= cfg.maxRetries` -> null (with `maxRetries: 0`, never retry)
 *   2. status 429 -> Retry-After, else X-RateLimit-Reset, else backoff
 *   3. status 5xx -> exponential backoff
 *   4. anything else -> null (no retry for non-429 4xx)
 *   5. if the resulting delay exceeds `cfg.maxRetryWaitMs` -> null. Blocking
 *      the MCP session for minutes is worse than failing fast with a
 *      message telling the caller to retry later.
 */
export function computeRetryDelayMs(
  status: number,
  headers: Headers,
  attempt: number,
  cfg: DatadogConfig,
): number | null {
  if (attempt >= cfg.maxRetries) {
    return null;
  }

  let delayMs: number;
  if (status === 429) {
    delayMs =
      parseRetryAfterMs(headers, Date.now()) ??
      parseRateLimitResetMs(headers) ??
      exponentialBackoffMs(attempt);
  } else if (status >= 500 && status <= 599) {
    delayMs = exponentialBackoffMs(attempt);
  } else {
    return null;
  }

  if (delayMs > cfg.maxRetryWaitMs) {
    return null;
  }
  return delayMs;
}
