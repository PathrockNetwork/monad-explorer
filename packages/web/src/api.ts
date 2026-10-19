/** Typed client for the Monad explorer REST API. Shapes mirror packages/api. */

/**
 * Drives which variant every panel renders. `dberror` is synthesised in the
 * client when the API itself is unreachable.
 */
export type SystemState = "normal" | "loading" | "empty" | "stopped" | "dberror" | "backfill";

export type Source = "db" | "rpc";

export type RpcStatus = { url: string; healthy: boolean; benchedUntil: number; lastError: string | null; latencyMs: number | null };

/** /api/v1/stats — the chain + indexer snapshot every page reads. */
export type Network = {
  chain_id: number;
  indexed_head: number | null;
  chain_finalized: number | null;
  lag_blocks: number | null;
  indexer_updated_at: string | null;
  earliest_indexed: number | null;
  earliest_indexed_time: string | null;
  blocks_indexed: number;
  backfill_target: number | null;
  avg_block_time_ms: number | null;
  tps: number | null;
  blocks_24h: number;
  txs_24h: number;
  gas_price: string | null;
  rpc: RpcStatus[];
  epoch: number | null;
  epoch_delay_period: boolean | null;
  validators_active: number;
  validators_total: number;
  /** Total stake in force this epoch (active set), wei. */
  total_stake: string;
  blocks_10m: number;
  /** Per-minute blocks/txs over the last 30 minutes, oldest first. */
  recent_minutes: { t: string; blocks: number; txs: number }[];
};

export type Block = {
  number: number;
  hash: string;
  parent_hash: string;
  time: string;
  miner: string;
  gas_used: number;
  gas_limit: number;
  base_fee_per_gas: string | null;
  tx_count: number;
  size: number | null;
  proposer_id: number | null;
  proposer_name: string | null;
  proposer_logo: string | null;
};

export type Tx = {
  hash: string;
  block_number: number;
  tx_index: number;
  time: string;
  from: string;
  to: string | null;
  contract_address: string | null;
  value: string;
  nonce: number;
  type: number;
  gas_limit: number;
  gas_used: number;
  effective_gas_price: string;
  fee: string;
  status: number;
  method: string | null;
  input_size: number;
  log_count: number;
};

export type TokenMeta = { address: string; name: string | null; symbol: string | null; decimals: number | null; standard: string };

export type Transfer = {
  tx_hash?: string;
  log_index?: number;
  logIndex?: number;
  block_number?: number;
  time?: string;
  token: string;
  from: string;
  to: string;
  value: string;
  standard: "erc20" | "erc721";
  token_meta: TokenMeta | null;
};

export type TxDetail = {
  source: Source;
  tx: {
    hash: string;
    pending: boolean;
    block_number: number | null;
    block_hash: string | null;
    tx_index: number | null;
    time: string | null;
    confirmations: number | null;
    from: string;
    to: string | null;
    contract_address: string | null;
    value: string;
    nonce: number;
    type: number;
    gas_limit: number;
    gas_used: number | null;
    gas_price: string | null;
    max_fee_per_gas: string | null;
    max_priority_fee_per_gas: string | null;
    effective_gas_price: string | null;
    fee: string | null;
    status: number | null;
    input: string;
  };
  transfers: Transfer[];
  logs: { address: string; topics: string[]; data: string; log_index: number }[];
};

export type AddressInfo = {
  address: string;
  balance: string;
  nonce: number;
  is_contract: boolean;
  code_size: number;
  token: (TokenMeta & { first_seen_block: string }) | null;
  validator: { id: number; name: string | null; logo: string | null; role: "auth" | "beneficiary" } | null;
  window: { sent: number; received: number; count_cap: number; blocks_proposed: number };
  transfers: Transfer[];
};

export type ValidatorStatus = "active" | "degraded" | "inactive";

