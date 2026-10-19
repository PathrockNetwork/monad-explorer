/**
 * History loop over eth_getLogs on the staking precompile, one range per
 * tick, two jobs in priority order:
 *
 *  1. reward repair: fill blocks.reward for indexed blocks that predate the
 *     column (newest first), from ValidatorRewarded logs;
 *  2. staking history: walk backwards from the oldest block the follower or
 *     backfill covered, collecting delegate/undelegate/withdraw/claim/
 *     commission events down to STAKING_HISTORY_FLOOR (genesis by default).
 *
 * The public endpoints cap eth_getLogs at 100 blocks per call, which makes
 * full history a slow crawl (~1M calls); a private RPC with a wider
 * STAKING_LOGS_RANGE covers it in hours.
 */
import { sql } from "drizzle-orm";
import { decodeStakingEvent, hexToBig, hexToNumber, stakingEvents, STAKING_EVENT_TOPICS, STAKING_PRECOMPILE, syncState, VALIDATOR_REWARDED_TOPIC } from "@monad-explorer/core";
import { caughtUp, sleep, toHex, type Ctx } from "./context";

const ENABLED = process.env.STAKING_HISTORY !== "0";
const RANGE = Number(process.env.STAKING_LOGS_RANGE ?? 100);
const FLOOR = Number(process.env.STAKING_HISTORY_FLOOR ?? 0);
/** Calls per second this loop may spend (shares the indexer's RPC budget). */
const RPS = Number(process.env.STAKING_HISTORY_RPS ?? 2);

const getLogs = (ctx: Ctx, from: number, to: number, topics: string[]) =>
  ctx.rpc.call<any[]>("eth_getLogs", [{ address: STAKING_PRECOMPILE, fromBlock: toHex(from), toBlock: toHex(to), topics: [topics] }]);

/** Newest indexed block range still missing rewards, or null when none are. */
async function rewardGap(ctx: Ctx): Promise<{ lo: number; hi: number } | null> {
  const { rows } = await ctx.pool.query<{ hi: string | null }>(
    `select max(number) as hi from blocks where reward is null and proposer_id is not null`,
  );
  if (!rows[0]?.hi) return null;
  const hi = Number(rows[0].hi);
  return { lo: Math.max(0, hi - RANGE + 1), hi };
}

async function repairRewards(ctx: Ctx, lo: number, hi: number): Promise<number> {
  const logs = await getLogs(ctx, lo, hi, [VALIDATOR_REWARDED_TOPIC]);
  const vals = logs.map((l) => ({ n: hexToNumber(l.blockNumber), r: hexToBig(`0x${String(l.data).slice(2, 66)}`).toString() }));
  // Blocks in the range that emitted no reward (none expected) are marked 0
  // so the repair never revisits them.
  await ctx.pool.query(
    `update blocks b set reward = coalesce(v.r, 0)
     from (select n from generate_series($1::bigint, $2::bigint) n) s
     left join jsonb_to_recordset($3::jsonb) as v(n bigint, r numeric) on v.n = s.n
     where b.number = s.n and b.reward is null`,
    [lo, hi, JSON.stringify(vals)],
  );
  return vals.length;
}

async function scanStaking(ctx: Ctx, lo: number, hi: number): Promise<number> {
  const logs = await getLogs(ctx, lo, hi, Object.keys(STAKING_EVENT_TOPICS));
  const rows = logs.map((l) => decodeStakingEvent(l)).filter((r): r is NonNullable<typeof r> => r !== null);
  if (rows.length) await ctx.db.insert(stakingEvents).values(rows).onConflictDoNothing();
  await ctx.db.update(syncState).set({ stakingHistoryFloor: lo }).where(sql`${syncState.id} = 1`);
  return rows.length;
}

export async function historyLoop(ctx: Ctx): Promise<void> {
  if (!ENABLED) {
    ctx.log("staking history disabled");
    return;
  }
  const pause = Math.ceil(1000 / Math.max(0.1, RPS));
  let floor: number | null = null;
  let found = 0;
  let repaired = 0;
  let lastLog = Date.now();
  while (!ctx.stopping()) {
    try {
      if (!caughtUp(ctx)) {
        await sleep(2_000);
        continue;
      }
      const gap = await rewardGap(ctx);
      if (gap) {
        repaired += await repairRewards(ctx, gap.lo, gap.hi);
      } else {
        if (floor === null) {
          const { rows } = await ctx.pool.query<{ f: string | null; lo: string | null }>(
            `select (select staking_history_floor from sync_state where id = 1) as f, (select min(number) from blocks) as lo`,
          );
          // Everything at or above the oldest indexed block came in through
          // receipts already, so the crawl starts just below it.
          floor = rows[0]?.f ? Number(rows[0].f) : rows[0]?.lo ? Number(rows[0].lo) : null;
        }
        if (floor === null || floor <= FLOOR) {
          await sleep(60_000);
          continue;
        }
        const hi = floor - 1;
        const lo = Math.max(FLOOR, hi - RANGE + 1);
        found += await scanStaking(ctx, lo, hi);
        floor = lo;
      }
      if (Date.now() - lastLog > 60_000) {
        ctx.log("history", { stakingFloor: floor, stakingEvents: found, rewardsRepaired: repaired });
        found = repaired = 0;
        lastLog = Date.now();
      }
    } catch (err) {
      ctx.log("history error", { err: (err as Error).message });
      await sleep(5_000);
    }
    await sleep(pause);
  }
}
