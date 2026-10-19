/**
 * Gas efficiency: how much of the gas limit Monad transactions actually need.
 * Monad charges the full gas limit, so an over-generous limit is MON spent for
 * nothing. "Needed" is an eth_estimateGas replay on the parent block's state,
 * over a sample of blocks; every figure here is labelled as such.
 */
import { useEffect, useMemo, useState } from "react";
import type { Dashboard } from "../useDashboard";
import { getAddressGas, getGas, type AddressGas, type GasSummary } from "../api";
import { fmt, middle, pct } from "../lib";
import { Skeleton } from "../components/ui";
import { addressName, compactNum, effText, effTone, isAddress, monAuto } from "../components/GasFormat";
import { DEFAULT_RANGES, chartSegments, rangeLabel, seriesExtent, type ChartPoint } from "../analyticsExplorer";
import { addressRoute } from "../transactionExplorer";
import "./gas.css";

const REFRESH_MS = 60_000;
const bucketSecs = (hours: number) => (hours <= 1 ? 60 : hours <= 6 ? 300 : hours <= 24 ? 900 : 3600);
const time = (ms: number, day = false) => new Date(ms).toLocaleString("en-GB", { timeZone: "UTC", ...(day ? { month: "short", day: "2-digit" } : {}), hour: "2-digit", minute: "2-digit" });

