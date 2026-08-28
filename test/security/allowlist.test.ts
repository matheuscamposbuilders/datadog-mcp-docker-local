import { describe, expect, it } from 'vitest';
import {
  ALLOWED_ROUTES,
  assertAllowed,
  assertAllowedUrl,
  findAllowedRoute,
  normalizePathname,
} from '../../src/security/allowlist.js';
import { ForbiddenRequestError } from '../../src/http/errors.js';

const ALLOWED_CASES: ReadonlyArray<[id: string, method: string, path: string]> = [
  ['validate', 'GET', '/api/v1/validate'],
  ['query_timeseries', 'GET', '/api/v1/query'],
  ['list_metrics', 'GET', '/api/v1/metrics'],
  ['get_metric_metadata', 'GET', '/api/v1/metrics/system.cpu.idle'],
  ['search_monitors', 'GET', '/api/v1/monitor/search'],
  ['list_monitors', 'GET', '/api/v1/monitor'],
  ['get_monitor', 'GET', '/api/v1/monitor/1234567'],
  ['list_events', 'GET', '/api/v1/events'],
  ['search_logs', 'POST', '/api/v2/logs/events/search'],
  ['search_spans', 'POST', '/api/v2/spans/events/search'],
];

const DENIED_CASES: ReadonlyArray<[label: string, method: string, path: string]> = [
  // Mutating verbs on routes that otherwise exist.
  ['PUT on get_monitor route', 'PUT', '/api/v1/monitor/123'],
  ['PATCH on get_monitor route', 'PATCH', '/api/v1/monitor/123'],
  ['DELETE on get_monitor route', 'DELETE', '/api/v1/monitor/123'],
  ['DELETE on non-allowlisted dashboard route', 'DELETE', '/api/v1/dashboard/abc'],
  ['HEAD on query route', 'HEAD', '/api/v1/query'],
  ['OPTIONS on query route', 'OPTIONS', '/api/v1/query'],
  ['TRACE on query route', 'TRACE', '/api/v1/query'],
  // Lowercase method must not bypass the verb check.
  ['lowercase delete does not bypass method check', 'delete', '/api/v1/monitor/123'],
  // POST on GET-only routes.
  ['POST on list_monitors (GET-only) route', 'POST', '/api/v1/monitor'],
  ['POST on query_timeseries (GET-only) route', 'POST', '/api/v1/query'],
  // POST on real Datadog write endpoints.
  ['POST on logs index config (write endpoint)', 'POST', '/api/v2/logs/config/indexes'],
  ['POST on dashboard create (write endpoint)', 'POST', '/api/v1/dashboard'],
  ['POST on downtime create (write endpoint)', 'POST', '/api/v1/downtime'],
  // GET on non-allowlisted routes.
  ['GET on /api/v1/user (not allowlisted)', 'GET', '/api/v1/user'],
  ['GET on /api/v2/users (not allowlisted)', 'GET', '/api/v2/users'],
  ['GET on /api/v1/api_key (not allowlisted)', 'GET', '/api/v1/api_key'],
  // Traversal.
  ['literal traversal via monitor id', 'GET', '/api/v1/monitor/../../v1/user'],
  ['encoded traversal under metrics', 'GET', '/api/v1/metrics/%2e%2e%2f%2e%2e%2fuser'],
  ['mixed literal/encoded traversal under metrics', 'GET', '/api/v1/metrics/..%2f..%2fuser'],
  ['deep literal traversal to /etc/passwd', 'GET', '/api/v1/metrics/../../../etc/passwd'],
  // Double encoding.
  ['double-encoded path smuggling', 'GET', '/api/v1/%256d%2565trics'],
  // Doubled separator.
  ['doubled slash before monitor', 'GET', '/api/v1//monitor'],
  // Wrong prefix.
  ['missing /api prefix', 'GET', '/v1/query'],
  ['unsupported api version v3', 'GET', '/api/v3/query'],
  ['malformed prefix apiv1', 'GET', '/apiv1/query'],
  ['prefix with nothing after it', 'GET', '/api/v1'],
  // Suffix stuck onto an anchored route (proves the trailing $ anchor).
  ['suffix appended to validate', 'GET', '/api/v1/validateX'],
  ['suffix appended to query', 'GET', '/api/v1/queryZ'],
  // Non-numeric monitor id.
  ['non-numeric monitor id (letters)', 'GET', '/api/v1/monitor/abc'],
  ['non-numeric monitor id (mixed)', 'GET', '/api/v1/monitor/12a'],
  // Invalid metric name.
  ['metric name with a space', 'GET', '/api/v1/metrics/foo bar'],
  ['metric name with an embedded slash', 'GET', '/api/v1/metrics/foo/bar'],
  // Null byte and backslash.
  ['null byte in path', 'GET', '/api/v1/query\0'],
  ['backslash in path', 'GET', '/api/v1\\query'],
  // Control characters (log injection via a forged log line).
  ['embedded newline', 'GET', '/api/v1/query\n'],
  ['embedded CRLF forging a second log line', 'GET', '/api/v1/query\r\nGET /api/v1/user'],
  // Percent-encoding in the raw input, even when it decodes to something
  // that would otherwise be allowed — normalizePathname's output must be
  // byte-identical to its input, so any '%' in the raw path is rejected
  // up front, before decoding.
  ['percent-encoded single character (decodes to a valid route)', 'GET', '/api/v1/quer%79'],
  ['percent-encoded dots in an otherwise-valid metric name', 'GET', '/api/v1/metrics/system%2Ecpu%2Eidle'],
];

describe('ALLOWED_ROUTES: allowed requests', () => {
  it.each(ALLOWED_CASES)('%s: %s %s is allowed', (id, method, path) => {
    const route = assertAllowed(method, path);
    expect(route.id).toBe(id);

    const found = findAllowedRoute(method, path);
    expect(found?.id).toBe(id);
  });
});

