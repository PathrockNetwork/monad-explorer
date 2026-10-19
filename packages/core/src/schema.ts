import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/*
 * By default the database is a rolling window over the chain, not an
 * archive. Monad produces ~3 blocks and ~50 transactions a second, so
 * everything older than RETAIN_HOURS is swept and the API reads it through
 * from the archive RPC instead. RETAIN_HOURS=0 keeps everything (full-history
 * mode, meant for a private RPC that can backfill to genesis). Addresses and hashes are stored lowercase 0x-hex; wei amounts are
 * numeric because they exceed every integer type.
 */

/** One row per finalized block. */
export const blocks = pgTable(
  "blocks",
  {
    number: bigint("number", { mode: "number" }).primaryKey(),
    hash: text("hash").notNull(),
    parentHash: text("parent_hash").notNull(),
    time: timestamp("time", { withTimezone: true }).notNull(),
    /** Block proposer's beneficiary address (the `miner` field). */
    miner: text("miner").notNull(),
    gasUsed: bigint("gas_used", { mode: "number" }).notNull(),
    gasLimit: bigint("gas_limit", { mode: "number" }).notNull(),
    baseFeePerGas: numeric("base_fee_per_gas"),
    txCount: integer("tx_count").notNull(),
    size: integer("size"),
    /** Proposer's validator id, from the block's ValidatorRewarded event. */
    proposerId: integer("proposer_id"),
    /** Block reward credited to the proposer's pool (ValidatorRewarded amount), wei. */
    reward: numeric("reward"),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byTime: index("blocks_time_idx").on(t.time),
    byHash: index("blocks_hash_idx").on(t.hash),
    byMiner: index("blocks_miner_idx").on(t.miner, t.number),
    byProposer: index("blocks_proposer_idx").on(t.proposerId, t.number),
  }),
);

/**
 * One row per transaction, joined with its receipt. No FK to blocks: the hot
 * insert path runs in the same transaction as the block row anyway, and the
 * retention sweep deletes both by block number.
 */
export const transactions = pgTable(
  "transactions",
  {
    hash: text("hash").primaryKey(),
    blockNumber: bigint("block_number", { mode: "number" }).notNull(),
    txIndex: integer("tx_index").notNull(),
    time: timestamp("time", { withTimezone: true }).notNull(),
    from: text("from").notNull(),
    /** Null for contract creation. */
    to: text("to"),
    /** Address deployed by a creation transaction. */
    contractAddress: text("contract_address"),
    value: numeric("value").notNull(),
    nonce: bigint("nonce", { mode: "number" }).notNull(),
    type: smallint("type").notNull(),
    gasLimit: bigint("gas_limit", { mode: "number" }).notNull(),
    gasUsed: bigint("gas_used", { mode: "number" }).notNull(),
    effectiveGasPrice: numeric("effective_gas_price").notNull(),
    /** gas_used × effective_gas_price, in wei. */
    fee: numeric("fee").notNull(),
    /** 1 = success, 0 = reverted. */
    status: smallint("status").notNull(),
    /** First four bytes of calldata (0x-prefixed), null for plain transfers. */
    method: text("method"),
    inputSize: integer("input_size").notNull(),
    logCount: integer("log_count").notNull(),
    /**
     * Gas the transaction needed, from eth_estimateGas replayed on the parent
     * block's state. Monad charges the full gas limit, so limit − estimate is
     * what the sender paid for and never used. Null until traced (sampled).
     */
    gasEstimate: bigint("gas_estimate", { mode: "number" }),
    /** Call frames below the top-level call; null until traced. */
    callCount: integer("call_count"),
    callDepth: smallint("call_depth"),
  },
  (t) => ({
    byBlock: index("txs_block_idx").on(t.blockNumber, t.txIndex),
    byFrom: index("txs_from_idx").on(t.from, t.blockNumber),
    byTo: index("txs_to_idx").on(t.to, t.blockNumber),
    /** The gas-replay sample, for the overpayment views. */
    byEstimated: index("txs_estimated_idx").on(t.blockNumber).where(sql`${t.gasEstimate} is not null`),
  }),
);

/**
 * ERC-20 / ERC-721 `Transfer` events. Both standards share topic0; ERC-721
 * indexes the token id (4 topics) where ERC-20 puts the amount in data.
 */
export const tokenTransfers = pgTable(
  "token_transfers",
  {
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    blockNumber: bigint("block_number", { mode: "number" }).notNull(),
    time: timestamp("time", { withTimezone: true }).notNull(),
    token: text("token").notNull(),
    from: text("from").notNull(),
    to: text("to").notNull(),
    /** ERC-20 amount, or the ERC-721 token id. */
    value: numeric("value").notNull(),
    standard: text("standard").notNull(), // "erc20" | "erc721"
  },
  (t) => ({
    pk: primaryKey({ columns: [t.txHash, t.logIndex] }),
    byBlock: index("transfers_block_idx").on(t.blockNumber),
    byFrom: index("transfers_from_idx").on(t.from, t.blockNumber),
    byTo: index("transfers_to_idx").on(t.to, t.blockNumber),
    byToken: index("transfers_token_idx").on(t.token, t.blockNumber),
  }),
);

