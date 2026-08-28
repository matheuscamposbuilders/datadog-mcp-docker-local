/**
 * Realistic fixtures shaped like a Datadog `GET /api/v1/events` response
 * (`{ events: [...] }`). Shared across `test/tools/events.test.ts`.
 */

/** A small, realistic page of events covering a deploy and an alert. */
export const eventsListResponse = {
  events: [
    {
      id: 1234567890123456789,
      date_happened: 1700000100,
      title: 'Deployed payments-api v2.3.1',
      text: 'Deployment triggered by CI pipeline #4821. Rolled out to 12 hosts in us-east-1. No errors reported during rollout.',
      priority: 'normal',
      source: 'deploy',
      host: 'payments-api-canary-01',
      tags: ['env:prod', 'service:payments-api', 'team:payments'],
      alert_type: 'info',
      // Extra field the real API sends that the tool must NOT surface.
      url: '/event/jump_to?event_id=1234567890123456789',
    },
    {
      id: 1234567890123456790,
      date_happened: 1700000400,
      title: '[Triggered] High error rate on payments-api',
      text: 'Monitor "payments-api error rate" triggered: error rate is 8.2%, above the 5% threshold. Recent errors:\n' +
        'TimeoutError: upstream request to ledger-service timed out after 3000ms\n'.repeat(5),
      priority: 'normal',
      source: 'nagios',
      host: 'payments-api-canary-01',
      tags: ['env:prod', 'service:payments-api', 'monitor:error-rate'],
      alert_type: 'error',
      device_name: 'us-east-1',
    },
  ],
};

/** A single event whose `text` is short — used to assert truncation is a no-op below the cap. */
export const eventsListResponseShortText = {
  events: [
    {
      id: 42,
      date_happened: 1700000000,
      title: 'Comment added to incident #99',
      text: 'Looks resolved, closing.',
      priority: 'low',
      source: 'comment',
      host: undefined,
      tags: ['env:staging'],
      alert_type: 'info',
    },
  ],
};

/** Builds a synthetic response with `count` minimal events, for cap/truncation tests. */
export function buildEventsResponse(count: number): { events: Array<Record<string, unknown>> } {
  return {
    events: Array.from({ length: count }, (_, i) => ({
      id: i,
      date_happened: 1700000000 + i,
      title: `Event ${i}`,
      text: `Body of event ${i}`,
      priority: 'normal',
      source: 'nagios',
      host: `host-${i}`,
      tags: [`index:${i}`],
      alert_type: 'info',
    })),
  };
}
