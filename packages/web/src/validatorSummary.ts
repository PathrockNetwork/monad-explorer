import type { Validator } from "./api";
import { median } from "./validatorDirectory";

/** Set-membership counts and the top proposers over the last 1,000 blocks. */
export function validatorSummary(validators: Validator[]) {
  const counts = { active: 0, inactive: 0 };
  for (const v of validators) counts[v.in_consensus_set ? "active" : "inactive"]++;
  const proposers = validators
    .filter((v) => v.proposed_1000 > 0)
    .slice()
    .sort((a, b) => b.proposed_1000 - a.proposed_1000 || a.rank - b.rank)
    .slice(0, 5);
  return { counts, proposers, total: validators.length };
}

/** Median measured delegator APR across active validators with a rate (median resists small-sample outliers). */
export function medianDelegatorApr(validators: Validator[]): number | null {
  return median(validators.filter((v) => v.in_consensus_set && v.delegator_apr !== null).map((v) => v.delegator_apr as number));
}