describe('ALLOWED_ROUTES: denied requests', () => {
  it.each(DENIED_CASES)('%s (%s %s) is denied', (_label, method, path) => {
    expect(() => assertAllowed(method, path)).toThrow(ForbiddenRequestError);
    expect(findAllowedRoute(method, path)).toBeUndefined();
  });
});

describe('normalizePathname', () => {
  it('returns the pathname unchanged when already clean', () => {
    expect(normalizePathname('/api/v1/monitor/123')).toBe('/api/v1/monitor/123');
  });

  it('rejects traversal after a single decode pass', () => {
    expect(() => normalizePathname('/api/v1/metrics/%2e%2e%2f%2e%2e%2fuser')).toThrow(
      ForbiddenRequestError,
    );
  });

  it('rejects a path that still contains % after one decode (double encoding)', () => {
    expect(() => normalizePathname('/api/v1/%256d%2565trics')).toThrow(ForbiddenRequestError);
  });

  it('rejects malformed percent-encoding that decodeURIComponent cannot parse', () => {
    expect(() => normalizePathname('/api/v1/query%E0%A4%A')).toThrow(ForbiddenRequestError);
  });

  it('rejects doubled slashes', () => {
    expect(() => normalizePathname('/api/v1//monitor')).toThrow(ForbiddenRequestError);
  });

  it('rejects a path missing the required prefix', () => {
    expect(() => normalizePathname('/apiv1/query')).toThrow(ForbiddenRequestError);
  });

  it('rejects backslashes and null bytes', () => {
    expect(() => normalizePathname('/api/v1\\query')).toThrow(ForbiddenRequestError);
    expect(() => normalizePathname('/api/v1/query\0')).toThrow(ForbiddenRequestError);
  });
});

describe('meta: ALLOWED_ROUTES shape', () => {
  it('has exactly 10 entries matching the literal id snapshot', () => {
    expect(ALLOWED_ROUTES).toHaveLength(10);
    const ids = ALLOWED_ROUTES.map((r) => r.id).sort();
    expect(ids).toEqual(
      [
        'get_metric_metadata',
        'get_monitor',
        'list_events',
        'list_metrics',
        'list_monitors',
        'query_timeseries',
        'search_logs',
        'search_monitors',
        'search_spans',
        'validate',
      ].sort(),
    );
  });

  it('has no duplicate ids', () => {
    const ids = ALLOWED_ROUTES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every pattern is fully anchored with ^ and $', () => {
    for (const route of ALLOWED_ROUTES) {
      expect(route.pattern.source.startsWith('^')).toBe(true);
      expect(route.pattern.source.endsWith('$')).toBe(true);
    }
  });

  it('no route uses a method other than GET or POST', () => {
    for (const route of ALLOWED_ROUTES) {
      expect(['GET', 'POST']).toContain(route.method);
    }
  });

  it('every route other than validate declares at least one scope', () => {
    for (const route of ALLOWED_ROUTES) {
      if (route.id === 'validate') {
        expect(route.scopes).toEqual([]);
      } else {
        expect(route.scopes.length).toBeGreaterThan(0);
      }
    }
  });

  it('normalizePathname is identity (and idempotent) over every allowed path', () => {
    for (const [, , path] of ALLOWED_CASES) {
      const once = normalizePathname(path);
      expect(once).toBe(path);
      expect(normalizePathname(once)).toBe(path);
    }
  });

  it('ALLOWED_ROUTES and every route entry are frozen', () => {
    expect(Object.isFrozen(ALLOWED_ROUTES)).toBe(true);
    for (const route of ALLOWED_ROUTES) {
      expect(Object.isFrozen(route)).toBe(true);
    }
  });
});

describe('assertAllowedUrl', () => {
  const HOST = 'api.datadoghq.com';

  it('allows a well-formed https URL on the expected host', () => {
    const route = assertAllowedUrl('GET', `https://${HOST}/api/v1/query`, HOST);
    expect(route.id).toBe('query_timeseries');
  });

  it('allows the request regardless of query string', () => {
    const route = assertAllowedUrl('GET', `https://${HOST}/api/v1/query?from=1&to=2`, HOST);
    expect(route.id).toBe('query_timeseries');
  });

  it('rejects a lookalike host that merely contains the expected host as a suffix', () => {
    // Anti-endsWith regression test: 'evil-datadoghq.com'.endsWith('datadoghq.com') is true,
    // but it is NOT equal to 'api.datadoghq.com' and must be rejected.
    expect(() => assertAllowedUrl('GET', 'https://evil-datadoghq.com/api/v1/query', HOST)).toThrow(
      ForbiddenRequestError,
    );
  });

  it('rejects a host that embeds the expected host as a subdomain prefix trick', () => {
    expect(() =>
      assertAllowedUrl('GET', 'https://api.datadoghq.com.evil.com/api/v1/query', HOST),
    ).toThrow(ForbiddenRequestError);
  });

  it('rejects plain http (no TLS)', () => {
    expect(() => assertAllowedUrl('GET', `http://${HOST}/api/v1/query`, HOST)).toThrow(
      ForbiddenRequestError,
    );
  });

  it('rejects URLs with embedded credentials', () => {
    expect(() =>
      assertAllowedUrl('GET', `https://user:pass@${HOST}/api/v1/query`, HOST),
    ).toThrow(ForbiddenRequestError);
  });

  it('rejects a host that differs from the expected host (e.g. wrong Datadog site)', () => {
    expect(() =>
      assertAllowedUrl('GET', 'https://api.datadoghq.eu/api/v1/query', HOST),
    ).toThrow(ForbiddenRequestError);
  });
});