export function Gas({ d }: { d: Dashboard }) {
  const ranges = d.config?.metric_hours?.length ? d.config.metric_hours : DEFAULT_RANGES;
  const [hours, setHours] = useState(24);
  const [data, setData] = useState<GasSummary | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => getGas(hours)
      .then((r) => { if (!cancelled) { setData(r); setError(false); setLoadedAt(Date.now()); } })
      .catch(() => { if (!cancelled) setError(true); });
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, REFRESH_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [hours, retry]);

  const shown = data?.hours ?? hours;
  const stale = !!data && data.hours !== hours;
  const t = data?.totals;
  /** Replay began after the window opened (e.g. a fresh deployment): extrapolate over what was sampled. */
  const sampleStartsLate = !!(t?.sample_since && data && Date.parse(t.sample_since) > Date.now() - data.hours * 3_600_000 * 0.95);
  const traceEvery = data?.trace_every ?? d.config?.features.trace_every ?? null;
  /** Coverage within the sampled period; the window total would understate it while replay is young. */
  const base = t ? (sampleStartsLate ? t.period_txs : t.all_txs) : 0;
  const coverage = t && base > 0 ? (t.sampled_txs / base) * 100 : null;
  const unusedShare = t && t.gas_paid > 0 ? (t.gas_unused / t.gas_paid) * 100 : null;
  const end = loadedAt ?? Date.now();
  const start = end - shown * 3_600_000;
  const empty = !!t && t.sampled_txs === 0;
  const loading = !data && !error;

  const tiles: { label: string; value: string; note: string; tone?: string; badge?: string }[] = [
    {
      label: `Transactions replayed · ${rangeLabel(shown)}`,
      value: t ? fmt(t.sampled_txs) : "—",
      note: t ? `of ${fmt(base)} ${sampleStartsLate ? "since replay began" : "in the window"} (${pct(coverage, coverage !== null && coverage < 1 ? 2 : 1)})${traceEvery ? ` · every ${traceEvery === 1 ? "" : `${fmtOrdinal(traceEvery)} `}block replayed` : ""}` : "Sample coverage",
    },
    {
      label: "Gas efficiency · sample",
      value: effText(t?.efficiency),
      note: t ? `Estimated needed ÷ paid · ${compactNum(t.gas_needed)} of ${compactNum(t.gas_paid)} gas` : "Estimated gas needed ÷ gas limit paid",
      tone: effTone(t?.efficiency),
    },
    {
      label: "Unused gas fees · sample",
      value: t ? monAuto(t.unused_fee) : "—",
      note: t ? `${compactNum(t.gas_unused)} gas paid for but not needed (${pct(unusedShare)} of paid), estimated` : "Gas limit − estimated need, priced at what was paid",
      tone: "warn",
    },
    {
      label: sampleStartsLate ? "Extrapolated · since replay began" : `Extrapolated · whole ${rangeLabel(shown)} window`,
      value: t ? `≈ ${monAuto(t.extrapolated_unused_fee)}` : "—",
      note: t
        ? `Sample scaled to all ${compactNum(t.period_txs)} transactions${sampleStartsLate && t.sample_since ? ` since ${new Date(t.sample_since).toUTCString().slice(5, 22)} UTC` : " in the window"}. An extrapolation, not a measurement.`
        : "Sample scaled to every transaction it covers. An extrapolation, not a measurement.",
      badge: "Estimate",
    },
    {
      label: "Total fees · sample",
      value: t ? monAuto(t.fees) : "—",
      note: t ? `Fees the ${fmt(t.sampled_txs)} replayed transactions paid` : "Fees paid by the replayed transactions",
    },
  ];

  return <div className="gx-page">
    <div className="gx-toolbar">
      <span>{data ? `${time(start, true)} – ${time(end, true)} UTC · refreshes every minute` : error ? "Gas data unavailable" : "Loading gas sample…"}</span>
      <div className="gx-ranges" aria-label="Gas time range">{ranges.map((h) => <button key={h} type="button" aria-pressed={hours === h} onClick={() => setHours(h)}>{rangeLabel(h)}</button>)}</div>
    </div>
    {(error || stale) && <div className="gx-notice" role="status"><span>{error ? `Gas data could not be loaded.${data ? ` Showing the last loaded ${rangeLabel(shown)} sample.` : ""}` : `Loading ${rangeLabel(hours)} · showing ${rangeLabel(shown)} until it arrives.`}</span>{error && <button type="button" onClick={() => setRetry((n) => n + 1)}>Retry</button>}</div>}
    {empty && <div className="gx-notice" role="status"><span>No transactions in this window have been replayed yet. The sample fills in as the indexer replays blocks.</span></div>}

    <div className="gx-tiles">{tiles.map((tile) => <section key={tile.label} className={`gx-card gx-tile ${tile.tone ?? ""}`}>
      <div className="gx-tile-label"><span>{tile.label}</span>{tile.badge && <em>{tile.badge}</em>}</div>
      {loading ? <Skeleton h={30} w="70%" /> : <strong title={tile.value}>{tile.value}</strong>}
      <p>{tile.note}</p>
    </section>)}</div>

    <div className="gx-charts">
      <section className="gx-card gx-panel">
        <Heading title="How much of the limit is needed" description="Replayed transactions by estimated gas needed as a share of the gas limit they paid for." right={<span className="gx-pill">{rangeLabel(shown)}</span>} />
        <Histogram data={data} loading={loading} />
      </section>
      <section className="gx-card gx-panel">
        <Heading title="Efficiency over time" description={`Estimated gas needed ÷ gas paid, per ${bucketLabel(bucketSecs(shown))} bucket of replayed transactions.`} right={<span className="gx-pill">{rangeLabel(shown)}</span>} />
        <EfficiencyChart data={data} start={start} end={end} loading={loading} />
      </section>
    </div>

    <div className="gx-boards">
      <section className="gx-card gx-panel gx-board">
        <Heading title="Contracts whose callers overpay most" description="Destination contracts ranked by estimated unused gas fees in the sample (3+ replayed transactions)." />
        <ContractBoard data={data} loading={loading} />
      </section>
      <section className="gx-card gx-panel gx-board">
        <Heading title="Top overpaying senders" description="Accounts ranked by estimated unused gas fees across their replayed transactions." />
        <SenderBoard data={data} loading={loading} />
      </section>
    </div>

    <div className="gx-lower">
      <AddressCheck traceEvery={traceEvery} />
      <section className="gx-card gx-panel gx-explainer">
        <Heading title="Why this matters on Monad" />
        <ul>
          <li><b>You pay for the gas limit, not the gas used.</b> Monad charges every transaction its full gas limit, so receipts report gas used equal to the limit. Setting a limit far above what the call needs costs real MON.</li>
          <li><b>“Needed” is an estimate.</b> The explorer replays each sampled transaction with <code>eth_estimateGas</code> on the parent block's state. The estimate includes the estimator's own headroom and ignores earlier transactions in the same block, so unused gas (limit − estimate) is conservative and approximate. It understates overpayment rather than inflating it.</li>
          <li><b>It is a sample.</b> {traceEvery && traceEvery > 1 ? `Only every ${fmtOrdinal(traceEvery)} block is replayed.` : traceEvery === 1 ? "Every block is replayed (private RPC)." : "Only a sample of blocks is replayed."} Leaderboards and totals cover replayed transactions only. The extrapolated figure scales the sample to the whole window and is an estimate.</li>
          <li><b>What to do:</b> wallets and bots should set the gas limit from a fresh estimate plus a small margin, not a fixed large constant.</li>
        </ul>
      </section>
    </div>
  </div>;
}