/**
 * Token metadata, resolved lazily over eth_call. Unlike the windowed tables
 * this is never swept: a contract's name and decimals do not expire.
 * Null fields mean the contract did not answer that call, not "unknown yet";
 * `resolvedAt` null means not attempted.
 */
export const tokens = pgTable(
  "tokens",
  {
    address: text("address").primaryKey(),
    name: text("name"),
    symbol: text("symbol"),
    decimals: smallint("decimals"),
    standard: text("standard").notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    firstSeenBlock: bigint("first_seen_block", { mode: "number" }).notNull(),
  },
  (t) => ({
    unresolved: index("tokens_unresolved_idx").on(t.address).where(sql`${t.resolvedAt} is null`),
  }),
);

/**
 * Validators from the staking precompile, joined with the off-chain
 * validator-info registry (names, logos). Unlike the windowed tables this is
 * current state, refreshed in place. Blocks link here through
 * blocks.proposer_id (from each block's reward event).
 */
export const validators = pgTable(
  "validators",
  {
    id: integer("id").primaryKey(), // on-chain validator id
    authAddress: text("auth_address").notNull(),
    /**
     * Block beneficiary (`miner`) the validator's node sets, learned from
     * indexed blocks. Usually differs from auth_address; lets blocks indexed
     * before proposer_id existed be attributed.
     */
    beneficiary: text("beneficiary"),
    secp: text("secp").notNull(),
    bls: text("bls"),
    /** Raw status flags from getValidator; the bits are undocumented, shown as-is. */
    flags: bigint("flags", { mode: "number" }).notNull().default(0),
    stake: numeric("stake").notNull(),
    consensusStake: numeric("consensus_stake").notNull(),
    snapshotStake: numeric("snapshot_stake").notNull(),
    commission: doublePrecision("commission").notNull(),
    consensusCommission: doublePrecision("consensus_commission").notNull(),
    snapshotCommission: doublePrecision("snapshot_commission"),
    unclaimedRewards: numeric("unclaimed_rewards").notNull(),
    inConsensusSet: boolean("in_consensus_set").notNull().default(false),
    inExecutionSet: boolean("in_execution_set").notNull().default(false),

    /* validator-info registry; all null when the validator never registered. */
    name: text("name"),
    logo: text("logo"),
    website: text("website"),
    description: text("description"),
    x: text("x"),
    vdp: boolean("vdp"),
    decommissioned: boolean("decommissioned"),
    registrySyncedAt: timestamp("registry_synced_at", { withTimezone: true }),

    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byAuth: index("validators_auth_idx").on(t.authAddress),
    byBeneficiary: index("validators_beneficiary_idx").on(t.beneficiary),
  }),
);

/**
 * Value-moving internal calls ("internal transactions") from callTracer:
 * frames below the top level that carry MON, create a contract, or
 * self-destruct. Plain zero-value calls are counted on the transaction but not
 * stored — they are the bulk of every trace and say little on their own.
 */
export const internalTxs = pgTable(
  "internal_txs",
  {
    txHash: text("tx_hash").notNull(),
    /** Depth-first position of the frame within its transaction's trace. */
    idx: integer("idx").notNull(),
    blockNumber: bigint("block_number", { mode: "number" }).notNull(),
    time: timestamp("time", { withTimezone: true }).notNull(),
    depth: smallint("depth").notNull(),
    callType: text("call_type").notNull(),
    from: text("from").notNull(),
    to: text("to"),
    value: numeric("value").notNull(),
    gasUsed: bigint("gas_used", { mode: "number" }),
    error: text("error"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.txHash, t.idx] }),
    byBlock: index("itx_block_idx").on(t.blockNumber),
    byFrom: index("itx_from_idx").on(t.from, t.blockNumber),
    byTo: index("itx_to_idx").on(t.to, t.blockNumber),
  }),
);

/**
 * Per-block parallelism reconstructed from prestateTracer read/write sets.
 * Monad executes a block's transactions optimistically in parallel and
 * re-executes the ones whose inputs an earlier transaction changed; this is
 * the dependency structure such a scheduler would face, not a measurement of
 * the node's own retries (it does not publish those).
 */
