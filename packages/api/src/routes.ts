/**
 * REST routes. Recent data comes from the indexed window in Postgres; anything
 * older (or not indexed yet) is read through from the archive RPC and shaped
 * identically, with `source` telling the client which one answered.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type pg from "pg";
import { JsonRpc, hexToNumber, isAddress, isHash, parseBlock, decodeTransfer, type ParsedBlock } from "@monad-explorer/core";

export type Deps = { pool: pg.Pool; rpc: JsonRpc };

const PAGE_MAX = 100;
const PAGE_DEFAULT = 25;
/** Address history counts stop here; hot contracts would make an exact count slow. */
const COUNT_CAP = 10_000;

/** Tiny TTL memo so a burst of dashboard polls costs one query, not N. */
function memo<T>(ttlMs: number, fn: () => Promise<T>): () => Promise<T> {
  let at = 0;
  let pending: Promise<T> | null = null;
  return () => {
    if (pending && Date.now() - at < ttlMs) return pending;
    at = Date.now();
    pending = fn().catch((e) => {
      at = 0; // never cache a failure
      throw e;
    });
    return pending;
  };
}

const limitOf = (q: any): number => Math.min(PAGE_MAX, Math.max(1, Number(q?.limit) || PAGE_DEFAULT));
const bad = (reply: FastifyReply, msg: string) => reply.code(400).send({ error: msg });
const toHex = (n: number) => `0x${n.toString(16)}`;

/** Blocks joined with their proposer's identity (b = blocks, v = validators). */
const BLOCK_SELECT = `select b.number, b.hash, b.parent_hash, b.time, b.miner, b.gas_used, b.gas_limit, b.base_fee_per_gas,
  b.tx_count, b.size, b.proposer_id, v.name as proposer_name, v.logo as proposer_logo
  from blocks b left join validators v on v.id = b.proposer_id`;
const TX_COLS = `hash, block_number, tx_index, time, "from", "to", contract_address, value, nonce, type,
  gas_limit, gas_used, effective_gas_price, fee, status, method, input_size, log_count`;

/** Normalise a parsed (RPC) block to the same snake_case shape the DB returns. */
function blockJson(b: ParsedBlock["block"]) {
  return {
    number: b.number,
    hash: b.hash,
    parent_hash: b.parentHash,
    time: b.time.toISOString(),
    miner: b.miner,
    gas_used: b.gasUsed,
    gas_limit: b.gasLimit,
    base_fee_per_gas: b.baseFeePerGas,
    tx_count: b.txCount,
    size: b.size,
    proposer_id: b.proposerId,
    proposer_name: null as string | null,
    proposer_logo: null as string | null,
  };
}

function txJson(t: ParsedBlock["txs"][number]) {
  return {
    hash: t.hash,
    block_number: t.blockNumber,
    tx_index: t.txIndex,
    time: t.time.toISOString(),
    from: t.from,
    to: t.to,
    contract_address: t.contractAddress,
    value: t.value,
    nonce: t.nonce,
    type: t.type,
    gas_limit: t.gasLimit,
    gas_used: t.gasUsed,
    effective_gas_price: t.effectiveGasPrice,
    fee: t.fee,
    status: t.status,
    method: t.method,
    input_size: t.inputSize,
    log_count: t.logCount,
  };
}

/** pg returns bigint/numeric as strings; block numbers fit comfortably in a JS number. */
const fixBlock = (r: any) => ({ ...r, number: Number(r.number), gas_used: Number(r.gas_used), gas_limit: Number(r.gas_limit) });
const fixTx = (r: any) => ({
  ...r,
  block_number: Number(r.block_number),
  nonce: Number(r.nonce),
  gas_limit: Number(r.gas_limit),
  gas_used: Number(r.gas_used),
});

