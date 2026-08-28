/**
 * Realistic Datadog API response fixtures for the monitor tools
 * (dd_list_monitors, dd_get_monitor, dd_search_monitors).
 */

/**
 * `GET /api/v1/monitor` returns a raw array of monitor objects. Each real
 * monitor carries a large nested `options` block and a `state` object with
 * per-scope history — both included here to prove the tool actually drops
 * them, not just that it doesn't crash on a minimal fixture.
 */
export const monitorsListResponse = [
  {
    id: 111,
    org_id: 999,
    name: 'High CPU on payments-api',
    type: 'metric alert',
    message: 'CPU usage is high on {{host.name}}. @slack-payments-alerts',
    tags: ['env:prod', 'service:payments-api', 'team:payments'],
    query:
      'avg(last_5m):avg:system.cpu.user{env:prod,service:payments-api} by {host} > 90 ' +
      '&& this is extra query text padding to push the string well past two hundred characters so truncation ' +
      'is actually exercised by the test suite instead of being a no-op',
    overall_state: 'Alert',
    overall_state_modified: '2024-01-15T10:32:00+00:00',
    created: '2023-06-01T09:00:00+00:00',
    created_at: 1685602800000,
    modified: '2024-01-15T10:32:00+00:00',
    multi: true,
    deleted: null,
    priority: 2,
    classification: 'metric',
    restricted_roles: null,
    notify_no_data: false,
    matching_downtimes: [],
    options: {
      thresholds: { critical: 90, warning: 80 },
      notify_no_data: false,
      no_data_timeframe: 20,
      evaluation_delay: 60,
      new_group_delay: 60,
      renotify_interval: 0,
      escalation_message: '',
      include_tags: true,
    },
    state: {
      groups: {
        'host:web-01': { status: 'Alert', last_triggered_ts: 1705315920 },
        'host:web-02': { status: 'OK', last_triggered_ts: 1705300000 },
      },
    },
  },
  {
    id: 222,
    org_id: 999,
    name: 'Low disk space on shared-fs',
    type: 'metric alert',
    message: 'Disk space low on {{host.name}}.',
    tags: ['env:prod', 'service:shared-fs'],
    query: 'avg(last_15m):avg:system.disk.free{env:prod,service:shared-fs} by {host} < 10',
    overall_state: 'OK',
    overall_state_modified: '2024-01-10T02:00:00+00:00',
    created: '2023-03-12T14:20:00+00:00',
    created_at: 1678630800000,
    modified: '2024-01-10T02:00:00+00:00',
    multi: true,
    deleted: null,
    priority: null,
    classification: 'metric',
    restricted_roles: [],
    notify_no_data: true,
    matching_downtimes: [],
    options: {
      thresholds: { critical: 10 },
      notify_no_data: true,
      no_data_timeframe: 30,
    },
    state: {
      groups: {
        'host:fs-01': { status: 'OK', last_triggered_ts: null },
      },
    },
  },
];

/** Builds a synthetic response with `count` minimal monitors, for pagination tests. */
export function buildMonitorsListResponse(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({
    id: i,
    name: `Synthetic monitor ${i}`,
    type: 'metric alert',
    query: `avg(last_5m):avg:custom.metric.${i}{*} > 1`,
    overall_state: 'OK',
    tags: [`index:${i}`],
    created: '2023-01-01T00:00:00+00:00',
    modified: '2023-01-01T00:00:00+00:00',
  }));
}

/** Full single-monitor object, as returned by `GET /api/v1/monitor/{monitor_id}`. */
export const monitorGetResponse = {
  id: 111,
  org_id: 999,
  name: 'High CPU on payments-api',
  type: 'metric alert',
  message: 'CPU usage is high on {{host.name}}. @slack-payments-alerts',
  tags: ['env:prod', 'service:payments-api', 'team:payments'],
  query: 'avg(last_5m):avg:system.cpu.user{env:prod,service:payments-api} by {host} > 90',
  overall_state: 'Alert',
  overall_state_modified: '2024-01-15T10:32:00+00:00',
  created: '2023-06-01T09:00:00+00:00',
  modified: '2024-01-15T10:32:00+00:00',
  multi: true,
  priority: 2,
  classification: 'metric',
  options: {
    thresholds: { critical: 90, warning: 80 },
    notify_no_data: false,
    no_data_timeframe: 20,
    evaluation_delay: 60,
    new_group_delay: 60,
    renotify_interval: 0,
    escalation_message: '',
    include_tags: true,
  },
  state: {
    groups: {
      'host:web-01': { status: 'Alert', last_triggered_ts: 1705315920 },
      'host:web-02': { status: 'OK', last_triggered_ts: 1705300000 },
    },
  },
};

/**
 * `GET /api/v1/monitor/search` response. Real monitor-search results also
 * carry `creator`/`notifications`/`metrics`/`last_triggered_ts`, kept here
 * for realism even though the tool only projects the same summary fields
 * `dd_list_monitors` does.
 */
export const monitorsSearchResponse = {
  counts: {
    status: [
      { name: 'Alert', count: 1 },
      { name: 'OK', count: 1 },
    ],
  },
  metadata: {
    page: 0,
    page_count: 1,
    per_page: 30,
    total_count: 2,
  },
  monitors: [
    {
      id: 111,
      org_id: 999,
      name: 'High CPU on payments-api',
      type: 'metric alert',
      query: 'avg(last_5m):avg:system.cpu.user{env:prod,service:payments-api} by {host} > 90',
      tags: ['env:prod', 'service:payments-api', 'team:payments'],
      status: 'Alert',
      overall_state: 'Alert',
      created: '2023-06-01T09:00:00+00:00',
      modified: '2024-01-15T10:32:00+00:00',
      metrics: ['system.cpu.user'],
      last_triggered_ts: 1705315920,
      creator: { name: 'Jane Doe', email: 'jane@example.com', handle: 'jane@example.com' },
      notifications: [{ name: 'slack-payments-alerts', handle: 'slack-payments-alerts' }],
      classification: 'metric',
    },
  ],
};

/** Monitor search response with no `metadata.total_count`, for the "count omitted" test path. */
export const monitorsSearchResponseNoMetadata = {
  monitors: [
    {
      id: 222,
      name: 'Low disk space on shared-fs',
      type: 'metric alert',
      query: 'avg(last_15m):avg:system.disk.free{env:prod,service:shared-fs} by {host} < 10',
      tags: ['env:prod', 'service:shared-fs'],
      status: 'OK',
      overall_state: 'OK',
    },
  ],
};
