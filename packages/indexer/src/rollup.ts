/**
 * Usage rollup: fold newly indexed transactions into usage_hourly, a chunk
 * of blocks at a time, behind a cursor in sync_state. On first run the
 * cursor starts at the oldest indexed block, so the existing window is
 * folded in too. Blocks the backfill later inserts below the cursor (gap
 * repair) are not re-folded; they are rare and small.
 */
import { sql } from "drizzle-orm";
import { syncState } from "@monad-explorer/core";
import { sleep, type Ctx } from "./context";

const CHUNK_BLOCKS = 5_000;
const IDLE_MS = 30_000;

export async function rollupLoop(ctx: Ctx): Promise<void> {
  while (!ctx.stopping()) {
    try {
      const { rows } = await ctx.pool.query<{ cursor: string | null; lo: string | null }>(
        `select (select usage_rolled_to from sync_state where id = 1) as cursor, (select min(number) - 1 from blocks) as lo`,
      );
      const head = ctx.head();
      const from = rows[0]?.cursor !== null && rows[0]?.cursor !== undefined ? Number(rows[0].cursor) : rows[0]?.lo ? Number(rows[0].lo) : null;
      if (head === null || from === null || from >= head) {
        await sleep(IDLE_MS);
        continue;
      }
      const to = Math.min(head, from + CHUNK_BLOCKS);
      await ctx.db.transaction(async (tx) => {
        await tx.execute(sql`
          insert into usage_hourly (hour, address, txs, failed, gas, fees)
          select date_trunc('hour', time), coalesce("to", ''), count(*), count(*) filter (where status = 0), sum(gas_used), sum(fee)
          from transactions where block_number > ${from} and block_number <= ${to}
          group by 1, 2
          on conflict (hour, address) do update set
            txs = usage_hourly.txs + excluded.txs,
            failed = usage_hourly.failed + excluded.failed,
            gas = usage_hourly.gas + excluded.gas,
            fees = usage_hourly.fees + excluded.fees`);
        await tx.update(syncState).set({ usageRolledTo: to }).where(sql`${syncState.id} = 1`);
      });
      if (to === head) await sleep(IDLE_MS);
    } catch (err) {
      ctx.log("rollup error", { err: (err as Error).message });
      await sleep(10_000);
    }
  }
}
