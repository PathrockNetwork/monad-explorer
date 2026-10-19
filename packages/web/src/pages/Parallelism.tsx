/**
 * Parallel execution: how much of each sampled block could run concurrently
 * under an optimistic scheduler, and which contracts serialise it. The summary
 * lives at #/parallel; #/parallel/<n> drills into one block's dependency graph.
 */
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import type { Dashboard } from "../useDashboard";
import { getParallelism, type BlockParallelism, type ParallelismSummary } from "../api";
import { fmt, methodLabel, middle, pct, short } from "../lib";
import { Identicon, Skeleton } from "../components/ui";
import { DependencyLanes, labelFor } from "../components/DependencyLanes";
import { DEFAULT_RANGES, chartSegments, rangeLabel, seriesExtent, type ChartPoint } from "../analyticsExplorer";
import { loadBlockParallelism, parallelismError, speedup } from "../blockExplorer";
import { addressRoute, txRoute } from "../transactionExplorer";
import "./parallelism.css";

const blockFromLocation = () => { const m = location.hash.match(/^#\/parallel\/(\d+)\/?$/); const n = Number(m?.[1]); return m && Number.isSafeInteger(n) && n >= 0 ? n : null; };
const time = (ms: number, day = false) => new Date(ms).toLocaleString("en-GB", { timeZone: "UTC", ...(day ? { month: "short", day: "2-digit" } : {}), hour: "2-digit", minute: "2-digit" });
const num = (v: number | null | undefined, digits = 1) => (v == null || !Number.isFinite(v) ? "—" : v.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits }));
const share = (v: number | null | undefined, digits = 1) => (v == null || !Number.isFinite(v) ? "—" : pct(v * 100, digits));
const POLL_MS = 60_000;

export function Parallelism({ d }: { d: Dashboard }) {
  const [block, setBlock] = useState<number | null>(blockFromLocation);
  useEffect(() => { const sync = () => setBlock(blockFromLocation()); window.addEventListener("hashchange", sync); return () => window.removeEventListener("hashchange", sync); }, []);
  return block === null ? <Summary d={d} /> : <BlockGraph key={block} d={d} n={block} />;
}

/* ───────────────────────────── summary ───────────────────────────── */

