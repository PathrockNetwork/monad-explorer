import type { Metrics, MetricsPoint, Usage } from "./api";

/** Horizons the API serves; the DB keeps a rolling 72 h window. */
export const DEFAULT_RANGES = [1, 6, 24, 72];
export const rangeLabel = (hours: number) => `${hours}h`;
/**
 * Explorer display targets, not protocol requirements. Block time is a
 * per-bucket average (timestamps have 1 s resolution), so the target applies
 * to bucket means only. `volume` is the share of the cadence-implied block
 * count below which a complete bucket is flagged.
 */
export const THRESHOLDS = { blockTimeMs: 500, volume: 0.9, coverage: 95 };
export type ChartPoint = { t: number; value: number | null };
export type SeriesKey = "tps" | "avg_block_time_ms" | "gas_utilization" | "blocks" | "txs";

export const bucketMs = (m: Pick<Metrics, "bucket_secs"> | null | undefined, hours: number) =>
  m?.bucket_secs ? m.bucket_secs * 1000 : (hours <= 1 ? 60 : hours <= 6 ? 300 : hours <= 24 ? 900 : 3600) * 1000;

/** A bucket is complete when it lies wholly inside [start, end]. */
export const isComplete = (t: number, step: number, start: number, end: number) => t >= start && t + step <= end;

/**
 * Series values in display units. TPS and block counts from a partial bucket
 * (window edge or the bucket still filling) would read as a dip, so `completeOnly`
 * turns them into gaps instead of plotting them.
 */
export function chartPoints(series: MetricsPoint[], key: SeriesKey, opts: { step?: number; start?: number; end?: number; completeOnly?: boolean } = {}): ChartPoint[] {
  return series
    .map(p => {
      const t = Date.parse(p.t);
      let value: number | null = p[key];
      if (key === "gas_utilization" && value !== null) value *= 100;
      if (opts.completeOnly && opts.step && opts.start !== undefined && opts.end !== undefined && !isComplete(t, opts.step, opts.start, opts.end)) value = null;
      return { t, value };
    })
    .filter(p => Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t);
}

/** Keep missing readings and missing time buckets visible as gaps. */
export function chartSegments(points: ChartPoint[], step: number) {
  const segments: { t: number; value: number }[][] = [];
  let current: { t: number; value: number }[] = [];
  for (const point of points) {
    if (point.value === null || !Number.isFinite(point.value)) { current = []; continue; }
    if (!current.length || point.t - current[current.length - 1].t > step * 1.5) { current = []; segments.push(current); }
    current.push({ t: point.t, value: point.value });
  }
  return segments;
}

export function seriesExtent(points: ChartPoint[]) {
  const values = points.flatMap(p => p.value !== null && Number.isFinite(p.value) ? [p.value] : []);
  return {
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    mean: values.length ? values.reduce((s, v) => s + v, 0) / values.length : null,
    count: values.length,
  };
}

