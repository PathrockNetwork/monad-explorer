/**
 * Trace views for the transaction inspector: gas analysis, call tree,
 * internal transfers and state changes. The trace loads lazily and on its
 * own, so the rest of the inspector never waits for it.
 */
import { useEffect, useState } from "react";
import { ApiError, getTxTrace, type CallNode, type Labels, type StateChange, type TxTrace } from "../api";
import { fmt, formatUnits, methodLabel, middle } from "../lib";
import { Chip, Meter, Skeleton } from "./ui";
import { addressName, effText, effTone, isPositiveWei, monAuto, monDelta, toneVar } from "./GasFormat";
import { addressRoute } from "../transactionExplorer";

export type TraceState = { trace: TxTrace | null; error: string | null; retry: () => void };

/** Fetch the trace for `hash` once per mount; independent of the transaction detail. */
export function useTxTrace(hash: string): TraceState {
  const [trace, setTrace] = useState<TxTrace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    getTxTrace(hash)
      .then((t) => { if (!cancelled) setTrace(t); })
      .catch((e) => { if (!cancelled) setError(e instanceof ApiError && e.status === 404 ? "No trace: the transaction is pending or unknown to the RPC." : "The trace could not be loaded from the RPC."); });
    return () => { cancelled = true; };
  }, [hash, attempt]);
  return { trace, error, retry: () => setAttempt((n) => n + 1) };
}

function TraceStatus({ state, rows = 3 }: { state: TraceState; rows?: number }) {
  if (state.error) return <div className="txe-trace-error" role="status"><span>{state.error}</span><button type="button" onClick={state.retry}>Retry</button></div>;
  return <div className="txe-trace-loading" aria-label="Loading trace">{Array.from({ length: rows }, (_, i) => <Skeleton key={i} h={i === 0 ? 20 : 14} w={`${90 - i * 12}%`} />)}</div>;
}

function Addr({ address, labels }: { address: string | null; labels: Labels }) {
  if (!address) return <span className="txe-muted-inline">—</span>;
  const name = addressName(address, null, labels, 8, 4);
  return <a className="txe-address-link" href={addressRoute(address)} title={address}>{name}</a>;
}

/* ───────────── Gas analysis ───────────── */

export function GasAnalysis({ state }: { state: TraceState }) {
  const g = state.trace?.gas;
  return <section className="txe-message txe-gas">
    <h3>Gas analysis</h3>
    {!g ? <TraceStatus state={state} /> : g.system ? <p className="txe-muted">Per-block reward system call: the first transaction of every Monad block credits the block reward through the staking precompile. It uses no gas and pays no fee, so there is nothing to analyse.</p> : <>
      <div className="txe-gas-grid">
        <div><span>Gas limit · paid</span><strong>{fmt(g.limit)}</strong></div>
        <div><span>Needed · estimated</span><strong>{g.estimate === null ? "—" : fmt(g.estimate)}</strong></div>
        <div><span>Unused · estimated</span><strong className={g.unused ? "warn" : undefined}>{g.unused === null ? "—" : fmt(g.unused)}</strong></div>
        <div><span>Cost of unused gas</span><strong className={g.unused ? "warn" : undefined}>{g.unused_fee === null ? "—" : monAuto(g.unused_fee)}</strong></div>
      </div>
      {g.efficiency !== null && <Meter label="Efficiency · estimated needed ÷ limit" value={effText(g.efficiency)} width={`${Math.min(100, g.efficiency * 100)}%`} color={toneVar(effTone(g.efficiency))} scale={`0% · ${g.price ? `priced at ${formatUnits(g.price, 9, 2)} gwei` : "price unknown"} · 100% of the limit`} />}
      <p className="txe-muted">
        {g.estimate === null ? "The gas needed could not be estimated (the replay failed, for example because the call reverts on the parent block's state). " : ""}
        Source: {g.source === "replayed" ? "replayed now with eth_estimateGas on the parent block's state" : g.source === "indexed" ? "indexed (the indexer replayed this transaction with eth_estimateGas when it sampled the block)" : "not available"}.
        {g.estimate !== null ? " Monad charges the full gas limit. The estimate includes the estimator's headroom and ignores earlier transactions in the block, so unused gas is a conservative approximation." : ""}
      </p>
    </>}
  </section>;
}

/* ───────────── Call tree ───────────── */

export function CallTree({ state }: { state: TraceState }) {
  const t = state.trace;
  if (!t) return <TraceStatus state={state} rows={5} />;
  const total = t.call_count + 1;
  return <section className="txe-trace">
    <p className="txe-muted">{fmt(total)} call frame{total === 1 ? "" : "s"} · max depth {fmt(t.call_depth)}. Inner frames show the gas they actually used; on Monad the top frame reports the full gas limit, which is not usage. Deeper levels start collapsed.</p>
    {t.truncated && <p className="txe-trace-warn">Tree truncated: showing {fmt(t.frames)} of {fmt(total)} frames.</p>}
    <ul className="txe-tree" role="tree" aria-label="Call tree"><CallRow node={t.tree} depth={0} labels={t.labels} /></ul>
  </section>;
}