function Summary({ d }: { d: Dashboard }) {
  const ranges = d.config?.metric_hours?.length ? d.config.metric_hours : DEFAULT_RANGES;
  const [hours, setHours] = useState(() => (ranges.includes(6) ? 6 : ranges[0] ?? 6));
  const [data, setData] = useState<ParallelismSummary | null>(null);
  const [error, setError] = useState(false);
  const [updated, setUpdated] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => getParallelism(hours).then((r) => { if (!cancelled) { setData(r); setError(false); setUpdated(Date.now()); } }).catch(() => { if (!cancelled) setError(true); });
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [hours]);

  const shown = data?.hours ?? hours, label = rangeLabel(shown);
  const end = updated ?? Date.now();
  const windowStart = end - shown * 3_600_000;
  const step = (data?.bucket_secs ?? 300) * 1000;
  const firstT = data?.series.length ? Math.min(...data.series.map((p) => Date.parse(p.t)).filter(Number.isFinite)) : NaN;
  const start = Number.isFinite(firstT) ? Math.max(windowStart, firstT) : windowStart;
  const day = shown > 24;
  const par = useMemo<ChartPoint[]>(() => (data?.series ?? []).map((p) => ({ t: Date.parse(p.t), value: Number.isFinite(p.parallelism) ? p.parallelism : null })).filter((p) => Number.isFinite(p.t)).sort((a, b) => a.t - b.t), [data]);
  const dep = useMemo<ChartPoint[]>(() => (data?.series ?? []).map((p) => ({ t: Date.parse(p.t), value: p.dependent_share == null || !Number.isFinite(p.dependent_share) ? null : p.dependent_share * 100 })).filter((p) => Number.isFinite(p.t)).sort((a, b) => a.t - b.t), [data]);
  const t = data?.totals;
  const every = data?.trace_every ?? null;
  const loading = !data && !error;
  const parExt = seriesExtent(par), depExt = seriesExtent(dep);

  const stats: { label: string; value: string; note: string; tone?: string }[] = [
    { label: `Avg parallelism · ${label}`, value: speedup(t?.parallelism), note: "Mean of txs ÷ critical path per traced block", tone: "brand" },
    { label: "Median parallelism", value: speedup(t?.median_parallelism), note: "Half of traced blocks score below this" },
    { label: "Avg critical path", value: t?.critical_path == null ? "—" : `${num(t.critical_path)} txs`, note: "Longest dependency chain per block" },
    { label: "Dependent transactions", value: share(t?.dependent_share), note: "Read or overwrote state an earlier tx wrote" },
    { label: "Traced blocks", value: fmt(t?.traced_blocks), note: t ? `of ${fmt(t.blocks)} in the window${every ? ` · sampled every ${every === 1 ? "block" : `${ordinal(every)} block`}` : ""}` : "Sampled blocks in the window" },
    { label: "Internal transfers", value: fmt(t?.internal_txs), note: "Value-moving inner calls in traced blocks" },
  ];
  const hist = data?.critical_path_histogram ?? [];
  const histMax = Math.max(1, ...hist.map((h) => h.n));
  const histTotal = hist.reduce((s, h) => s + h.n, 0);
  const histBars = Array.from({ length: 12 }, (_, i) => ({ path: i + 1, n: hist.find((h) => h.path === i + 1)?.n ?? 0 }));
  const mode = histTotal ? histBars.reduce((a, b) => (b.n > a.n ? b : a)) : null;
  const hot = data?.hot ?? [];
  const hotMax = Math.max(1, ...hot.map((h) => h.edges));
  const serial = (data?.extremes ?? []).filter((e) => e.kind === "serial");
  const parallel = (data?.extremes ?? []).filter((e) => e.kind === "parallel");

  return <div className="px-page">
    <div className="px-toolbar"><span>{data ? `${time(windowStart, true)} – ${time(end, true)} UTC · traced sample` : error ? "Parallelism data unavailable" : "Loading parallelism sample…"}</span><div className="px-ranges" aria-label="Parallelism time range">{ranges.map((h) => <button key={h} type="button" aria-pressed={hours === h} onClick={() => setHours(h)}>{rangeLabel(h)}</button>)}</div></div>
    {data && start > windowStart + step && <div className="px-notice" role="status"><span>Traced history starts {time(start, true)} UTC, after the start of this {label} window; the charts begin there.</span></div>}
    {(error || (data && hours !== shown)) && <div className="px-notice" role="status"><span>{error ? `The parallelism summary could not refresh.${data ? ` Showing the last loaded ${label} snapshot.` : ""}` : `Loading ${rangeLabel(hours)} · showing ${label} until it arrives.`}</span></div>}
    <div className="px-stats">{stats.map((s) => <section className={`px-panel px-stat ${s.tone ?? ""}`} key={s.label}><div className="px-stat-label"><span>{s.label}</span></div><div className="px-stat-value">{loading ? <Skeleton h={28} w="60%" /> : <strong>{s.value}</strong>}</div><p title={s.note}>{s.note}</p></section>)}</div>

    <div className="px-main-grid">
      <section className="px-panel px-chart-card">
        <PanelHeading title="Parallelism over time" description="Average ideal speed-up (txs ÷ critical path) of the traced blocks in each bucket." right={<span className="px-range-label">{label}</span>} />
        <SeriesChart label="Avg parallelism" points={par} start={start} end={end} step={step} day={day} domain={[0, axisMax((parExt.max ?? 0) * 1.15, 2)]} format={(v) => speedup(v)} tick={(v) => `${Number(v.toFixed(2))}×`} loading={loading} height={190} />
        <div className="px-subchart-head"><span>Dependent share</span><span>Bucket range <b>{depExt.min === null ? "—" : `${pct(depExt.min)} – ${pct(depExt.max)}`}</b></span></div>
        <SeriesChart label="Dependent share" points={dep} start={start} end={end} step={step} day={day} domain={[0, 100]} format={(v) => pct(v)} tick={(v) => `${Math.round(v)}%`} loading={loading} height={78} tone="ok" axisTicks={3} />
        <div className="px-chart-footer"><span className="px-legend"><i className="brand" />Avg parallelism</span><span className="px-legend"><i className="ok" />Dependent share</span><span>Window <b>{speedup(t?.parallelism)}</b> <i>·</i> Peak bucket <b>{speedup(parExt.max)}</b></span></div>
      </section>
      <section className="px-panel px-hist-card">
        <PanelHeading title="Critical path length" description="Traced blocks by their longest dependency chain. Shorter is more parallel." right={<span className="px-range-label">{fmt(histTotal)} blocks</span>} />
        {histTotal ? <><div className="px-hist" role="img" aria-label={histBars.map((b) => `${b.path === 12 ? "12 or more" : b.path}: ${b.n} blocks`).join(", ")}>
          {histBars.map((b) => <div key={b.path} className="px-hist-col" title={`Critical path ${b.path === 12 ? "12 or more" : b.path}: ${fmt(b.n)} blocks (${pct(b.n / histTotal * 100)})`}><span className="px-hist-n">{b.n ? fmt(b.n) : ""}</span><i className={b.path === mode?.path ? "mode" : ""} style={{ height: `${b.n ? Math.max(2, b.n / histMax * 100) : 0}%` }} /><span className="px-hist-x">{b.path === 12 ? "12+" : b.path}</span></div>)}
        </div><p className="px-footnote">Most common: a {mode?.path === 12 ? "12+" : mode?.path}-transaction chain ({pct(mode ? mode.n / histTotal * 100 : null)} of blocks). A path of 1 means nothing in the block depended on anything else.</p></> : <Empty loading={loading} text="No traced blocks in this window yet." />}
      </section>
    </div>

    <div className="px-support-grid">
      <section className="px-panel px-hot">
        <PanelHeading title="Hot contracts" description="Contracts whose state caused the most dependency edges across traced blocks." right={<span className="px-count">{data ? hot.length : "—"}</span>} />
        {hot.length ? <div className="px-table-wrap"><table className="px-table"><thead><tr><th>#</th><th>Contract</th><th className="num">Edges</th><th className="num">Blocks</th></tr></thead><tbody>{hot.slice(0, 12).map((h, i) => <tr key={h.address}><td className="rank">{i + 1}</td><td><a className="px-addr" href={addressRoute(h.address)} title={h.address}><Identicon address={h.address} size={16} /><span>{h.label?.name ?? short(h.address)}</span>{h.label && <small>{h.label.kind}</small>}</a><i className="px-bar"><b style={{ width: `${h.edges / hotMax * 100}%` }} /></i></td><td className="num">{fmt(h.edges)}</td><td className="num">{fmt(h.blocks)}</td></tr>)}</tbody></table></div> : <Empty loading={loading} text="No contended contracts in this window." />}
      </section>
      <section className="px-panel px-extremes">
        <PanelHeading title="Recent extremes" description="Traced blocks in the window with the most and least parallel structure." />
        <ExtremeList title="Most serial" note="≥ 5 txs, longest chain relative to size" rows={serial} loading={loading} tone="warn" />
        <ExtremeList title="Most parallel" note="Highest txs ÷ critical path" rows={parallel} loading={loading} tone="ok" />
      </section>
      <div className="px-side">
        <section className="px-panel"><PanelHeading title="Open a block" description="Any finalized block works; untraced blocks are traced on demand." /><BlockJump chainHead={d.net?.chain_finalized ?? null} /></section>
        <section className="px-panel px-method"><PanelHeading title="How this is measured" /><Method every={every} /></section>
      </div>
    </div>
    <div className="px-method-note">All times UTC · {Math.round(step / 60_000)}-minute buckets · {every ? `every ${every === 1 ? "block" : `${ordinal(every)} block`} is traced` : "sampled blocks"} with prestateTracer · parallelism is an ideal upper bound, not measured node performance{updated ? ` · updated ${time(updated)} UTC` : ""}.</div>
  </div>;
}

