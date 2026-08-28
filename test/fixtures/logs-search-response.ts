/**
 * Realistic-shape fixtures for `POST /api/v2/logs/events/search` responses,
 * used by test/tools/logs.test.ts. Shape mirrors Datadog's actual v2 Logs
 * Events Search response: `data[]` of `{id, type, attributes}`, with
 * `meta.page.after` as the pagination cursor.
 */

export const logsSearchResponseFixture = {
  data: [
    {
      id: 'AAAAAWnativelog1',
      type: 'log',
      attributes: {
        timestamp: '2024-01-01T00:00:01.000Z',
        service: 'api',
        status: 'error',
        host: 'web-01',
        message: 'connection refused while calling downstream payment service',
        tags: ['env:prod', 'service:api'],
        attributes: {
          duration: 1234,
          'http.status_code': 500,
        },
      },
    },
    {
      id: 'AAAAAWnativelog2',
      type: 'log',
      attributes: {
        timestamp: '2024-01-01T00:00:02.000Z',
        service: 'api',
        status: 'warn',
        host: 'web-02',
        message: 'retrying request after transient failure',
        tags: ['env:prod', 'service:api'],
        attributes: {
          'retry.count': 2,
        },
      },
    },
  ],
  meta: {
    page: {
      after: 'eyJhZnRlciI6ImN1cnNvci1sb2dzLTEifQ==',
    },
  },
};

export const logsSearchResponseNoNextPageFixture = {
  data: [
    {
      id: 'AAAAAWnativelog3',
      type: 'log',
      attributes: {
        timestamp: '2024-01-01T00:00:03.000Z',
        service: 'checkout',
        status: 'info',
        host: 'web-03',
        message: 'order placed successfully',
      },
    },
  ],
  meta: {
    page: {},
  },
};

/** A log whose message is well over the 500-char truncation limit. */
export const logsSearchResponseLongMessageFixture = {
  data: [
    {
      id: 'AAAAAWnativelog4',
      type: 'log',
      attributes: {
        timestamp: '2024-01-01T00:00:04.000Z',
        service: 'api',
        status: 'error',
        host: 'web-01',
        message: 'x'.repeat(1000),
        attributes: {
          'stack.trace': 'y'.repeat(5000),
        },
      },
    },
  ],
  meta: {
    page: {},
  },
};
