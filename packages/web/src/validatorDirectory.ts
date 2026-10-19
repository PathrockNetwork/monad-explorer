/** Pure helpers behind the Monad validator directory: filters, sorting and set statistics. */
import type { Validator } from "./api";

export type ValidatorFilter = "all" | "active" | "inactive" | "vdp" | "unregistered" | "low-rate";
export type ValidatorSort = "stake" | "commission" | "proposed" | "rate" | "apr" | "last" | "name" | "id";

/** Below this observed ÷ expected ratio a validator is flagged "Low proposal rate". */
export const LOW_RATE = 0.8;

export const isLowRate = (v: Validator) => v.proposal_ratio !== null && v.proposal_ratio < LOW_RATE;

/**
 * Below this many rewarded blocks in the 24h window a measured APR is mostly
 * proposer-lottery noise; the UI mutes it rather than hiding it.
 */
export const MIN_REWARD_BLOCKS = 30;

/** True when the measured APR rests on too few blocks; unknown sample sizes are not flagged. */
export const isNoisyApr = (blocks: number | undefined) => blocks !== undefined && blocks < MIN_REWARD_BLOCKS;

/** Display name, falling back to the on-chain id. */
export const validatorName = (v: Pick<Validator, "id" | "name">) => v.name?.trim() || `Validator #${v.id}`;

export function matchesValidatorFilter(v: Validator, filter: ValidatorFilter): boolean {
  switch (filter) {
    case "all": return true;
    case "active": return v.in_consensus_set;
    case "inactive": return !v.in_consensus_set;
    case "vdp": return v.vdp === true;
    case "unregistered": return !v.registered;
    case "low-rate": return isLowRate(v);
  }
}

const big = (s: string | null | undefined): bigint => (s && /^\d+$/.test(s) ? BigInt(s) : 0n);

function metric(v: Validator, sort: ValidatorSort): number | null {
  switch (sort) {
    case "stake": return v.stake_share;
    case "commission": return v.active_commission;
    case "proposed": return v.proposed_1000;
    case "rate": return v.proposal_ratio;
    case "apr": return v.delegator_apr;
    case "last": return v.last_proposed_block;
    case "id": return v.id;
    default: return null;
  }
}

export function directoryRows(validators: Validator[], query: string, filter: ValidatorFilter, sort: ValidatorSort, descending: boolean): Validator[] {
  const q = query.trim().toLowerCase().replace(/^#/, "");
  const dir = descending ? -1 : 1;
  return validators
    .filter((v) => matchesValidatorFilter(v, filter) &&
      (!q || String(v.id) === q || [v.name, v.auth_address, v.beneficiary].some((s) => s?.toLowerCase().includes(q))))
    .sort((a, b) => {
      if (sort === "name") return dir * validatorName(a).localeCompare(validatorName(b)) || a.id - b.id;
      if (sort === "stake") {
        const av = big(a.active_stake), bv = big(b.active_stake);
        return av === bv ? a.id - b.id : (av > bv ? 1 : -1) * dir;
      }
      const av = metric(a, sort), bv = metric(b, sort);
      if (av === null) return bv === null ? a.rank - b.rank : 1;
      if (bv === null) return -1;
      return dir * (av - bv) || a.rank - b.rank;
    });
}

export function median(values: number[]): number | null {
  const s = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Commission fractions (0.05 = 5%) of every validator with a sane rate. */
export function commissionStats(validators: Validator[]) {
  const values = validators.map((v) => v.active_commission).filter((n) => Number.isFinite(n) && n >= 0 && n <= 1).sort((a, b) => a - b);
  return {
    values,
    min: values[0] ?? null,
    max: values.at(-1) ?? null,
    mean: values.length ? values.reduce((s, n) => s + n, 0) / values.length : null,
    median: median(values),
  };
}

/** A readable commission scale that expands to include every known rate. */
export function commissionHistogram(values: number[]) {
  const known = values.filter((n) => Number.isFinite(n) && n >= 0 && n <= 1);
  const max = Math.min(1, Math.max(0.2, Math.ceil(Math.max(0, ...known) * 10) / 10));
  const step = max / 10;
  const buckets = Array.from({ length: 10 }, (_, i) => ({ min: i * step, max: (i + 1) * step, count: 0 }));
  for (const value of known) buckets[Math.min(9, Math.floor(value / step + 1e-9))].count++;
  return { max, buckets };
}

/**
 * Smallest number of validators whose combined consensus stake exceeds one
 * third of the total — the count that could halt BFT consensus.
 */
export function nakamotoCoefficient(validators: Validator[], total: string | null | undefined): number | null {
  const sum = big(total) || validators.reduce((s, v) => s + (v.in_consensus_set ? big(v.active_stake) : 0n), 0n);
  if (sum === 0n) return null;
  const stakes = validators.filter((v) => v.in_consensus_set).map((v) => big(v.active_stake)).sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  let acc = 0n;
  for (let i = 0; i < stakes.length; i++) {
    acc += stakes[i];
    if (acc * 3n > sum) return i + 1;
  }
  return null;
}

/** Mutually exclusive set-membership buckets for the donut. */
export function setMembership(validators: Validator[]) {
  const counts = { consensus: 0, execution: 0, none: 0 };
  for (const v of validators) {
    if (v.in_consensus_set) counts.consensus++;
    else if (v.in_execution_set) counts.execution++;
    else counts.none++;
  }
  return counts;
}

/** Validators whose next-epoch stake differs most from the stake in force this epoch. */
export function stakeMovers(validators: Validator[], limit = 8) {
  return validators
    .map((v) => ({ v, delta: big(v.next_stake) - big(v.active_stake) }))
    .filter((m) => m.delta !== 0n)
    .sort((a, b) => {
      const aa = a.delta < 0n ? -a.delta : a.delta, bb = b.delta < 0n ? -b.delta : b.delta;
      return aa === bb ? a.v.rank - b.v.rank : aa > bb ? -1 : 1;
    })
    .slice(0, limit);
}
