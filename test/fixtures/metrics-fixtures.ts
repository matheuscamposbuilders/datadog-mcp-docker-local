/**
 * Realistic Datadog API response fixtures for the metrics tools
 * (dd_query_timeseries, dd_list_metrics, dd_get_metric_metadata).
 */

export const metricsQueryTimeseriesSmall = {
  status: 'ok',
  series: [
    {
      metric: 'system.cpu.user',
      scope: 'host:web-01',
      unit: [{ family: 'percentage', name: 'percent', short_name: '%' }],
      pointlist: [
        [1700000000000, 12.5],
        [1700000010000, 13.1],
        [1700000020000, 11.9],
      ],
    },
  ],
};

export function buildPointlist(count: number): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  for (let i = 0; i < count; i += 1) {
    points.push([1700000000000 + i * 10000, Math.sin(i / 10) * 50 + 50]);
  }
  return points;
}

/** Raw pointlist backing `metricsQueryTimeseriesLarge`, exported for direct comparison in tests. */
export const metricsQueryTimeseriesLargePointlist = buildPointlist(1000);

/** A series with 1000 points, well over the 500-point per-series sampling threshold. */
export const metricsQueryTimeseriesLarge = {
  status: 'ok',
  series: [
    {
      metric: 'system.cpu.user',
      scope: 'host:web-01',
      unit: [{ family: 'percentage', name: 'percent', short_name: '%' }],
      pointlist: metricsQueryTimeseriesLargePointlist,
    },
  ],
};

/** Raw pointlist backing `metricsQueryTimeseriesHuge`, exported for direct comparison in tests. */
export const metricsQueryTimeseriesHugePointlist = buildPointlist(5000);

/** A series with 5000 points, used to check that downsampling never drops the last (most recent) point. */
export const metricsQueryTimeseriesHuge = {
  status: 'ok',
  series: [
    {
      metric: 'system.cpu.user',
      scope: 'host:web-01',
      unit: [{ family: 'percentage', name: 'percent', short_name: '%' }],
      pointlist: metricsQueryTimeseriesHugePointlist,
    },
  ],
};

/** A series with exactly 500 points — equal to the sampling threshold, so no sampling should occur. */
export const metricsQueryTimeseriesExactlyAtLimitPointlist = buildPointlist(500);
export const metricsQueryTimeseriesExactlyAtLimit = {
  status: 'ok',
  series: [
    {
      metric: 'system.cpu.user',
      scope: 'host:web-01',
      unit: [{ family: 'percentage', name: 'percent', short_name: '%' }],
      pointlist: metricsQueryTimeseriesExactlyAtLimitPointlist,
    },
  ],
};

export const metricsListSmall = {
  from: '1700000000',
  metrics: ['system.cpu.idle', 'system.cpu.user', 'system.mem.used'],
};

function buildManyMetricNames(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `custom.metric.${i}`);
}

/** 250 metric names — over the dd_list_metrics default limit of 200. */
export const metricsListLarge = {
  from: '1700000000',
  metrics: buildManyMetricNames(250),
};

export const metricsMetadata = {
  description: 'The percent of time the CPU spent in user mode.',
  short_name: 'cpu user',
  unit: 'percent',
  per_unit: null,
  type: 'gauge',
  statsd_interval: null,
};
