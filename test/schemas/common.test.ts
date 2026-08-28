import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import {
  zCursor,
  zIsoTimeRange,
  zLimit,
  zMetricName,
  zMonitorId,
  zQueryString,
  zTags,
  zTimeRangeSeconds,
  zTimestampSeconds,
} from '../../src/schemas/common.js';
import { findAllowedRoute } from '../../src/security/allowlist.js';

describe('zTimestampSeconds', () => {
  it('accepts a positive integer', () => {
    expect(zTimestampSeconds.safeParse(1700000000).success).toBe(true);
  });

  it('rejects zero', () => {
    expect(zTimestampSeconds.safeParse(0).success).toBe(false);
  });

  it('rejects a negative number', () => {
    expect(zTimestampSeconds.safeParse(-1).success).toBe(false);
  });

  it('rejects a non-integer', () => {
    expect(zTimestampSeconds.safeParse(1.5).success).toBe(false);
  });

  it('rejects a string', () => {
    expect(zTimestampSeconds.safeParse('1700000000').success).toBe(false);
  });
});

describe('zTimeRangeSeconds', () => {
  it('accepts a valid range', () => {
    expect(zTimeRangeSeconds.safeParse({ from: 100, to: 200 }).success).toBe(true);
  });

  it('rejects to === from', () => {
    const result = zTimeRangeSeconds.safeParse({ from: 100, to: 100 });
    expect(result.success).toBe(false);
  });

  it('rejects to < from', () => {
    const result = zTimeRangeSeconds.safeParse({ from: 200, to: 100 });
    expect(result.success).toBe(false);
  });

  it('rejects a missing bound', () => {
    expect(zTimeRangeSeconds.safeParse({ from: 100 }).success).toBe(false);
  });
});

describe('zIsoTimeRange', () => {
  it('accepts two relative terms', () => {
    expect(zIsoTimeRange.safeParse({ from: 'now-15m', to: 'now' }).success).toBe(true);
  });

  it('accepts two absolute ISO timestamps with to after from', () => {
    expect(
      zIsoTimeRange.safeParse({ from: '2024-01-01T00:00:00Z', to: '2024-01-01T01:00:00Z' })
        .success,
    ).toBe(true);
  });

  it('rejects two absolute ISO timestamps with to before from', () => {
    expect(
      zIsoTimeRange.safeParse({ from: '2024-01-01T01:00:00Z', to: '2024-01-01T00:00:00Z' })
        .success,
    ).toBe(false);
  });

  it('accepts a mix of relative and absolute bounds (ordering not checked)', () => {
    expect(zIsoTimeRange.safeParse({ from: 'now-1h', to: '2024-01-01T00:00:00Z' }).success).toBe(
      true,
    );
  });

  it('rejects a garbage string that is neither relative nor ISO', () => {
    expect(zIsoTimeRange.safeParse({ from: 'yesterday', to: 'now' }).success).toBe(false);
  });

  it('rejects an empty string bound', () => {
    expect(zIsoTimeRange.safeParse({ from: '', to: 'now' }).success).toBe(false);
  });
});

describe('zLimit', () => {
  const zPageLimit = zLimit(100, 50);

  it('accepts a value within range', () => {
    expect(zPageLimit.safeParse(10).success).toBe(true);
  });

  it('applies the default when omitted', () => {
    const result = zPageLimit.safeParse(undefined);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe(50);
    }
  });

  it('rejects zero', () => {
    expect(zPageLimit.safeParse(0).success).toBe(false);
  });

  it('rejects a value above the max', () => {
    expect(zPageLimit.safeParse(101).success).toBe(false);
  });

  it('rejects a non-integer', () => {
    expect(zPageLimit.safeParse(1.5).success).toBe(false);
  });
});

describe('zCursor', () => {
  it('accepts a short opaque string', () => {
    expect(zCursor.safeParse('abc123').success).toBe(true);
  });

  it('is optional', () => {
    expect(zCursor.safeParse(undefined).success).toBe(true);
  });

  it('accepts a string up to the 4096-char cap', () => {
    expect(zCursor.safeParse('a'.repeat(4096)).success).toBe(true);
  });

  it('rejects a string over the 4096-char cap', () => {
    expect(zCursor.safeParse('a'.repeat(4097)).success).toBe(false);
  });
});

describe('zQueryString', () => {
  it('accepts a normal query', () => {
    expect(zQueryString.safeParse('service:web status:error').success).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(zQueryString.safeParse('').success).toBe(false);
  });

  it('rejects a string over the 2000-char cap', () => {
    expect(zQueryString.safeParse('a'.repeat(2001)).success).toBe(false);
  });

  it('accepts a string at the 2000-char cap', () => {
    expect(zQueryString.safeParse('a'.repeat(2000)).success).toBe(true);
  });
});

describe('zMetricName', () => {
  it('accepts a dotted metric name', () => {
    expect(zMetricName.safeParse('system.cpu.idle').success).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(zMetricName.safeParse('').success).toBe(false);
  });

  it('rejects a name with a space', () => {
    expect(zMetricName.safeParse('foo bar').success).toBe(false);
  });

  it('rejects a name with an embedded slash', () => {
    expect(zMetricName.safeParse('foo/bar').success).toBe(false);
  });

  it('rejects a name over 200 characters', () => {
    expect(zMetricName.safeParse('a'.repeat(201)).success).toBe(false);
  });

  it('accepts a name at exactly 200 characters', () => {
    expect(zMetricName.safeParse('a'.repeat(200)).success).toBe(true);
  });
});

