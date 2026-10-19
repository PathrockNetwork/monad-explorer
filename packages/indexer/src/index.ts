/**
 * Monad indexer: follows finalized blocks over JSON-RPC into Postgres.
 *
 * Four loops share one rate-limited RPC client:
 *  - follow:    ingest every newly finalized block, in order (the point of it all)
 *  - backfill:  walk back from head to fill the window and repair any gaps,
 *               but only while the follower is caught up
 *  - retention: sweep rows older than RETAIN_HOURS (the API reads those
 *               through from the archive RPC instead)
 *  - tokens:    resolve name/symbol/decimals for newly seen token contracts
 *  - validators: staking precompile state + validator-info registry metadata
 *  - traces:    call/prestate traces and gas replay for sampled blocks (traces.ts)
 *  - pipeline:  MonadBFT commit stages from monadNewHeads (pipeline.ts)
 *  - history:   staking events and block rewards over eth_getLogs (history.ts)
 *  - rollup:    hourly per-contract usage for the day-scale leaderboards (rollup.ts)
 *
 * Only `finalized` blocks are ingested. On Monad that tag trails the tip by
 * ~2 blocks (<1s), and in exchange there are no reorgs to unwind.
 */
import { and, isNull, lt, or, sql } from "drizzle-orm";
import {
  JsonRpc,
  blocks,
  createDb,
  decodeAbiString,
  decodeDecimals,
  activeView,
  fetchRegistryEntry,
  getEpoch,
  getValidatorSet,
  getValidators,
  hexToNumber,
  loadEnv,
  parseBlock,
  rpcUrlsFromEnv,
  stakingEvents,
  syncState,
  tokenTransfers,
  tokens,
  transactions,
  validators,
  type ParsedBlock,
} from "@monad-explorer/core";

import { CAUGHT_UP_BLOCKS, type Ctx } from "./context";
import { historyLoop } from "./history";
import { pipelineLoop } from "./pipeline";
import { rollupLoop } from "./rollup";
import { traceLoop } from "./traces";

loadEnv();

const CHAIN_ID = Number(process.env.CHAIN_ID ?? 143);
/**
 * Blocks to backfill behind head (~0.4s each: 30k ≈ 3.3h); "all" walks back
 * to genesis, which only makes sense with RETAIN_HOURS=0 and a private RPC.
 */
const BACKFILL_DEPTH = process.env.BACKFILL_DEPTH === "all" ? Number.POSITIVE_INFINITY : Number(process.env.BACKFILL_DEPTH ?? 30_000);
/** Hours of chain kept in Postgres; 0 keeps everything (full-history mode). */
const RETAIN_HOURS = Number(process.env.RETAIN_HOURS ?? 72);
const FOLLOW_POLL_MS = 500;
/** Blocks fetched in parallel while catching up; each costs 2 RPC requests. */
const FETCH_CONCURRENCY = Number(process.env.FETCH_CONCURRENCY ?? 4);
const BACKFILL_RESCAN_MS = 5 * 60_000;
const RETENTION_SWEEP_MS = 10 * 60_000;
const RETENTION_CHUNK = 20_000;
const TOKEN_POLL_MS = 5_000;
const TOKENS_PER_TICK = 10;
/** Stake moves every epoch (~5.5h); 5 minutes keeps the page fresh for ~10 calls of 20 reads. */
const VALIDATOR_SYNC_MS = Number(process.env.VALIDATOR_SYNC_INTERVAL_MS ?? 5 * 60_000);
/** Registry files change rarely; refetch each validator's at most this often. */
const REGISTRY_TTL_MS = 6 * 3600_000;

const { db, pool } = createDb();
const rpc = new JsonRpc(rpcUrlsFromEnv());
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const log = (msg: string, extra?: Record<string, unknown>) =>
  console.log(`${new Date().toISOString()} ${msg}${extra ? ` ${JSON.stringify(extra)}` : ""}`);

let stopping = false;
let head: number | null = null;
let finalized = 0;
const stats = { live: 0, backfilled: 0, txs: 0 };

async function fetchBlock(n: number): Promise<ParsedBlock> {
  const hex = `0x${n.toString(16)}`;
  const [block, receipts] = await rpc.batch([
    { method: "eth_getBlockByNumber", params: [hex, true] },
    { method: "eth_getBlockReceipts", params: [hex] },
  ]);
  if (!block) throw new Error(`block ${n} not available yet`);
  return parseBlock(block, receipts ?? []);
}