function fmtOrdinal(n: number) { const s = ["th", "st", "nd", "rd"], v = n % 100; return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`; }
function bucketLabel(secs: number) { return secs >= 3600 ? "1-hour" : `${secs / 60}-minute`; }

function Heading({ title, description, right }: { title: string; description?: string; right?: React.ReactNode }) {
  return <header className="gx-heading"><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{right}</header>;
}
function Empty({ loading, text }: { loading: boolean; text: string }) {
  return <div className="gx-empty" role="status">{loading ? "Loading…" : text}</div>;
}

function Histogram({ data, loading }: { data: GasSummary | null; loading: boolean }) {
  const buckets = useMemo(() => Array.from({ length: 10 }, (_, b) => data?.efficiency_histogram.find((h) => h.bucket === b)?.n ?? 0), [data]);
  const total = buckets.reduce((s, n) => s + n, 0);
  const max = Math.max(1, ...buckets);
  const [hover, setHover] = useState<number | null>(null);
  if (!data || !total) return <Empty loading={loading} text="No replayed transactions in this window." />;
  const h = hover ?? null;
  return <>
    <div className="gx-hist" role="img" aria-label="Distribution of replayed transactions by share of gas limit needed">
      {buckets.map((n, b) => <div key={b} className="gx-hist-col" onPointerEnter={() => setHover(b)} onPointerLeave={() => setHover(null)}>
        <span className="gx-hist-n">{n ? pct((n / total) * 100, 0) : ""}</span>
        <i className={`gx-hist-bar ${effTone((b + 0.5) / 10)}`} style={{ height: `${Math.max(n ? 2 : 0, (n / max) * 100)}%` }} />
        <span className="gx-hist-x">{b * 10}</span>
      </div>)}
    </div>
    <div className="gx-hist-axis"><span>Share of gas limit needed (%) →</span><span>100</span></div>
    <p className="gx-foot" aria-live="polite">{h !== null ? `${h * 10}–${(h + 1) * 10}% of the limit needed: ${fmt(buckets[h])} transactions (${pct((buckets[h] / total) * 100)})` : `${fmt(total)} replayed transactions. Bars on the left needed only a small part of the limit they paid for.`}</p>
  </>;
}

function EfficiencyChart({ data, start, end, loading }: { data: GasSummary | null; start: number; end: number; loading: boolean }) {
  const step = bucketSecs(data?.hours ?? 24) * 1000;
  const points: ChartPoint[] = useMemo(() => (data?.series ?? []).map((p) => ({ t: Date.parse(p.t), value: p.efficiency == null ? null : p.efficiency * 100 })).filter((p) => Number.isFinite(p.t)).sort((a, b) => a.t - b.t), [data]);
  const [hover, setHover] = useState<number | null>(null);
  const ext = seriesExtent(points);
  if (!data || !ext.count) return <Empty loading={loading} text="No replayed buckets in this window yet." />;
  const segments = chartSegments(points, step);
  const x = (t: number) => Math.max(0, Math.min(1000, ((t - start) / (end - start)) * 1000));
  const y = (v: number) => 200 - (Math.max(0, Math.min(100, v)) / 100) * 200;
  const sel = hover !== null ? points[hover] : undefined;
  const raw = hover !== null ? data.series.find((p) => Date.parse(p.t) === points[hover]?.t) : undefined;
  const day = data.hours > 24;
  return <>
    <div className="gx-line">
      <div className="gx-y">{[100, 75, 50, 25, 0].map((v) => <span key={v}>{v}%</span>)}</div>
      <div className="gx-plot" onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const target = start + Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (end - start);
        let best = 0; points.forEach((p, i) => { if (Math.abs(p.t - target) < Math.abs(points[best].t - target)) best = i; });
        setHover(best);
      }} onPointerLeave={() => setHover(null)}>
        <svg viewBox="0 0 1000 200" preserveAspectRatio="none" aria-hidden="true">
          {[0, 50, 100, 150, 200].map((g) => <line key={g} x1="0" x2="1000" y1={g} y2={g} className="gx-grid" />)}
          {segments.map((s, i) => { const line = s.map((p) => `${x(p.t)},${y(p.value)}`).join(" "); return <g key={i}>{s.length > 1 && <polygon points={`${x(s[0].t)},200 ${line} ${x(s[s.length - 1].t)},200`} fill="var(--brandSoft)" />}<polyline points={line} className="gx-series" />{s.length === 1 && <circle cx={x(s[0].t)} cy={y(s[0].value)} r="3" fill="var(--brand2)" />}</g>; })}
          {sel && <line x1={x(sel.t)} x2={x(sel.t)} y1="0" y2="200" className="gx-cursor" />}
        </svg>
        {sel && <div className="gx-tip" style={{ left: `${Math.min(70, Math.max(0, x(sel.t) / 10 - 12))}%` }}><span>{time(sel.t, day)} UTC</span><strong>{sel.value === null ? "No reading" : pct(sel.value)}</strong><small>{raw ? `${fmt(raw.txs)} txs · ${monAuto(raw.unused_fee)} unused` : ""}</small></div>}
      </div>
      <div className="gx-x"><span>{time(start, day)}</span><span>{time((start + end) / 2, day)}</span><span>{time(end, day)}</span></div>
    </div>
    <p className="gx-foot">Bucket range <b>{pct(ext.min)}</b> – <b>{pct(ext.max)}</b> · {ext.count} buckets with replayed transactions{ext.count < 3 ? " · the sample is still filling in" : ""}.</p>
  </>;
}

function AddrCell({ address, name }: { address: string; name: string }) {
  return <a className="gx-addr" href={addressRoute(address)} title={address}><span>{name}</span>{name !== middle(address, 8, 4) && <small>{middle(address, 6, 4)}</small>}</a>;
}
function Eff({ e }: { e: number | null }) {
  const tone = effTone(e);
  return <span className={`gx-eff ${tone}`}><i><b style={{ width: `${e == null ? 0 : Math.min(100, e * 100)}%` }} /></i>{effText(e, 0)}</span>;
}

function ContractBoard({ data, loading }: { data: GasSummary | null; loading: boolean }) {
  const rows = data?.by_contract ?? [];
  if (!rows.length) return <Empty loading={loading} text="No contract had 3 or more replayed transactions in this window." />;
  return <div className="gx-table-scroll" tabIndex={0} role="region" aria-label="Contracts whose callers overpay most">
    <table className="gx-table">
      <thead><tr><th>#</th><th>Contract</th><th>Txs</th><th>Avg limit → needed</th><th>Efficiency</th><th>Unused · est.</th><th>Senders</th></tr></thead>
      <tbody>{rows.map((r, i) => <tr key={r.address}>
        <td>{i + 1}</td>
        <td><AddrCell address={r.address} name={addressName(r.address, r.label)} /></td>
        <td>{fmt(r.txs)}</td>
        <td><span className="gx-limits">{compactNum(Math.round(r.avg_limit))} <i>→</i> {compactNum(Math.round(r.avg_needed))}</span></td>
        <td><Eff e={r.efficiency} /></td>
        <td className="gx-mon">{monAuto(r.unused_fee)}</td>
        <td>{fmt(r.senders)}</td>
      </tr>)}</tbody>
    </table>
  </div>;
}

function SenderBoard({ data, loading }: { data: GasSummary | null; loading: boolean }) {
  const rows = data?.by_sender ?? [];
  if (!rows.length) return <Empty loading={loading} text="No replayed transactions in this window." />;
  return <div className="gx-table-scroll" tabIndex={0} role="region" aria-label="Top overpaying senders">
    <table className="gx-table">
      <thead><tr><th>#</th><th>Sender</th><th>Txs</th><th>Efficiency</th><th>Unused · est.</th></tr></thead>
      <tbody>{rows.map((r, i) => <tr key={r.address}>
        <td>{i + 1}</td>
        <td><AddrCell address={r.address} name={addressName(r.address, r.label)} /></td>
        <td>{fmt(r.txs)}</td>
        <td><Eff e={r.efficiency} /></td>
        <td className="gx-mon">{monAuto(r.unused_fee)}</td>
      </tr>)}</tbody>
    </table>
  </div>;
}

function AddressCheck({ traceEvery }: { traceEvery: number | null }) {
  const [input, setInput] = useState("");
  const [result, setResult] = useState<{ address: string; gas: AddressGas } | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const value = input.trim().toLowerCase();
  const valid = isAddress(value);
  useEffect(() => {
    if (!valid) { setResult(null); setState("idle"); return; }
    let cancelled = false;
    setState("loading");
    getAddressGas(value).then((gas) => { if (!cancelled) { setResult({ address: value, gas }); setState("idle"); } }).catch(() => { if (!cancelled) setState("error"); });
    return () => { cancelled = true; };
  }, [value, valid]);
  const s = result?.address === value ? result.gas.sampled : null;
  const sent = result?.address === value ? result.gas.sent_in_window : null;
  return <section className="gx-card gx-panel gx-check">
    <Heading title="Check an address" description="How much gas an account paid for but did not need, across its replayed transactions." />
    <label className="gx-input"><span className="gx-visually-hidden">Address</span><input value={input} onChange={(e) => setInput(e.target.value)} placeholder="0x… sender address" spellCheck={false} autoComplete="off" aria-invalid={input.trim() !== "" && !valid} /></label>
    {input.trim() !== "" && !valid && <p className="gx-hint">Enter a full 0x address (40 hex characters).</p>}
    {valid && state === "loading" && <div className="gx-check-body"><Skeleton h={22} w="60%" /><Skeleton h={16} w="85%" /></div>}
    {valid && state === "error" && <p className="gx-hint bad">This address could not be checked right now.</p>}
    {valid && state === "idle" && s && <div className="gx-check-body">
      {s.txs === 0 ? <p className="gx-check-none">{sent ? `None of the ${fmt(sent)}${sent >= 10000 ? "+" : ""} transactions this address sent in the indexed window fall in a replayed block${traceEvery && traceEvery > 1 ? ` (every ${fmtOrdinal(traceEvery)} block)` : ""}, so there is nothing to estimate yet.` : "This address sent no transactions in the indexed window, so there is nothing to estimate. Only senders pay gas."}</p> : <>
        <div className="gx-check-grid">
          <div><span>Overpaid · sample</span><strong className="warn">{monAuto(s.unused_fee)}</strong></div>
          <div><span>Efficiency</span><strong className={effTone(s.efficiency)}>{effText(s.efficiency)}</strong></div>
          <div><span>Fees paid · sample</span><strong>{monAuto(s.fees)}</strong></div>
          <div><span>Replayed txs</span><strong>{fmt(s.txs)}</strong></div>
        </div>
        <p className="gx-hint">Estimated over {fmt(s.txs)} replayed of {sent !== null ? `${fmt(sent)}${sent >= 10000 ? "+" : ""}` : "—"} transactions sent in the indexed window. Conservative: the estimate includes the estimator's headroom.</p>
      </>}
      <a className="gx-open" href={addressRoute(value)}>Open address →</a>
    </div>}
  </section>;
}