export type Validator = {
  rank: number;
  id: number;
  name: string | null;
  logo: string | null;
  website: string | null;
  description: string | null;
  x: string | null;
  vdp: boolean | null;
  decommissioned: boolean | null;
  /** Has an entry in the validator-info registry. */
  registered: boolean;
  auth_address: string;
  /** Block beneficiary (`miner`) learned from indexed blocks. */
  beneficiary: string | null;
  secp: string;
  /** Raw, undocumented status flags; 0 for every healthy validator observed. */
  flags: number;
  /** Wei strings: execution (live), consensus (this epoch), snapshot (next epoch). */
  stake: string;
  consensus_stake: string;
  snapshot_stake: string;
  /** Fractions: 0.05 = 5%. */
  commission: number;
  consensus_commission: number;
  unclaimed_rewards: string;
  /**
   * Resolved views — prefer these over the raw ones above. The raw precompile
   * views swap meaning during the epoch delay period; the API resolves them
   * into the stake/commission in force THIS epoch and what takes effect NEXT.
   */
  active_stake: string;
  active_commission: number;
  next_stake: string;
  next_commission: number;
  /** In the validator set leading the current epoch. */
  in_consensus_set: boolean;
  in_execution_set: boolean;
  /** Share of the current epoch's total active stake (0–1). */
  stake_share: number;
  proposed_1000: number;
  proposed_window: number;
  /** Proposals in the fully-attributed ratio sample vs. stake-expected. */
  proposed_sample: number;
  expected_sample: number;
  /** observed ÷ expected; null when fewer than 5 proposals were expected. */
  proposal_ratio: number | null;
  last_proposed_block: number | null;
  last_proposed_time: string | null;
  /** Block rewards received over 24h (wei) and the annualised rate they imply; null without data. */
  rewards_24h: string;
  /** Rewarded blocks behind rewards_24h (sample size of reward_apr). */
  reward_blocks_24h: number;
  reward_apr: number | null;
  /** reward_apr net of the active commission: what a delegator earns. */
  delegator_apr: number | null;
  /** Proposals in the last 24h that never finalized while a competing proposal did. */
  abandoned_24h: number;
  synced_at: string;
};

export type ValidatorList = {
  epoch: number | null;
  epoch_delay_period: boolean | null;
  synced_at: string | null;
  total_consensus_stake: string;
  window: { since: string | null; blocks: number; attributed: number; recent_blocks: number };
  ratio_sample: { from_block: number | null; blocks: number };
  network_apr: number | null;
  reward_coverage: number | null;
  count: number;
  active: number;
  validators: Validator[];
};

export type ValidatorDetail = {
  validator: Validator;
  epoch: number | null;
  recent_blocks: { number: number; hash: string; time: string; tx_count: number; gas_used: number; gas_limit: number }[];
  hourly: { t: string; n: number }[];
};

export type MetricsPoint = {
  t: string;
  blocks: number;
  txs: number;
  tps: number;
  avg_block_time_ms: number | null;
  gas_utilization: number | null;
};

export type Metrics = {
  hours: number;
  allowed_hours: number[];
  bucket_secs: number;
  stats: {
    blocks: number;
    txs: number;
    avg_block_time_ms: number | null;
    tps: number | null;
    gas_utilization: number | null;
    max_txs_in_block: number | null;
  };
  series: MetricsPoint[];
  proposers: { id: number; name: string | null; logo: string | null; n: number; share: number | null }[];
};

export type Endpoint = {
  url: string;
  healthy: boolean;
  latency_ms: number | null;
  height: number | null;
  client: string | null;
  error: string | null;
  priority: number;
  used_by_indexer: boolean;
};

export type EndpointList = {
  indexer_rpc: string | null;
  chain_finalized: number | null;
  endpoints: Endpoint[];
  api_rpc: RpcStatus[];
};

export type Config = {
  chain: { name: string; network: string; chain_id: number; currency: { symbol: string; decimals: number } };
  rpc_endpoints: string[];
  indexer: { head: string; retain_hours: number; backfill_depth: number; database: string };
  validator_registry: string;
  metric_hours: number[];
  /** What the configured RPC allows; a private node raises these. */
  features: {
    full_history: boolean;
    trace_every: number;
    gas_replay: boolean;
    staking_history: boolean;
    staking_logs_range: number;
    pipeline: boolean;
  };
};

export type MarketPrice = { id: string; usd: number; usd_24h_change: number };