function CallRow({ node, depth, labels }: { node: CallNode; depth: number; labels: Labels }) {
  const [open, setOpen] = useState(depth < 2);
  const kids = node.calls ?? [];
  const method = methodLabel(node.method, node.inputSize, node.to ?? null);
  return <li role="treeitem" aria-expanded={kids.length ? open : undefined}>
    <div className={`txe-tree-row${node.error ? " failed" : ""}`} style={{ paddingLeft: Math.min(depth, 12) * 14 }}>
      {kids.length ? <button type="button" className="txe-tree-toggle" aria-label={open ? "Collapse" : `Expand ${kids.length} inner calls`} onClick={() => setOpen(!open)}>{open ? "▾" : "▸"}</button> : <span className="txe-tree-toggle leaf" aria-hidden="true">·</span>}
      <span className="txe-tree-type">{node.type}</span>
      <Addr address={node.to} labels={labels} />
      <span className="txe-tree-method" title={node.method ?? undefined}>{method}</span>
      {isPositiveWei(node.value) && <span className="txe-tree-value">{monAuto(node.value)}</span>}
      <span className="txe-tree-gas">{depth === 0 ? "top frame · charged the limit" : node.gasUsed !== null ? `${fmt(node.gasUsed)} gas` : ""}</span>
      {!open && kids.length > 0 && <span className="txe-tree-more">+{kids.length}</span>}
      {node.error && <span className="txe-tree-error" title={node.error}>{node.error}</span>}
    </div>
    {open && kids.length > 0 && <ul role="group">{kids.map((c, i) => <CallRow key={i} node={c} depth={depth + 1} labels={labels} />)}</ul>}
  </li>;
}

/* ───────────── Internal transfers ───────────── */

export function InternalTransfers({ state }: { state: TraceState }) {
  const t = state.trace;
  if (!t) return <TraceStatus state={state} />;
  if (!t.internal.length) return <p className="txe-muted">No internal transfers: no inner call moved MON (CALL with value, CREATE/CREATE2 or SELFDESTRUCT).</p>;
  return <section>
    <p className="txe-muted">Value-moving inner calls from the call trace.</p>
    <div className="txe-table-scroll"><table className="txe-mini-table"><thead><tr><th>Type</th><th>Depth</th><th>From</th><th>To</th><th>Value</th><th>Status</th></tr></thead><tbody>
      {t.internal.map((i) => <tr key={i.idx}><td>{i.type}</td><td>{i.depth}</td><td><Addr address={i.from} labels={t.labels} /></td><td><Addr address={i.to} labels={t.labels} /></td><td>{monAuto(i.value)}</td><td>{i.error ? <span className="txe-bad-text" title={i.error}>{i.error}</span> : <Chip tone="ok">OK</Chip>}</td></tr>)}
    </tbody></table></div>
  </section>;
}

/* ───────────── State changes ───────────── */

export function StateChanges({ state }: { state: TraceState }) {
  const t = state.trace;
  if (!t) return <TraceStatus state={state} rows={4} />;
  if (!t.state.length) return <p className="txe-muted">No state changes were reported for this transaction.</p>;
  return <section className="txe-state">
    <p className="txe-muted">{fmt(t.state.length)} account{t.state.length === 1 ? "" : "s"} changed. Fields absent after the transaction were not modified.</p>
    {t.state.map((s) => <StateRow key={s.address} s={s} labels={t.labels} />)}
  </section>;
}

/** Balances keep 6 decimals so a small delta stays visible next to a large balance. */
const bal = (wei: string | null) => (wei == null ? "—" : `${formatUnits(wei, 18, 6)} MON`);

function StateRow({ s, labels }: { s: StateChange; labels: Labels }) {
  const [open, setOpen] = useState(false);
  const balanceChanged = s.balance_after !== null || s.destroyed;
  const before = s.balance_before ?? (s.created ? "0" : null);
  const after = s.balance_after ?? "0";
  const delta = balanceChanged ? monDelta(before ?? "0", after) : null;
  const nonceChanged = s.nonce_after !== null && s.nonce_after !== s.nonce_before;
  return <div className="txe-state-row">
    <div className="txe-state-head">
      <Addr address={s.address} labels={labels} />
      <div className="txe-badges">{s.created && <Chip tone="ok">Created</Chip>}{s.destroyed && <Chip tone="bad">Destroyed</Chip>}{s.code_changed && <Chip tone="brand">Code changed</Chip>}</div>
    </div>
    <dl className="txe-state-facts">
      <div><dt>Balance</dt><dd>{!balanceChanged ? <>{bal(s.balance_before)} <em>unchanged</em></> : <>{bal(before)} → {bal(after)}{delta && <b className={delta.sign > 0 ? "up" : delta.sign < 0 ? "down" : undefined}>{delta.text}</b>}</>}</dd></div>
      <div><dt>Nonce</dt><dd>{nonceChanged ? `${s.nonce_before ?? "—"} → ${s.nonce_after}` : s.nonce_before !== null ? <>{s.nonce_before} <em>unchanged</em></> : "—"}</dd></div>
      <div><dt>Storage</dt><dd>{s.storage_changes ? <button type="button" className="txe-inline-button" aria-expanded={open} onClick={() => setOpen(!open)}>{fmt(s.storage_changes)} slot{s.storage_changes === 1 ? "" : "s"} {open ? "▾" : "▸"}</button> : "No slots"}</dd></div>
    </dl>
    {open && s.storage.length > 0 && <div className="txe-slots">
      {s.storage.map((slot) => <div key={slot.slot} className="txe-slot"><code title={slot.slot}>{middle(slot.slot, 10, 6)}</code><code title={slot.before ?? undefined}>{slot.before ? middle(slot.before, 10, 8) : "— (empty)"}</code><span aria-hidden="true">→</span><code title={slot.after ?? undefined}>{slot.after ? middle(slot.after, 10, 8) : "— (cleared)"}</code></div>)}
      {s.storage_changes > s.storage.length && <p className="txe-muted">Showing {s.storage.length} of {fmt(s.storage_changes)} slots.</p>}
    </div>}
  </div>;
}
