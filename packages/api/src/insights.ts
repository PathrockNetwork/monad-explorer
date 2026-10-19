/**
 * Monad-specific views: what this explorer shows that a generic EVM explorer
 * does not.
 *
 *  - transaction traces: call tree, internal transfers, state changes, and
 *    the gas a sender paid for but never used (Monad charges the gas limit);
 *  - block parallelism: the dependency graph between a block's transactions;
 *  - gas overpayment and chain usage leaderboards;
 *  - staking: delegation flows, measured reward rates, delegator positions;
 *  - the MonadBFT pipeline: per-block commit-stage latencies, abandoned
 *    proposals, and a live server-sent-event stream.
 *
 * Indexed (sampled) data is used where it exists; single-object views fall
 * back to on-demand RPC tracing, cached, so any transaction or block can be
 * inspected regardless of sampling.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type pg from "pg";
import {
  JsonRpc,
  STAKING_PRECOMPILE,
  callTree,
  estimateTxGas,
  fetchBlockTrace,
  getDelegations,
  hexToBig,
  hexToNumber,
  isAddress,
  isHash,
  summarizeCalls,
  type CallFrame,
} from "@monad-explorer/core";

const TRACE_EVERY = Number(process.env.TRACE_EVERY ?? 10);
const RETAIN_HOURS = Number(process.env.RETAIN_HOURS ?? 72);
/** Hours a windowed view may ask for: capped by retention (0 = unlimited, then a week). */
const MAX_HOURS = RETAIN_HOURS > 0 ? RETAIN_HOURS : 168;
const hoursOf = (q: any, def: number, max = MAX_HOURS) => Math.min(max, Math.max(1, Number(q?.hours) || def));

/** TTL + size-bounded cache for on-demand traces (insertion-ordered eviction). */
function lru<T>(max: number, ttlMs: number) {
  const m = new Map<string, { at: number; p: Promise<T> }>();
  return (key: string, fn: () => Promise<T>): Promise<T> => {
    const hit = m.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.p;
    const p = fn().catch((e) => {
      m.delete(key);
      throw e;
    });
    m.set(key, { at: Date.now(), p });
    if (m.size > max) m.delete(m.keys().next().value!);
    return p;
  };
}

function memoBy<T>(ttlMs: number, fn: (key: string) => Promise<T>): (key: string) => Promise<T> {
  const cache = lru<T>(64, ttlMs);
  return (key) => cache(key, () => fn(key));
}

const bad = (reply: FastifyReply, msg: string) => reply.code(400).send({ error: msg });
/** First block inside the last $1 hours (blocks.time is indexed; transactions.time is not). */
const SINCE_BLOCK = `(select coalesce(min(number), 0) from blocks where time > now() - make_interval(hours => $1))`;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

type Label = { name: string; kind: "token" | "validator" | "system" };

export type RewardRates = {
  hours: number;
  coverage: number;
  blocks: number;
  network_apr: number | null;
  total_rewards: string;
  validators: { id: number; blocks: number; rewards: string; apr: number | null; delegator_apr: number | null }[];
};

