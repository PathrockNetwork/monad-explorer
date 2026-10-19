/**
 * Trace loop: for every TRACE_EVERY-th indexed block, fetch call and
 * prestate traces, persist internal transactions and the block's dependency
 * graph, and replay each transaction's gas with eth_estimateGas.
 *
 * Cost per traced block is one 4-call batch plus one call per transaction for
 * the gas replay, so on the public endpoints this samples (default every 10th
 * block). With a private RPC set TRACE_EVERY=1 to cover the whole chain.
 */
import { blockTraces, estimateTxGas, fetchBlockTrace, internalTxs, type BlockTrace } from "@monad-explorer/core";
import { sql } from "drizzle-orm";
import { caughtUp, sleep, type Ctx } from "./context";

/** Trace every Nth block; 0 disables tracing. */
const TRACE_EVERY = Number(process.env.TRACE_EVERY ?? 10);
const ESTIMATE_GAS = process.env.ESTIMATE_GAS !== "0";
/** Gas replays in flight per block. */
const ESTIMATE_CONCURRENCY = Number(process.env.ESTIMATE_CONCURRENCY ?? 4);
/** How far behind head the cheap "recent" scan looks, in traced blocks. */
const RECENT_SPAN = 300;
const FULL_SCAN_MS = 60_000;

const chunk = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** Blocks whose trace failed this many times are skipped until restart. */
const MAX_FAILURES = 3;
const failures = new Map<number, number>();
const skipped = () => [...failures].filter(([, f]) => f >= MAX_FAILURES).map(([n]) => n);

/** Indexed, untraced multiples of TRACE_EVERY in [lo, hi], newest first. */
async function untraced(ctx: Ctx, lo: number, hi: number, limit: number): Promise<number[]> {
  const top = hi - (hi % TRACE_EVERY);
  if (top < lo) return [];
  const { rows } = await ctx.pool.query<{ n: string }>(
    `select n from generate_series($1::bigint, $2::bigint, $3::bigint) n
     where exists (select 1 from blocks b where b.number = n)
       and not exists (select 1 from block_traces t where t.block_number = n)
       and n <> all($5::bigint[])
     limit $4`,
    [top, lo, -TRACE_EVERY, limit, skipped()],
  );
  return rows.map((r) => Number(r.n));
}

async function estimates(ctx: Ctx, t: BlockTrace): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!ESTIMATE_GAS || t.number === 0) return out;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(ESTIMATE_CONCURRENCY, t.rawTxs.length) }, async () => {
      while (next < t.rawTxs.length && !ctx.stopping()) {
        const tx = t.rawTxs[next++];
        const est = await estimateTxGas(ctx.rpc, tx, t.number - 1);
        if (est !== null) out.set(String(tx.hash).toLowerCase(), est);
      }
    }),
  );
  return out;
}

async function traceOne(ctx: Ctx, n: number): Promise<void> {
  const t = await fetchBlockTrace(ctx.rpc, n);
  const gas = await estimates(ctx, t);
  const g = t.graph;
  await ctx.db.transaction(async (tx) => {
    for (const rows of chunk(t.internal, 1000)) await tx.insert(internalTxs).values(rows).onConflictDoNothing();
    const vals = t.txs.map((x) => ({ hash: x.hash, calls: x.callCount, depth: x.callDepth, est: gas.get(x.hash) ?? null }));
    if (vals.length) {
      await tx.execute(sql`
        update transactions t set call_count = v.calls, call_depth = v.depth, gas_estimate = v.est
        from jsonb_to_recordset(${JSON.stringify(vals)}::jsonb) as v(hash text, calls int, depth smallint, est bigint)
        where t.hash = v.hash`);
    }
    await tx
      .insert(blockTraces)
      .values({
        blockNumber: n,
        time: t.time,
        txCount: g.txCount,
        dependentTxs: g.dependentTxs,
        edges: g.edgeCount,
        criticalPath: g.criticalPath,
        parallelism: g.parallelism,
        internalTxs: t.internal.length,
        levels: g.levels,
        edgeList: g.edges,
        hot: g.hot,
      })
      .onConflictDoNothing();
  });
}

export async function traceLoop(ctx: Ctx, floor: () => Promise<number>): Promise<void> {
  if (TRACE_EVERY <= 0) {
    ctx.log("tracing disabled (TRACE_EVERY=0)");
    return;
  }
  let lastFull = 0;
  let traced = 0;
  let lastLog = Date.now();
  while (!ctx.stopping()) {
    try {
      const head = ctx.head();
      if (head === null || !caughtUp(ctx)) {
        await sleep(1_000);
        continue;
      }
      // Newest blocks first so the live views fill in; the whole window only
      // once a minute, since scanning it costs an index probe per candidate.
      let todo = await untraced(ctx, Math.max(0, head - RECENT_SPAN * TRACE_EVERY), head, 4);
      if (!todo.length && Date.now() - lastFull > FULL_SCAN_MS) {
        lastFull = Date.now();
        todo = await untraced(ctx, await floor(), head, 4);
      }
      if (!todo.length) {
        await sleep(Math.max(500, TRACE_EVERY * 200));
        continue;
      }
      for (const n of todo) {
        if (ctx.stopping()) break;
        try {
          await traceOne(ctx, n);
          failures.delete(n);
          traced++;
        } catch (err) {
          failures.set(n, (failures.get(n) ?? 0) + 1);
          ctx.log("trace error", { block: n, attempt: failures.get(n), err: (err as Error).message });
          await sleep(2_000);
        }
      }
      if (Date.now() - lastLog > 60_000) {
        ctx.log("traces", { traced, every: TRACE_EVERY });
        traced = 0;
        lastLog = Date.now();
      }
    } catch (err) {
      ctx.log("trace loop error", { err: (err as Error).message });
      await sleep(5_000);
    }
  }
}
