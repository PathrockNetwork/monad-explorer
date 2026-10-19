import { preferredScrollBehavior } from "../appearance";
import { Timestamp } from "../components/Timestamp";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Dashboard } from "../useDashboard";
import { ApiError, getBlock, getBlocks, type Block, type BlockParallelism, type Source, type Tx } from "../api";
import { filterBlocks, gasShare, HIGH_GAS_SHARE, loadBlockParallelism, normalizeBlock, speedup, sumWei, type BlockVolume } from "../blockExplorer";
import { copyText, fmt, gwei, methodLabel, middle, mon, pct, short } from "../lib";
import { CopyButton, Skeleton, ValidatorAvatar } from "../components/ui";
import { DependencyLanes } from "../components/DependencyLanes";
import { addressRoute, transactionKind, txRoute } from "../transactionExplorer";
import "./blocks.css";

const compact = (n: number | null | undefined) => n == null ? "—" : Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
const share = (b: Block) => { const s = gasShare(b); return s === null ? "—" : pct(s * 100); };
const heightFromLocation = () => { const match = location.hash.match(/^#\/blocks\/(\d+)$/); const h = Number(match?.[1]); return Number.isSafeInteger(h) && h >= 0 && match ? h : null; };
/** Ledger page size for the live head; older pages are fetched with `before`. */
const HEAD_LIMIT = 50;
const POLL_MS = 5_000;
type Detail = { block: Block | null; txs: Tx[]; source: Source | null; error: string | null; loading: boolean };
type OlderPage = { before: number; source: Source; blocks: Block[] };

export function Blocks({ d, live }: { d: Dashboard; live: boolean }) {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [selected, setSelected] = useState<number | null>(heightFromLocation);
  const [details, setDetails] = useState<Record<number, Detail>>({});
  const detailsRef = useRef(details);
  detailsRef.current = details;
  const [query, setQuery] = useState("");
  const [volume, setVolume] = useState<BlockVolume>("all");
  const [ascending, setAscending] = useState(false);
  const [perPage, setPerPage] = useState(10);
  /** `before` cursors of the pages walked into; empty = the live head page. */
  const [cursors, setCursors] = useState<number[]>([]);
  const [older, setOlder] = useState<OlderPage | null>(null);
  const [olderError, setOlderError] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [jumpHeight, setJumpHeight] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState(false);
  const [tab, setTab] = useState("Header");
  const running = live && !paused;
  const retainHours = d.config?.indexer.retain_hours ?? 72;
  const pick = (height: number) => { setSelected(height); location.hash = `/blocks/${height}`; };
  const copy = async (value: string) => { try { await copyText(value); setCopied(value); setCopyError(false); } catch { setCopyError(true); } };
  useEffect(() => { const sync = () => setSelected(heightFromLocation()); window.addEventListener("hashchange", sync); return () => window.removeEventListener("hashchange", sync); }, []);
  useEffect(() => { if (!copied) return; const t = setTimeout(() => setCopied(null), 1800); return () => clearTimeout(t); }, [copied]);
  useEffect(() => {
    let cancelled = false;
    const load = () => getBlocks(HEAD_LIMIT).then((r) => { if (!cancelled) { setBlocks(r.blocks.map(normalizeBlock)); setError(null); setLoading(false); } }).catch(() => { if (!cancelled) { setError("Recent blocks are temporarily unavailable."); setLoading(false); } });
    void load(); const timer = running ? window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, POLL_MS) : null;
    return () => { cancelled = true; if (timer) clearInterval(timer); };
  }, [running]);
  const before = cursors[cursors.length - 1];
  useEffect(() => {
    if (before === undefined) { setOlder(null); setOlderError(null); return; }
    let cancelled = false;
    setOlderError(null);
    getBlocks(perPage, before).then((r) => { if (!cancelled) setOlder({ before, source: r.source, blocks: r.blocks.map(normalizeBlock) }); }).catch(() => { if (!cancelled) setOlderError("This page of blocks could not be loaded."); });
    return () => { cancelled = true; };
  }, [before, perPage]);

  const onHead = cursors.length === 0;
  const olderReady = !onHead && older?.before === before;
  const base = onHead ? blocks.slice(0, perPage) : olderReady ? older!.blocks : [];
  const rows = filterBlocks(base, query, volume, ascending);
  const lowest = base.length ? Math.min(...base.map((b) => b.number)) : null;
  const canOlder = lowest !== null && lowest > 0 && base.length >= perPage;
  const pageSource: Source | null = onHead ? (blocks.length ? "db" : null) : olderReady ? older!.source : null;
  const head = blocks[0];
  const chainHead = d.net?.chain_finalized ?? head?.number;
  const selectedHeight = selected ?? head?.number ?? null;
  const findBlock = (height: number) => blocks.find((b) => b.number === height) ?? older?.blocks.find((b) => b.number === height) ?? details[height]?.block ?? undefined;
  const picked = selectedHeight === null ? undefined : findBlock(selectedHeight);
  useEffect(() => {
    if (selectedHeight === null) return;
    const known = detailsRef.current[selectedHeight];
    if (known && !known.error) return;
    let cancelled = false;
    const h = selectedHeight;
    setDetails((old) => ({ ...old, [h]: { block: null, txs: [], source: null, error: null, loading: true } }));
    getBlock(h).then((r) => {
      if (cancelled) return;
      setDetails((old) => ({ ...Object.fromEntries(Object.entries(old).slice(-49)), [h]: { block: normalizeBlock(r.block), txs: r.txs, source: r.source, error: null, loading: false } }));
    }).catch((e) => {
      if (cancelled) return;
      setDetails((old) => ({ ...old, [h]: { block: null, txs: [], source: null, error: e instanceof ApiError && e.status === 404 ? `Block #${fmt(h)} was not found. It may not be finalized yet.` : "This block could not be loaded.", loading: false } }));
    });
    return () => { cancelled = true; };
  }, [selectedHeight]);
  const streamLive = running && !error && d.state !== "stopped" && d.state !== "dberror";
  const selectedDetail = selectedHeight === null ? undefined : details[selectedHeight];
  const resetPaging = () => { setCursors([]); };
  return <div className="bx-page bx-history">
    <div className="bx-chain-toolbar"><span>Chain explorer <i>/</i> Blocks <i>/</i> Finalized</span><div><form onSubmit={(event) => { event.preventDefault(); const height = Number(jumpHeight); if (Number.isSafeInteger(height) && height >= 0 && (chainHead === undefined || height <= chainHead)) pick(height); }}><input type="number" min={0} max={chainHead} step={1} required aria-label="Jump to block height" placeholder="Jump to height…" value={jumpHeight} onChange={(event) => setJumpHeight(event.target.value)} /><button type="submit">Go →</button></form><a href="#/rpc">↗ Query via RPC</a></div></div>
    <section className="bx-card bx-sequence">
      <header><div><h2>Live block sequence</h2><span>Follow the head or inspect an earlier height.</span><LiveBadge live={streamLive} /></div><div className="bx-sequence-meta"><span>Height <strong>{head ? fmt(head.number) : "—"}</strong></span><span>{d.net?.avg_block_time_ms == null ? "—" : `${(d.net.avg_block_time_ms / 1000).toFixed(2)}s`} cadence</span><button type="button" disabled={!live} onClick={() => setPaused(!paused)} aria-label={paused ? "Resume block updates" : "Pause block updates"}>{paused ? "▶ Resume" : "Ⅱ Pause"}</button><button type="button" onClick={() => { setSelected(null); location.hash = "/blocks"; }}>Follow head →</button></div></header>
      <div className="bx-sequence-track">{blocks.slice(0, 9).map((block) => <button type="button" key={block.number} className={`bx-sequence-block ${block.number === picked?.number ? "selected" : ""}`} onClick={() => pick(block.number)} aria-pressed={block.number === picked?.number} aria-label={`Inspect block ${block.number}`}>
        <strong><Glyph name="cube" />#{fmt(block.number)}</strong><span className="bx-sequence-proposer" title={block.proposer_name ?? block.miner}><ValidatorAvatar id={block.proposer_id} seed={block.miner} hasLogo={!!block.proposer_logo} size={16} />{proposerLabel(block)}</span><GasStrip block={block} compact /><small><span>{fmt(block.tx_count)} tx · {share(block)}</span><span><Timestamp value={block.time} /></span></small>
      </button>)}{!blocks.length && <p className="bx-muted">{loading ? "Loading block sequence…" : error ?? "Waiting for indexed blocks."}</p>}</div>
    </section>
    {error && <p className="bx-notice" role="alert">{error} {blocks.length > 0 && "Showing the last successful snapshot."}</p>}
    {copyError && <p className="bx-notice" role="alert">Could not copy to clipboard.</p>}
    <div className="bx-workspace"><section className="bx-card bx-directory"><header><div><h2>Block ledger <small>{base.length} on this page</small></h2><p>Finalized history · {ascending ? "oldest" : "newest"} height first{onHead ? " · live head" : ""}{pageSource === "rpc" && <span className="bx-archive-note"> · via archive RPC</span>}</p></div><div className="bx-ledger-actions"><button type="button" aria-pressed={volume === "all" && !query} onClick={() => { setVolume("all"); setQuery(""); }}>All blocks</button><button type="button" aria-pressed={volume === "transactions"} onClick={() => setVolume("transactions")}>With transactions</button><button type="button" aria-pressed={volume === "highgas"} onClick={() => setVolume("highgas")} title={`Gas used above ${HIGH_GAS_SHARE * 100}% of the block gas limit`}>High gas</button><button type="button" aria-expanded={filtersOpen} aria-controls="block-ledger-filters" onClick={() => setFiltersOpen(!filtersOpen)}>☷ Filters</button></div></header>
      {filtersOpen && <div className="bx-filters" id="block-ledger-filters"><label className="bx-search"><Glyph name="search" /><input aria-label="Search blocks" placeholder="Search height, hash, proposer or beneficiary…" value={query} onChange={(event) => setQuery(event.target.value)} /></label><select aria-label="Block contents" value={volume} onChange={(event) => setVolume(event.target.value as BlockVolume)}><option value="all">Any tx count</option><option value="transactions">With transactions</option><option value="empty">Empty blocks</option><option value="highgas">High gas (&gt;{HIGH_GAS_SHARE * 100}% of limit)</option></select><select aria-label="Sort blocks" value={ascending ? "asc" : "desc"} onChange={(event) => setAscending(event.target.value === "asc")}><option value="desc">Newest first</option><option value="asc">Oldest first</option></select></div>}
      <div className="bx-table-scroll" tabIndex={0} role="region" aria-label="Block ledger"><table className="bx-table"><thead><tr><th>Height</th><th>UTC time</th><th>Proposed by</th><th>Txs</th><th title="Gas used as a share of the block gas limit">Gas used</th><th>Base fee</th><th>Finality</th><th><span className="bx-action-label">Inspect</span></th></tr></thead><tbody>{rows.map((block) => <tr key={block.number} className={block.number === picked?.number ? "selected" : ""} onClick={() => pick(block.number)}>
        <td><button className="bx-height" type="button" onClick={() => pick(block.number)} aria-pressed={block.number === picked?.number}>{fmt(block.number)}</button></td><td title={new Date(block.time).toUTCString()}><span>{utcTime(block.time)}</span><small className="bx-ledger-age"><Timestamp value={block.time} /></small></td><td><Proposer block={block} size={26} /></td><td>{fmt(block.tx_count)}</td><td><BarValue block={block} /></td><td>{gwei(block.base_fee_per_gas)}</td><td><Finalized /></td><td><button className="bx-inspect-button" type="button" aria-label={`Open block ${block.number} inspector`} onClick={(event) => { event.stopPropagation(); pick(block.number); document.querySelector('.bx-inspector')?.scrollIntoView({ behavior: preferredScrollBehavior(), block: "nearest" }); }}>›</button></td>
      </tr>)}{rows.length === 0 && <tr><td colSpan={8} className="bx-empty">{onHead ? (loading ? "Loading indexed blocks…" : error ?? (base.length ? "No blocks on this page match your filters." : "No blocks indexed yet.")) : olderError ?? (olderReady ? (base.length ? "No blocks on this page match your filters." : "No older blocks.") : "Loading older blocks…")}{base.length > 0 && <button type="button" onClick={() => { setQuery(""); setVolume("all"); }}>Clear filters</button>}</td></tr>}</tbody></table></div>
      <footer><span>{base.length ? `#${fmt(Math.max(...base.map((b) => b.number)))} – #${fmt(lowest)} · ${rows.length} shown` : "0 blocks"}{pageSource === "rpc" ? " · older than the indexed window, served by the archive RPC" : volume !== "all" || query ? " · filters apply to this page" : ""}</span><nav aria-label="Block pages"><button type="button" aria-label="Newest blocks" disabled={onHead} onClick={resetPaging}>«</button><button type="button" aria-label="Newer block page" disabled={onHead} onClick={() => setCursors((c) => c.slice(0, -1))}>‹</button><button type="button" aria-current="page" aria-label={`Block page ${cursors.length + 1}`}>{cursors.length + 1}</button><button type="button" aria-label="Older block page" disabled={!canOlder} onClick={() => lowest !== null && setCursors((c) => [...c, lowest])}>›</button></nav><label>Rows <select aria-label="Blocks per page" value={perPage} onChange={(event) => { setPerPage(Number(event.target.value)); resetPaging(); }}>{[10, 25, 50].map((count) => <option key={count} value={count}>{count}</option>)}</select></label></footer>
    </section>
    <BlockInspector block={picked} detail={selectedDetail} height={selectedHeight} chainHead={chainHead} findBlock={findBlock} onSelect={pick} copied={copied} onCopy={copy} pending={loading} retainHours={retainHours} tab={tab} setTab={setTab} autoParallel={selected !== null} /></div>
    <BlockAnalytics blocks={blocks} selected={picked} detail={selectedDetail} onSelect={pick} />
    <div className="bx-footnote"><span>MONAD MAINNET / CHAIN HISTORY / {d.net?.chain_id ?? 143}</span><span>Finalized blocks only · {retainHours} h indexed window</span></div>
  </div>;
}

function utcTime(time: string) { return new Date(time).toLocaleTimeString("en-GB", { timeZone: "UTC", hour12: false }); }
function proposerLabel(b: Block) { return b.proposer_name ?? (b.proposer_id !== null ? `Validator #${b.proposer_id}` : "Unknown proposer"); }
function Proposer({ block: b, size }: { block: Block; size: number }) {
  const label = proposerLabel(b);
  return <div className="bx-proposer"><ValidatorAvatar id={b.proposer_id} seed={b.miner} hasLogo={!!b.proposer_logo} title={label} size={size} />{b.proposer_id !== null ? <a href={`#/validators/${b.proposer_id}`} onClick={(event) => event.stopPropagation()} title={label}>{label}</a> : <span title={b.miner}>{label}</span>}</div>;
}
/** Gas used against the block gas limit, drawn as segments. */
function GasStrip({ block, compact = false }: { block: Block; compact?: boolean }) {
  const s = gasShare(block);
  const segments = compact ? 10 : 40;
  const filled = s === null ? 0 : s > 0 ? Math.max(1, Math.round(s * segments)) : 0;
  return <span className={`bx-gas-strip ${compact ? "compact" : ""} ${s === null ? "unknown" : ""} ${s !== null && s > HIGH_GAS_SHARE ? "high" : ""}`} role="img" aria-label={s === null ? "Gas use unknown" : `${pct(s * 100)} of the block gas limit used`}>{Array.from({ length: segments }, (_, i) => <i key={i} className={i < filled ? "used" : ""} />)}</span>;
}

function Glyph({ name }: { name: string }) {
  const paths: Record<string, string> = { cube: "m12 2 9 5v10l-9 5-9-5V7l9-5ZM3 7l9 5 9-5M12 12v10M7.5 4.5l9 5", pulse: "M2 12h4l3-8 5 16 3-8h5", clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4v5l3 2", search: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5 12 6 6", gas: "M12 3C6 3 3 5 3 7s3 4 9 4 9-2 9-4-3-4-9-4ZM3 7v10c0 2 3 4 9 4s9-2 9-4V7M3 12c0 2 3 4 9 4s9-2 9-4", shield: "M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Zm-3 9 2 2 4-4", archive: "M3 5h18v4H3zM5 9v10h14V9M10 13h4" };
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] ?? paths.cube} /></svg>;
}
function LiveBadge({ live = true }: { live?: boolean }) { return <span className={`bx-live ${live ? "" : "paused"}`}><i />{live ? "Live" : "Paused"}</span>; }
function Finalized() { return <span className="bx-finalized"><i />Finalized</span>; }
function BarValue({ block }: { block: Block }) { const s = gasShare(block); return <span className="bx-bar-value" title={`${fmt(block.gas_used)} / ${fmt(block.gas_limit)} gas`}><span>{compact(block.gas_used)}</span><i><b style={{ width: `${Math.min(100, (s ?? 0) * 100)}%` }} /></i><small>{share(block)}</small></span>; }