export type SearchResult = { type: "block" | "tx" | "address"; id: string };

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function get<T>(path: string): Promise<T> {
  const r = await fetch(path, { headers: { accept: "application/json" } });
  if (!r.ok) {
    let detail = `${r.status}`;
    try {
      const body = (await r.json()) as { error?: string };
      if (body?.error) detail = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(detail, r.status);
  }
  return r.json() as Promise<T>;
}

export const getNetwork = () => get<Network>("/api/v1/stats");
export const getBlocks = (limit = 25, before?: number) =>
  get<{ source: Source; blocks: Block[] }>(`/api/v1/blocks?limit=${limit}${before ? `&before=${before}` : ""}`);
export const getBlock = (id: number | string) =>
  get<{ source: Source; block: Block; txs: Tx[] }>(`/api/v1/blocks/${encodeURIComponent(String(id))}`);
/** `before` is the "block:index" cursor of the previous page's last row. */
export const getTransactions = (limit = 25, opts: { before?: string; address?: string } = {}) => {
  const q = new URLSearchParams({ limit: String(limit) });
  if (opts.before) q.set("before", opts.before);
  if (opts.address) q.set("address", opts.address);
  return get<{ source: Source; txs: Tx[] }>(`/api/v1/txs?${q}`);
};
export const getTransaction = (hash: string) => get<TxDetail>(`/api/v1/txs/${encodeURIComponent(hash)}`);
export const getAddress = (address: string) => get<AddressInfo>(`/api/v1/address/${encodeURIComponent(address)}`);
export const getValidators = () => get<ValidatorList>("/api/v1/validators");
export const getValidatorDetail = (id: number) => get<ValidatorDetail>(`/api/v1/validators/${id}`);
export const getMetrics = (hours = 24) => get<Metrics>(`/api/v1/metrics?hours=${hours}`);
export const getEndpoints = () => get<EndpointList>("/api/v1/endpoints");
export const getConfig = () => get<Config>("/api/v1/config");
export const getMarket = () => get<MarketPrice>("/api/v1/market");
export const search = (q: string) => get<SearchResult>(`/api/v1/search?q=${encodeURIComponent(q)}`);

/** Same-origin logo URL for a validator (the API proxies and caches the registry logo). */
export const validatorLogoUrl = (id: number) => `/api/v1/validators/${id}/logo`;

/* ───────────── Monad-specific insights (packages/api/src/insights.ts) ───────────── */

export type AddressLabel = { name: string; kind: "token" | "validator" | "system" };
export type Labels = Record<string, AddressLabel>;

export type CallNode = {
  type: string;
  from: string;
  to: string | null;
  value: string;
  gas: number | null;
  /** On Monad the top frame reports the gas limit here; inner frames are real. */
  gasUsed: number | null;
  method: string | null;
  inputSize: number;
  error: string | null;
  calls: CallNode[];
};

export type InternalTransfer = { idx: number; depth: number; type: string; from: string; to: string | null; value: string; error: string | null };

export type StateChange = {
  address: string;
  balance_before: string | null;
  balance_after: string | null;
  nonce_before: number | null;
  nonce_after: number | null;
  code_changed: boolean;
  created: boolean;
  destroyed: boolean;
  storage_changes: number;
  storage: { slot: string; before: string | null; after: string | null }[];
};

/**
 * Monad charges the full gas limit. `estimate` is eth_estimateGas replayed on
 * the parent block's state; it includes the estimator's headroom, so `unused`
 * is a conservative (never inflated) figure.
 */
export type GasAnalysis = {
  limit: number;
  estimate: number | null;
  unused: number | null;
  unused_fee: string | null;
  efficiency: number | null;
  price: string | null;
  source: "indexed" | "replayed" | null;
  /** The per-block reward syscall: gas 0, nothing to analyse. */
  system: boolean;
};

export type TxTrace = {
  hash: string;
  block_number: number;
  call_count: number;
  call_depth: number;
  frames: number;
  truncated: boolean;
  tree: CallNode;
  internal: InternalTransfer[];
  gas: GasAnalysis;
  state: StateChange[];
  labels: Labels;
};

export type HotContract = { address: string; edges: number; txs: number };

/** Dependency graph between a block's transactions (prestateTracer read/write sets). */
export type BlockParallelism = {
  block_number: number;
  source: "indexed" | "traced";
  tx_count: number;
  dependent_txs: number;
  edges: number;
  critical_path: number;
  /** tx_count ÷ critical_path: ideal speed-up over serial execution. */
  parallelism: number;
  internal_txs: number;
  levels: number[];
  /** [from, to]: tx `to` read or overwrote state tx `from` wrote. Capped at 2000. */
  edge_list: [number, number][];
  /** True when edge_list was cut short of `edges`. */
  edges_capped: boolean;
  /** Block timestamp. */
  time: string;
  hot: HotContract[];
  txs: { index: number; hash: string; from: string; to: string | null; method: string | null; gas_limit: number; level: number }[];
  labels: Labels;
};

export type ParallelismSummary = {
  hours: number;
  bucket_secs: number;
  /** Every Nth block is traced; 1 with a private RPC. */
  trace_every: number;
  totals: {
    traced_blocks: number;
    blocks: number;
    parallelism: number | null;
    median_parallelism: number | null;
    critical_path: number | null;
    /** Share of transactions that depend on an earlier one in their block. */
    dependent_share: number | null;
    internal_txs: number;
    /** Oldest traced block in the window; charts start here. */
    first_traced: string | null;
  };
  series: { t: string; blocks: number; parallelism: number; critical_path: number; dependent_share: number | null; txs: number }[];
  /** Blocks by critical path length (12 = 12 or more). */
  critical_path_histogram: { path: number; n: number }[];
  hot: (HotContract & { blocks: number; label: AddressLabel | null })[];
  extremes: { block_number: number; tx_count: number; critical_path: number; parallelism: number; kind: "serial" | "parallel" }[];
};

export type GasLeader = { address: string; txs: number; unused_fee: string; efficiency: number | null; label: AddressLabel | null };

export type GasSummary = {
  hours: number;
  trace_every: number;
  totals: {
    sampled_txs: number;
    all_txs: number;
    gas_paid: number;
    gas_needed: number;
    gas_unused: number;
    /** wei, over the sample */
    unused_fee: string;
    fees: string;
    efficiency: number | null;
    /** First replayed transaction in the window: the sample (and extrapolation) cover [sample_since, now]. */
    sample_since: string | null;
    /** All transactions since sample_since: the extrapolation base. */
    period_txs: number;
    /** wei, the sample scaled to every transaction since sample_since — an estimate */
    extrapolated_unused_fee: string;
  };
  by_contract: (GasLeader & { avg_limit: number; avg_needed: number; senders: number })[];
  by_sender: GasLeader[];
  /** bucket b = efficiency in [b/10, (b+1)/10) */
  efficiency_histogram: { bucket: number; n: number }[];
  series: { t: string; txs: number; efficiency: number | null; unused_fee: string }[];
};

export type Usage = {
  hours: number;
  totals: { txs: number; gas: number; contracts: number; fees: string; success: number | null; creations: number; since: string | null };
  contracts: { address: string; txs: number; gas: number; fees: string; success: number | null; share: number | null; label: AddressLabel | null }[];
  fee_series: { t: string; base_fee: number | null; fullness: number | null; max_fullness: number | null }[];
};

export type StakingEvent = {
  tx_hash: string;
  log_index: number;
  block_number: number;
  time: string | null;
  kind: "delegate" | "undelegate" | "withdraw" | "claim" | "commission" | "created" | "status";
  validator_id: number | null;
  validator_name: string | null;
  address: string | null;
  amount: string | null;
  epoch: number | null;
  withdraw_id: number | null;
  old_commission: number | null;
  new_commission: number | null;
  flags: number | null;
};

export type StakingSummary = {
  hours: number;
  totals: { delegated: string; undelegated: string; withdrawn: string; claimed: string; net: string; addresses: number; events: number };
  kinds: { kind: string; n: number }[];
  flows: { id: number; name: string | null; delegated: string; undelegated: string; claimed: string; net: string; delegators: number }[];
  /** How far back staking history has been collected. */
  history: { scanned_from_block: number | null; oldest_event: string | null; events: number };
};

/** Measured from block rewards actually paid, annualised; noisy for small validators over short windows. */
export type RewardRates = {
  hours: number;
  /** Share of blocks in the window with a known reward. */
  coverage: number;
  blocks: number;
  network_apr: number | null;
  total_rewards: string;
  validators: { id: number; name: string | null; blocks: number; rewards: string; stake: string; commission: number; apr: number | null; delegator_apr: number | null }[];
};

export type Delegation = {
  validatorId: number;
  stake: string;
  unclaimedRewards: string;
  /** Stake that activates at deltaEpoch / nextDeltaEpoch. */
  deltaStake: string;
  nextDeltaStake: string;
  deltaEpoch: number;
  nextDeltaEpoch: number;
  validator_name: string | null;
  in_consensus_set: boolean | null;
  delegator_apr: number | null;
};

export type AddressStaking = { address: string; delegations: Delegation[]; events: StakingEvent[] };
export type AddressInternalRow = {
  tx_hash: string;
  idx: number;
  block_number: number;
  time: string;
  depth: number;
  call_type: string;
  from: string;
  to: string | null;
  value: string;
  gas_used: number | null;
  error: string | null;
};
export type AddressInternal = { trace_every: number; internal: AddressInternalRow[]; labels: Labels };
export type AddressGas = { trace_every: number; sampled: { txs: number; unused_fee: string; fees: string; efficiency: number | null }; sent_in_window: number };

/** One proposal's MonadBFT commit stages, as observed by this server. */
export type StageRow = {
  block_id: string;
  number: number;
  hash: string | null;
  miner: string | null;
  proposer_id: number | null;
  proposer_name: string | null;
  /** The validator has a registry logo (served at validatorLogoUrl). */
  proposer_logo: boolean;
  gas_used: number | null;
  proposed_at: string | null;
  voted_at: string | null;
  finalized_at: string | null;
  verified_at: string | null;
  ms_to_vote: number | null;
  ms_to_finalize: number | null;
  ms_to_verify: number | null;
};

export type Percentiles = { p50: number; p95: number } | null;

export type PipelineState = {
  minutes: number;
  latency_ms: { blocks: number; vote: Percentiles; finalize: Percentiles; total: Percentiles; verify: Percentiles };
  heads: { proposed: number | null; voted: number | null; finalized: number | null; verified: number | null; execution_lag: number | null };
  observed_24h: number;
  observed_since: string | null;
  abandoned_24h: number;
  abandoned: { block_id: string; number: number; miner: string | null; proposer_id: number | null; proposer_name: string | null; proposer_logo: boolean; proposed_at: string; voted_at: string | null }[];
  abandoned_by_proposer: { id: number | null; name: string | null; n: number }[];
  recent: StageRow[];
};

export const getTxTrace = (hash: string) => get<TxTrace>(`/api/v1/txs/${encodeURIComponent(hash)}/trace`);
export const getBlockParallelism = (n: number) => get<BlockParallelism>(`/api/v1/blocks/${n}/parallelism`);
export const getParallelism = (hours = 6) => get<ParallelismSummary>(`/api/v1/parallelism?hours=${hours}`);
export const getGas = (hours = 24) => get<GasSummary>(`/api/v1/gas?hours=${hours}`);
export const getUsage = (hours = 24) => get<Usage>(`/api/v1/usage?hours=${hours}`);
export const getStaking = (hours = 24) => get<StakingSummary>(`/api/v1/staking?hours=${hours}`);
export const getRewardRates = (hours = 24) => get<RewardRates>(`/api/v1/staking/rewards?hours=${hours}`);
export const getStakingEvents = (opts: { limit?: number; kind?: string; validator?: number; before?: string } = {}) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(opts)) if (v !== undefined) q.set(k, String(v));
  return get<{ events: StakingEvent[] }>(`/api/v1/staking/events?${q}`);
};
export const getAddressStaking = (a: string) => get<AddressStaking>(`/api/v1/address/${encodeURIComponent(a)}/staking`);
/** `before` is the previous page's last row: `${block_number}:${tx_hash}:${idx}`. */
export const getAddressInternal = (a: string, before?: string) =>
  get<AddressInternal>(`/api/v1/address/${encodeURIComponent(a)}/internal${before ? `?before=${encodeURIComponent(before)}` : ""}`);
export const getAddressGas = (a: string) => get<AddressGas>(`/api/v1/address/${encodeURIComponent(a)}/gas`);
export const getPipeline = (minutes = 10) => get<PipelineState>(`/api/v1/pipeline?minutes=${minutes}`);

/**
 * Live stage updates over server-sent events. Returns an unsubscribe
 * function; the browser reconnects on its own after a drop.
 */
export function subscribeStages(onRows: (rows: StageRow[]) => void, onState?: (open: boolean) => void): () => void {
  const es = new EventSource("/api/v1/stream");
  es.addEventListener("stages", (e) => {
    try {
      onRows(JSON.parse((e as MessageEvent).data) as StageRow[]);
    } catch {
      /* malformed frame: skip */
    }
  });
  es.onopen = () => onState?.(true);
  es.onerror = () => onState?.(false);
  return () => es.close();
}
