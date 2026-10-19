/** Ethereum-compatible JSON-RPC method catalog for the Monad RPC console. */
import { STAKING_PRECOMPILE } from "./lib";
import { PUBLIC_RPCS } from "./networkExplorer";

export type ParamKind = "block" | "address" | "hash" | "bool" | "quantity" | "data" | "json" | "uint";
export type ParamSpec = { key: string; label: string; kind: ParamKind; placeholder?: string; hint?: string; optional?: boolean; default?: string };
export type MethodSpec = {
  /** Catalog id; equals `method` except for presets built on eth_call. */
  id: string;
  group: string;
  method: string;
  description: string;
  params: ParamSpec[];
  note?: string;
  /** Turns validated, converted values into the positional params array. */
  build?: (v: Record<string, unknown>) => unknown[];
  /** Human reading of an ABI-encoded result, for the staking presets. */
  decode?: (result: unknown) => string | null;
};

export { PUBLIC_RPCS };
export const PUBLIC_RPC = PUBLIC_RPCS[0];

const block = (def = "latest"): ParamSpec => ({ key: "block", label: "block", kind: "block", placeholder: def, default: def, hint: "number or latest · safe · finalized" });
const hash = (hint = "transaction hash"): ParamSpec => ({ key: "hash", label: "hash", kind: "hash", placeholder: "0x… (32 bytes)", hint });
const address: ParamSpec = { key: "address", label: "address", kind: "address", placeholder: "0x… (20 bytes)" };
const fullTx: ParamSpec = { key: "full", label: "full transactions", kind: "bool", default: "false", optional: true };
const tracer: ParamSpec = { key: "tracer", label: "tracer options", kind: "json", default: '{"tracer":"callTracer"}', hint: "JSON object" };

/** 32-byte words of an eth_call result. */
const words = (result: unknown): bigint[] | null => typeof result === "string" && /^0x([0-9a-f]{64})+$/i.test(result) ? result.slice(2).match(/.{64}/g)!.map(w => BigInt(`0x${w}`)) : null;
const callPreset = (data: (v: Record<string, unknown>) => string) => (v: Record<string, unknown>) => [{ to: STAKING_PRECOMPILE, data: data(v) }, v.block];

