/**
 * Direct browser → Monad JSON-RPC requests. No explorer server in the middle,
 * so answers are independent of our indexer and API. The public Monad
 * gateways send CORS headers allowing browser POSTs; a custom endpoint that
 * doesn't (or an http endpoint loaded from the https site) is blocked by the
 * browser, which is reported honestly rather than as "down".
 */

/** Shared error model for every direct-RPC call. */
export type RpcResult<T> =
  | { state: "ok"; latencyMs: number; data: T }
  | { state: "blocked" | "error"; latencyMs: number; error: string; data?: unknown };

export type JsonRpcRequest = { method: string; params: unknown[] };
type Envelope = { jsonrpc?: string; id?: unknown; result?: unknown; error?: { code?: number; message?: string; data?: unknown } };

let nextId = 1;
export const requestBody = (method: string, params: unknown[]) => ({ jsonrpc: "2.0", id: nextId++, method, params });

const hexNum = (v: unknown): number | null => typeof v === "string" && /^0x[0-9a-f]+$/i.test(v) ? Number(BigInt(v)) : null;
const hexBig = (v: unknown): string | null => typeof v === "string" && /^0x[0-9a-f]+$/i.test(v) ? BigInt(v).toString() : null;

/**
 * One POST. A TimeoutError is a timeout; any other throw is the browser
 * blocking the request (CORS, mixed content and unreachable hosts all throw
 * the same TypeError by design). HTTP 429 is called out because the public
 * gateways rate-limit per IP.
 */
async function post(url: string, body: unknown, timeoutMs: number): Promise<RpcResult<unknown>> {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await r.text();
    let json: unknown;
    try { json = JSON.parse(text); } catch { json = undefined; }
    if (r.status === 429) return { state: "error", latencyMs: ms(), error: "HTTP 429 · rate limited (public gateways allow ~50 requests/s per IP; batch items count individually)", data: json };
    if (!r.ok && json === undefined) return { state: "error", latencyMs: ms(), error: `HTTP ${r.status}` };
    if (json === undefined) return { state: "error", latencyMs: ms(), error: "response was not JSON" };
    return { state: "ok", latencyMs: ms(), data: json };
  } catch (e) {
    if ((e as DOMException)?.name === "TimeoutError") return { state: "error", latencyMs: ms(), error: `no answer in ${ms()} ms (timeout)` };
    return { state: "blocked", latencyMs: ms(), error: "browser blocked the request (no CORS headers, unreachable host, or an http endpoint on the https site)" };
  }
}

/**
 * One raw call for the RPC console: returns the full JSON-RPC envelope as-is,
 * with the node's own error (if any) surfaced as the message.
 */
export async function rpcCallRaw(url: string, method: string, params: unknown[], timeoutMs = 20_000): Promise<RpcResult<unknown>> {
  const r = await post(url, requestBody(method, params), timeoutMs);
  if (r.state !== "ok") return r;
  const err = (r.data as Envelope | null)?.error;
  if (err) {
    const detail = err.data === undefined ? "" : `: ${typeof err.data === "string" ? err.data : JSON.stringify(err.data)}`;
    return { state: "error", latencyMs: r.latencyMs, error: `${err.code ?? ""} ${err.message ?? "node returned an error"}${detail}`.trim(), data: r.data };
  }
  return r;
}

/** A JSON-RPC batch; each item's result or null. Every item counts toward rate limits. */
export async function rpcBatch(url: string, calls: JsonRpcRequest[], timeoutMs = 8_000): Promise<RpcResult<(unknown | null)[]>> {
  const bodies = calls.map(c => requestBody(c.method, c.params));
  const r = await post(url, bodies, timeoutMs);
  if (r.state !== "ok") return r;
  if (!Array.isArray(r.data)) {
    const err = (r.data as Envelope | null)?.error;
    return { state: "error", latencyMs: r.latencyMs, error: err?.message ?? "endpoint did not answer the batch", data: r.data };
  }
  const byId = new Map((r.data as Envelope[]).map(e => [e?.id, e]));
  return { state: "ok", latencyMs: r.latencyMs, data: bodies.map(b => { const e = byId.get(b.id); return e && !e.error ? e.result ?? null : null; }) };
}

export type NodeProbe = {
  state: "ok" | "blocked" | "error";
  latencyMs: number;
  chainId?: number | null;
  netVersion?: string | null;
  client?: string | null;
  latest?: number | null;
  finalized?: number | null;
  gasPrice?: string | null;
  syncing?: boolean | null;
  error?: string;
};

/** Identity and head of an endpoint in one batch (6 items toward the rate limit). */
export async function probeNode(url: string): Promise<NodeProbe> {
  const r = await rpcBatch(url, [
    { method: "eth_chainId", params: [] },
    { method: "eth_blockNumber", params: [] },
    { method: "web3_clientVersion", params: [] },
    { method: "eth_getBlockByNumber", params: ["finalized", false] },
    { method: "eth_gasPrice", params: [] },
    { method: "eth_syncing", params: [] },
  ]);
  if (r.state !== "ok") return { state: r.state, latencyMs: r.latencyMs, error: r.error };
  const [chain, latest, client, finalized, gasPrice, syncing] = r.data;
  if (hexNum(chain) === null || hexNum(latest) === null) return { state: "error", latencyMs: r.latencyMs, error: "not an Ethereum JSON-RPC response (eth_chainId / eth_blockNumber missing)" };
  return {
    state: "ok",
    latencyMs: r.latencyMs,
    chainId: hexNum(chain),
    client: typeof client === "string" ? client : null,
    latest: hexNum(latest),
    finalized: hexNum((finalized as { number?: string } | null)?.number),
    gasPrice: hexBig(gasPrice),
    syncing: syncing === false ? false : syncing ? true : null,
  };
}

export type BlockInfo = { number: number; hash: string | null; time: string | null; txCount: number; gasUsed: number | null; gasLimit: number | null; baseFee: string | null };

/** The newest `count` blocks at or below `head`, newest first, in one batch. */
export async function fetchBlocks(url: string, head: number, count = 5): Promise<RpcResult<BlockInfo[]>> {
  const heights = Array.from({ length: Math.min(count, head + 1) }, (_, i) => head - i);
  const r = await rpcBatch(url, heights.map(h => ({ method: "eth_getBlockByNumber", params: [`0x${h.toString(16)}`, false] })));
  if (r.state !== "ok") return r;
  const blocks = r.data.flatMap(raw => {
    const b = raw as { number?: string; hash?: string; timestamp?: string; transactions?: unknown[]; gasUsed?: string; gasLimit?: string; baseFeePerGas?: string } | null;
    const n = hexNum(b?.number);
    if (!b || n === null) return [];
    const ts = hexNum(b.timestamp);
    return [{ number: n, hash: b.hash ?? null, time: ts === null ? null : new Date(ts * 1000).toISOString(), txCount: Array.isArray(b.transactions) ? b.transactions.length : 0, gasUsed: hexNum(b.gasUsed), gasLimit: hexNum(b.gasLimit), baseFee: hexBig(b.baseFeePerGas) }];
  });
  return { state: "ok", latencyMs: r.latencyMs, data: blocks };
}