export function registerInsightRoutes(app: FastifyInstance, { pool, rpc }: { pool: pg.Pool; rpc: JsonRpc }) {
  const q = <T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []) => pool.query<T>(text, params);

  /** Human names for addresses we know: tokens, validator addresses, the staking precompile. */
  const labels = async (addresses: (string | null)[]): Promise<Record<string, Label>> => {
    const list = [...new Set(addresses.filter((a): a is string => !!a))];
    if (!list.length) return {};
    const out: Record<string, Label> = {};
    if (list.includes(STAKING_PRECOMPILE)) out[STAKING_PRECOMPILE] = { name: "Staking precompile", kind: "system" };
    const [toks, vals] = await Promise.all([
      q(`select address, coalesce(symbol, name) as name from tokens where address = any($1) and coalesce(symbol, name) is not null`, [list]),
      q(
        `select auth_address, beneficiary, coalesce(name, 'Validator #' || id) as name from validators
         where auth_address = any($1) or beneficiary = any($1)`,
        [list],
      ),
    ]);
    for (const t of toks.rows) out[t.address] = { name: t.name, kind: "token" };
    for (const v of vals.rows) {
      if (list.includes(v.auth_address)) out[v.auth_address] = { name: v.name, kind: "validator" };
      if (v.beneficiary && list.includes(v.beneficiary)) out[v.beneficiary] = { name: `${v.name} (beneficiary)`, kind: "validator" };
    }
    return out;
  };

  /* ───────────────────────── transaction trace ───────────────────────── */

  const txTraces = lru<any>(500, 10 * 60_000);

  /**
   * Call tree, internal transfers, state diff and gas analysis for one
   * transaction. Two debug calls plus, when the indexer has not replayed its
   * gas, one eth_estimateGas.
   */
  app.get("/api/v1/txs/:hash/trace", async (req, reply) => {
    const hash = String((req.params as any).hash).toLowerCase();
    if (!isHash(hash)) return bad(reply, "invalid transaction hash");
    return txTraces(hash, async () => {
      const [tx, calls, diff] = await rpc.batch<any>([
        { method: "eth_getTransactionByHash", params: [hash] },
        { method: "debug_traceTransaction", params: [hash, { tracer: "callTracer" }] },
        { method: "debug_traceTransaction", params: [hash, { tracer: "prestateTracer", tracerConfig: { diffMode: true } }] },
      ]);
      if (!tx || !tx.blockNumber) {
        const e: any = new Error("transaction not found or pending");
        e.statusCode = 404;
        throw e;
      }
      const block = hexToNumber(tx.blockNumber);
      const time = new Date();
      const root = calls as CallFrame;
      const summary = summarizeCalls(hash, block, time, root);
      const { tree, frames, truncated } = callTree(root, 400);

      // Gas: indexed replay when we have it, otherwise replay now.
      const limit = hexToNumber(tx.gas);
      const indexed = await q(`select gas_estimate, effective_gas_price from transactions where hash = $1`, [hash]);
      let estimate: number | null = num(indexed.rows[0]?.gas_estimate);
      let source: "indexed" | "replayed" | null = estimate !== null ? "indexed" : null;
      if (estimate === null) {
        estimate = await estimateTxGas(rpc, tx, block - 1);
        if (estimate !== null) source = "replayed";
      }
      let price = indexed.rows[0]?.effective_gas_price ? BigInt(indexed.rows[0].effective_gas_price) : null;
      if (price === null) {
        const rc = await rpc.call<any>("eth_getTransactionReceipt", [hash]);
        price = rc ? hexToBig(rc.effectiveGasPrice ?? tx.gasPrice) : null;
      }
      const unused = estimate !== null && limit > 0 ? Math.max(0, limit - estimate) : null;

      // State changes, trimmed: balances and nonces per account, storage slot counts and a sample.
      const pre = diff?.pre ?? {};
      const post = diff?.post ?? {};
      const accounts = [...new Set([...Object.keys(pre), ...Object.keys(post)])].map((a) => {
        const p = pre[a] ?? {};
        const n = post[a] ?? {};
        const slots = [...new Set([...Object.keys(p.storage ?? {}), ...Object.keys(n.storage ?? {})])];
        return {
          address: a.toLowerCase(),
          balance_before: p.balance !== undefined ? hexToBig(p.balance).toString() : null,
          balance_after: n.balance !== undefined ? hexToBig(n.balance).toString() : null,
          nonce_before: p.nonce ?? null,
          nonce_after: n.nonce ?? null,
          code_changed: n.code !== undefined,
          created: !pre[a],
          destroyed: !post[a],
          storage_changes: slots.length,
          storage: slots.slice(0, 12).map((s) => ({ slot: s, before: p.storage?.[s] ?? null, after: n.storage?.[s] ?? null })),
        };
      });
      const names = await labels([...accounts.map((a) => a.address), ...summary.internal.flatMap((i) => [i.from, i.to])]);

      return {
        hash,
        block_number: block,
        call_count: summary.callCount,
        call_depth: summary.callDepth,
        frames,
        truncated,
        tree,
        internal: summary.internal.map((i) => ({ idx: i.idx, depth: i.depth, type: i.callType, from: i.from, to: i.to, value: i.value, error: i.error })),
        gas: {
          limit,
          estimate,
          unused,
          unused_fee: unused !== null && price !== null ? (BigInt(unused) * price).toString() : null,
          efficiency: estimate !== null && limit > 0 ? Math.min(1, estimate / limit) : null,
          price: price?.toString() ?? null,
          source,
          system: limit === 0,
        },
        state: accounts,
        labels: names,
      };
    }).catch((e) => {
      if (e.statusCode === 404) return reply.code(404).send({ error: e.message });
      throw e;
    });
  });

  /* ───────────────────────── block parallelism ───────────────────────── */

  const blockGraphs = lru<any>(200, 30 * 60_000);

  app.get("/api/v1/blocks/:n/parallelism", async (req, reply) => {
    const n = Number((req.params as any).n);
    if (!Number.isInteger(n) || n < 1) return bad(reply, "block number must be a positive integer");
    return blockGraphs(String(n), async () => {
      const stored = await q(`select * from block_traces where block_number = $1`, [n]);
      let g: any;
      let txs: { index: number; hash: string; from: string; to: string | null; method: string | null; gas_limit: number }[];
      if (stored.rows[0]) {
        const r = stored.rows[0];
        g = {
          source: "indexed",
          tx_count: r.tx_count,
          dependent_txs: r.dependent_txs,
          edges: r.edges,
          critical_path: r.critical_path,
          parallelism: r.parallelism,
          internal_txs: r.internal_txs,
          levels: r.levels,
          edge_list: r.edge_list,
          hot: r.hot,
          time: r.time,
        };
        const t = await q(`select tx_index, hash, "from", "to", method, gas_limit from transactions where block_number = $1 order by tx_index`, [n]);
        txs = t.rows.map((x) => ({ index: x.tx_index, hash: x.hash, from: x.from, to: x.to, method: x.method, gas_limit: Number(x.gas_limit) }));
      } else {
        const t = await fetchBlockTrace(rpc, n);
        g = {
          source: "traced",
          tx_count: t.graph.txCount,
          dependent_txs: t.graph.dependentTxs,
          edges: t.graph.edgeCount,
          critical_path: t.graph.criticalPath,
          parallelism: t.graph.parallelism,
          internal_txs: t.internal.length,
          levels: t.graph.levels,
          edge_list: t.graph.edges,
          hot: t.graph.hot,
          time: t.time,
        };
        txs = t.rawTxs.map((x: any) => ({
          index: hexToNumber(x.transactionIndex),
          hash: String(x.hash).toLowerCase(),
          from: String(x.from).toLowerCase(),
          to: x.to ? String(x.to).toLowerCase() : null,
          method: x.input && x.input.length >= 10 ? String(x.input).slice(0, 10).toLowerCase() : null,
          gas_limit: hexToNumber(x.gas),
        }));
      }
      const names = await labels([...g.hot.map((h: any) => h.address), ...txs.map((t) => t.to)]);
      return { block_number: n, ...g, edges_capped: g.edge_list.length < g.edges, txs: txs.map((t, i) => ({ ...t, level: g.levels[i] ?? 0 })), labels: names };
    }).catch((e) => {
      if (/not available/.test(String(e?.message))) return reply.code(404).send({ error: "block not found" });
      throw e;
    });
  });

  /** Parallelism over time from the traced sample, plus the most contended contracts. */
  const parallelism = memoBy(30_000, async (key) => {
    const hours = Number(key);
    const bucketSecs = hours <= 1 ? 60 : hours <= 6 ? 300 : hours <= 24 ? 900 : 3600;
    const [series, totals, hist, hot, extremes] = await Promise.all([
      q(
        `select to_timestamp(floor(extract(epoch from time) / $2) * $2) as t, count(*)::int as blocks,
                avg(parallelism)::float8 as parallelism, avg(critical_path)::float8 as critical_path,
                sum(dependent_txs)::float8 / nullif(sum(tx_count), 0) as dependent_share, avg(tx_count)::float8 as txs
         from block_traces where time > now() - make_interval(hours => $1) group by 1 order by 1`,
        [hours, bucketSecs],
      ),
      q(
        `select count(*)::int as traced, avg(parallelism)::float8 as parallelism,
                percentile_cont(0.5) within group (order by parallelism)::float8 as median,
                avg(critical_path)::float8 as critical_path,
                sum(dependent_txs)::float8 / nullif(sum(tx_count), 0) as dependent_share,
                sum(internal_txs)::bigint as internal_txs, min(time) as first_traced,
                (select count(*)::int from blocks where time > now() - make_interval(hours => $1)) as blocks
         from block_traces where time > now() - make_interval(hours => $1)`,
        [hours],
      ),
      q(
        `select least(critical_path, 12) as path, count(*)::int as n from block_traces
         where time > now() - make_interval(hours => $1) group by 1 order by 1`,
        [hours],
      ),
      q(
        `select h->>'address' as address, sum((h->>'edges')::int)::int as edges, count(*)::int as blocks
         from block_traces, jsonb_array_elements(hot) h
         where time > now() - make_interval(hours => $1) group by 1 order by edges desc limit 15`,
        [hours],
      ),
      q(
        `(select block_number, tx_count, critical_path, parallelism, 'serial' as kind from block_traces
          where time > now() - make_interval(hours => $1) and tx_count >= 5 order by critical_path::float8 / tx_count desc, tx_count desc limit 5)
         union all
         (select block_number, tx_count, critical_path, parallelism, 'parallel' from block_traces
          where time > now() - make_interval(hours => $1) order by parallelism desc, tx_count desc limit 5)`,
        [hours],
      ),
    ]);
    const t = totals.rows[0] ?? {};
    const names = await labels(hot.rows.map((h) => h.address));
    return {
      hours,
      bucket_secs: bucketSecs,
      trace_every: TRACE_EVERY,
      totals: {
        traced_blocks: t.traced ?? 0,
        blocks: t.blocks ?? 0,
        parallelism: t.parallelism ?? null,
        median_parallelism: t.median ?? null,
        critical_path: t.critical_path ?? null,
        dependent_share: t.dependent_share ?? null,
        internal_txs: Number(t.internal_txs ?? 0),
        first_traced: t.first_traced ?? null,
      },
      series: series.rows,
      critical_path_histogram: hist.rows,
      hot: hot.rows.map((h) => ({ ...h, label: names[h.address] ?? null })),
      extremes: extremes.rows.map((r) => ({ ...r, block_number: Number(r.block_number) })),
    };
  });

  app.get("/api/v1/parallelism", async (req) => parallelism(String(hoursOf(req.query, 6))));

  /* ───────────────────────── gas overpayment ───────────────────────── */

  /**
   * Unused gas = gas limit − replayed estimate, priced at what the sender
   * paid. Only replayed (sampled) transactions count; `extrapolated` scales
   * by the sampling rate and is labelled as such.
   */
  const gas = memoBy(60_000, async (key) => {
    const hours = Number(key);
    const UNUSED = `greatest(gas_limit - gas_estimate, 0)`;
    // Block range rather than time: transactions has no time index.
    const where = `gas_estimate is not null and gas_limit > 0 and block_number >= ${SINCE_BLOCK}`;
    const [totals, byContract, bySender, dist, series] = await Promise.all([
      q(
        `select count(*)::int as txs, sum(gas_limit)::float8 as gas_paid, sum(least(gas_estimate, gas_limit))::float8 as gas_needed,
                sum(${UNUSED})::float8 as gas_unused, coalesce(sum(${UNUSED} * effective_gas_price), 0)::text as unused_fee,
                coalesce(sum(fee), 0)::text as fees,
                (select coalesce(sum(tx_count), 0)::int from blocks where time > now() - make_interval(hours => $1)) as all_txs,
                min(block_number) as first_block, min(time) as sample_since,
                -- Transactions in the span the sample actually covers: the base for extrapolation.
                (select coalesce(sum(tx_count), 0)::int from blocks
                  where number >= (select min(block_number) from transactions where ${where})) as period_txs
         from transactions where ${where}`,
        [hours],
      ),
      q(
        `select "to" as address, count(*)::int as txs, avg(gas_limit)::float8 as avg_limit, avg(least(gas_estimate, gas_limit))::float8 as avg_needed,
                sum(${UNUSED} * effective_gas_price)::text as unused_fee, count(distinct "from")::int as senders,
                sum(least(gas_estimate, gas_limit))::float8 / nullif(sum(gas_limit), 0)::float8 as efficiency
         from transactions where ${where} and "to" is not null
         group by 1 having count(*) >= 3 order by sum(${UNUSED} * effective_gas_price) desc limit 20`,
        [hours],
      ),
      q(
        `select "from" as address, count(*)::int as txs, sum(${UNUSED} * effective_gas_price)::text as unused_fee,
                sum(least(gas_estimate, gas_limit))::float8 / nullif(sum(gas_limit), 0)::float8 as efficiency
         from transactions where ${where} group by 1 order by sum(${UNUSED} * effective_gas_price) desc limit 20`,
        [hours],
      ),
      q(
        `select least(floor(least(gas_estimate, gas_limit)::float8 / gas_limit * 10), 9)::int as bucket, count(*)::int as n
         from transactions where ${where} group by 1 order by 1`,
        [hours],
      ),
      q(
        `select to_timestamp(floor(extract(epoch from time) / $2) * $2) as t, count(*)::int as txs,
                sum(least(gas_estimate, gas_limit))::float8 / nullif(sum(gas_limit), 0)::float8 as efficiency,
                sum(${UNUSED} * effective_gas_price)::text as unused_fee
         from transactions where ${where} group by 1 order by 1`,
        [hours, hours <= 1 ? 60 : hours <= 6 ? 300 : hours <= 24 ? 900 : 3600],
      ),
    ]);
    const t = totals.rows[0] ?? {};
    const names = await labels([...byContract.rows.map((r) => r.address), ...bySender.rows.map((r) => r.address)]);
    // Scale only over the period the sample covers; replay may have started mid-window.
    const scale = Math.max(1, (t.period_txs ?? 0) / Math.max(1, t.txs ?? 0));
    return {
      hours,
      trace_every: TRACE_EVERY,
      totals: {
        sampled_txs: t.txs ?? 0,
        all_txs: t.all_txs ?? 0,
        gas_paid: t.gas_paid ?? 0,
        gas_needed: t.gas_needed ?? 0,
        gas_unused: t.gas_unused ?? 0,
        unused_fee: t.unused_fee ?? "0",
        fees: t.fees ?? "0",
        efficiency: t.gas_paid ? t.gas_needed / t.gas_paid : null,
        /** First replayed transaction in the window; extrapolation covers [sample_since, now]. */
        sample_since: t.sample_since ?? null,
        period_txs: t.period_txs ?? 0,
        /** unused_fee scaled from the sample to every transaction since sample_since. */
        extrapolated_unused_fee: t.unused_fee ? ((BigInt(t.unused_fee) * BigInt(Math.round(scale * 1000))) / 1000n).toString() : "0",
      },
      by_contract: byContract.rows.map((r) => ({ ...r, label: names[r.address] ?? null })),
      by_sender: bySender.rows.map((r) => ({ ...r, label: names[r.address] ?? null })),
      efficiency_histogram: dist.rows,
      series: series.rows,
    };
  });

  app.get("/api/v1/gas", async (req) => gas(String(hoursOf(req.query, 24))));

  /* ───────────────────────── chain usage ───────────────────────── */

  /**
   * Who uses the chain, from the hourly rollup: whole hours, so "last 24h"
   * means the last 24 started hours including the current partial one.
   */
  const usage = memoBy(60_000, async (key) => {
    const hours = Number(key);
    const SINCE_HOUR = `date_trunc('hour', now()) - make_interval(hours => $1 - 1)`;
    const [top, totals, fees] = await Promise.all([
      q(
        `select address, sum(txs)::int as txs, sum(gas)::float8 as gas, sum(fees)::text as fees,
                1 - sum(failed)::float8 / nullif(sum(txs), 0) as success
         from usage_hourly where hour >= ${SINCE_HOUR} and address <> ''
         group by 1 order by gas desc limit 25`,
        [hours],
      ),
      q(
        `select coalesce(sum(txs), 0)::int as txs, coalesce(sum(gas), 0)::float8 as gas, count(distinct address)::int as contracts,
                coalesce(sum(fees), 0)::text as fees, 1 - sum(failed)::float8 / nullif(sum(txs), 0) as success,
                coalesce(sum(txs) filter (where address = ''), 0)::int as creations, min(hour) as since
         from usage_hourly where hour >= ${SINCE_HOUR}`,
        [hours],
      ),
      q(
        `select to_timestamp(floor(extract(epoch from time) / $2) * $2) as t,
                avg(base_fee_per_gas)::float8 as base_fee, sum(gas_used)::float8 / nullif(sum(gas_limit), 0)::float8 as fullness,
                max(gas_used::float8 / nullif(gas_limit, 0))::float8 as max_fullness
         from blocks where time > now() - make_interval(hours => $1) group by 1 order by 1`,
        [hours, hours <= 1 ? 60 : hours <= 6 ? 300 : 900],
      ),
    ]);
    const t = totals.rows[0] ?? {};
    const names = await labels(top.rows.map((r) => r.address));
    return {
      hours,
      totals: t,
      contracts: top.rows.map((r) => ({ ...r, share: t.gas ? r.gas / t.gas : null, label: names[r.address] ?? null })),
      fee_series: fees.rows,
    };
  });

  app.get("/api/v1/usage", async (req) => usage(String(hoursOf(req.query, 24))));

  /* ───────────────────────── address extras ───────────────────────── */

  app.get("/api/v1/address/:addr/internal", async (req, reply) => {
    const addr = String((req.params as any).addr).toLowerCase();
    if (!isAddress(addr)) return bad(reply, "invalid address");
    // Cursor "block:tx_hash:idx" of the previous page's last row (a bare block number also works).
    const [b, h, i] = String((req.query as any).before ?? "").split(":");
    const params: unknown[] = [addr];
    let cursor = "";
    if (b && /^\d+$/.test(b)) {
      if (h && isHash(h) && /^\d+$/.test(i ?? "")) {
        params.push(Number(b), h.toLowerCase(), Number(i));
        cursor = `and (block_number, tx_hash, idx) < ($2, $3, $4)`;
      } else {
        params.push(Number(b));
        cursor = `and block_number < $2`;
      }
    }
    const order = `order by block_number desc, tx_hash desc, idx desc`;
    const { rows } = await q(
      `(select * from internal_txs where "from" = $1 ${cursor} ${order} limit 50)
       union (select * from internal_txs where "to" = $1 ${cursor} ${order} limit 50)
       ${order} limit 50`,
      params,
    );
    const names = await labels(rows.flatMap((r) => [r.from, r.to]));
    return {
      trace_every: TRACE_EVERY,
      internal: rows.map((r) => ({ ...r, block_number: Number(r.block_number), gas_used: num(r.gas_used) })),
      labels: names,
    };
  });

  /** Gas this address overpaid as a sender, over the replayed sample. */
  app.get("/api/v1/address/:addr/gas", async (req, reply) => {
    const addr = String((req.params as any).addr).toLowerCase();
    if (!isAddress(addr)) return bad(reply, "invalid address");
    const [mine, all] = await Promise.all([
      q(
        `select count(*)::int as txs, coalesce(sum(greatest(gas_limit - gas_estimate, 0) * effective_gas_price), 0)::text as unused_fee,
                coalesce(sum(fee), 0)::text as fees, sum(least(gas_estimate, gas_limit))::float8 / nullif(sum(gas_limit), 0)::float8 as efficiency
         from transactions where "from" = $1 and gas_estimate is not null and gas_limit > 0`,
        [addr],
      ),
      q(`select count(*)::int as txs from (select 1 from transactions where "from" = $1 limit 10000) c`, [addr]),
    ]);
    return { trace_every: TRACE_EVERY, sampled: mine.rows[0], sent_in_window: all.rows[0]?.txs ?? 0 };
  });

  /** Live delegations from the precompile, plus this address's staking history. */
  const delegations = lru<any>(500, 30_000);
  app.get("/api/v1/address/:addr/staking", async (req, reply) => {
    const addr = String((req.params as any).addr).toLowerCase();
    if (!isAddress(addr)) return bad(reply, "invalid address");
    const [positions, events] = await Promise.all([
      delegations(addr, () => getDelegations(rpc, addr)),
      q(
        `select e.*, v.name as validator_name from staking_events e left join validators v on v.id = e.validator_id
         where e.address = $1 order by e.block_number desc, e.log_index desc limit 100`,
        [addr],
      ),
    ]);
    const ids = positions.map((p: any) => p.validatorId);
    const vals = ids.length
      ? await q(`select id, name, logo, consensus_commission, commission, in_consensus_set from validators where id = any($1)`, [ids])
      : { rows: [] as any[] };
    const byId = new Map(vals.rows.map((v) => [v.id, v]));
    const rates = await rewardRates("24");
    const rateBy = new Map(rates.validators.map((r: any) => [r.id, r]));
    return {
      address: addr,
      delegations: positions.map((p: any) => ({
        ...p,
        validator_name: byId.get(p.validatorId)?.name ?? null,
        in_consensus_set: byId.get(p.validatorId)?.in_consensus_set ?? null,
        delegator_apr: rateBy.get(p.validatorId)?.delegator_apr ?? null,
      })),
      events: events.rows.map((e) => ({ ...e, block_number: Number(e.block_number), epoch: num(e.epoch) })),
    };
  });

  /* ───────────────────────── staking ───────────────────────── */

  /**
   * Measured reward rates: block rewards each validator's pool actually
   * received over the window (blocks.reward), annualised against the stake
   * in force. Delegators earn that net of commission. A short window over a
   * stake-weighted lottery is noisy for small validators; the sample size is
   * returned so the UI can say so.
   */
  const rewardRates = memoBy<RewardRates>(60_000, async (key) => {
    const hours = Number(key);
    const [rows, cover, state] = await Promise.all([
      q(
        `select proposer_id as id, count(*)::int as blocks, sum(reward)::text as rewards
         from blocks where time > now() - make_interval(hours => $1) and reward is not null and proposer_id is not null
         group by 1`,
        [hours],
      ),
      q(
        `select count(*)::int as blocks, count(reward)::int as with_reward, extract(epoch from max(time) - min(time))::float8 as span
         from blocks where time > now() - make_interval(hours => $1)`,
        [hours],
      ),
      q(`select epoch_delay_period from sync_state where id = 1`),
    ]);
    const inDelay = Boolean(state.rows[0]?.epoch_delay_period);
    const vals = await q(
      `select id, name, logo, in_consensus_set, ${inDelay ? "snapshot_stake" : "consensus_stake"} as stake,
              ${inDelay ? "coalesce(snapshot_commission, consensus_commission)" : "consensus_commission"} as commission
       from validators`,
    );
    const c = cover.rows[0] ?? {};
    const span = Number(c.span) || hours * 3600;
    // Rewards only count over blocks that have them; scale the year by that coverage.
    const coverage = c.blocks ? c.with_reward / c.blocks : 0;
    const yearFactor = coverage > 0 ? (365 * 86400) / (span * coverage) : 0;
    const by = new Map(rows.rows.map((r) => [r.id, r]));
    let totalRewards = 0n;
    let totalStake = 0n;
    const validators = vals.rows.map((v) => {
      const r = by.get(v.id);
      const rewards = r ? BigInt(r.rewards.split(".")[0]) : 0n;
      const stake = BigInt(String(v.stake ?? "0").split(".")[0]);
      if (v.in_consensus_set) {
        totalRewards += rewards;
        totalStake += stake;
      }
      const apr = stake > 0n ? (Number((rewards * 1_000_000n) / stake) / 1_000_000) * yearFactor : null;
      return {
        id: v.id,
        name: v.name,
        blocks: r?.blocks ?? 0,
        rewards: rewards.toString(),
        stake: stake.toString(),
        commission: v.commission,
        apr,
        delegator_apr: apr === null ? null : apr * (1 - Number(v.commission ?? 0)),
      };
    });
    const networkApr = totalStake > 0n ? (Number((totalRewards * 1_000_000n) / totalStake) / 1_000_000) * yearFactor : null;
    return { hours, coverage, blocks: c.blocks ?? 0, network_apr: networkApr, total_rewards: totalRewards.toString(), validators };
  });

  app.get("/api/v1/staking/rewards", async (req) => rewardRates(String(hoursOf(req.query, 24))));

  app.get("/api/v1/staking/events", async (req, reply) => {
    const query = req.query as any;
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 50));
    const params: unknown[] = [limit];
    const where: string[] = [];
    if (query.kind) {
      params.push(String(query.kind));
      where.push(`e.kind = $${params.length}`);
    }
    if (query.validator !== undefined) {
      const id = Number(query.validator);
      if (!Number.isInteger(id)) return bad(reply, "validator must be an integer");
      params.push(id);
      where.push(`e.validator_id = $${params.length}`);
    }
    if (query.before) {
      const [b, l] = String(query.before).split(":").map(Number);
      if (Number.isFinite(b)) where.push(`(e.block_number, e.log_index) < (${Math.trunc(b!)}, ${Math.trunc(l ?? 0)})`);
    }
    where.push(`e.kind <> 'epoch'`);
    const { rows } = await q(
      `select e.*, v.name as validator_name from staking_events e left join validators v on v.id = e.validator_id
       where ${where.join(" and ")} order by e.block_number desc, e.log_index desc limit $1`,
      params,
    );
    return { events: rows.map((e) => ({ ...e, block_number: Number(e.block_number), epoch: num(e.epoch) })) };
  });

  /** Delegation flows per validator and network-wide, plus history coverage. */
  const stakingSummary = memoBy(30_000, async (key) => {
    const hours = Number(key);
    const [flows, totals, coverage, kinds] = await Promise.all([
      q(
        `select e.validator_id as id, v.name,
                coalesce(sum(amount) filter (where kind = 'delegate'), 0)::text as delegated,
                coalesce(sum(amount) filter (where kind = 'undelegate'), 0)::text as undelegated,
                coalesce(sum(amount) filter (where kind = 'claim'), 0)::text as claimed,
                count(distinct address) filter (where kind in ('delegate', 'undelegate'))::int as delegators
         from staking_events e left join validators v on v.id = e.validator_id
         where e.time > now() - make_interval(hours => $1) and e.validator_id is not null
         group by 1, 2`,
        [hours],
      ),
      q(
        `select coalesce(sum(amount) filter (where kind = 'delegate'), 0)::text as delegated,
                coalesce(sum(amount) filter (where kind = 'undelegate'), 0)::text as undelegated,
                coalesce(sum(amount) filter (where kind = 'withdraw'), 0)::text as withdrawn,
                coalesce(sum(amount) filter (where kind = 'claim'), 0)::text as claimed,
                count(distinct address)::int as addresses, count(*)::int as events
         from staking_events where time > now() - make_interval(hours => $1)`,
        [hours],
      ),
      q(
        `select s.staking_history_floor as floor, (select min(time) from staking_events) as oldest_event,
                (select count(*)::int from staking_events) as events, (select min(number) from blocks) as indexed_from
         from sync_state s where id = 1`,
      ),
      q(
        `select kind, count(*)::int as n from staking_events where time > now() - make_interval(hours => $1) group by 1`,
        [hours],
      ),
    ]);
    const net = (r: any) => (BigInt(r.delegated.split(".")[0]) - BigInt(r.undelegated.split(".")[0])).toString();
    const c = coverage.rows[0] ?? {};
    return {
      hours,
      totals: { ...totals.rows[0], net: totals.rows[0] ? net(totals.rows[0]) : "0" },
      kinds: kinds.rows,
      flows: flows.rows
        .map((r) => ({ ...r, net: net(r) }))
        .sort((a, b) => {
          const d = BigInt(b.net) - BigInt(a.net);
          return d > 0n ? 1 : d < 0n ? -1 : 0;
        }),
      history: {
        scanned_from_block: num(c.floor) ?? num(c.indexed_from),
        oldest_event: c.oldest_event ?? null,
        events: c.events ?? 0,
      },
    };
  });

  app.get("/api/v1/staking", async (req) => stakingSummary(String(hoursOf(req.query, 24, 24 * 365))));

  /* ───────────────────────── MonadBFT pipeline ───────────────────────── */

  const STAGE_COLS = `block_id, number, hash, miner, proposer_id, gas_used, proposed_at, voted_at, finalized_at, verified_at`;
  const stageJson = (r: any) => ({
    ...r,
    number: Number(r.number),
    gas_used: num(r.gas_used),
    ms_to_vote: r.voted_at && r.proposed_at ? r.voted_at - r.proposed_at : null,
    ms_to_finalize: r.finalized_at && r.proposed_at ? r.finalized_at - r.proposed_at : null,
    ms_to_verify: r.verified_at && r.finalized_at ? r.verified_at - r.finalized_at : null,
  });

  /**
   * Stage latencies, recent blocks, and abandoned proposals: a proposal that
   * never finalized while another proposal at the same height did.
   */
  const pipeline = memoBy(2_000, async (key) => {
    const minutes = Number(key);
    const [recent, lat, abandoned, byProposer, heads] = await Promise.all([
      q(
        `select s.${STAGE_COLS.split(", ").join(", s.")}, v.name as proposer_name, v.logo is not null as proposer_logo
         from block_stages s left join validators v on v.id = s.proposer_id
         where s.number > (select max(number) - 40 from block_stages) order by s.number desc, s.proposed_at desc`,
      ),
      q(
        `select count(*)::int as blocks,
                percentile_cont(array[0.5, 0.95]) within group (order by extract(epoch from voted_at - proposed_at) * 1000) as vote,
                percentile_cont(array[0.5, 0.95]) within group (order by extract(epoch from finalized_at - voted_at) * 1000) as finalize,
                percentile_cont(array[0.5, 0.95]) within group (order by extract(epoch from finalized_at - proposed_at) * 1000) as total,
                percentile_cont(array[0.5, 0.95]) within group (order by extract(epoch from verified_at - finalized_at) * 1000) as verify
         from block_stages where proposed_at > now() - make_interval(mins => $1)
           and voted_at is not null and finalized_at is not null`,
        [minutes],
      ),
      q(
        `select s.block_id, s.number, s.miner, s.proposer_id, v.name as proposer_name, v.logo is not null as proposer_logo, s.proposed_at, s.voted_at
         from block_stages s left join validators v on v.id = s.proposer_id
         where s.finalized_at is null and s.proposed_at > now() - interval '24 hours' and s.proposed_at < now() - interval '10 seconds'
           and exists (select 1 from block_stages o where o.number = s.number and o.block_id <> s.block_id and o.finalized_at is not null)
         order by s.number desc limit 50`,
      ),
      q(
        `select s.proposer_id as id, v.name, count(*)::int as n
         from block_stages s left join validators v on v.id = s.proposer_id
         where s.finalized_at is null and s.proposed_at > now() - interval '24 hours' and s.proposed_at < now() - interval '10 seconds'
           and exists (select 1 from block_stages o where o.number = s.number and o.block_id <> s.block_id and o.finalized_at is not null)
         group by 1, 2 order by n desc limit 20`,
      ),
      q(
        `select max(number) filter (where proposed_at is not null) as proposed, max(number) filter (where voted_at is not null) as voted,
                max(number) filter (where finalized_at is not null) as finalized, max(number) filter (where verified_at is not null) as verified,
                count(*) filter (where proposed_at > now() - interval '24 hours')::int as observed_24h,
                min(proposed_at) as since
         from block_stages where number > (select max(number) - 5000 from block_stages) or proposed_at > now() - interval '24 hours'`,
      ),
    ]);
    const pct = (a: number[] | null) => (a ? { p50: Math.round(a[0]!), p95: Math.round(a[1]!) } : null);
    const l = lat.rows[0] ?? {};
    const h = heads.rows[0] ?? {};
    return {
      minutes,
      latency_ms: { blocks: l.blocks ?? 0, vote: pct(l.vote), finalize: pct(l.finalize), total: pct(l.total), verify: pct(l.verify) },
      heads: {
        proposed: num(h.proposed),
        voted: num(h.voted),
        finalized: num(h.finalized),
        verified: num(h.verified),
        /** Blocks finalized but not yet verified: how far execution trails consensus. */
        execution_lag: h.finalized && h.verified ? Number(h.finalized) - Number(h.verified) : null,
      },
      observed_24h: h.observed_24h ?? 0,
      observed_since: h.since ?? null,
      abandoned_24h: abandoned.rows.length,
      abandoned: abandoned.rows.map((r) => ({ ...r, number: Number(r.number) })),
      abandoned_by_proposer: byProposer.rows,
      recent: recent.rows.map(stageJson),
    };
  });

  app.get("/api/v1/pipeline", async (req) => {
    const minutes = Math.min(1440, Math.max(1, Number((req.query as any).minutes) || 10));
    return pipeline(String(minutes));
  });

  /**
   * Server-sent events: stage changes as they land. One shared poller feeds
   * every connected client and only runs while someone is listening.
   */
  const clients = new Set<(data: string) => void>();
  let poller: NodeJS.Timeout | null = null;
  const seen = new Map<string, string>();
  /** The last ~20 heights: enough for views that trail the head a little to see Verified land. */
  const streamRows = () =>
    q(
      `select s.${STAGE_COLS.split(", ").join(", s.")}, v.name as proposer_name, v.logo is not null as proposer_logo
       from block_stages s left join validators v on v.id = s.proposer_id
       where s.number > (select max(number) - 20 from block_stages) order by s.number`,
    );
  const poll = async () => {
    try {
      const { rows } = await streamRows();
      const changed = rows.map(stageJson).filter((r) => {
        const sig = `${+r.proposed_at || 0}|${+r.voted_at || 0}|${+r.finalized_at || 0}|${+r.verified_at || 0}`;
        if (seen.get(r.block_id) === sig) return false;
        seen.set(r.block_id, sig);
        return true;
      });
      if (seen.size > 400) for (const k of [...seen.keys()].slice(0, seen.size - 200)) seen.delete(k);
      if (changed.length) {
        const msg = `event: stages\ndata: ${JSON.stringify(changed)}\n\n`;
        for (const send of clients) send(msg);
      }
    } catch {
      /* transient DB error: the next tick retries */
    }
  };
  const MAX_STREAM_CLIENTS = Number(process.env.MAX_STREAM_CLIENTS ?? 200);
  app.get("/api/v1/stream", async (req, reply) => {
    if (clients.size >= MAX_STREAM_CLIENTS) return reply.code(503).send({ error: "too many live connections" });
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(`retry: 3000\n\n`);
    const send = (data: string) => res.write(data);
    // A new client gets the current rows at once instead of waiting for changes.
    streamRows()
      .then(({ rows }) => rows.length && send(`event: stages\ndata: ${JSON.stringify(rows.map(stageJson))}\n\n`))
      .catch(() => undefined);
    clients.add(send);
    if (!poller) poller = setInterval(poll, 400);
    const ping = setInterval(() => res.write(`: ping\n\n`), 15_000);
    req.raw.on("close", () => {
      clearInterval(ping);
      clients.delete(send);
      if (!clients.size && poller) {
        clearInterval(poller);
        poller = null;
        seen.clear();
      }
    });
  });

  return { rewardRates };
}
