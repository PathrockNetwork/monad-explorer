/**
 * Validator, analytics and network routes. Validators come from the staking
 * precompile mirror (`validators`); proposal activity is counted from indexed
 * blocks via blocks.proposer_id, so every count covers the indexed window.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type pg from "pg";
import { JsonRpc, hexToNumber, redactUrl, rpcUrlsFromEnv } from "@monad-explorer/core";
import type { RewardRates } from "./insights.js";

/** Same TTL memo as routes.ts, keyed so parameterised queries cache separately. */
function memoBy<T>(ttlMs: number, fn: (key: string) => Promise<T>): (key: string) => Promise<T> {
  const cache = new Map<string, { at: number; p: Promise<T> }>();
  return (key) => {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.p;
    const p = fn(key).catch((e) => {
      cache.delete(key);
      throw e;
    });
    cache.set(key, { at: Date.now(), p });
    return p;
  };
}

const RETAIN_HOURS = Number(process.env.RETAIN_HOURS ?? 72);
/** Full-history mode (RETAIN_HOURS=0) offers every horizon. */
const METRIC_HOURS = [1, 6, 24, 72].filter((h) => RETAIN_HOURS <= 0 || h <= RETAIN_HOURS);

export function registerNetworkRoutes(
  app: FastifyInstance,
  { pool, rpc, rewardRates }: { pool: pg.Pool; rpc: JsonRpc; rewardRates: () => Promise<RewardRates> },
): void {
  const q = <T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []) => pool.query<T>(text, params);
  const notFound = (reply: FastifyReply, msg: string) => reply.code(404).send({ error: msg });

  /**
   * All validators with stake, commission, set membership, registry identity
   * and proposal activity. `expected_*` is the validator's share of consensus
   * stake applied to the attributed block count — Monad's leader schedule is
   * stake-weighted, so observed ÷ expected well below 1 suggests missed
   * proposals. It is an estimate: stake shifts between epochs and small
   * samples are noisy, which the UI says alongside the number.
   */
  const validatorList = memoBy(10_000, async () => {
    const [vals, recent, sample, window, state, rates, abandoned] = await Promise.all([
      q(`select v.*, coalesce(w.n, 0)::int as proposed_window, w.last_block, w.last_time
         from validators v
         left join (select proposer_id, count(*) as n, max(number) as last_block, max(time) as last_time
                    from blocks where proposer_id is not null group by proposer_id) w on w.proposer_id = v.id`),
      q(`select proposer_id, count(*)::int as n from (select proposer_id from blocks order by number desc limit 1000) r
         where proposer_id is not null group by proposer_id`),
      // The ratio sample: the newest run of blocks that are ALL attributed
      // (capped at 50k). Older blocks are attributed only once each
      // validator's beneficiary is learned, so mixing them in would bias the
      // counts toward validators learned first.
      q(`with edge as (
           select greatest(coalesce(max(number) filter (where proposer_id is null), 0), max(number) - 50000) as lo from blocks
         )
         select proposer_id, count(*)::int as n, (select lo from edge) as lo
         from blocks where number > (select lo from edge) group by proposer_id`),
      q(`select count(*)::int as blocks, count(proposer_id)::int as attributed, min(time) as since from blocks`),
      q(`select epoch, epoch_delay_period, validators_synced_at from sync_state where id = 1`),
      rewardRates().catch(() => null),
      // Proposals that never finalized while a competing one at the same height did.
      q(`select s.proposer_id, count(*)::int as n from block_stages s
         where s.finalized_at is null and s.proposer_id is not null
           and s.proposed_at > now() - interval '24 hours' and s.proposed_at < now() - interval '10 seconds'
           and exists (select 1 from block_stages o where o.number = s.number and o.block_id <> s.block_id and o.finalized_at is not null)
         group by 1`),
    ]);
    const rateBy = new Map((rates?.validators ?? []).map((r) => [r.id, r]));
    const abandonedBy = new Map(abandoned.rows.map((r) => [r.proposer_id, r.n]));
    const recentBy = new Map(recent.rows.map((r) => [r.proposer_id, r.n]));
    const recentTotal = recent.rows.reduce((a, r) => a + r.n, 0);
    const s = state.rows[0] ?? {};
    // Raw precompile views mean different things inside and outside the epoch
    // delay period; resolve them once here into "this epoch" and "next epoch".
    const inDelay = Boolean(s.epoch_delay_period);
    const active = (v: any) => (inDelay ? { stake: v.snapshot_stake, commission: v.snapshot_commission ?? v.consensus_commission } : { stake: v.consensus_stake, commission: v.consensus_commission });
    const next = (v: any) => (inDelay ? { stake: v.consensus_stake, commission: v.consensus_commission } : { stake: v.stake, commission: v.commission });
    const totalConsensus = vals.rows.filter((v) => v.in_consensus_set).reduce((a, v) => a + BigInt(active(v).stake), 0n);
    const attributed: number = window.rows[0]?.attributed ?? 0;
    const sampleBy = new Map(sample.rows.map((r) => [r.proposer_id, r.n]));
    const sampleBlocks = sample.rows.reduce((a, r) => a + r.n, 0);
    const sampleFrom = sample.rows[0]?.lo ? Number(sample.rows[0].lo) + 1 : null;
    const rows = vals.rows
      .map((v) => {
        const share = v.in_consensus_set && totalConsensus > 0n ? Number((BigInt(active(v).stake) * 1_000_000n) / totalConsensus) / 1_000_000 : 0;
        const expected = share * sampleBlocks;
        const observed = sampleBy.get(v.id) ?? 0;
        return {
          id: v.id,
          name: v.name,
          logo: v.logo,
          website: v.website,
          description: v.description,
          x: v.x,
          vdp: v.vdp,
          decommissioned: v.decommissioned,
          registered: v.registry_synced_at !== null && v.name !== null,
          auth_address: v.auth_address,
          beneficiary: v.beneficiary,
          secp: v.secp,
          flags: Number(v.flags),
          stake: v.stake,
          consensus_stake: v.consensus_stake,
          snapshot_stake: v.snapshot_stake,
          commission: v.commission,
          consensus_commission: v.consensus_commission,
          unclaimed_rewards: v.unclaimed_rewards,
          /** Stake and commission in force this epoch, and what takes effect next epoch. */
          active_stake: active(v).stake,
          active_commission: active(v).commission,
          next_stake: next(v).stake,
          next_commission: next(v).commission,
          in_consensus_set: v.in_consensus_set,
          in_execution_set: v.in_execution_set,
          stake_share: share,
          proposed_1000: recentBy.get(v.id) ?? 0,
          proposed_window: v.proposed_window,
          proposed_sample: observed,
          expected_sample: Number(expected.toFixed(1)),
          // Below ~5 expected proposals the ratio is noise; report null instead.
          proposal_ratio: expected >= 5 ? Number((observed / expected).toFixed(3)) : null,
          last_proposed_block: v.last_block ? Number(v.last_block) : null,
          last_proposed_time: v.last_time ?? null,
          /** Measured from block rewards over 24h, annualised; see insights.ts rewardRates. */
          rewards_24h: rateBy.get(v.id)?.rewards ?? "0",
          /** Blocks behind rewards_24h: the sample size of reward_apr. */
          reward_blocks_24h: rateBy.get(v.id)?.blocks ?? 0,
          reward_apr: rateBy.get(v.id)?.apr ?? null,
          delegator_apr: rateBy.get(v.id)?.delegator_apr ?? null,
          abandoned_24h: abandonedBy.get(v.id) ?? 0,
          synced_at: v.synced_at,
        };
      })
      .sort((a, b) => (BigInt(b.active_stake || "0") > BigInt(a.active_stake || "0") ? 1 : -1))
      .map((v, i) => ({ rank: i + 1, ...v }));
    return {
      epoch: s.epoch ? Number(s.epoch) : null,
      epoch_delay_period: s.epoch_delay_period ?? null,
      synced_at: s.validators_synced_at ?? null,
      total_consensus_stake: totalConsensus.toString(),
      window: {
        since: window.rows[0]?.since ?? null,
        blocks: window.rows[0]?.blocks ?? 0,
        attributed,
        recent_blocks: recentTotal,
      },
      ratio_sample: { from_block: sampleFrom, blocks: sampleBlocks },
      network_apr: rates?.network_apr ?? null,
      reward_coverage: rates?.coverage ?? null,
      count: rows.length,
      active: rows.filter((v) => v.in_consensus_set).length,
      validators: rows,
    };
  });

  app.get("/api/v1/validators", async () => validatorList(""));

  app.get("/api/v1/validators/:id", async (req, reply) => {
    const id = Number((req.params as any).id);
    if (!Number.isInteger(id) || id < 0) return reply.code(400).send({ error: "validator id must be an integer" });
    const list = await validatorList("");
    const v = list.validators.find((x) => x.id === id);
    if (!v) return notFound(reply, "validator not found");
    const [blocks, hourly] = await Promise.all([
      q(
        `select number, hash, time, tx_count, gas_used, gas_limit from blocks where proposer_id = $1 order by number desc limit 25`,
        [id],
      ),
      q(
        `select date_trunc('hour', time) as t, count(*)::int as n from blocks
         where proposer_id = $1 and time > now() - interval '24 hours' group by 1 order by 1`,
        [id],
      ),
    ]);
    return {
      validator: v,
      epoch: list.epoch,
      recent_blocks: blocks.rows.map((b) => ({ ...b, number: Number(b.number), gas_used: Number(b.gas_used), gas_limit: Number(b.gas_limit) })),
      hourly: hourly.rows,
    };
  });

  /**
   * Same-origin proxy for registry logos. Visitors never contact third-party
   * hosts and the CSP keeps img-src 'self'. SVGs are allowed but served with
   * a sandboxing CSP: browsers never run script in an <img>-loaded SVG, and
   * the header neutralises one opened directly at this URL.
   */
  const LOGO_TTL_MS = 6 * 3600_000;
  /** Failures (throttled host, timeout) are retried sooner than successes are refreshed. */
  const LOGO_FAIL_TTL_MS = 10 * 60_000;
  const LOGO_MAX_BYTES = 2 * 1024 * 1024;
  const IMAGE = /^image\/(png|jpeg|jpg|gif|webp|avif|svg\+xml)$/;
  /** Registry URLs are third-party input: never let them aim the server at itself or a LAN. */
  const publicHttps = (raw: string): boolean => {
    try {
      const u = new URL(raw);
      const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
      if (u.protocol !== "https:" || h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return false;
      if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return false;
      if (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return false;
      return true;
    } catch {
      return false;
    }
  };
  const logos = new Map<number, { at: number; type: string; body: Buffer } | { at: number; missing: true }>();
  app.get("/api/v1/validators/:id/logo", async (req, reply) => {
    const id = Number((req.params as any).id);
    if (!Number.isInteger(id) || id < 0) return reply.code(400).send({ error: "bad id" });
    let hit = logos.get(id);
    if (!hit || Date.now() - hit.at > ("missing" in hit ? LOGO_FAIL_TTL_MS : LOGO_TTL_MS)) {
      const { rows } = await q(`select logo from validators where id = $1`, [id]);
      const url: string | null = rows[0]?.logo ?? null;
      hit = { at: Date.now(), missing: true };
      if (url && publicHttps(url)) {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(8_000), redirect: "follow" });
          const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
          const body = Buffer.from(await res.arrayBuffer());
          if (res.ok && IMAGE.test(type) && body.length <= LOGO_MAX_BYTES) hit = { at: Date.now(), type, body };
        } catch {
          /* unreachable logo host: fall through to "missing", retried after the TTL */
        }
      }
      logos.set(id, hit);
    }
    if ("missing" in hit) return reply.code(404).header("cache-control", "public, max-age=600").send({ error: "no logo" });
    return reply
      .header("content-type", hit.type)
      .header("cache-control", "public, max-age=3600")
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
      .send(hit.body);
  });

  /** Throughput, block cadence, gas and proposer distribution over a horizon. */
  const metrics = memoBy(15_000, async (key) => {
    const hours = Number(key);
    const bucketSecs = hours <= 1 ? 60 : hours <= 6 ? 300 : hours <= 24 ? 900 : 3600;
    const [series, totals, proposers] = await Promise.all([
      q(
        `select to_timestamp(floor(extract(epoch from time) / $2) * $2) as t,
                count(*)::int as blocks, sum(tx_count)::int as txs,
                sum(gas_used)::float8 as gas_used, sum(gas_limit)::float8 as gas_limit,
                extract(epoch from max(time) - min(time)) as span
         from blocks where time > now() - make_interval(hours => $1)
         group by 1 order by 1`,
        [hours, bucketSecs],
      ),
      q(
        `select count(*)::int as blocks, coalesce(sum(tx_count), 0)::bigint as txs,
                extract(epoch from max(time) - min(time)) as span,
                coalesce(sum(gas_used)::float8 / nullif(sum(gas_limit)::float8, 0), 0) as gas_util,
                max(tx_count) as max_txs
         from blocks where time > now() - make_interval(hours => $1)`,
        [hours],
      ),
      q(
        `select b.proposer_id as id, v.name, v.logo, count(*)::int as n
         from blocks b left join validators v on v.id = b.proposer_id
         where b.time > now() - make_interval(hours => $1) and b.proposer_id is not null
         group by 1, 2, 3 order by n desc limit 12`,
        [hours],
      ),
    ]);
    const t = totals.rows[0];
    const span = Number(t?.span) || 0;
    return {
      hours,
      allowed_hours: METRIC_HOURS,
      bucket_secs: bucketSecs,
      stats: {
        blocks: t?.blocks ?? 0,
        txs: Number(t?.txs ?? 0),
        avg_block_time_ms: t?.blocks > 1 && span ? Math.round((span * 1000) / (t.blocks - 1)) : null,
        tps: span ? Number((Number(t.txs) / span).toFixed(2)) : null,
        gas_utilization: t ? Number(Number(t.gas_util).toFixed(4)) : null,
        max_txs_in_block: t?.max_txs ?? null,
      },
      series: series.rows.map((r) => ({
        t: r.t,
        blocks: r.blocks,
        txs: r.txs,
        tps: Number((r.txs / bucketSecs).toFixed(2)),
        // Block timestamps have 1s resolution, so cadence is only meaningful per bucket.
        avg_block_time_ms: r.blocks > 1 && Number(r.span) ? Math.round((Number(r.span) * 1000) / (r.blocks - 1)) : null,
        gas_utilization: r.gas_limit ? Number((r.gas_used / r.gas_limit).toFixed(4)) : null,
      })),
      proposers: proposers.rows.map((r) => ({ ...r, share: t?.blocks ? r.n / t.blocks : null })),
    };
  });

  app.get("/api/v1/metrics", async (req) => {
    const want = Number((req.query as any).hours) || 24;
    const hours = METRIC_HOURS.includes(want) ? want : METRIC_HOURS[METRIC_HOURS.length - 1]!;
    return metrics(String(hours));
  });

  /**
   * Probe each configured RPC endpoint: height, client version, latency. Run
   * through a one-off client per URL (not the shared one) so a probe measures
   * that endpoint, not whichever the failover picked.
   */
  const urls = rpcUrlsFromEnv();
  const probes = urls.map((u) => new JsonRpc([u], 2));
  const endpoints = memoBy(15_000, async () => {
    const state = await q(`select active_rpc, chain_finalized from sync_state where id = 1`);
    const active = state.rows[0]?.active_rpc ?? null;
    const results = await Promise.all(
      probes.map(async (client, i) => {
        const started = Date.now();
        try {
          const [height, version, chain] = await client.batch<string>([
            { method: "eth_blockNumber", params: [] },
            { method: "web3_clientVersion", params: [] },
            { method: "eth_chainId", params: [] },
          ]);
          return {
            url: redactUrl(urls[i]!),
            healthy: hexToNumber(chain) === 143,
            latency_ms: Date.now() - started,
            height: hexToNumber(height),
            client: version,
            error: null as string | null,
          };
        } catch (e) {
          return { url: redactUrl(urls[i]!), healthy: false, latency_ms: null, height: null, client: null, error: (e as Error).message };
        }
      }),
    );
    return {
      indexer_rpc: active,
      chain_finalized: state.rows[0]?.chain_finalized ? Number(state.rows[0].chain_finalized) : null,
      endpoints: results.map((r, i) => ({ ...r, priority: i + 1, used_by_indexer: r.url === active })),
      api_rpc: rpc.status(),
    };
  });

  app.get("/api/v1/endpoints", async () => endpoints(""));

  /** Same-origin market snapshot for the header ticker, one upstream call a minute. */
  const COINGECKO_ID = process.env.COINGECKO_ID ?? "monad";
  const price = memoBy(60_000, async () => {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(COINGECKO_ID)}&vs_currencies=usd&include_24hr_change=true`,
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8_000) },
    );
    if (!res.ok) throw new Error(`market upstream HTTP ${res.status}`);
    const json = (await res.json()) as Record<string, { usd?: unknown; usd_24h_change?: unknown } | undefined>;
    const usd = json[COINGECKO_ID]?.usd;
    const change = json[COINGECKO_ID]?.usd_24h_change;
    if (typeof usd !== "number" || !Number.isFinite(usd) || typeof change !== "number" || !Number.isFinite(change)) {
      throw new Error("market upstream returned an invalid payload");
    }
    return { id: COINGECKO_ID, usd, usd_24h_change: change };
  });
  app.get("/api/v1/market", async (_req, reply) => {
    try {
      return await price("");
    } catch (e) {
      app.log.warn({ err: e }, "market data unavailable");
      return reply.code(503).send({ error: "market data unavailable" });
    }
  });

  app.get("/api/v1/config", async () => ({
    chain: { name: "Monad", network: "mainnet", chain_id: 143, currency: { symbol: "MON", decimals: 18 } },
    rpc_endpoints: urls.map(redactUrl),
    indexer: {
      head: "finalized",
      retain_hours: RETAIN_HOURS,
      backfill_depth: Number(process.env.BACKFILL_DEPTH ?? 30_000),
      database: "PostgreSQL",
    },
    validator_registry: "https://github.com/monad-developers/validator-info",
    metric_hours: METRIC_HOURS,
    /** What the configured RPC lets this deployment do; a private node flips these up. */
    features: {
      full_history: RETAIN_HOURS <= 0,
      trace_every: Number(process.env.TRACE_EVERY ?? 10),
      gas_replay: process.env.ESTIMATE_GAS !== "0",
      staking_history: process.env.STAKING_HISTORY !== "0",
      staking_logs_range: Number(process.env.STAKING_LOGS_RANGE ?? 100),
      pipeline: process.env.PIPELINE !== "0",
    },
  }));
}
