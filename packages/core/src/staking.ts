/**
 * Monad staking precompile (0x…1000) reads and the off-chain validator
 * registry. Calls go through JsonRpc (not a viem client) so they share the
 * rate budget and endpoint failover with everything else; viem only encodes
 * and decodes the ABI.
 */
import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
import type { JsonRpc } from "./rpc";

export const STAKING_PRECOMPILE = "0x0000000000000000000000000000000000001000";

const abi = parseAbi([
  "function getValidator(uint64 validatorId) returns (address authAddress, uint64 flags, uint256 stake, uint256 accRewardPerToken, uint256 commission, uint256 unclaimedRewards, uint256 consensusStake, uint256 consensusCommission, uint256 snapshotStake, uint256 snapshotCommission, bytes secpPubkey, bytes blsPubkey)",
  "function getConsensusValidatorSet(uint32 startIndex) returns (bool isDone, uint32 nextIndex, uint64[] valIds)",
  "function getExecutionValidatorSet(uint32 startIndex) returns (bool isDone, uint32 nextIndex, uint64[] valIds)",
  "function getSnapshotValidatorSet(uint32 startIndex) returns (bool isDone, uint32 nextIndex, uint64[] valIds)",
  "function getEpoch() returns (uint64 epoch, bool inEpochDelayPeriod)",
  "function getDelegator(uint64 validatorId, address delegator) returns (uint256 stake, uint256 accRewardPerToken, uint256 unclaimedRewards, uint256 deltaStake, uint256 nextDeltaStake, uint64 deltaEpoch, uint64 nextDeltaEpoch)",
  "function getDelegations(address delegator, uint64 startValId) returns (bool isDone, uint64 nextValId, uint64[] valIds)",
]);

type Fn =
  | "getValidator"
  | "getConsensusValidatorSet"
  | "getExecutionValidatorSet"
  | "getSnapshotValidatorSet"
  | "getEpoch"
  | "getDelegator"
  | "getDelegations";

const callParams = (functionName: Fn, args: readonly unknown[]) => [
  { to: STAKING_PRECOMPILE, data: encodeFunctionData({ abi, functionName, args } as any) },
  "latest",
];
const decode = (functionName: Fn, data: string) => decodeFunctionResult({ abi, functionName, data: data as `0x${string}` } as any) as any;

export type OnchainValidator = {
  id: number;
  authAddress: string;
  flags: number;
  /** Wei strings: execution (live), consensus (current epoch), snapshot (next epoch). */
  stake: string;
  consensusStake: string;
  snapshotStake: string;
  /** Commission as a fraction (1e18 on chain = 100%). */
  commission: number;
  consensusCommission: number;
  snapshotCommission: number;
  unclaimedRewards: string;
  secp: string;
  bls: string;
};

const fraction = (x: bigint) => Number(x) / 1e18;

export async function getEpoch(rpc: JsonRpc): Promise<{ epoch: number; inDelayPeriod: boolean }> {
  const [epoch, inDelay] = decode("getEpoch", await rpc.call("eth_call", callParams("getEpoch", [])));
  return { epoch: Number(epoch), inDelayPeriod: inDelay };
}

/**
 * Which view governs the CURRENT epoch. At the epoch boundary the precompile
 * copies the consensus view into the snapshot view and refills consensus with
 * the upcoming set, so during the delay period the snapshot is what is
 * actually in force (rewards read it too); otherwise it is the consensus view.
 * Observed on mainnet, and consistent with the staking API docs' prose.
 */
export const activeView = (inDelayPeriod: boolean): "snapshot" | "consensus" => (inDelayPeriod ? "snapshot" : "consensus");

/** Walk a paginated validator-set view to completion. */
export async function getValidatorSet(rpc: JsonRpc, which: "consensus" | "execution" | "snapshot"): Promise<number[]> {
  const fn: Fn = which === "consensus" ? "getConsensusValidatorSet" : which === "snapshot" ? "getSnapshotValidatorSet" : "getExecutionValidatorSet";
  const ids: number[] = [];
  let start = 0;
  for (let page = 0; page < 100; page++) {
    const [done, next, valIds] = decode(fn, await rpc.call("eth_call", callParams(fn, [start])));
    ids.push(...(valIds as bigint[]).map(Number));
    if (done) return ids;
    start = Number(next);
  }
  throw new Error(`${which} validator set did not terminate`);
}