export const RPC_METHODS: MethodSpec[] = [
  { id: "eth_chainId", group: "Chain", method: "eth_chainId", description: "Chain ID as hex (0x8f = 143 for Monad mainnet)", params: [] },
  { id: "net_version", group: "Chain", method: "net_version", description: "Network ID as a decimal string", params: [] },
  { id: "web3_clientVersion", group: "Chain", method: "web3_clientVersion", description: "Client name and version of the node", params: [] },
  { id: "eth_blockNumber", group: "Chain", method: "eth_blockNumber", description: "Number of the latest block", params: [] },
  { id: "eth_syncing", group: "Chain", method: "eth_syncing", description: "Sync status; false when the node is caught up", params: [] },
  { id: "eth_gasPrice", group: "Chain", method: "eth_gasPrice", description: "Suggested gas price in wei", params: [] },
  { id: "eth_maxPriorityFeePerGas", group: "Chain", method: "eth_maxPriorityFeePerGas", description: "Suggested priority fee (tip) in wei", params: [] },
  { id: "eth_feeHistory", group: "Chain", method: "eth_feeHistory", description: "Base fees and gas-used ratios for recent blocks", params: [{ key: "count", label: "block count", kind: "quantity", default: "4", placeholder: "4" }, { ...block(), key: "newest", label: "newest block" }, { key: "percentiles", label: "reward percentiles", kind: "json", default: "[25, 75]", hint: "JSON array" }] },
  { id: "eth_getBlockByNumber", group: "Blocks", method: "eth_getBlockByNumber", description: "Block by number or tag", params: [block("finalized"), fullTx] },
  { id: "eth_getBlockByHash", group: "Blocks", method: "eth_getBlockByHash", description: "Block by hash", params: [hash("block hash"), fullTx] },
  { id: "eth_getBlockTransactionCountByNumber", group: "Blocks", method: "eth_getBlockTransactionCountByNumber", description: "Number of transactions in a block", params: [block()] },
  { id: "eth_getBlockReceipts", group: "Blocks", method: "eth_getBlockReceipts", description: "All transaction receipts of a block", params: [block("finalized")], note: "Busy blocks return large responses." },
  { id: "eth_getTransactionByHash", group: "Transactions", method: "eth_getTransactionByHash", description: "Transaction by hash", params: [hash()] },
  { id: "eth_getTransactionReceipt", group: "Transactions", method: "eth_getTransactionReceipt", description: "Receipt: status, gas used, logs", params: [hash()] },
  { id: "eth_getTransactionByBlockNumberAndIndex", group: "Transactions", method: "eth_getTransactionByBlockNumberAndIndex", description: "Transaction by block and position", params: [block("finalized"), { key: "index", label: "index", kind: "quantity", default: "0", placeholder: "0" }] },
  { id: "eth_call", group: "Transactions", method: "eth_call", description: "Execute a read-only call against state", params: [{ ...address, key: "to", label: "to" }, { key: "data", label: "data", kind: "data", default: "0x", placeholder: "0x…", hint: "ABI-encoded calldata" }, { ...address, key: "from", label: "from", optional: true, hint: "optional" }, block()], build: v => [{ ...(v.from ? { from: v.from } : {}), to: v.to, data: v.data }, v.block] },
  { id: "eth_estimateGas", group: "Transactions", method: "eth_estimateGas", description: "Gas a transaction would use", params: [{ ...address, key: "to", label: "to" }, { key: "data", label: "data", kind: "data", default: "0x", placeholder: "0x…" }, { ...address, key: "from", label: "from", optional: true, hint: "optional" }, { key: "value", label: "value (wei)", kind: "quantity", optional: true, placeholder: "0", hint: "optional" }], build: v => [{ ...(v.from ? { from: v.from } : {}), to: v.to, data: v.data, ...(v.value ? { value: v.value } : {}) }] },
  { id: "eth_getBalance", group: "Accounts", method: "eth_getBalance", description: "MON balance of an address, in wei", params: [address, block()] },
  { id: "eth_getTransactionCount", group: "Accounts", method: "eth_getTransactionCount", description: "Nonce: transactions sent by an address", params: [address, block()] },
  { id: "eth_getCode", group: "Accounts", method: "eth_getCode", description: "Contract bytecode at an address", params: [address, block()] },
  { id: "eth_getStorageAt", group: "Accounts", method: "eth_getStorageAt", description: "Raw storage slot of a contract", params: [address, { key: "slot", label: "slot", kind: "quantity", default: "0", placeholder: "0" }, block()] },
  { id: "eth_getLogs", group: "Logs", method: "eth_getLogs", description: "Event logs matching a filter", params: [{ key: "filter", label: "filter", kind: "json", default: '{"fromBlock":"finalized","toBlock":"finalized"}', hint: "JSON filter object" }], note: "Keep block ranges small; add address and topics to narrow results." },
  { id: "debug_traceTransaction", group: "Debug/Trace", method: "debug_traceTransaction", description: "Call trace of a transaction", params: [hash(), tracer] },
  { id: "debug_traceBlockByNumber", group: "Debug/Trace", method: "debug_traceBlockByNumber", description: "Call traces of every transaction in a block", params: [block("finalized"), tracer], note: "Traces of busy blocks are large." },
  { id: "staking_getEpoch", group: "Monad staking", method: "eth_call", description: "getEpoch() · current epoch and delay-period flag", params: [block()], build: callPreset(() => "0x757991a8"), note: `eth_call to the staking precompile ${STAKING_PRECOMPILE} with selector 0x757991a8.`, decode: r => { const w = words(r); return w && w.length >= 2 ? `epoch ${w[0].toString()} · in epoch delay period: ${w[1] !== 0n}` : null; } },
  { id: "staking_getProposerValId", group: "Monad staking", method: "eth_call", description: "getProposerValId() · validator id of the current proposer", params: [block()], build: callPreset(() => "0xfbacb0be"), note: `eth_call to the staking precompile ${STAKING_PRECOMPILE} with selector 0xfbacb0be.`, decode: r => { const w = words(r); return w && w.length >= 1 ? `validator id ${w[0].toString()}` : null; } },
  { id: "staking_getValidator", group: "Monad staking", method: "eth_call", description: "getValidator(uint64) · ABI-encoded validator record", params: [{ key: "id", label: "validator id", kind: "uint", placeholder: "1" }, block()], build: callPreset(v => `0x2b6d639a${BigInt(v.id as string).toString(16).padStart(64, "0")}`), note: `eth_call to the staking precompile with selector 0x2b6d639a; the first word of the result is the auth address.` },
];

export const POPULAR_METHODS = ["eth_blockNumber", "eth_getBlockByNumber", "eth_getTransactionReceipt", "eth_getBalance", "eth_call", "eth_getLogs", "debug_traceTransaction", "staking_getEpoch"];
export const RPC_CATEGORIES: Record<string, string[] | null> = { Popular: null, Chain: ["Chain"], Blocks: ["Blocks"], Transactions: ["Transactions"], Accounts: ["Accounts"], Logs: ["Logs"], "Debug/Trace": ["Debug/Trace"], "Monad staking": ["Monad staking"], All: [] };
export const findMethod = (id: string | null | undefined) => RPC_METHODS.find(m => m.id === id) ?? null;
export const methodTitle = (m: MethodSpec) => m.id.startsWith("staking_") ? m.id.slice(8) : m.method;

