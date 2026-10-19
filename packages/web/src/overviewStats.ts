/**
 * Pure helpers behind the Overview page. Everything here is derived from API
 * data; nothing is estimated beyond what the formula states.
 */
import type { MetricsPoint, Validator } from "./api";

/** Statistics over per-bucket average block times (ms); empty buckets are skipped, never zeroed. */
export function blockTimeSummary(points: MetricsPoint[]) {
  const values = points
    .map((p) => p.avg_block_time_ms)
    .filter((v): v is number => v !== null && Number.isFinite(v) && v > 0);
  return {
    count: values.length,
    min: values.length ? Math.min(...values) : null,
    avg: values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null,
    max: values.length ? Math.max(...values) : null,
    latest: values.at(-1) ?? null,
  };
}

/** Block-weighted mean block time over buckets in [from, to). */
function weightedBlockTime(points: MetricsPoint[], from: number, to: number) {
  let blocks = 0;
  let sum = 0;
  let buckets = 0;
  for (const p of points) {
    const t = Date.parse(p.t);
    if (t < from || t >= to || p.avg_block_time_ms === null || !p.blocks) continue;
    blocks += p.blocks;
    sum += p.avg_block_time_ms * p.blocks;
    buckets += 1;
  }
  return { mean: blocks ? sum / blocks : null, buckets };
}

/**
 * Change (%) in mean block time, last hour vs. the hour before, from the
 * 6-hour series (5-minute buckets). At least 9 of 12 buckets must be present
 * in each hour, otherwise there is no honest comparison and null is returned.
 */
export function previousHourChange(series6h: MetricsPoint[], bucketSecs: number, now: number): number | null {
  const hour = 3_600_000;
  const minBuckets = Math.ceil((hour / (bucketSecs * 1000)) * 0.75);
  const recent = weightedBlockTime(series6h, now - hour, now + 1);
  const prior = weightedBlockTime(series6h, now - 2 * hour, now - hour);
  if (recent.mean === null || prior.mean === null || recent.buckets < minBuckets || prior.buckets < minBuckets) return null;
  return ((recent.mean - prior.mean) / prior.mean) * 100;
}

const big = (s: string | null | undefined): bigint => (s && /^\d+$/.test(s) ? BigInt(s) : 0n);

/** part ÷ total as a 0–1 float without losing precision on 27-digit wei values. */
export function ratio(part: bigint, total: bigint): number {
  if (total <= 0n) return 0;
  return Number((part * 1_000_000n) / total) / 1_000_000;
}

export type SetSummary = {
  total: number;
  active: number;
  inactive: number;
  registered: number;
  /** Sum of consensus stake across the active set, wei. */
  consensusStake: string;
  /** Min validators whose consensus stake exceeds 1/3 of the total. */
  nakamoto: number | null;
  top10Share: number | null;
  /** Shares (0–1) of consensus stake: top 10, ranks 11–50, remainder. */
  buckets: { top10: number; mid: number; rest: number } | null;
  /** Commission range across the active set (fractions). */
  commission: { mean: number | null; min: number | null; max: number | null };
  /** Ordered by proposals in the last 1k blocks. */
  proposers: Validator[];
  /** Validators with a proposal-rate estimate below 0.8. */
  lowProposal: Validator[];
};

export function setSummary(validators: Validator[]): SetSummary {
  const active = validators.filter((v) => v.in_consensus_set);
  const stakes = active.map((v) => big(v.active_stake)).sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  const total = stakes.reduce((a, b) => a + b, 0n);

  let nakamoto: number | null = null;
  if (total > 0n) {
    let acc = 0n;
    for (let i = 0; i < stakes.length; i++) {
      acc += stakes[i];
      if (acc * 3n > total) {
        nakamoto = i + 1;
        break;
      }
    }
  }
  const sumRange = (a: number, b: number) => stakes.slice(a, b).reduce((x, y) => x + y, 0n);
  const top10 = total > 0n ? ratio(sumRange(0, 10), total) : null;
  const mid = total > 0n ? ratio(sumRange(10, 50), total) : null;

  const comm = active.map((v) => v.active_commission).filter((c) => Number.isFinite(c));
  return {
    total: validators.length,
    active: active.length,
    inactive: validators.length - active.length,
    registered: validators.filter((v) => v.registered).length,
    consensusStake: total.toString(),
    nakamoto,
    top10Share: top10,
    buckets: top10 === null || mid === null ? null : { top10, mid, rest: Math.max(0, 1 - top10 - mid) },
    commission: {
      mean: comm.length ? comm.reduce((a, b) => a + b, 0) / comm.length : null,
      min: comm.length ? Math.min(...comm) : null,
      max: comm.length ? Math.max(...comm) : null,
    },
    proposers: validators.filter((v) => v.proposed_1000 > 0).sort((a, b) => b.proposed_1000 - a.proposed_1000),
    lowProposal: validators.filter((v) => v.proposal_ratio !== null && v.proposal_ratio < 0.8),
  };
}

export type StakeChange = {
  v: Validator;
  kind: "joining" | "leaving" | "increase" | "decrease";
  /** next-epoch stake − stake in force this epoch, wei; may be negative. */
  delta: bigint;
};

/**
 * Pending stake movements: the live execution-layer stake against the stake
 * the consensus set is using this epoch. They take effect at a later epoch
 * boundary, so this is the honest analog of "upcoming set changes".
 */
/** Moves under 1 MON are ignored so reward dust doesn't read as a stake change. */
const DUST = 10n ** 18n;

export function pendingStakeChanges(validators: Validator[]): StakeChange[] {
  const out: StakeChange[] = [];
  for (const v of validators) {
    const delta = big(v.next_stake) - big(v.active_stake);
    let kind: StakeChange["kind"] | null = null;
    if (v.in_execution_set && !v.in_consensus_set) kind = "joining";
    else if (!v.in_execution_set && v.in_consensus_set) kind = "leaving";
    else if (delta >= DUST) kind = "increase";
    else if (delta <= -DUST) kind = "decrease";
    if (kind) out.push({ v, kind, delta });
  }
  const abs = (x: bigint) => (x < 0n ? -x : x);
  const weight = (c: StakeChange) => (c.kind === "joining" || c.kind === "leaving" ? 1 : 0);
  return out.sort((a, b) => weight(b) - weight(a) || (abs(b.delta) > abs(a.delta) ? 1 : abs(b.delta) < abs(a.delta) ? -1 : 0));
}

/** Drops the partial first and last minute so per-minute counts aren't understated. */
export function fullMinutes<T>(rows: T[]): T[] {
  return rows.length > 2 ? rows.slice(1, -1) : rows;
}