type InspectorProps = { block?: Block; detail?: Detail; height: number | null; chainHead?: number; findBlock: (height: number) => Block | undefined; onSelect: (height: number) => void; copied: string | null; onCopy: (value: string) => void; pending: boolean; retainHours: number; tab: string; setTab: (tab: string) => void; autoParallel: boolean };
function BlockInspector({ block: b, detail, height, chainHead, findBlock, onSelect, copied, onCopy, pending, retainHours, tab, setTab, autoParallel }: InspectorProps) {
  const txs = detail?.txs ?? [];
  const txsLoaded = !!detail && !detail.loading && !detail.error;
  const fees = txsLoaded ? sumWei(txs, "fee") : null;
  const value = txsLoaded ? sumWei(txs, "value") : null;
  const s = b ? gasShare(b) : null;
  const hasNext = b !== undefined && chainHead !== undefined && b.number < chainHead;
  const headerFields: [string, string | null, string | null][] = b ? [["Block hash", b.hash, null], ["Parent hash", b.parent_hash, null], ["Beneficiary", b.miner, addressRoute(b.miner)]] : [];
  return <aside className="bx-card bx-inspector" aria-label="Block inspector">
    <header><div><span className="bx-inspector-kicker">Block inspector · selected</span><h2>{b ? `#${fmt(b.number)}` : height !== null ? `#${fmt(height)}` : "Select a height"}</h2></div><div className="bx-inspector-state">{b && <Finalized />}{b && <small><Timestamp value={b.time} /> · {utcTime(b.time)} UTC</small>}{b && <span className="bx-inspector-nav"><button type="button" disabled={b.number <= 0} onClick={() => onSelect(b.number - 1)} aria-label="Previous block">‹ Prev</button><button type="button" disabled={!hasNext} onClick={() => onSelect(b.number + 1)} aria-label="Next block">Next ›</button></span>}</div></header>
    {!b ? <p className="bx-empty">{detail?.error ?? (pending || detail?.loading ? "Loading selected block…" : "Select a block to inspect it.")}</p> : <>
      <nav className="bx-tabs" aria-label="Block detail tabs">{["Header", "Transactions", "Gas & fees", "Raw JSON"].map((value) => <button type="button" key={value} onClick={() => setTab(value)} aria-pressed={tab === value}>{value}{value === "Transactions" ? ` (${fmt(b.tx_count)})` : ""}</button>)}</nav>
      <div className="bx-detail-metrics">{[["Transactions", fmt(b.tx_count)], ["Base fee", b.base_fee_per_gas ? gwei(b.base_fee_per_gas, 0) : "—"], ["Gas used", `${compact(b.gas_used)} · ${share(b)}`], ["Proposer", proposerLabel(b)]].map(([label, val]) => <div key={label}><span>{label}</span><strong title={val}>{val}</strong></div>)}</div>
      <section className="bx-participation"><header><h3>Gas usage</h3><span className={s !== null && s > HIGH_GAS_SHARE ? "bx-high" : ""}>{fmt(b.gas_used)} / {fmt(b.gas_limit)} · {share(b)}</span></header><GasStrip block={b} /><p>Base fee {gwei(b.base_fee_per_gas)} · Monad charges each transaction for its full gas limit.</p></section>
      <ParallelPanel key={b.number} height={b.number} txCount={b.tx_count} auto={autoParallel} />
      <div className="bx-detail-body">
        {tab === "Header" && <><div className="bx-public-header"><h3>Block header</h3><button type="button" onClick={() => onCopy(JSON.stringify({ number: b.number, hash: b.hash, parent_hash: b.parent_hash, miner: b.miner, time: b.time }, null, 2))}>{copied?.startsWith('{\n  "number"') ? "Copied ✓" : "Copy values ↗"}</button></div><dl className="bx-fields">
          {headerFields.map(([label, val, href]) => <div key={label}><dt>{label}</dt><dd>{val ? href ? <a href={href} title={val}>{middle(val, 10, 8)}</a> : <span title={val}>{middle(val, 10, 8)}</span> : <span>—</span>}{val && <CopyButton value={val} copied={copied === val} onCopy={onCopy} />}</dd></div>)}
          <div><dt>Proposer</dt><dd><Proposer block={b} size={18} /></dd></div>
          <div><dt>Time (UTC)</dt><dd><span>{new Date(b.time).toISOString().replace("T", " ").replace(".000Z", "")}</span></dd></div>
          <div><dt>Gas used / limit</dt><dd><span>{fmt(b.gas_used)} / {fmt(b.gas_limit)}</span></dd></div>
          <div><dt>Base fee</dt><dd><span>{gwei(b.base_fee_per_gas)}</span></dd></div>
          <div><dt>Total fees</dt><dd><span>{fees === null ? "—" : mon(fees, 6)}</span></dd></div>
          <div><dt>Value transferred</dt><dd><span>{value === null ? "—" : mon(value, 4)}</span></dd></div>
        </dl><HashContinuity block={b} child={hasNext ? findBlock(b.number + 1) : undefined} hasNext={hasNext} onSelect={onSelect} /></>}
        {tab === "Transactions" && (!detail || detail.loading ? <p className="bx-muted">Loading this block’s transactions…</p> : detail.error ? <p className="bx-notice">{detail.error}</p> : <div className="bx-transactions">{txs.map((tx) => <a href={txRoute(tx.hash)} key={tx.hash}><span><strong>{methodLabel(tx.method, tx.input_size, tx.to)}</strong><small>#{tx.tx_index} · {short(tx.hash)} · {short(tx.from)} → {tx.to ? short(tx.to) : "Create"}</small></span><span className="bx-tx-value">{tx.value === "0" ? "" : mon(tx.value, 4)}</span><span className={tx.status === 1 ? "bx-success" : "bx-notice"}>{tx.status === 1 ? "Success" : "Failed"}</span><span aria-hidden="true">↗</span></a>)}{!txs.length && <p className="bx-muted">{b.tx_count === 0 ? "This block contains no transactions." : "No transactions returned for this block."}</p>}{txs.length > 0 && txs[0]!.fee === "0" && transactionKind(txs[0]!) === "Staking" && <p className="bx-muted">Transaction #0 is the zero-gas system call to the staking precompile that opens every Monad block.</p>}</div>)}
        {tab === "Gas & fees" && <><dl className="bx-fields"><div><dt>Finality</dt><dd><Finalized /></dd></div><div><dt>Gas used</dt><dd><span>{fmt(b.gas_used)}</span></dd></div><div><dt>Gas limit</dt><dd><span>{fmt(b.gas_limit)}</span></dd></div><div><dt>Utilization</dt><dd><span>{share(b)}</span></dd></div><div><dt>Base fee per gas</dt><dd><span>{gwei(b.base_fee_per_gas)}</span></dd></div><div><dt>Total fees paid</dt><dd><span>{fees === null ? "—" : mon(fees, 6)}</span></dd></div><div><dt>Fee-paying transactions</dt><dd><span>{txsLoaded ? fmt(txs.filter((tx) => tx.fee !== "0").length) : "—"}</span></dd></div><div><dt>Zero-gas system calls</dt><dd><span>{txsLoaded ? fmt(txs.filter((tx) => tx.fee === "0").length) : "—"}</span></dd></div></dl><p className="bx-muted">Block gas used is the sum of transaction gas limits: Monad charges gas on the limit, so receipts report gas used equal to the gas limit.</p></>}
        {tab === "Raw JSON" && <><p className="bx-muted">Block record as reported by the explorer API{detail?.source === "rpc" ? " (read through from the archive RPC)" : ""}.</p><pre className="bx-raw-json">{JSON.stringify({ source: detail?.source ?? null, block: b, txs: txsLoaded ? txs.length : null }, null, 2)}</pre></>}
      </div>
      {detail?.source === "rpc" ? <div className="bx-visibility"><Glyph name="archive" /><span><strong>Via archive RPC</strong> · This block is older than the {retainHours} h indexed window and was read through from the archive RPC.</span></div> : <div className="bx-visibility"><Glyph name="shield" /><span><strong>Finalized</strong> · Only finalized Monad blocks are indexed, so this block cannot be reorganized.</span></div>}
    </>}
  </aside>;
}

function HashContinuity({ block, child, hasNext, onSelect }: { block: Block; child?: Block; hasNext: boolean; onSelect: (height: number) => void }) {
  const childMatches = child ? block.hash.toLowerCase() === child.parent_hash.toLowerCase() : null;
  const nodes = [
    { label: "Parent", height: block.number - 1, hash: block.number > 0 ? block.parent_hash : null, enabled: block.number > 0, note: "No parent" },
    { label: "Selected", height: block.number, hash: block.hash, enabled: false, note: "" },
    { label: "Child", height: block.number + 1, hash: child?.hash ?? null, enabled: hasNext, note: hasNext ? "Open to load" : "Waiting for next block" },
  ];
  return <section className="bx-continuity"><header><h3>Hash-linked continuity</h3><span>Parent ← block → child</span></header><div className="bx-continuity-track">{nodes.map((node) => <button type="button" key={node.label} className={node.label === "Selected" ? "selected" : ""} disabled={!node.enabled} onClick={() => onSelect(node.height)} title={node.hash ?? undefined}><span>{node.label}</span><code>{node.hash ? short(node.hash) : "—"}</code><small>{node.hash || node.enabled ? `#${fmt(node.height)}` : node.note}</small></button>)}</div>{childMatches !== null && <p className={childMatches ? "bx-muted" : "bx-notice"}>{childMatches ? "The child block references this block’s hash." : "The child block reports a different parent hash."}</p>}</section>;
}

function BlockAnalytics({ blocks, selected, detail, onSelect }: { blocks: Block[]; selected?: Block; detail?: Detail; onSelect: (height: number) => void }) {
  const transactions = detail && !detail.loading && !detail.error ? detail.txs : [];
  const groups = [
    { name: "Contract call", kind: "Contract calls", color: "var(--brand)", n: 0 },
    { name: "Transfer", kind: "Transfers", color: "var(--ok)", n: 0 },
    { name: "Create", kind: "Creates", color: "var(--tx3)", n: 0 },
    { name: "Staking", kind: "Staking", color: "var(--warn)", n: 0 },
  ];
  for (const tx of transactions) groups.find((group) => group.kind === transactionKind(tx))!.n++;
  const failed = transactions.filter((tx) => tx.status === 0).length;
  const gasBlocks = blocks.slice(0, 32).reverse();
  const peak = Math.max(0, ...gasBlocks.map((b) => gasShare(b) ?? 0));
  const [expanded, setExpanded] = useState(false);
  return <div className="bx-analytics bx-chain-analytics">
    <Analytic title="Transaction types" subtitle={selected ? `Selected block #${fmt(selected.number)}` : "Select a block"} icon="cube">
      {!detail || detail.loading ? <p className="bx-muted">Loading the selected block’s contents…</p> : detail.error ? <p className="bx-notice">{detail.error}</p> : <><p className="bx-muted">Kinds across {transactions.length} transactions, from destination and method selector.</p><div className="bx-message-distribution" role="img" aria-label={groups.map((group) => `${group.name}: ${group.n}`).join(", ")}>{groups.filter((group) => group.n > 0).map((group) => <i key={group.name} title={`${group.name}: ${group.n}`} style={{ flex: group.n, background: group.color }} />)}</div><ul className="bx-message-legend">{groups.map((group) => <li key={group.name}><i style={{ background: group.color }} /><span>{group.name}</span><strong>{transactions.length ? pct(group.n / transactions.length * 100, 0) : "—"}</strong></li>)}</ul><p className="bx-muted">{selected?.tx_count === 0 ? "This block contains no transactions." : `${failed} failed · staking is the per-block system call.`}</p></>}
    </Analytic>
    <Analytic title="Gas used per block" subtitle={`Recent ${gasBlocks.length} blocks · share of gas limit`} icon="gas"><p className="bx-muted">Each column is gas used against that block’s gas limit.</p><div className="bx-gas-columns">{gasBlocks.map((block) => { const s = gasShare(block); return <button type="button" key={block.number} className={`${block.number === selected?.number ? "selected" : ""} ${s === null ? "unknown" : ""}`} onClick={() => onSelect(block.number)} title={`Block ${fmt(block.number)} · ${fmt(block.gas_used)} gas · ${share(block)}`} aria-label={`Inspect block ${block.number}: ${share(block)} of gas limit`}><i style={{ height: `${s === null || s === 0 ? 4 : Math.max(5, s * 100)}%` }} /></button>; })}</div><div className="bx-chart-axis"><span>Older</span><span>Peak {gasBlocks.length ? pct(peak * 100) : "—"}</span><span>Head →</span></div><p className="bx-muted">Column height is the full gas limit ({gasBlocks[0] ? compact(gasBlocks[0].gas_limit) : "—"}).</p></Analytic>
    <Analytic title="Block signals" subtitle="Recent finalized blocks" icon="pulse" action={<button type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>{expanded ? "Show less" : "View all →"}</button>}><div className="bx-events">{blocks.slice(0, expanded ? 50 : 5).map((block) => { const s = gasShare(block) ?? 0; const high = s > HIGH_GAS_SHARE; return <button type="button" key={block.number} onClick={() => onSelect(block.number)}><i className={high ? "warn" : ""} /><span>#{fmt(block.number)}</span><strong>{high ? `High gas · ${share(block)} of limit` : block.tx_count === 0 ? "Finalized · empty" : `Finalized · ${fmt(block.tx_count)} tx · ${share(block)} gas`}</strong><small><Timestamp value={block.time} /></small></button>; })}{!blocks.length && <p className="bx-muted">No recent blocks.</p>}</div></Analytic>
  </div>;
}
function Analytic({ title, subtitle, icon, children, action }: { title: string; subtitle?: string; icon: string; children: ReactNode; action?: ReactNode }) { return <section className="bx-card bx-analytic"><header><Glyph name={icon} /><div><h3>{title}</h3>{subtitle && <small>{subtitle}</small>}</div>{action}</header>{children}</section>; }

/**
 * Parallel execution summary for the inspected block. Loaded lazily after the
 * block itself (untraced blocks are traced on demand, which can take seconds);
 * while following the head it waits for a click so each new head block does
 * not trigger a trace. Failures stay quiet: a short note, never an alert.
 */
type ParallelState = { data: BlockParallelism | null; failed: boolean; loading: boolean };
function ParallelPanel({ height, txCount, auto }: { height: number; txCount: number; auto: boolean }) {
  const [wanted, setWanted] = useState(auto);
  const [state, setState] = useState<ParallelState>({ data: null, failed: false, loading: false });
  const trivial = txCount <= 1;
  useEffect(() => {
    if (!wanted || trivial) return;
    let cancelled = false;
    // A short delay keeps fast Prev/Next stepping from tracing every height passed.
    const timer = window.setTimeout(() => {
      setState({ data: null, failed: false, loading: true });
      loadBlockParallelism(height).then((data) => { if (!cancelled) setState({ data, failed: false, loading: false }); }).catch(() => { if (!cancelled) setState({ data: null, failed: true, loading: false }); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [wanted, trivial, height]);
  const p = state.data;
  const analysed = p ? Math.max(0, p.tx_count - 1) : 0;
  const link = <a className="bx-parallel-link" href={`#/parallel/${height}`}>Open dependency graph →</a>;
  return <section className="bx-parallel" aria-label="Parallel execution">
    <header><h3>Parallel execution</h3>{p && <span className="bx-parallel-source">{p.source === "indexed" ? "Sampled trace" : "Traced on demand"}</span>}</header>
    {trivial ? <p className="bx-muted">{txCount === 0 ? "No transactions in this block." : "Only the reward syscall: nothing to schedule in parallel."}</p>
      : !wanted ? <div className="bx-parallel-idle"><p className="bx-muted">See which transactions could run side by side and what serialised the rest.</p><button type="button" onClick={() => setWanted(true)}>Analyse dependencies</button></div>
      : state.failed ? <p className="bx-muted">Dependency data is unavailable for this block right now. {link}</p>
      : !p ? <div className="bx-parallel-skeleton" aria-busy="true"><div className="bx-parallel-stats">{[0, 1, 2].map((i) => <div key={i}><Skeleton h={10} w="60%" /><Skeleton h={18} w="45%" /></div>)}</div><Skeleton h={56} w="100%" r={6} /></div>
      : <>
        <div className="bx-parallel-stats">
          <div><span>Parallelism</span><strong>{speedup(p.parallelism)}</strong></div>
          <div><span>Critical path</span><strong>{fmt(p.critical_path)} {p.critical_path === 1 ? "tx" : "txs"}</strong></div>
          <div><span>Dependent txs</span><strong>{fmt(p.dependent_txs)}<small>/{fmt(analysed)}</small></strong></div>
        </div>
        {p.levels.length > 0 && <DependencyLanes compact levels={p.levels} edges={p.edge_list} totalEdges={p.edges} txs={p.txs} labels={p.labels} />}
        <p className="bx-parallel-foot"><span>Ideal speed-up from read/write sets; conservative, excludes tx 0.</span>{link}</p>
      </>}
  </section>;
}