function ExtremeList({ title, note, rows, loading, tone }: { title: string; note: string; rows: ParallelismSummary["extremes"]; loading: boolean; tone: string }) {
  return <div className="px-extreme"><h3><i className={`px-dot ${tone}`} />{title}<small>{note}</small></h3>{rows.length ? <ul>{rows.map((r) => <li key={r.block_number}><a href={`#/parallel/${r.block_number}`}><span className="px-ext-n">#{fmt(r.block_number)}</span><span className="px-ext-meta">{fmt(r.tx_count)} txs · path {fmt(r.critical_path)}</span><strong className={tone}>{speedup(r.parallelism, 1)}</strong></a></li>)}</ul> : <p className="px-muted">{loading ? "Loading…" : "No blocks yet."}</p>}</div>;
}

function Method({ every }: { every: number | null }) {
  return <ul className="px-observations">
    <li><i className="px-dot brand" /><div><strong>Dependency graph</strong><span>Monad runs a block’s transactions optimistically in parallel and re-executes any whose inputs an earlier one changed. From prestateTracer read/write sets, tx <em>j</em> depends on an earlier tx <em>i</em> if it read or overwrote state <em>i</em> wrote. Parallelism = txs ÷ critical path, the ideal speed-up over serial execution.</span></div></li>
    <li><i className="px-dot warn" /><div><strong>Conservative</strong><span>Conflicts are tracked per account and storage slot, so some may be over-counted. The fee recipient and the per-block reward syscall (tx 0) are excluded.</span></div></li>
    <li><i className="px-dot muted" /><div><strong>Structure, not re-executions</strong><span>This is the dependency structure an optimistic scheduler faces, not the node’s actual re-execution count, which Monad does not publish.</span></div></li>
    <li><i className="px-dot muted" /><div><strong>Sampled</strong><span>{every === 1 ? "Every block is traced." : every ? `Only every ${ordinal(every)} block is traced; averages describe that sample.` : "Only a sample of blocks is traced."}</span></div></li>
  </ul>;
}

/* ───────────────────────────── drill-down ───────────────────────────── */

function BlockGraph({ d, n }: { d: Dashboard; n: number }) {
  const [data, setData] = useState<BlockParallelism | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    const timer = window.setTimeout(() => setSlow(true), 1200);
    loadBlockParallelism(n).then((r) => { if (!cancelled) setData(r); }).catch((e) => { if (!cancelled) setError(parallelismError(e, n)); }).finally(() => clearTimeout(timer));
    return () => { cancelled = true; clearTimeout(timer); };
  }, [n, attempt]);
  const head = d.net?.chain_finalized ?? null;
  const preds = useMemo(() => { const c = new Array<number>(data?.levels.length ?? 0).fill(0); for (const [, b] of data?.edge_list ?? []) if (b < c.length) c[b]!++; return c; }, [data]);
  const maxLevel = data?.levels.length ? Math.max(...data.levels) : 0;
  const analysed = data ? Math.max(0, data.tx_count - 1) : 0;

  const stats: [string, string, string][] = data ? [
    ["Transactions", fmt(data.tx_count), analysed === data.tx_count ? "In this block" : `${fmt(analysed)} analysed · syscall excluded`],
    ["Dependent txs", fmt(data.dependent_txs), analysed ? `${pct(data.dependent_txs / analysed * 100)} of analysed txs` : "Nothing to depend on"],
    ["Dependency edges", fmt(data.edges), data.edges > data.edge_list.length ? `${fmt(data.edge_list.length)} returned` : "Read/write conflicts"],
    ["Critical path", `${fmt(data.critical_path)} ${data.critical_path === 1 ? "tx" : "txs"}`, "Longest dependency chain"],
    ["Parallelism", speedup(data.parallelism), "Ideal speed-up over serial"],
    ["Source", data.source === "indexed" ? "Indexed" : "Traced", data.source === "indexed" ? "From the sampled trace index" : "Traced on demand for this view"],
  ] : [];

  return <div className="px-page">
    <div className="px-toolbar px-crumbs"><span><a href="#/parallel">Parallel execution</a> <i>/</i> Block #{fmt(n)}</span><div className="px-crumb-actions"><a href={`#/parallel/${n - 1}`} className={n <= 0 ? "disabled" : ""} aria-disabled={n <= 0}>‹ Prev</a><a href={`#/parallel/${n + 1}`} className={head !== null && n >= head ? "disabled" : ""} aria-disabled={head !== null && n >= head}>Next ›</a><a href={`#/blocks/${n}`}>Block details ↗</a></div></div>
    {error ? <section className="px-panel"><Empty text={error} /><div className="px-center"><button type="button" className="px-btn" onClick={() => setAttempt((a) => a + 1)}>Retry</button><a className="px-btn" href="#/parallel">← Back to summary</a></div></section> : <>
      <div className="px-stats">{data ? stats.map(([label, value, note]) => <section className={`px-panel px-stat ${label === "Parallelism" ? "brand" : ""}`} key={label}><div className="px-stat-label"><span>{label}</span></div><div className="px-stat-value"><strong>{value}</strong></div><p title={note}>{note}</p></section>) : Array.from({ length: 6 }, (_, i) => <section className="px-panel px-stat" key={i}><Skeleton h={12} w="55%" /><div className="px-stat-value"><Skeleton h={28} w="45%" /></div><Skeleton h={10} w="75%" /></section>)}</div>
      <section className="px-panel px-lanes-card">
        <PanelHeading title="Dependency lanes" description={data ? `${fmt(data.tx_count)} transactions in ${fmt(maxLevel + 1)} ${maxLevel ? "levels" : "level"}. Each column is a depth level; a curve means the later transaction read or overwrote state the earlier one wrote.` : "Columns are depth levels; curves are read/write dependencies."} right={data && <span className="px-range-label">{speedup(data.parallelism)}</span>} />
        {data ? (data.levels.length ? <DependencyLanes levels={data.levels} edges={data.edge_list} totalEdges={data.edges} txs={data.txs} labels={data.labels} active={active} onActive={setActive} /> : <Empty text="This block has no transactions." />) : <div className="px-lanes-loading"><Skeleton h={150} w="100%" r={8} /><p className="px-muted">{slow ? "Tracing this block on demand — this can take a few seconds…" : "Loading the dependency graph…"}</p></div>}
      </section>
      <div className="px-detail-grid">
        <section className="px-panel px-txs">
          <PanelHeading title="Transactions" description="Block order. Level is the transaction’s depth in the dependency graph." right={data && <span className="px-count">{fmt(data.txs.length)}</span>} />
          {data ? (data.txs.length ? <div className="px-table-wrap px-tx-scroll"><table className="px-table px-tx-table"><thead><tr><th className="num">#</th><th>Tx hash</th><th>To</th><th>Method</th><th className="num">Level</th><th className="num">Waits on</th></tr></thead><tbody>{data.txs.map((tx) => <tr key={tx.hash} className={active === tx.index ? "active" : ""} onPointerEnter={() => setActive(tx.index)} onPointerLeave={() => setActive(null)}>
            <td className="num rank">{tx.index}</td>
            <td><a className="px-mono" href={txRoute(tx.hash)} title={tx.hash} onFocus={() => setActive(tx.index)} onBlur={() => setActive(null)}>{middle(tx.hash, 8, 6)}</a></td>
            <td>{tx.to ? <a className="px-addr" href={addressRoute(tx.to)} title={tx.to}><Identicon address={tx.to} size={14} /><span>{labelFor(data.labels, tx.to) ?? short(tx.to)}</span></a> : <span className="px-muted">Create</span>}</td>
            <td className="px-method-cell" title={tx.method ?? undefined}>{methodLabel(tx.method, tx.method ? 4 : 0, tx.to)}</td>
            <td className="num"><span className="px-level"><i><b style={{ width: `${maxLevel ? (tx.level / maxLevel) * 100 : 0}%` }} /></i>{tx.level}</span></td>
            <td className="num">{tx.index === 0 ? <span className="px-muted" title="The per-block reward syscall is excluded from the analysis">excl.</span> : fmt(preds[tx.index] ?? 0)}</td>
          </tr>)}</tbody></table></div> : <Empty text="This block has no transactions." />) : <div className="px-skel-rows">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} h={14} w="100%" />)}</div>}
        </section>
        <div className="px-side">
          <section className="px-panel px-hot">
            <PanelHeading title="Hot contracts in this block" description="Contracts whose state created the dependency edges." />
            {data ? (data.hot.length ? <div className="px-table-wrap"><table className="px-table"><thead><tr><th>Contract</th><th className="num">Edges</th><th className="num">Txs</th></tr></thead><tbody>{data.hot.map((h) => <tr key={h.address}><td><a className="px-addr" href={addressRoute(h.address)} title={h.address}><Identicon address={h.address} size={16} /><span>{labelFor(data.labels, h.address) ?? short(h.address)}</span></a></td><td className="num">{fmt(h.edges)}</td><td className="num">{fmt(h.txs)}</td></tr>)}</tbody></table></div> : <Empty text="No shared state: every transaction could run independently." />) : <div className="px-skel-rows">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} h={14} w="100%" />)}</div>}
          </section>
          <section className="px-panel"><PanelHeading title="Open another block" /><BlockJump chainHead={head} initial={n} /><div className="px-links"><a href={`#/blocks/${n}`}>Block #{fmt(n)} details ↗</a><a href="#/parallel">← Parallelism summary</a></div></section>
          <section className="px-panel px-method"><PanelHeading title="Reading this graph" /><ul className="px-observations"><li><i className="px-dot warn" /><div><strong>Conservative</strong><span>Account- and storage-slot-level conflicts, so some edges may be over-counted. The fee recipient and tx 0 (the reward syscall) are excluded.</span></div></li><li><i className="px-dot muted" /><div><strong>Scheduler’s view</strong><span>The structure an optimistic scheduler faces, not the node’s actual re-execution count, which Monad does not publish.</span></div></li></ul></section>
        </div>
      </div>
    </>}
  </div>;
}

