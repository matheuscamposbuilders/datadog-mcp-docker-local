/**
 * The read-only allowlist: the single source of truth for which
 * (method, route) pairs the Datadog HTTP chokepoint is permitted to issue.
 *
 * Read-only in the Datadog API is NOT the same as GET-only — logs and APM
 * span search are POST endpoints (`POST /api/v2/logs/events/search`,
 * `POST /api/v2/spans/events/search`). Filtering by verb alone would either
 * block essential functionality or be trivially bypassable. Every route
 * below is therefore allowlisted as an exact (method, anchored-pattern)
 * pair, never by verb or prefix alone.
 */
import type { AllowedRoute, HttpMethod } from '../contracts.js';
import { ForbiddenRequestError } from '../http/errors.js';

const API_PATH_PREFIXES = ['/api/v1/', '/api/v2/'] as const;

/**
 * `{monitor_id}` is digits-only (`\d{1,20}`), deliberately. If it accepted
 * letters, `/api/v1/monitor/search` would match both `search_monitors` and
 * `get_monitor`, making route resolution ambiguous. Digits-only makes the
 * disambiguation structural rather than order-dependent.
 */
const MONITOR_ID = '\\d{1,20}';

/**
 * `{metric_name}` allows `.` (Datadog metric names are dotted, e.g.
 * `system.cpu.idle`), which means it would also allow `..`. The defense
 * against traversal via this segment is `normalizePathname`, not this
 * character class — see its tests.
 */
const METRIC_NAME = '[A-Za-z0-9_.]{1,200}';

function frozenRoute(route: {
  id: string;
  method: HttpMethod;
  pattern: RegExp;
  scopes: readonly string[];
}): AllowedRoute {
  return Object.freeze({
    id: route.id,
    method: route.method,
    pattern: route.pattern,
    scopes: Object.freeze([...route.scopes]),
  });
}

/** The exact 10 allowlisted (method, route) pairs. Nothing else may be added silently. */
export const ALLOWED_ROUTES: readonly AllowedRoute[] = Object.freeze([
  frozenRoute({
    id: 'validate',
    method: 'GET',
    pattern: /^\/api\/v1\/validate$/,
    scopes: [],
  }),
  frozenRoute({
    id: 'query_timeseries',
    method: 'GET',
    pattern: /^\/api\/v1\/query$/,
    scopes: ['timeseries_query'],
  }),
  frozenRoute({
    id: 'list_metrics',
    method: 'GET',
    pattern: /^\/api\/v1\/metrics$/,
    scopes: ['metrics_read'],
  }),
  frozenRoute({
    id: 'get_metric_metadata',
    method: 'GET',
    pattern: new RegExp(`^/api/v1/metrics/${METRIC_NAME}$`),
    scopes: ['metrics_read'],
  }),
  frozenRoute({
    id: 'search_monitors',
    method: 'GET',
    pattern: /^\/api\/v1\/monitor\/search$/,
    scopes: ['monitors_read'],
  }),
  frozenRoute({
    id: 'list_monitors',
    method: 'GET',
    pattern: /^\/api\/v1\/monitor$/,
    scopes: ['monitors_read'],
  }),
  frozenRoute({
    id: 'get_monitor',
    method: 'GET',
    pattern: new RegExp(`^/api/v1/monitor/${MONITOR_ID}$`),
    scopes: ['monitors_read'],
  }),
  frozenRoute({
    id: 'list_events',
    method: 'GET',
    pattern: /^\/api\/v1\/events$/,
    scopes: ['events_read'],
  }),
  frozenRoute({
    id: 'search_logs',
    method: 'POST',
    pattern: /^\/api\/v2\/logs\/events\/search$/,
    scopes: ['logs_read_data', 'logs_read_index_data'],
  }),
  frozenRoute({
    id: 'search_spans',
    method: 'POST',
    pattern: /^\/api\/v2\/spans\/events\/search$/,
    scopes: ['apm_read'],
  }),
]);

/** Type guard: is `value` one of the two verbs this server will ever issue. */
function isHttpMethod(value: string): value is HttpMethod {
  return value === 'GET' || value === 'POST';
}

/**
 * Normalizes and validates a request pathname. Throws `ForbiddenRequestError`
 * for anything that looks like path traversal, separator smuggling, or
 * encoding tricks. Does exactly one `decodeURIComponent` pass, and runs the
 * `..`/`//` checks AFTER decoding — checking before decoding would let
 * `%2e%2e` slip through undetected.
 */