async function rpcBlock(rpc: JsonRpc, id: number | string): Promise<ParsedBlock | null> {
  const isNum = typeof id === "number";
  const block = await rpc.call(isNum ? "eth_getBlockByNumber" : "eth_getBlockByHash", [isNum ? toHex(id) : id, true]);
  if (!block) return null;
  const receipts = await rpc.call<any[]>("eth_getBlockReceipts", [block.number]);
  return parseBlock(block, receipts ?? []);
}

export function registerRoutes(app: FastifyInstance, { pool, rpc }: Deps): void {
  const q = <T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []) => pool.query<T>(text, params);

  const tokenMeta = async (addresses: string[]) => {
    if (!addresses.length) return {};
    const { rows } = await q(`select address, name, symbol, decimals, standard from tokens where address = any($1)`, [addresses]);
    return Object.fromEntries(rows.map((r) => [r.address, r]));
  };

  const gasPrice = memo(10_000, () => rpc.call<string>("eth_gasPrice").then((h) => BigInt(h).toString()));

  const stats = memo(2_000, async () => {
    const [state, recent, day, window, vals, cadence, tenMin] = await Promise.all([
      q(`select head_number, chain_finalized, backfill_target, active_rpc, updated_at, epoch, epoch_delay_period from sync_state where id = 1`),
      q(`select count(*)::int as blocks, coalesce(sum(tx_count), 0)::int as txs,
                extract(epoch from max(time) - min(time)) as span, max(number) as head
         from (select number, time, tx_count from blocks order by number desc limit 1000) r`),
      q(`select count(*)::int as blocks, coalesce(sum(tx_count), 0)::bigint as txs
         from blocks where time > now() - interval '24 hours'`),
      q(`select min(number) as earliest, min(time) as earliest_time, count(*)::int as blocks from blocks`),
      // Stake in force this epoch: the snapshot view during the delay period (see core activeView).
      q(`select count(*) filter (where in_consensus_set)::int as active, count(*)::int as total,
                coalesce(sum(case when (select epoch_delay_period from sync_state where id = 1) then snapshot_stake else consensus_stake end)
                         filter (where in_consensus_set), 0)::text as stake from validators`),
      // Per-minute cadence for the last 30 minutes (the overview sparkline).
      q(`select to_timestamp(floor(extract(epoch from time) / 60) * 60) as t, count(*)::int as blocks, sum(tx_count)::int as txs
         from blocks where time > now() - interval '30 minutes' group by 1 order by 1`),
      q(`select count(*)::int as n from blocks where time > now() - interval '10 minutes'`),
    ]);
    const s = state.rows[0] ?? {};
    const r = recent.rows[0];
    const span = Number(r?.span) || 0;
    const head = s.head_number === null || s.head_number === undefined ? null : Number(s.head_number);
    const finalized = s.chain_finalized === null || s.chain_finalized === undefined ? null : Number(s.chain_finalized);
    return {
      chain_id: 143,
      indexed_head: head,
      chain_finalized: finalized,
      lag_blocks: head !== null && finalized !== null ? finalized - head : null,
      indexer_updated_at: s.updated_at ?? null,
      earliest_indexed: window.rows[0]?.earliest ? Number(window.rows[0].earliest) : null,
      earliest_indexed_time: window.rows[0]?.earliest_time ?? null,
      blocks_indexed: window.rows[0]?.blocks ?? 0,
      backfill_target: s.backfill_target ? Number(s.backfill_target) : null,
      avg_block_time_ms: r && r.blocks > 1 && span ? Math.round((span * 1000) / (r.blocks - 1)) : null,
      tps: r && span ? Number((r.txs / span).toFixed(2)) : null,
      blocks_24h: day.rows[0]?.blocks ?? 0,
      txs_24h: Number(day.rows[0]?.txs ?? 0),
      gas_price: await gasPrice().catch(() => null),
      epoch: s.epoch ? Number(s.epoch) : null,
      epoch_delay_period: s.epoch_delay_period ?? null,
      validators_active: vals.rows[0]?.active ?? 0,
      validators_total: vals.rows[0]?.total ?? 0,
      total_stake: vals.rows[0]?.stake ?? "0",
      blocks_10m: tenMin.rows[0]?.n ?? 0,
      recent_minutes: cadence.rows,
      rpc: rpc.status(),
    };
  });

  app.get("/health", async () => {
    await q("select 1");
    return { ok: true };
  });

  app.get("/api/v1/stats", async () => stats());

  /** Transactions and gas per time bucket over the last N hours (from the block table). */
  app.get("/api/v1/series", async (req) => {
    const hours = Math.min(72, Math.max(1, Number((req.query as any).hours) || 1));
    const bucketSecs = hours <= 1 ? 60 : hours <= 6 ? 300 : hours <= 24 ? 900 : 3600;
    const { rows } = await q(
      `select to_timestamp(floor(extract(epoch from time) / $2) * $2) as t,
              count(*)::int as blocks, sum(tx_count)::int as txs, sum(gas_used)::float8 as gas
       from blocks where time > now() - make_interval(hours => $1)
       group by 1 order by 1`,
      [hours, bucketSecs],
    );
    return { hours, bucket_secs: bucketSecs, points: rows };
  });

  app.get("/api/v1/blocks", async (req) => {
    const query = req.query as any;
    const limit = limitOf(query);
    const before = query.before ? Number(query.before) : null;
    const { rows } = await q(
      `${BLOCK_SELECT} ${before ? "where b.number < $2" : ""} order by b.number desc limit $1`,
      before ? [limit, before] : [limit],
    );
    if (rows.length || !before) return { source: "db", blocks: rows.map(fixBlock) };
    // Past the indexed window: page through the archive RPC instead.
    const nums = Array.from({ length: Math.min(limit, before) }, (_, i) => before - 1 - i);
    const raw = await rpc.batch(nums.map((n) => ({ method: "eth_getBlockByNumber", params: [toHex(n), false] })));
    return {
      source: "rpc",
      blocks: raw.filter(Boolean).map((b: any) => ({
        number: hexToNumber(b.number),
        hash: b.hash,
        parent_hash: b.parentHash,
        time: new Date(hexToNumber(b.timestamp) * 1000).toISOString(),
        miner: String(b.miner).toLowerCase(),
        gas_used: hexToNumber(b.gasUsed),
        gas_limit: hexToNumber(b.gasLimit),
        base_fee_per_gas: b.baseFeePerGas ? BigInt(b.baseFeePerGas).toString() : null,
        tx_count: b.transactions.length,
        size: hexToNumber(b.size),
      })),
    };
  });

  app.get("/api/v1/blocks/:id", async (req, reply) => {
    const id = (req.params as any).id as string;
    const isNum = /^\d+$/.test(id);
    if (!isNum && !isHash(id)) return bad(reply, "block id must be a number or 0x hash");
    const where = isNum ? `b.number = $1` : `b.hash = $1`;
    const key = isNum ? Number(id) : id.toLowerCase();
    const { rows } = await q(`${BLOCK_SELECT} where ${where}`, [key]);
    if (rows[0]) {
      const txs = await q(`select ${TX_COLS} from transactions where block_number = $1 order by tx_index`, [rows[0].number]);
      return { source: "db", block: fixBlock(rows[0]), txs: txs.rows.map(fixTx) };
    }
    const p = await rpcBlock(rpc, key);
    if (!p) return reply.code(404).send({ error: "block not found" });
    const block = blockJson(p.block);
    if (block.proposer_id !== null) {
      const v = await q(`select name, logo from validators where id = $1`, [block.proposer_id]);
      block.proposer_name = v.rows[0]?.name ?? null;
      block.proposer_logo = v.rows[0]?.logo ?? null;
    }
    return { source: "rpc", block, txs: p.txs.map(txJson) };
  });

  app.get("/api/v1/txs", async (req, reply) => {
    const query = req.query as any;
    const limit = limitOf(query);
    const address = query.address ? String(query.address).toLowerCase() : null;
    if (address && !isAddress(address)) return bad(reply, "invalid address");
    // Cursor "block:index" — the last row of the previous page.
    const [cb, ci] = query.before ? String(query.before).split(":").map(Number) : [null, null];
    const cursor = cb !== null && Number.isFinite(cb) ? `(block_number, tx_index) < (${Math.trunc(cb!)}, ${Math.trunc(ci ?? 0)})` : "true";
    const sqlText = address
      ? `(select ${TX_COLS} from transactions where "from" = $2 and ${cursor} order by block_number desc, tx_index desc limit $1)
         union
         (select ${TX_COLS} from transactions where "to" = $2 and ${cursor} order by block_number desc, tx_index desc limit $1)
         order by block_number desc, tx_index desc limit $1`
      : `select ${TX_COLS} from transactions where ${cursor} order by block_number desc, tx_index desc limit $1`;
    const { rows } = await q(sqlText, address ? [limit, address] : [limit]);
    return { source: "db", txs: rows.map(fixTx) };
  });

  app.get("/api/v1/txs/:hash", async (req, reply) => {
    const hash = String((req.params as any).hash).toLowerCase();
    if (!isHash(hash)) return bad(reply, "invalid transaction hash");
    const [tx, rc] = await rpc.batch([
      { method: "eth_getTransactionByHash", params: [hash] },
      { method: "eth_getTransactionReceipt", params: [hash] },
    ]);
    if (!tx) return reply.code(404).send({ error: "transaction not found" });
    const pending = !rc;
    let time: string | null = tx.blockTimestamp ? new Date(hexToNumber(tx.blockTimestamp) * 1000).toISOString() : null;
    if (!time && tx.blockNumber) {
      const b = await rpc.call("eth_getBlockByNumber", [tx.blockNumber, false]);
      time = b ? new Date(hexToNumber(b.timestamp) * 1000).toISOString() : null;
    }
    const logs: any[] = rc?.logs ?? [];
    const transfers = logs.map(decodeTransfer).filter((t): t is NonNullable<typeof t> => t !== null);
    const meta = await tokenMeta([...new Set(transfers.map((t) => t.token))]);
    const s = await stats().catch(() => null);
    const gasUsed = rc ? BigInt(rc.gasUsed) : null;
    const price = rc ? BigInt(rc.effectiveGasPrice ?? tx.gasPrice ?? 0) : null;
    return {
      source: "rpc",
      tx: {
        hash,
        pending,
        block_number: tx.blockNumber ? hexToNumber(tx.blockNumber) : null,
        block_hash: tx.blockHash,
        tx_index: tx.transactionIndex ? hexToNumber(tx.transactionIndex) : null,
        time,
        confirmations: s?.chain_finalized && tx.blockNumber ? Math.max(0, s.chain_finalized - hexToNumber(tx.blockNumber)) : null,
        from: String(tx.from).toLowerCase(),
        to: tx.to ? String(tx.to).toLowerCase() : null,
        contract_address: rc?.contractAddress ? String(rc.contractAddress).toLowerCase() : null,
        value: BigInt(tx.value).toString(),
        nonce: hexToNumber(tx.nonce),
        type: hexToNumber(tx.type),
        gas_limit: hexToNumber(tx.gas),
        gas_used: gasUsed === null ? null : Number(gasUsed),
        gas_price: tx.gasPrice ? BigInt(tx.gasPrice).toString() : null,
        max_fee_per_gas: tx.maxFeePerGas ? BigInt(tx.maxFeePerGas).toString() : null,
        max_priority_fee_per_gas: tx.maxPriorityFeePerGas ? BigInt(tx.maxPriorityFeePerGas).toString() : null,
        effective_gas_price: price === null ? null : price.toString(),
        fee: gasUsed !== null && price !== null ? (gasUsed * price).toString() : null,
        status: rc ? hexToNumber(rc.status) : null,
        input: tx.input,
      },
      transfers: transfers.map((t) => ({ ...t, token_meta: (meta as any)[t.token] ?? null })),
      logs: logs.map((l) => ({ address: String(l.address).toLowerCase(), topics: l.topics, data: l.data, log_index: hexToNumber(l.logIndex) })),
    };
  });

  app.get("/api/v1/address/:addr", async (req, reply) => {
    const addr = String((req.params as any).addr).toLowerCase();
    if (!isAddress(addr)) return bad(reply, "invalid address");
    const [balance, nonce, code] = await rpc.batch<string>([
      { method: "eth_getBalance", params: [addr, "latest"] },
      { method: "eth_getTransactionCount", params: [addr, "latest"] },
      { method: "eth_getCode", params: [addr, "latest"] },
    ]);
    const capped = (col: string) =>
      q(`select count(*)::int as n from (select 1 from transactions where ${col} = $1 limit ${COUNT_CAP}) c`, [addr]);
    const [sent, received, transfers, token, mined] = await Promise.all([
      capped(`"from"`),
      capped(`"to"`),
      // For a token contract, "its transfers" means movements of that token.
      q(
        `(select * from token_transfers where "from" = $1 order by block_number desc limit 25)
         union (select * from token_transfers where "to" = $1 order by block_number desc limit 25)
         union (select * from token_transfers where token = $1 order by block_number desc limit 25)
         order by block_number desc, log_index desc limit 25`,
        [addr],
      ),
      q(`select address, name, symbol, decimals, standard, first_seen_block from tokens where address = $1`, [addr]),
      q(
        `select v.id, v.name, v.logo, (v.auth_address = $1) as is_auth, (v.beneficiary = $1) as is_beneficiary,
                (select count(*)::int from blocks where proposer_id = v.id) as blocks_proposed
         from validators v where v.auth_address = $1 or v.beneficiary = $1 limit 1`,
        [addr],
      ),
    ]);
    const meta = await tokenMeta([...new Set(transfers.rows.map((t) => t.token))]);
    const codeSize = code && code !== "0x" ? (code.length - 2) / 2 : 0;
    return {
      address: addr,
      balance: BigInt(balance!).toString(),
      nonce: hexToNumber(nonce),
      is_contract: codeSize > 0,
      code_size: codeSize,
      token: token.rows[0] ?? null,
      validator: mined.rows[0]
        ? { id: mined.rows[0].id, name: mined.rows[0].name, logo: mined.rows[0].logo, role: mined.rows[0].is_auth ? "auth" : "beneficiary" }
        : null,
      window: {
        sent: sent.rows[0].n,
        received: received.rows[0].n,
        count_cap: COUNT_CAP,
        blocks_proposed: mined.rows[0]?.blocks_proposed ?? 0,
      },
      transfers: transfers.rows.map((t) => ({ ...t, block_number: Number(t.block_number), token_meta: (meta as any)[t.token] ?? null })),
    };
  });

  /** Resolve free text to a page: block number, tx hash, block hash or address. */
  app.get("/api/v1/search", async (req, reply) => {
    const raw = String((req.query as any).q ?? "").trim();
    if (/^\d+$/.test(raw)) return { type: "block", id: raw };
    if (isAddress(raw)) return { type: "address", id: raw.toLowerCase() };
    if (isHash(raw)) {
      const h = raw.toLowerCase();
      const { rows } = await q(
        `select 'tx' as type from transactions where hash = $1 union all select 'block' from blocks where hash = $1 limit 1`,
        [h],
      );
      if (rows[0]) return { type: rows[0].type, id: h };
      const [tx, block] = await rpc.batch([
        { method: "eth_getTransactionByHash", params: [h] },
        { method: "eth_getBlockByHash", params: [h, false] },
      ]);
      if (tx) return { type: "tx", id: h };
      if (block) return { type: "block", id: String(hexToNumber(block.number)) };
      return reply.code(404).send({ error: "no transaction or block with that hash" });
    }
    return bad(reply, "enter a block number, transaction or block hash, or address");
  });
}