export function methodList(category: string, query: string) {
  const q = query.trim().toLowerCase();
  return RPC_METHODS.filter(m => (q || category === "All" || (category === "Popular" ? POPULAR_METHODS.includes(m.id) : RPC_CATEGORIES[category]?.includes(m.group))) && (!q || `${m.id} ${m.method} ${m.description}`.toLowerCase().includes(q)));
}

export function normalizeEndpoint(raw: string): { url: string; error?: never } | { error: string; url?: never } {
  try {
    const url = new URL(raw.trim());
    if (!["http:", "https:"].includes(url.protocol)) return { error: "Use an HTTP or HTTPS JSON-RPC endpoint." };
    if (url.username || url.password) return { error: "Enter an endpoint without embedded credentials." };
    if (url.hash) return { error: "Enter the RPC URL without a fragment." };
    return { url: url.toString().replace(/\/+$/, "") };
  } catch { return { error: "Enter a valid RPC endpoint URL." }; }
}

const TAGS = ["latest", "finalized", "safe", "earliest", "pending"];
const toHex = (v: string) => `0x${BigInt(v).toString(16)}`;
const isNum = (v: string) => /^\d+$/.test(v) || /^0x[0-9a-f]+$/i.test(v);

/** Validate one field and convert it to its JSON-RPC form. */
function convert(p: ParamSpec, raw: string): { value: unknown; error?: never } | { error: string; value?: never } {
  const v = raw.trim();
  switch (p.kind) {
    case "block": return TAGS.includes(v.toLowerCase()) ? { value: v.toLowerCase() } : isNum(v) ? { value: toHex(v) } : { error: `${p.label} must be a block number or one of ${TAGS.join(", ")}.` };
    case "quantity": return isNum(v) ? { value: toHex(v) } : { error: `${p.label} must be a non-negative integer (decimal or 0x hex).` };
    case "uint": return /^\d+$/.test(v) && BigInt(v) < 2n ** 64n ? { value: v } : { error: `${p.label} must be a non-negative integer below 2^64.` };
    case "address": return /^0x[0-9a-fA-F]{40}$/.test(v) ? { value: v } : { error: `${p.label} must be a 0x-prefixed 20-byte address.` };
    case "hash": return /^0x[0-9a-fA-F]{64}$/.test(v) ? { value: v } : { error: `${p.label} must be a 0x-prefixed 32-byte hash.` };
    case "data": return /^0x([0-9a-fA-F]{2})*$/.test(v) ? { value: v } : { error: `${p.label} must be 0x-prefixed hex with whole bytes.` };
    case "bool": return v === "true" || v === "false" ? { value: v === "true" } : { error: `${p.label} must be true or false.` };
    case "json": try { return { value: JSON.parse(v) }; } catch { return { error: `${p.label} must be valid JSON.` }; }
  }
}

/** Positional params array from form values (blank fields fall back to defaults). */
export function compileParams(method: MethodSpec, values: Record<string, string>, raw: string | null = null): { params: unknown[]; error?: never } | { error: string; params?: never } {
  if (raw !== null) {
    try { const parsed: unknown = JSON.parse(raw); return Array.isArray(parsed) ? { params: parsed } : { error: "Raw parameters must be a JSON array." }; }
    catch { return { error: "Enter valid JSON parameters." }; }
  }
  const converted: Record<string, unknown> = {};
  for (const p of method.params) {
    const value = (values[p.key] ?? "").trim() || p.default || "";
    if (!value) { if (p.optional) continue; return { error: `${p.label} is required for ${methodTitle(method)}.` }; }
    const c = convert(p, value);
    if (c.error !== undefined) return { error: c.error };
    converted[p.key] = c.value;
  }
  if (method.build) return { params: method.build(converted) };
  const params = method.params.map(p => converted[p.key]);
  while (params.length && params[params.length - 1] === undefined) params.pop();
  return params.includes(undefined) ? { error: "Fill optional fields in order, or use raw JSON." } : { params };
}

/** Map a raw params array back to fields; null when it can't be represented. */
export function formFromRaw(method: MethodSpec, raw: string): Record<string, string> | null {
  if (method.build) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(parsed) || parsed.length > method.params.length) return null;
  const out: Record<string, string> = {};
  method.params.forEach((p, i) => {
    const v = parsed[i];
    if (v === undefined) return;
    out[p.key] = p.kind === "json" ? JSON.stringify(v) : (p.kind === "block" || p.kind === "quantity") && typeof v === "string" && /^0x[0-9a-f]+$/i.test(v) ? BigInt(v).toString() : String(v);
  });
  return out;
}

export function curlCommand(url: string, body: unknown): string {
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  return `curl -s -X POST ${quote(url)} \\\n  -H 'content-type: application/json' \\\n  --data ${quote(JSON.stringify(body))}`;
}