/** Read validators in batches of 20 calls per JSON-RPC request. */
export async function getValidators(rpc: JsonRpc, ids: number[]): Promise<OnchainValidator[]> {
  const out: OnchainValidator[] = [];
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    const results = await rpc.batch<string>(chunk.map((id) => ({ method: "eth_call", params: callParams("getValidator", [BigInt(id)]) })));
    results.forEach((data, k) => {
      const r = decode("getValidator", data);
      out.push({
        id: chunk[k]!,
        authAddress: String(r[0]).toLowerCase(),
        flags: Number(r[1]),
        stake: r[2].toString(),
        commission: fraction(r[4]),
        unclaimedRewards: r[5].toString(),
        consensusStake: r[6].toString(),
        consensusCommission: fraction(r[7]),
        snapshotStake: r[8].toString(),
        snapshotCommission: fraction(r[9]),
        secp: String(r[10]).replace(/^0x/, "").toLowerCase(),
        bls: String(r[11]).replace(/^0x/, "").toLowerCase(),
      });
    });
  }
  return out;
}

export type Delegation = {
  validatorId: number;
  /** Active stake, wei. */
  stake: string;
  unclaimedRewards: string;
  /** Stake activating at deltaEpoch / nextDeltaEpoch (delegations not yet in force), wei. */
  deltaStake: string;
  nextDeltaStake: string;
  deltaEpoch: number;
  nextDeltaEpoch: number;
};

/** Every validator `delegator` has stake with, and the position at each. */
export async function getDelegations(rpc: JsonRpc, delegator: string): Promise<Delegation[]> {
  const ids: number[] = [];
  let start = 0n;
  for (let page = 0; page < 50; page++) {
    const [done, next, valIds] = decode("getDelegations", await rpc.call("eth_call", callParams("getDelegations", [delegator, start])));
    ids.push(...(valIds as bigint[]).map(Number));
    if (done) break;
    start = next as bigint;
  }
  const out: Delegation[] = [];
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    const results = await rpc.batch<string>(chunk.map((id) => ({ method: "eth_call", params: callParams("getDelegator", [BigInt(id), delegator]) })));
    results.forEach((data, k) => {
      const r = decode("getDelegator", data);
      out.push({
        validatorId: chunk[k]!,
        stake: r[0].toString(),
        unclaimedRewards: r[2].toString(),
        deltaStake: r[3].toString(),
        nextDeltaStake: r[4].toString(),
        deltaEpoch: Number(r[5]),
        nextDeltaEpoch: Number(r[6]),
      });
    });
  }
  return out;
}

export type RegistryEntry = {
  name: string | null;
  website: string | null;
  description: string | null;
  logo: string | null;
  x: string | null;
  vdp: boolean | null;
  decommissioned: boolean | null;
};

const REGISTRY_BASE = "https://raw.githubusercontent.com/monad-developers/validator-info/main/mainnet";

/** Accept only plain https URLs; anything else from a third-party file is dropped. */
function httpsUrl(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 500) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

const text = (v: unknown, max: number): string | null =>
  typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) || null : null;

/**
 * Parse one validator-info registry file. The file is keyed by SECP key and
 * must agree with the chain on both the key and the validator id; a file that
 * claims someone else's id is ignored rather than trusted.
 */
export function parseRegistryEntry(raw: any, expect: { id: number; secp: string }): RegistryEntry | null {
  if (!raw || typeof raw !== "object") return null;
  if (String(raw.secp ?? "").toLowerCase() !== expect.secp || Number(raw.id) !== expect.id) return null;
  return {
    name: text(raw.name, 64),
    website: httpsUrl(raw.website),
    description: text(raw.description, 400),
    logo: httpsUrl(raw.logo),
    x: httpsUrl(raw.x),
    vdp: typeof raw.vdp === "boolean" ? raw.vdp : null,
    decommissioned: typeof raw.decommissioned === "boolean" ? raw.decommissioned : null,
  };
}

/** Fetch one validator's registry file; null when the validator never registered. */
export async function fetchRegistryEntry(v: { id: number; secp: string }): Promise<RegistryEntry | null> {
  const res = await fetch(`${REGISTRY_BASE}/${v.secp}.json`, { signal: AbortSignal.timeout(10_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`registry HTTP ${res.status}`);
  return parseRegistryEntry(await res.json(), v);
}