/** Fetch blocks with bounded concurrency; results keep input order. */
async function fetchMany(nums: number[]): Promise<ParsedBlock[]> {
  const out: ParsedBlock[] = new Array(nums.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(FETCH_CONCURRENCY, nums.length) }, async () => {
      while (next < nums.length) {
        const i = next++;
        out[i] = await fetchBlock(nums[i]!);
      }
    }),
  );
  return out;
}

const chunk = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/**
 * Persist one block with its transactions and transfers atomically. The
 * backfill finds holes by looking at `blocks` alone, so a block row must
 * never commit without its transactions.
 */
async function persist(p: ParsedBlock): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(blocks).values(p.block).onConflictDoNothing();
    // Learn the proposer's beneficiary address (it rarely changes, so this
    // is almost always a no-op match) for attributing pre-existing blocks.
    if (p.block.proposerId !== null) {
      await tx
        .update(validators)
        .set({ beneficiary: p.block.miner })
        .where(sql`${validators.id} = ${p.block.proposerId} and ${validators.beneficiary} is distinct from ${p.block.miner}`);
    }
    for (const rows of chunk(p.txs, 1000)) await tx.insert(transactions).values(rows).onConflictDoNothing();
    for (const rows of chunk(p.transfers, 1000)) await tx.insert(tokenTransfers).values(rows).onConflictDoNothing();
    if (p.staking.length) await tx.insert(stakingEvents).values(p.staking).onConflictDoNothing();
    if (p.transfers.length) {
      const seen = new Map(p.transfers.map((t) => [t.token, t.standard]));
      await tx
        .insert(tokens)
        .values([...seen].map(([address, standard]) => ({ address, standard, firstSeenBlock: p.block.number })))
        .onConflictDoNothing();
    }
  });
  stats.txs += p.txs.length;
}

async function finalizedHeight(): Promise<number> {
  const b = await rpc.call("eth_getBlockByNumber", ["finalized", false]);
  return hexToNumber(b.number);
}

async function saveState(): Promise<void> {
  await db
    .update(syncState)
    .set({ headNumber: head, chainFinalized: finalized, activeRpc: rpc.active, updatedAt: new Date() })
    .where(sql`${syncState.id} = 1`);
}

async function follow(): Promise<void> {
  while (!stopping) {
    try {
      finalized = await finalizedHeight();
      if (head === null) head = finalized - 1;
      while (!stopping && head < finalized) {
        const nums = Array.from({ length: Math.min(FETCH_CONCURRENCY * 4, finalized - head) }, (_, i) => head! + 1 + i);
        const parsed = await fetchMany(nums);
        for (const p of parsed) {
          await persist(p);
          head = p.block.number;
          stats.live++;
        }
        await saveState();
      }
    } catch (err) {
      log("follow error", { err: (err as Error).message });
      await sleep(2_000);
    }
    await sleep(FOLLOW_POLL_MS);
  }
}

/**
 * Oldest block the backfill should reach: BACKFILL_DEPTH behind head, but
 * never older than the retention window — the sweep would delete those again
 * and the backfill would see them as holes forever. Block numbers are mapped
 * to time with the observed block interval, with a 2% safety margin.
 */
async function backfillFloor(): Promise<number> {
  const h = head ?? 0;
  const { rows } = await pool.query<{ secs: number | null }>(
    `select extract(epoch from max(time) - min(time)) / nullif(max(number) - min(number), 0) as secs
     from (select number, time from blocks order by number desc limit 2000) recent`,
  );
  const blockSecs = Number(rows[0]?.secs) || 0.4;
  const byRetention = RETAIN_HOURS > 0 ? h - Math.floor(((RETAIN_HOURS * 3600) / blockSecs) * 0.98) : 0;
  return Math.max(0, h - BACKFILL_DEPTH, byRetention);
}

/** Newest-first list of block numbers missing from [lo, hi]. */
async function missing(lo: number, hi: number, limit: number): Promise<number[]> {
  const { rows } = await pool.query<{ n: string }>(
    `select n from generate_series($1::bigint, $2::bigint, -1) n
     where not exists (select 1 from blocks b where b.number = n) limit $3`,
    [hi, lo, limit],
  );
  return rows.map((r) => Number(r.n));
}