/* ───────────────────────────── shared bits ───────────────────────────── */

function BlockJump({ chainHead, initial }: { chainHead: number | null; initial?: number }) {
  const [value, setValue] = useState(initial !== undefined ? String(initial) : "");
  const [invalid, setInvalid] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const h = Number(value.trim().replace(/[,#\s]/g, ""));
    if (!value.trim() || !Number.isSafeInteger(h) || h < 0 || (chainHead !== null && h > chainHead)) { setInvalid(true); return; }
    setInvalid(false);
    location.hash = `/parallel/${h}`;
  };
  return <form className="px-jump" onSubmit={submit}><input inputMode="numeric" aria-label="Block number" aria-invalid={invalid} placeholder={chainHead !== null ? `Block number, e.g. ${chainHead.toLocaleString("en-US")}` : "Block number"} value={value} onChange={(e) => { setValue(e.target.value); setInvalid(false); }} /><button type="submit">Open →</button>{invalid && <span className="px-jump-error" role="alert">Enter a finalized block number{chainHead !== null ? ` up to ${fmt(chainHead)}` : ""}.</span>}</form>;
}

/** Axis ceiling whose quarter-steps are round numbers (0.5, 1, 1.5, 2, 2.5, 5 × 10ⁿ). */
function axisMax(v: number, floor: number) { const raw = Math.max(floor, v) / 4; const p = 10 ** Math.floor(Math.log10(raw)); const step = [1, 1.5, 2, 2.5, 5, 10].map((f) => f * p).find((s) => s >= raw) ?? raw; return step * 4; }
function ordinal(n: number) { const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"; return `${n}${s}`; }
function PanelHeading({ title, description, right }: { title: string; description?: string; right?: ReactNode }) { return <header className="px-panel-heading"><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{right}</header>; }
function Empty({ loading = false, text }: { loading?: boolean; text: string }) { return <div className="px-empty" role="status">{loading ? "Loading…" : text}</div>; }

function SeriesChart({ label, points, start, end, step, day, domain, format, tick, loading, height, tone = "brand", axisTicks = 5 }: { label: string; points: ChartPoint[]; start: number; end: number; step: number; day: boolean; domain: [number, number]; format: (v: number) => string; tick: (v: number) => string; loading: boolean; height: number; tone?: "brand" | "ok"; axisTicks?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const [min, max] = domain, ext = seriesExtent(points);
  const segments = chartSegments(points, step);
  const span = Math.max(1, end - start);
  const x = (t: number) => Math.max(0, Math.min(1000, (t - start) / span * 1000));
  const y = (v: number) => 200 - (Math.max(min, Math.min(max, v)) - min) / (max - min || 1) * 200;
  const ticks = Array.from({ length: axisTicks }, (_, i) => i);
  const selected = hover !== null ? points[Math.min(hover, points.length - 1)] : undefined;
  const nearest = (clientX: number, rect: DOMRect) => {
    const target = start + Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * span;
    let best = 0; points.forEach((p, i) => { if (Math.abs(p.t - target) < Math.abs(points[best]!.t - target)) best = i; });
    if (points.length) setHover(best);
  };
  const showX = axisTicks >= 5;
  return <div className={`px-history ${tone}`} style={{ gridTemplateRows: `${height}px auto` }}>
    <div className="px-y-axis">{ticks.map((t) => <span key={t}>{tick(max - (max - min) * t / (axisTicks - 1))}</span>)}</div>
    <div className="px-history-plot" tabIndex={0} role="group" aria-label={`${label} chart. Use left and right arrow keys to inspect buckets.`} onFocus={() => points.length && setHover(points.length - 1)} onBlur={() => setHover(null)} onKeyDown={(e) => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key) && points.length) { e.preventDefault(); setHover(e.key === "Home" ? 0 : e.key === "End" ? points.length - 1 : Math.max(0, Math.min(points.length - 1, (hover ?? 0) + (e.key === "ArrowRight" ? 1 : -1)))); } }} onPointerMove={(e) => nearest(e.clientX, e.currentTarget.getBoundingClientRect())} onPointerLeave={() => setHover(null)}>
      <svg viewBox="0 0 1000 200" preserveAspectRatio="none" aria-hidden="true">
        {ticks.map((t) => <line key={t} x1="0" x2="1000" y1={t * 200 / (axisTicks - 1)} y2={t * 200 / (axisTicks - 1)} className="px-grid-line" />)}
        {segments.map((seg, i) => { const line = seg.map((p) => `${x(p.t)},${y(p.value)}`).join(" "); return <g key={i}>{seg.length > 1 && <polygon points={`${x(seg[0]!.t)},200 ${line} ${x(seg[seg.length - 1]!.t)},200`} className="px-series-area" />}<polyline points={line} className="px-series-line" />{seg.length === 1 && <circle cx={x(seg[0]!.t)} cy={y(seg[0]!.value)} r="3" className="px-series-dot" />}</g>; })}
        {selected && <line x1={x(selected.t)} x2={x(selected.t)} y1="0" y2="200" className="px-cursor-line" />}
      </svg>
      {!ext.count && <Empty loading={loading} text="No traced blocks in this window yet." />}
      {selected && <div className="px-chart-tooltip" role="status" style={{ left: `${Math.min(70, Math.max(0, x(selected.t) / 10 - 12))}%` }}><span>{time(selected.t, day)} UTC</span><strong>{selected.value === null ? "No reading" : format(selected.value)}</strong></div>}
    </div>
    {showX && <div className="px-x-axis">{[0, 1, 2, 3, 4].map((t) => <span key={t}>{time(start + span * t / 4, day)}</span>)}</div>}
  </div>;
}
