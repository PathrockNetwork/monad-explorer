/**
 * Pure decoding of debug_trace* output: internal transactions from
 * callTracer, and the per-block transaction dependency graph from
 * prestateTracer read/write sets. No I/O here, so it is unit-tested.
 */
import { hexToBig, hexToNumber } from "./evm";

export type CallFrame = {
  type: string;
  from: string;
  to?: string;
  value?: string;
  gas?: string;
  gasUsed?: string;
  input?: string;
  output?: string;
  error?: string;
  revertReason?: string;
  calls?: CallFrame[];
};

export type InternalTxRow = {
  txHash: string;
  idx: number;
  blockNumber: number;
  time: Date;
  depth: number;
  callType: string;
  from: string;
  to: string | null;
  value: string;
  gasUsed: number | null;
  error: string | null;
};

export type TraceSummary = { callCount: number; callDepth: number; internal: InternalTxRow[] };

const KEEP_TYPES = new Set(["CREATE", "CREATE2", "SELFDESTRUCT"]);
/**
 * Frames whose `value` actually moves MON. A DELEGATECALL reports the
 * caller's msg.value but transfers nothing; STATICCALL cannot carry value.
 */
const VALUE_TYPES = new Set(["CALL", "CREATE", "CREATE2", "SELFDESTRUCT"]);

/**
 * Walk one transaction's call tree depth-first. Frames below the top level
 * are counted; the ones that move MON, create a contract or self-destruct are
 * returned as internal transactions.
 */
export function summarizeCalls(txHash: string, blockNumber: number, time: Date, root: CallFrame | null | undefined): TraceSummary {
  const internal: InternalTxRow[] = [];
  let callCount = 0;
  let callDepth = 0;
  let idx = 0;
  const walk = (f: CallFrame, depth: number) => {
    if (depth > 0) {
      callCount++;
      callDepth = Math.max(callDepth, depth);
      const type = String(f.type ?? "CALL").toUpperCase();
      const value = VALUE_TYPES.has(type) ? hexToBig(f.value) : 0n;
      if (value > 0n || KEEP_TYPES.has(type)) {
        internal.push({
          txHash,
          idx,
          blockNumber,
          time,
          depth,
          callType: type,
          from: String(f.from).toLowerCase(),
          to: f.to ? String(f.to).toLowerCase() : null,
          value: value.toString(),
          gasUsed: f.gasUsed ? hexToNumber(f.gasUsed) : null,
          error: f.error ? String(f.error).slice(0, 200) : null,
        });
      }
    }
    idx++;
    for (const c of f.calls ?? []) walk(c, depth + 1);
  };
  if (root) walk(root, 0);
  return { callCount, callDepth, internal };
}

/** A call frame trimmed for display: no output, input cut to the selector plus a little. */
export type CallNode = {
  type: string;
  from: string;
  to: string | null;
  value: string;
  gas: number | null;
  gasUsed: number | null;
  method: string | null;
  inputSize: number;
  error: string | null;
  calls: CallNode[];
};

/** Trim a call tree for the API, keeping at most `maxFrames` frames. */
export function callTree(root: CallFrame, maxFrames = 500): { tree: CallNode; frames: number; truncated: boolean } {
  let frames = 0;
  let truncated = false;
  const conv = (f: CallFrame): CallNode => {
    frames++;
    const input = f.input ?? "0x";
    const node: CallNode = {
      type: String(f.type ?? "CALL").toUpperCase(),
      from: String(f.from).toLowerCase(),
      to: f.to ? String(f.to).toLowerCase() : null,
      value: hexToBig(f.value).toString(),
      gas: f.gas ? hexToNumber(f.gas) : null,
      gasUsed: f.gasUsed ? hexToNumber(f.gasUsed) : null,
      method: input.length >= 10 ? input.slice(0, 10).toLowerCase() : null,
      inputSize: Math.max(0, (input.length - 2) / 2),
      error: f.error ? String(f.revertReason ?? f.error).slice(0, 200) : null,
      calls: [],
    };
    for (const c of f.calls ?? []) {
      if (frames >= maxFrames) {
        truncated = true;
        break;
      }
      node.calls.push(conv(c));
    }
    return node;
  };
  const tree = conv(root);
  return { tree, frames, truncated };
}

type AccountState = { balance?: string; nonce?: number; code?: string; storage?: Record<string, string> };
type Prestate = Record<string, AccountState>;

/** State keys: an account (balance/nonce/code) is `addr`; a storage slot is `addr:slot`. */
export type AccessSet = { reads: Set<string>; writes: Set<string> };

