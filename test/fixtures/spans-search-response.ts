/**
 * Realistic-shape fixtures for `POST /api/v2/spans/events/search` responses,
 * used by test/tools/spans.test.ts. Shape mirrors the response documented
 * by Datadog for this endpoint: `data[]` of `{id, type, attributes}`, where
 * `attributes` carries `trace_id`/`span_id` (numeric), `name` (the
 * operation name — NOT `operation_name`), `start` (epoch ms — NOT
 * `start_timestamp`), `duration` directly (NOT nested under a further
 * `attributes.attributes` bag), `service`, and a nested `resource: { name }`
 * object (NOT a flat `resource_name` string). `meta.page.after` is the
 * pagination cursor, same as logs. `status`/`error` and `http` are included
 * on some entries to exercise optional-field handling and to prove those
 * bags are NOT leaked into the tool's projection.
 */

export const spansSearchResponseFixture = {
  data: [
    {
      id: 'span-1',
      type: 'span',
      attributes: {
        trace_id: 1234567890,
        span_id: 9876543210,
        name: 'http.request',
        start: 1678886400000,
        duration: 15234000,
        service: 'api',
        resource: { name: 'GET /orders/:id' },
        status: 'ok',
        http: { method: 'GET', url: 'https://example.com/orders/1' },
      },
    },
    {
      id: 'span-2',
      type: 'span',
      attributes: {
        trace_id: 1234567891,
        span_id: 9876543211,
        name: 'payments.charge',
        start: 1678886401000,
        duration: 98765000,
        service: 'payments',
        resource: { name: 'POST /charge' },
        status: 'error',
        error: 1,
        http: { method: 'POST', url: 'https://example.com/charge' },
      },
    },
  ],
  meta: {
    page: {
      after: 'gAAAAABspans1',
    },
  },
};

export const spansSearchResponseNoNextPageFixture = {
  data: [
    {
      id: 'span-3',
      type: 'span',
      attributes: {
        trace_id: 1234567892,
        span_id: 9876543212,
        name: 'checkout.process',
        start: 1678886402000,
        duration: 500000,
        service: 'checkout',
        resource: { name: 'POST /checkout' },
        status: 'ok',
      },
    },
  ],
  meta: {
    page: {},
  },
};