/** Round a domain ceiling up to 1, 2 or 5 × 10ⁿ so the axis labels read cleanly. */
export function niceCeil(v: number): number {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

export function chartDomain(points: ChartPoint[], floor: number): [number, number] {
  const { max } = seriesExtent(points);
  return [0, niceCeil(Math.max(floor, (max ?? 0) * 1.15))];
}

/**
 * Where usable data begins: the window start, or — when indexed history is
 * shorter than the window (fresh deployment, retention edge) — just after the
 * first recorded bucket, which the indexed range may only partly cover.
 */
export function dataStart(metrics: Metrics, start: number): number {
  const first = Math.min(...metrics.series.map(p => Date.parse(p.t)).filter(Number.isFinite));
  return Number.isFinite(first) ? Math.max(start, first + 1) : start;
}

export type VolumeBucket = { t: number; n: number; complete: boolean };
/** Blocks per API bucket, with empty buckets filled so outages read as gaps. */
export function volumeBuckets(metrics: Metrics, end: number): VolumeBucket[] {
  const step = metrics.bucket_secs * 1000;
  const start = end - metrics.hours * 3_600_000;
  const usable = dataStart(metrics, start);
  const observed = new Map(metrics.series.map(p => [Date.parse(p.t), p.blocks]));
  const first = Math.floor(start / step) * step;
  const buckets: VolumeBucket[] = [];
  for (let t = first; t < end; t += step) buckets.push({ t, n: observed.get(t) ?? 0, complete: isComplete(t, step, usable, end) });
  return buckets;
}

/** Blocks a full bucket should hold at the window's average cadence. */
export function expectedVolume(metrics: Metrics) {
  const avg = metrics.stats.avg_block_time_ms;
  return avg !== null && avg > 0 ? (metrics.bucket_secs * 1000) / avg : null;
}

/** Share of complete buckets since indexing began that carry any indexed block (0–100). */
export function sampleCoverage(metrics: Metrics, end: number): number | null {
  const buckets = volumeBuckets(metrics, end).filter(b => b.complete);
  if (!buckets.length) return null;
  return (buckets.filter(b => b.n > 0).length / buckets.length) * 100;
}

export type OutlierWindow = { start: number; end: number; kind: "block" | "volume"; value: number; buckets: number };
/** Anomalous aggregate buckets — never claimed to be exact incident durations. */
export function outlierWindows(metrics: Metrics, end: number): OutlierWindow[] {
  const windows: OutlierWindow[] = [];
  const step = metrics.bucket_secs * 1000;
  let current: OutlierWindow | null = null;
  for (const p of [...metrics.series].sort((a, b) => Date.parse(a.t) - Date.parse(b.t))) {
    const value = p.avg_block_time_ms;
    const start = Date.parse(p.t);
    if (value === null || !Number.isFinite(start) || value <= THRESHOLDS.blockTimeMs) { current = null; continue; }
    if (current && Math.abs(start - current.end) < step * 0.1) {
      current.end = Math.min(end, start + step); current.buckets++; current.value = Math.max(current.value, value);
    } else { current = { start, end: Math.min(end, start + step), kind: "block", value, buckets: 1 }; windows.push(current); }
  }
  const expected = expectedVolume(metrics);
  if (expected !== null) for (const b of volumeBuckets(metrics, end)) {
    if (b.complete && b.n < expected * THRESHOLDS.volume) windows.push({ start: b.t, end: b.t + step, kind: "volume", value: (b.n / expected) * 100, buckets: 1 });
  }
  return windows.sort((a, b) => b.start - a.start || a.kind.localeCompare(b.kind));
}

/* ── "Who uses Monad": the hourly usage rollup and the per-bucket fee series ── */

/** The usage endpoint accepts at most the retention window (72 h by default). */
export const USAGE_MAX_HOURS = 72;
/** Base-fee/fullness buckets as the API groups them (≤ 15 min, even for 72 h). */
export const usageBucketMs = (hours: number) => (hours <= 1 ? 60 : hours <= 6 ? 300 : 900) * 1000;

export type UsageSeriesKey = "base_fee" | "fullness" | "max_fullness";
/** Base fee in gwei (the API returns wei as a float); fullness in percent. */
export function usagePoints(series: Usage["fee_series"], key: UsageSeriesKey): ChartPoint[] {
  return series
    .map(p => {
      const raw = p[key];
      const value = raw === null || !Number.isFinite(raw) ? null : key === "base_fee" ? raw / 1e9 : raw * 100;
      return { t: Date.parse(p.t), value };
    })
    .filter(p => Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t);
}

/**
 * The rollup may still be backfilling: when its first hour starts after the
 * requested window, the totals cover less than the window. Returns that start
 * (ms) or null when the window is fully covered or unknown.
 */
export function usagePartialSince(usage: Pick<Usage, "hours" | "totals">, now: number): number | null {
  const since = usage.totals.since ? Date.parse(usage.totals.since) : NaN;
  if (!Number.isFinite(since)) return null;
  const hourStart = Math.floor(now / 3_600_000) * 3_600_000;
  const windowStart = hourStart - (usage.hours - 1) * 3_600_000;
  return since > windowStart ? since : null;
}
