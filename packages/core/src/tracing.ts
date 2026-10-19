/**
 * Trace fetching shared by the indexer (sampled, persisted) and the API
 * (on demand, cached): one JSON-RPC batch of four calls per block.
 */
import { hexToBig, hexToNumber } from "./evm";
import type { JsonRpc } from "./rpc";
import {
  accessSet,
  byTxHash,
  dependencyGraph,
  summarizeCalls,
  type CallFrame,
  type DependencyGraph,
  type InternalTxRow,
} from "./trace";

export type TxTrace = { hash: string; txIndex: number; callCount: number; callDepth: number };

export type BlockTrace = {
  number: number;
  time: Date;
  miner: string;
  /** Raw transactions (eth_getBlockByNumber with full objects), for gas replay. */
  rawTxs: any[];
  graph: DependencyGraph;
  txs: TxTrace[];
  internal: InternalTxRow[];
};

export async function fetchBlockTrace(rpc: JsonRpc, n: number): Promise<BlockTrace> {
  const hex = `0x${n.toString(16)}`;
  const [block, calls, pre, diff] = await rpc.batch<any>([
    { method: "eth_getBlockByNumber", params: [hex, true] },
    { method: "debug_traceBlockByNumber", params: [hex, { tracer: "callTracer" }] },
    { method: "debug_traceBlockByNumber", params: [hex, { tracer: "prestateTracer" }] },
    { method: "debug_traceBlockByNumber", params: [hex, { tracer: "prestateTracer", tracerConfig: { diffMode: true } }] },
  ]);
  if (!block) throw new Error(`block ${n} not available`);
  const time = new Date(hexToNumber(block.timestamp) * 1000);
  const miner = String(block.miner).toLowerCase();
  const callMap = byTxHash<CallFrame>(calls ?? []);
  const preMap = byTxHash<any>(pre ?? []);
  const diffMap = byTxHash<any>(diff ?? []);
  const ignore = new Set([miner]);

  const txs: TxTrace[] = [];
  const internal: InternalTxRow[] = [];
  const sets = (block.transactions as any[]).map((tx) => {
    const hash = String(tx.hash).toLowerCase();
    const s = summarizeCalls(hash, n, time, callMap.get(hash));
    txs.push({ hash, txIndex: hexToNumber(tx.transactionIndex), callCount: s.callCount, callDepth: s.callDepth });
    internal.push(...s.internal);
    // The reward syscall (gas 0) runs as a block preamble, not as a peer of
    // user transactions; linking every staking read to it would be noise.
    if (hexToNumber(tx.gas) === 0) return { reads: new Set<string>(), writes: new Set<string>() };
    return accessSet(preMap.get(hash), diffMap.get(hash), ignore);
  });
  return { number: n, time, miner, rawTxs: block.transactions, graph: dependencyGraph(sets), txs, internal };
}

/**
 * Gas a transaction needed: eth_estimateGas replayed against the parent
 * block's state. It ignores earlier transactions in the same block and adds
 * the estimator's own headroom, so limit − estimate understates the gas a
 * sender paid for and never used — a conservative figure, never inflated.
 * Null for the reward syscall (gas 0) and for calls the replay rejects.
 */
export async function estimateTxGas(rpc: JsonRpc, tx: any, parent: number): Promise<number | null> {
  if (hexToNumber(tx.gas) === 0) return null;
  const call: Record<string, string> = { from: tx.from, data: tx.input ?? "0x", value: tx.value ?? "0x0" };
  if (tx.to) call.to = tx.to;
  try {
    const est = await rpc.call<string>("eth_estimateGas", [call, `0x${parent.toString(16)}`]);
    return Number(hexToBig(est));
  } catch {
    return null;
  }
}