async function backfill(): Promise<void> {
  while (!stopping) {
    try {
      if (head === null || finalized - head > CAUGHT_UP_BLOCKS) {
        await sleep(1_000);
        continue;
      }
      const floor = await backfillFloor();
      await db.update(syncState).set({ backfillTarget: floor }).where(sql`${syncState.id} = 1`);
      const gaps = await missing(floor, head, FETCH_CONCURRENCY * 4);
      if (!gaps.length) {
        await sleep(BACKFILL_RESCAN_MS);
        continue;
      }
      for (const p of await fetchMany(gaps)) {
        await persist(p);
        stats.backfilled++;
      }
    } catch (err) {
      log("backfill error", { err: (err as Error).message });
      await sleep(5_000);
    }
  }
}

/**
 * Delete everything older than the retention window, in chunks so no single
 * statement holds locks long enough to stall the follower's inserts.
 */
async function retention(): Promise<void> {
  if (RETAIN_HOURS <= 0) {
    log("retention disabled (RETAIN_HOURS=0): keeping full history");
    return;
  }
  while (!stopping) {
    try {
      const { rows } = await pool.query<{ n: string | null }>(
        `select max(number) as n from blocks where time < now() - make_interval(hours => $1)`,
        [RETAIN_HOURS],
      );
      const cutoff = rows[0]?.n ? Number(rows[0].n) : null;
      if (cutoff !== null) {
        let removed = 0;
        // staking_events is deliberately absent: delegation history is kept.
        for (const table of ["token_transfers", "internal_txs", "transactions"]) {
          for (;;) {
            const r = await pool.query(
              `delete from ${table} where ctid in (select ctid from ${table} where block_number <= $1 limit $2)`,
              [cutoff, RETENTION_CHUNK],
            );
            removed += r.rowCount ?? 0;
            if ((r.rowCount ?? 0) < RETENTION_CHUNK || stopping) break;
          }
        }
        // Blocks go last: until its transactions are gone a block must stay,
        // or the backfill would see a hole and re-fetch it.
        await pool.query(`delete from block_traces where block_number <= $1`, [cutoff]);
        await pool.query(`delete from block_stages where number <= $1`, [cutoff]);
        await pool.query(`delete from usage_hourly where hour < now() - make_interval(hours => $1)`, [RETAIN_HOURS + 1]);
        await db.delete(blocks).where(lt(blocks.number, cutoff + 1));
        if (removed) log("retention sweep", { cutoff, removed });
      }
    } catch (err) {
      log("retention error", { err: (err as Error).message });
    }
    await sleep(RETENTION_SWEEP_MS);
  }
}

async function resolveTokens(): Promise<void> {
  while (!stopping) {
    try {
      const pending = await db
        .select({ address: tokens.address })
        .from(tokens)
        .where(isNull(tokens.resolvedAt))
        .limit(TOKENS_PER_TICK);
      for (const { address } of pending) {
        // One token at a time: a reverting call fails the whole batch, and a
        // contract without symbol() is common enough to expect.
        const settle = (data: string) => rpc.call<string>("eth_call", [{ to: address, data }, "latest"]).catch(() => null);
        const [name, symbol, decimals] = await Promise.all([settle("0x06fdde03"), settle("0x95d89b41"), settle("0x313ce567")]);
        await db
          .update(tokens)
          .set({ name: decodeAbiString(name), symbol: decodeAbiString(symbol), decimals: decodeDecimals(decimals), resolvedAt: new Date() })
          .where(and(sql`${tokens.address} = ${address}`, isNull(tokens.resolvedAt)));
      }
      if (pending.length) continue;
    } catch (err) {
      log("token resolve error", { err: (err as Error).message });
    }
    await sleep(TOKEN_POLL_MS);
  }
}

/**
 * Mirror the staking precompile into `validators`: every validator in the
 * consensus or execution set, plus any already known (a validator that left
 * the set keeps its row, with both set flags cleared).
 */
