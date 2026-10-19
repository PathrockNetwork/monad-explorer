/**
 * Pipeline loop: subscribe to `monadNewHeads` over WebSocket and record when
 * each proposal reaches each MonadBFT commit stage (Proposed → Voted →
 * Finalized → Verified). Times are when this server observed the event, so
 * they include network latency to the RPC; stage-to-stage gaps cancel most
 * of that out.
 *
 * Writes are buffered and flushed once a second: ~3 blocks × 4 stages a
 * second would otherwise be a dozen tiny transactions.
 */
import { sql } from "drizzle-orm";
import { hexToNumber } from "@monad-explorer/core";
import { sleep, type Ctx } from "./context";

const WS_URLS = (process.env.WS_URLS ?? "wss://rpc.monad.xyz,wss://rpc3.monad.xyz")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const FLUSH_MS = 1_000;
/** No message for this long means the socket is wedged; reconnect. */
const STALL_MS = 15_000;

type Stage = "Proposed" | "Voted" | "Finalized" | "Verified";
const COLUMN: Record<Stage, string> = { Proposed: "proposed_at", Voted: "voted_at", Finalized: "finalized_at", Verified: "verified_at" };

type Pending = {
  blockId: string;
  number: number;
  hash: string | null;
  miner: string | null;
  gasUsed: number | null;
  proposed_at?: number;
  voted_at?: number;
  finalized_at?: number;
  verified_at?: number;
};

export async function pipelineLoop(ctx: Ctx): Promise<void> {
  if (!WS_URLS.length || process.env.PIPELINE === "0") {
    ctx.log("pipeline disabled");
    return;
  }
  const buf = new Map<string, Pending>();
  let beneficiaries = new Map<string, number>();
  let benAt = 0;

  const flush = async () => {
    if (Date.now() - benAt > 60_000) {
      const { rows } = await ctx.pool.query<{ id: number; beneficiary: string }>(
        `select id, beneficiary from validators where beneficiary is not null`,
      );
      beneficiaries = new Map(rows.map((r) => [r.beneficiary, r.id]));
      benAt = Date.now();
    }
    if (!buf.size) return;
    const rows = [...buf.values()].map((p) => ({
      block_id: p.blockId,
      number: p.number,
      hash: p.hash,
      miner: p.miner,
      gas_used: p.gasUsed,
      proposer_id: p.miner ? (beneficiaries.get(p.miner) ?? null) : null,
      proposed_at: p.proposed_at ? new Date(p.proposed_at).toISOString() : null,
      voted_at: p.voted_at ? new Date(p.voted_at).toISOString() : null,
      finalized_at: p.finalized_at ? new Date(p.finalized_at).toISOString() : null,
      verified_at: p.verified_at ? new Date(p.verified_at).toISOString() : null,
    }));
    buf.clear();
    // First observation of each stage wins; later duplicates (reconnects,
    // a second endpoint) never move a timestamp.
    await ctx.db.execute(sql`
      insert into block_stages (block_id, number, hash, miner, proposer_id, gas_used, proposed_at, voted_at, finalized_at, verified_at)
      select block_id, number, hash, miner, proposer_id, gas_used, proposed_at, voted_at, finalized_at, verified_at
      from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as r(
        block_id text, number bigint, hash text, miner text, proposer_id int, gas_used bigint,
        proposed_at timestamptz, voted_at timestamptz, finalized_at timestamptz, verified_at timestamptz)
      on conflict (block_id) do update set
        hash = coalesce(block_stages.hash, excluded.hash),
        miner = coalesce(block_stages.miner, excluded.miner),
        proposer_id = coalesce(block_stages.proposer_id, excluded.proposer_id),
        gas_used = coalesce(block_stages.gas_used, excluded.gas_used),
        proposed_at = least(block_stages.proposed_at, excluded.proposed_at),
        voted_at = least(block_stages.voted_at, excluded.voted_at),
        finalized_at = least(block_stages.finalized_at, excluded.finalized_at),
        verified_at = least(block_stages.verified_at, excluded.verified_at)`);
  };

  const flusher = (async () => {
    while (!ctx.stopping()) {
      try {
        await flush();
      } catch (err) {
        ctx.log("pipeline flush error", { err: (err as Error).message });
      }
      await sleep(FLUSH_MS);
    }
  })();

  let attempt = 0;
  let failures = 0;
  while (!ctx.stopping()) {
    const url = WS_URLS[attempt % WS_URLS.length]!;
    attempt++;
    let received = 0;
    await new Promise<void>((resolve) => {
      let lastMsg = Date.now();
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        ctx.log("pipeline connect error", { url, err: (err as Error).message });
        return resolve();
      }
      const watchdog = setInterval(() => {
        if (Date.now() - lastMsg > STALL_MS || ctx.stopping()) ws.close();
      }, 2_000);
      ws.onopen = () => {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["monadNewHeads"] }));
        ctx.log("pipeline subscribed", { url });
      };
      ws.onmessage = (m) => {
        lastMsg = Date.now();
        received++;
        let d: any;
        try {
          d = JSON.parse(String(m.data));
        } catch {
          return;
        }
        if (d.error) ctx.log("pipeline subscribe error", { url, err: d.error.message });
        const r = d.params?.result;
        if (!r?.blockId || !(r.commitState in COLUMN)) return;
        const id = String(r.blockId).toLowerCase();
        let p = buf.get(id);
        if (!p) {
          p = {
            blockId: id,
            number: hexToNumber(r.number),
            hash: r.hash ? String(r.hash).toLowerCase() : null,
            miner: r.miner ? String(r.miner).toLowerCase() : null,
            gasUsed: r.gasUsed ? hexToNumber(r.gasUsed) : null,
          };
          buf.set(id, p);
        }
        const col = COLUMN[r.commitState as Stage] as keyof Pending;
        if (p[col] === undefined) (p as any)[col] = lastMsg;
      };
      ws.onerror = () => ctx.log("pipeline socket error", { url });
      ws.onclose = () => {
        clearInterval(watchdog);
        resolve();
      };
    });
    // A session that delivered heads resets the backoff; one that never did grows it.
    failures = received > 10 ? 0 : failures + 1;
    if (!ctx.stopping()) await sleep(Math.min(30_000, 500 * 2 ** Math.min(failures, 6)));
  }
  await flusher;
}