export const blockTraces = pgTable(
  "block_traces",
  {
    blockNumber: bigint("block_number", { mode: "number" }).primaryKey(),
    time: timestamp("time", { withTimezone: true }).notNull(),
    txCount: integer("tx_count").notNull(),
    /** Transactions that depend on at least one earlier transaction in the block. */
    dependentTxs: integer("dependent_txs").notNull(),
    edges: integer("edges").notNull(),
    /** Longest dependency chain, in transactions (1 = fully parallel). */
    criticalPath: integer("critical_path").notNull(),
    /** tx_count ÷ critical_path: the ideal speed-up over serial execution. */
    parallelism: doublePrecision("parallelism").notNull(),
    internalTxs: integer("internal_txs").notNull(),
    /** Per-transaction dependency level (0 = no dependency), in tx order. */
    levels: jsonb("levels").$type<number[]>().notNull(),
    /** [from, to] tx-index pairs, capped; `to` read or overwrote state `from` wrote. */
    edgeList: jsonb("edge_list").$type<[number, number][]>().notNull(),
    /** Most contended contracts: address and how many dependency edges it caused. */
    hot: jsonb("hot").$type<{ address: string; edges: number; txs: number }[]>().notNull(),
    tracedAt: timestamp("traced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byTime: index("block_traces_time_idx").on(t.time),
  }),
);

/**
 * Staking precompile events other than the per-block ValidatorRewarded
 * (which lives on blocks.reward). Never swept: delegation history is small
 * and is the point of keeping it. Filled live from receipts and backwards by
 * the staking-history loop over eth_getLogs.
 */
export const stakingEvents = pgTable(
  "staking_events",
  {
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    blockNumber: bigint("block_number", { mode: "number" }).notNull(),
    time: timestamp("time", { withTimezone: true }),
    /** delegate | undelegate | withdraw | claim | commission | created | status | epoch */
    kind: text("kind").notNull(),
    validatorId: integer("validator_id"),
    /** Delegator, or the auth address for `created`. */
    address: text("address"),
    amount: numeric("amount"),
    epoch: bigint("epoch", { mode: "number" }),
    withdrawId: smallint("withdraw_id"),
    oldCommission: doublePrecision("old_commission"),
    newCommission: doublePrecision("new_commission"),
    flags: bigint("flags", { mode: "number" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.txHash, t.logIndex] }),
    byBlock: index("staking_block_idx").on(t.blockNumber),
    byValidator: index("staking_validator_idx").on(t.validatorId, t.blockNumber),
    byAddress: index("staking_address_idx").on(t.address, t.blockNumber),
  }),
);

/**
 * MonadBFT commit stages for each proposal, from the monadNewHeads
 * subscription: Proposed → Voted → Finalized, then Verified once execution
 * catches up (state roots trail consensus by a few blocks). Keyed by blockId
 * because a height can see more than one proposal; one that never finalizes
 * while another proposal at its height does was abandoned.
 */
export const blockStages = pgTable(
  "block_stages",
  {
    blockId: text("block_id").primaryKey(),
    number: bigint("number", { mode: "number" }).notNull(),
    hash: text("hash"),
    miner: text("miner"),
    proposerId: integer("proposer_id"),
    txCount: integer("tx_count"),
    gasUsed: bigint("gas_used", { mode: "number" }),
    proposedAt: timestamp("proposed_at", { withTimezone: true, precision: 3 }),
    votedAt: timestamp("voted_at", { withTimezone: true, precision: 3 }),
    finalizedAt: timestamp("finalized_at", { withTimezone: true, precision: 3 }),
    verifiedAt: timestamp("verified_at", { withTimezone: true, precision: 3 }),
  },
  (t) => ({
    byNumber: index("block_stages_number_idx").on(t.number),
    byProposed: index("block_stages_proposed_idx").on(t.proposedAt),
  }),
);

/**
 * Hourly per-contract usage, rolled up from `transactions` by the indexer so
 * day-scale leaderboards don't scan millions of rows. Distinct senders are
 * not additive across hours, so they are not kept here.
 */
export const usageHourly = pgTable(
  "usage_hourly",
  {
    hour: timestamp("hour", { withTimezone: true }).notNull(),
    /** Called contract or recipient; "" for contract creations. */
    address: text("address").notNull(),
    txs: integer("txs").notNull(),
    failed: integer("failed").notNull(),
    gas: doublePrecision("gas").notNull(),
    fees: numeric("fees").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.hour, t.address] }),
  }),
);

/** Single-row indexer bookkeeping (id = 1). */
export const syncState = pgTable("sync_state", {
  id: integer("id").primaryKey(),
  chainId: integer("chain_id").notNull(),
  /** Newest block ingested by the live follower. */
  headNumber: bigint("head_number", { mode: "number" }),
  /** Oldest block the backfill should reach; moves forward with retention. */
  backfillTarget: bigint("backfill_target", { mode: "number" }),
  /** Newest finalized height the RPC reported at the last poll. */
  chainFinalized: bigint("chain_finalized", { mode: "number" }),
  activeRpc: text("active_rpc"),
  epoch: bigint("epoch", { mode: "number" }),
  epochDelayPeriod: boolean("epoch_delay_period"),
  validatorsSyncedAt: timestamp("validators_synced_at", { withTimezone: true }),
  /** Lowest block the staking-history loop has scanned down to (inclusive). */
  stakingHistoryFloor: bigint("staking_history_floor", { mode: "number" }),
  /** Newest block folded into usage_hourly. */
  usageRolledTo: bigint("usage_rolled_to", { mode: "number" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