describe('zMonitorId', () => {
  it('accepts a positive integer', () => {
    expect(zMonitorId.safeParse(123456).success).toBe(true);
  });

  it('rejects zero', () => {
    expect(zMonitorId.safeParse(0).success).toBe(false);
  });

  it('rejects a negative number', () => {
    expect(zMonitorId.safeParse(-1).success).toBe(false);
  });

  it('rejects a non-integer', () => {
    expect(zMonitorId.safeParse(1.5).success).toBe(false);
  });
});

describe('zTags', () => {
  it('is optional', () => {
    expect(zTags.safeParse(undefined).success).toBe(true);
  });

  it('accepts a list of tags', () => {
    expect(zTags.safeParse(['env:prod', 'service:web']).success).toBe(true);
  });

  it('rejects an empty-string tag', () => {
    expect(zTags.safeParse(['']).success).toBe(false);
  });

  it('rejects more than 100 tags', () => {
    const tags = Array.from({ length: 101 }, (_, i) => `tag:${i}`);
    expect(zTags.safeParse(tags).success).toBe(false);
  });

  it('accepts exactly 100 tags', () => {
    const tags = Array.from({ length: 100 }, (_, i) => `tag:${i}`);
    expect(zTags.safeParse(tags).success).toBe(true);
  });
});

describe('alignment with the allowlist (src/security/allowlist.ts)', () => {
  it('metric names accepted by zMetricName resolve to the get_metric_metadata route', () => {
    const validNames = ['system.cpu.idle', 'a', 'A9_.', 'x'.repeat(200)];
    for (const name of validNames) {
      expect(zMetricName.safeParse(name).success).toBe(true);
      const route = findAllowedRoute('GET', `/api/v1/metrics/${name}`);
      expect(route?.id).toBe('get_metric_metadata');
    }
  });

  it('metric names rejected by zMetricName do not resolve to any allowlisted route', () => {
    const invalidNames = ['foo bar', 'foo/bar', 'x'.repeat(201)];
    for (const name of invalidNames) {
      expect(zMetricName.safeParse(name).success).toBe(false);
      const route = findAllowedRoute('GET', `/api/v1/metrics/${name}`);
      expect(route).toBeUndefined();
    }
  });

  it('monitor ids accepted by zMonitorId resolve to the get_monitor route', () => {
    const validIds = [1, 123456789, Number.MAX_SAFE_INTEGER];
    for (const id of validIds) {
      expect(zMonitorId.safeParse(id).success).toBe(true);
      const route = findAllowedRoute('GET', `/api/v1/monitor/${id}`);
      expect(route?.id).toBe('get_monitor');
    }
  });

  it('monitor ids rejected by zMonitorId for shape reasons do not resolve to any allowlisted route', () => {
    // -5 and 1.5 fail both the schema (positive integer) and the allowlist's
    // \d{1,20} shape check (they contain '-' / '.', not digits only).
    const invalidIds = [-5, 1.5];
    for (const id of invalidIds) {
      expect(zMonitorId.safeParse(id).success).toBe(false);
      const route = findAllowedRoute('GET', `/api/v1/monitor/${id}`);
      expect(route).toBeUndefined();
    }
  });

  it('zero is rejected by zMonitorId even though "0" alone is a valid \\d{1,20} shape', () => {
    // The allowlist route pattern is a pure transport-shape check (any
    // 1-20 digit string, including "0"); it says nothing about whether 0 is
    // a semantically valid monitor id. zMonitorId is the layer responsible
    // for that: Datadog monitor ids are always >= 1, so 0 is rejected here
    // even though it would still resolve to the get_monitor route pattern.
    // This is an intentional division of responsibility, not a divergence.
    expect(zMonitorId.safeParse(0).success).toBe(false);
    expect(findAllowedRoute('GET', '/api/v1/monitor/0')?.id).toBe('get_monitor');
  });
});

describe('every exported schema field carries a non-empty description', () => {
  function collectDescriptions(schema: unknown, path: string, out: Map<string, string | undefined>): void {
    const jsonSchema = z.toJSONSchema(schema as z.core.$ZodType, { unrepresentable: 'any' }) as Record<
      string,
      unknown
    >;
    walk(jsonSchema, path, out);
  }

  function walk(node: unknown, path: string, out: Map<string, string | undefined>): void {
    if (!node || typeof node !== 'object') {
      return;
    }
    const record = node as Record<string, unknown>;
    out.set(path, typeof record.description === 'string' ? record.description : undefined);

    const properties = record.properties;
    if (properties && typeof properties === 'object') {
      for (const [key, sub] of Object.entries(properties as Record<string, unknown>)) {
        walk(sub, `${path}.${key}`, out);
      }
    }
    const items = record.items;
    if (items && typeof items === 'object') {
      walk(items, `${path}[]`, out);
    }
  }

  const namedSchemas: ReadonlyArray<[string, z.core.$ZodType]> = [
    ['zTimestampSeconds', zTimestampSeconds],
    ['zTimeRangeSeconds', zTimeRangeSeconds],
    ['zIsoTimeRange', zIsoTimeRange],
    ['zLimit(100, 50)', zLimit(100, 50)],
    ['zCursor', zCursor],
    ['zQueryString', zQueryString],
    ['zMetricName', zMetricName],
    ['zMonitorId', zMonitorId],
    ['zTags', zTags],
  ];

  it.each(namedSchemas)('%s has a non-empty description on every field', (name, schema) => {
    const out = new Map<string, string | undefined>();
    collectDescriptions(schema, name, out);
    for (const [path, description] of out) {
      expect(description, `${path} is missing a description`).toBeTruthy();
      expect(description?.length ?? 0, `${path} has an empty description`).toBeGreaterThan(0);
    }
  });
});