export function normalizePathname(pathname: string): string {
  // Every path this server ever builds internally is plain ASCII — metric
  // names are [A-Za-z0-9_.], monitor ids are digits. None of it legitimately
  // needs percent-encoding. Rejecting '%' in the RAW input (before any
  // decode) closes the whole class of "validated string differs from
  // requested string" bugs at the source: normalizePathname's return value
  // is then guaranteed byte-identical to its input for every accepted path,
  // so a caller building a request URL from the return value can never send
  // something other than what was validated.
  if (pathname.includes('%')) {
    throw new ForbiddenRequestError('Request path must not be percent-encoded.');
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new ForbiddenRequestError('Request path contains malformed percent-encoding.');
  }

  // With the raw-input '%' check above, decodeURIComponent is now always a
  // no-op and this can never fire. Kept anyway as cheap, redundant defense
  // — redundancy is the point of an allowlist — in case the check above is
  // ever weakened without this one being revisited.
  if (decoded.includes('%')) {
    throw new ForbiddenRequestError('Request path contains double-encoded characters.');
  }
  if (decoded.includes('..')) {
    throw new ForbiddenRequestError('Request path contains a traversal sequence.');
  }
  if (decoded.includes('//')) {
    throw new ForbiddenRequestError('Request path contains a doubled path separator.');
  }
  // Reject the whole C0 control range (includes \0, \n, \r, \t, ...) plus
  // DEL (0x7f). A bare \0 check alone lets \n/\r through, and those can
  // forge a fake log line once an unmatched path lands in an error message
  // that the logger writes to a line-oriented stream (log injection).
  if (/[\x00-\x1f\x7f]/.test(decoded)) {
    throw new ForbiddenRequestError('Request path contains a control character.');
  }
  if (decoded.includes('\\')) {
    throw new ForbiddenRequestError('Request path contains an illegal character.');
  }
  if (!API_PATH_PREFIXES.some((prefix) => decoded.startsWith(prefix))) {
    throw new ForbiddenRequestError('Request path must start with /api/v1/ or /api/v2/.');
  }

  return decoded;
}

/**
 * Resolves `(method, pathname)` against `ALLOWED_ROUTES`, returning
 * `undefined` for anything not allowlisted instead of throwing. Never
 * throws: normalization failures are treated as "no match".
 */
export function findAllowedRoute(method: string, pathname: string): AllowedRoute | undefined {
  const normalizedMethod = method.toUpperCase();
  if (!isHttpMethod(normalizedMethod)) {
    return undefined;
  }

  let normalized: string;
  try {
    normalized = normalizePathname(pathname);
  } catch {
    return undefined;
  }

  return ALLOWED_ROUTES.find(
    (route) => route.method === normalizedMethod && route.pattern.test(normalized),
  );
}

/**
 * Resolves `(method, pathname)` against `ALLOWED_ROUTES`, throwing
 * `ForbiddenRequestError` for anything not allowlisted.
 *
 * The method check runs FIRST, before any path parsing — this is the
 * barrier that still holds even if a route pattern has a bug. Only `GET`
 * and `POST` (after `toUpperCase()`) are ever accepted.
 */
export function assertAllowed(method: string, pathname: string): AllowedRoute {
  const normalizedMethod = method.toUpperCase();
  if (!isHttpMethod(normalizedMethod)) {
    throw new ForbiddenRequestError(`HTTP method not allowed: ${method}`);
  }

  const normalized = normalizePathname(pathname);

  const route = ALLOWED_ROUTES.find(
    (r) => r.method === normalizedMethod && r.pattern.test(normalized),
  );
  if (!route) {
    // Cite method + normalized path only — never the full URL, which may
    // carry a query string containing sensitive data.
    throw new ForbiddenRequestError(`Route not allowlisted: ${normalizedMethod} ${normalized}`);
  }

  return route;
}

/**
 * Parses `url`, validates its transport and host, then delegates to
 * `assertAllowed` for the method/path check.
 *
 * The host comparison is EXACT equality against `expectedHost`, never
 * `endsWith` — `endsWith('datadoghq.com')` would also accept
 * `evil-datadoghq.com`. This is a security requirement, not a style choice.
 */
export function assertAllowedUrl(method: string, url: string, expectedHost: string): AllowedRoute {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ForbiddenRequestError('Malformed URL.');
  }

  if (parsed.protocol !== 'https:') {
    throw new ForbiddenRequestError(`URL must use https: got ${parsed.protocol}`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new ForbiddenRequestError('URL must not contain embedded credentials.');
  }
  if (parsed.host !== expectedHost) {
    throw new ForbiddenRequestError(`Unexpected host: ${parsed.host}`);
  }

  return assertAllowed(method, parsed.pathname);
}