/**
 * Read and write sets for one transaction. `pre` is prestateTracer output
 * (every account and slot the transaction touched, i.e. a superset of what it
 * read); `diff` is the same tracer in diffMode, whose `post` lists only what
 * changed. `ignore` drops accounts every transaction writes for bookkeeping —
 * the block beneficiary collecting fees — which would otherwise make every
 * block look serial.
 */
export function accessSet(pre: Prestate | null | undefined, diff: { pre?: Prestate; post?: Prestate } | null | undefined, ignore: Set<string>): AccessSet {
  const reads = new Set<string>();
  const writes = new Set<string>();
  for (const [addrRaw, acct] of Object.entries(pre ?? {})) {
    const addr = addrRaw.toLowerCase();
    if (ignore.has(addr)) continue;
    reads.add(addr);
    for (const slot of Object.keys(acct?.storage ?? {})) reads.add(`${addr}:${slot.toLowerCase()}`);
  }
  const before = diff?.pre ?? {};
  for (const [addrRaw, acct] of Object.entries(diff?.post ?? {})) {
    const addr = addrRaw.toLowerCase();
    if (ignore.has(addr)) continue;
    const prev = before[addrRaw] ?? before[addr];
    if (acct.balance !== undefined || acct.nonce !== undefined || acct.code !== undefined || !prev) writes.add(addr);
    for (const slot of Object.keys(acct?.storage ?? {})) writes.add(`${addr}:${slot.toLowerCase()}`);
  }
  // Accounts deleted by the transaction appear in diff.pre but not diff.post.
  for (const addrRaw of Object.keys(before)) {
    const addr = addrRaw.toLowerCase();
    if (!ignore.has(addr) && !(diff?.post ?? {})[addrRaw]) writes.add(addr);
  }
  return { reads, writes };
}

export type DependencyGraph = {
  txCount: number;
  /** Per-transaction level: 0 = depends on nothing earlier in the block. */
  levels: number[];
  edges: [number, number][];
  edgeCount: number;
  dependentTxs: number;
  criticalPath: number;
  parallelism: number;
  hot: { address: string; edges: number; txs: number }[];
};

/**
 * Dependency graph over a block's transactions, in block order. Transaction j
 * depends on an earlier i when j reads or overwrites a key i wrote: under
 * optimistic parallel execution j's first attempt could have seen stale state
 * and been re-run. For each key only the most recent writer is linked, which
 * is enough because writers of the same key are themselves chained.
 */
export function dependencyGraph(sets: AccessSet[], maxEdges = 2000): DependencyGraph {
  const lastWriter = new Map<string, number>();
  const levels: number[] = [];
  const edgeSet = new Map<string, [number, number]>();
  const hotEdges = new Map<string, number>();
  const hotTxs = new Map<string, Set<number>>();
  let dependentTxs = 0;

  sets.forEach((s, j) => {
    const deps = new Map<number, Set<string>>();
    for (const key of new Set([...s.reads, ...s.writes])) {
      const i = lastWriter.get(key);
      if (i === undefined) continue;
      const contract = key.split(":")[0]!;
      let cs = deps.get(i);
      if (!cs) deps.set(i, (cs = new Set()));
      cs.add(contract);
    }
    let level = 0;
    for (const [i, contracts] of deps) {
      level = Math.max(level, levels[i]! + 1);
      edgeSet.set(`${i}-${j}`, [i, j]);
      for (const c of contracts) {
        hotEdges.set(c, (hotEdges.get(c) ?? 0) + 1);
        let t = hotTxs.get(c);
        if (!t) hotTxs.set(c, (t = new Set()));
        t.add(i).add(j);
      }
    }
    if (deps.size) dependentTxs++;
    levels.push(level);
    for (const key of s.writes) lastWriter.set(key, j);
  });

  const n = sets.length;
  const criticalPath = n ? Math.max(...levels) + 1 : 0;
  const edges = [...edgeSet.values()];
  const hot = [...hotEdges]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([address, e]) => ({ address, edges: e, txs: hotTxs.get(address)?.size ?? 0 }));
  return {
    txCount: n,
    levels,
    edges: edges.slice(0, maxEdges),
    edgeCount: edges.length,
    dependentTxs,
    criticalPath,
    parallelism: criticalPath ? n / criticalPath : 0,
    hot,
  };
}

/** Pair debug_traceBlockByNumber results (which carry txHash) with the block's tx order. */
export function byTxHash<T>(results: { txHash?: string; result?: T }[]): Map<string, T> {
  return new Map(results.filter((r) => r.txHash).map((r) => [String(r.txHash).toLowerCase(), r.result as T]));
}