async function syncValidators(): Promise<void> {
  const epoch = await getEpoch(rpc);
  // "consensus" below means the set leading the current epoch (see activeView).
  const [consensus, execution] = await Promise.all([getValidatorSet(rpc, activeView(epoch.inDelayPeriod)), getValidatorSet(rpc, "execution")]);
  const known = await db.select({ id: validators.id }).from(validators);
  const ids = [...new Set([...consensus, ...execution, ...known.map((k) => k.id)])];
  const cons = new Set(consensus);
  const exec = new Set(execution);
  const onchain = await getValidators(rpc, ids);
  const now = new Date();
  for (const v of onchain) {
    // Unregistered ids read back as zeroed structs; skip rather than store junk.
    if (!v.secp || /^0+$/.test(v.authAddress.slice(2))) continue;
    const row = {
      id: v.id,
      authAddress: v.authAddress,
      secp: v.secp,
      bls: v.bls || null,
      flags: v.flags,
      stake: v.stake,
      consensusStake: v.consensusStake,
      snapshotStake: v.snapshotStake,
      commission: v.commission,
      consensusCommission: v.consensusCommission,
      snapshotCommission: v.snapshotCommission,
      unclaimedRewards: v.unclaimedRewards,
      inConsensusSet: cons.has(v.id),
      inExecutionSet: exec.has(v.id),
      syncedAt: now,
    };
    const { id: _id, ...update } = row;
    await db.insert(validators).values(row).onConflictDoUpdate({ target: validators.id, set: update });
  }
  await db
    .update(syncState)
    .set({ epoch: epoch.epoch, epochDelayPeriod: epoch.inDelayPeriod, validatorsSyncedAt: now })
    .where(sql`${syncState.id} = 1`);

  // Registry metadata for anything never fetched or stale.
  const stale = await db
    .select({ id: validators.id, secp: validators.secp })
    .from(validators)
    .where(or(isNull(validators.registrySyncedAt), lt(validators.registrySyncedAt, new Date(Date.now() - REGISTRY_TTL_MS))));
  let named = 0;
  for (let i = 0; i < stale.length && !stopping; i += 6) {
    await Promise.all(
      stale.slice(i, i + 6).map(async (v) => {
        try {
          const entry = await fetchRegistryEntry(v);
          if (entry) named++;
          await db
            .update(validators)
            .set({
              name: entry?.name ?? null,
              logo: entry?.logo ?? null,
              website: entry?.website ?? null,
              description: entry?.description ?? null,
              x: entry?.x ?? null,
              vdp: entry?.vdp ?? null,
              decommissioned: entry?.decommissioned ?? null,
              registrySyncedAt: new Date(),
            })
            .where(sql`${validators.id} = ${v.id}`);
        } catch (err) {
          // Leave registrySyncedAt untouched so the next sweep retries.
          log("registry fetch failed", { id: v.id, err: (err as Error).message });
        }
      }),
    );
  }
  // Attribute blocks indexed before proposer_id existed, via learned beneficiaries.
  const attributed = await pool.query(
    `update blocks b set proposer_id = v.id from validators v
     where b.proposer_id is null and v.beneficiary is not null and b.miner = v.beneficiary`,
  );
  log("validators synced", { attributed: attributed.rowCount, epoch: epoch.epoch, consensus: consensus.length, execution: execution.length, registryFetched: stale.length, named });
}

async function validatorLoop(): Promise<void> {
  while (!stopping) {
    try {
      await syncValidators();
    } catch (err) {
      log("validator sync error", { err: (err as Error).message });
    }
    await sleep(VALIDATOR_SYNC_MS);
  }
}

async function main(): Promise<void> {
  const chainId = hexToNumber(await rpc.call("eth_chainId"));
  if (chainId !== CHAIN_ID) throw new Error(`RPC serves chain ${chainId}, expected ${CHAIN_ID}`);

  await db.insert(syncState).values({ id: 1, chainId }).onConflictDoNothing();
  // Resume from the newest stored block so a restart refills the downtime
  // instead of jumping to the tip and leaving a hole for backfill to find.
  const { rows } = await pool.query<{ n: string | null }>(`select max(number) as n from blocks`);
  head = rows[0]?.n ? Number(rows[0].n) : null;
  log("indexer starting", { chainId, resumeFrom: head, rpc: rpc.active, backfillDepth: process.env.BACKFILL_DEPTH ?? 30_000, retainHours: RETAIN_HOURS });

  const progress = setInterval(() => {
    log("progress", { head, finalized, lag: head === null ? null : finalized - head, ...stats });
    stats.live = stats.backfilled = stats.txs = 0;
  }, 30_000);

  const ctx: Ctx = { db, pool, rpc, log, stopping: () => stopping, head: () => head, finalized: () => finalized };
  await Promise.all([follow(), backfill(), retention(), resolveTokens(), validatorLoop(), traceLoop(ctx, backfillFloor), pipelineLoop(ctx), historyLoop(ctx), rollupLoop(ctx)]);
  clearInterval(progress);
}

const shutdown = (sig: string) => {
  log("shutting down", { sig });
  stopping = true;
  setTimeout(() => void pool.end().finally(() => process.exit(0)), 3_000).unref();
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main().catch((err) => {
  log("fatal", { err: (err as Error).message });
  process.exit(1);
});
