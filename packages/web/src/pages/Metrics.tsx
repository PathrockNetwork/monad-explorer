/** Analytics over the indexed rolling window; missing samples remain visible gaps. */
import { useEffect, useMemo, useState } from "react";
import type { Dashboard } from "../useDashboard";
import { getUsage, type Metrics as MetricsData, type Usage } from "../api";
import { fmt, middle, mon, pct } from "../lib";
import { ValidatorAvatar } from "../components/ui";
import { DEFAULT_RANGES, THRESHOLDS, USAGE_MAX_HOURS, bucketMs, dataStart, chartDomain, chartPoints, chartSegments, expectedVolume, outlierWindows, rangeLabel, sampleCoverage, seriesExtent, usageBucketMs, usagePartialSince, usagePoints, volumeBuckets, type ChartPoint, type OutlierWindow } from "../analyticsExplorer";
import { addressRoute } from "../transactionExplorer";
import "./analytics.css";

const time = (ms: number, day = false) => new Date(ms).toLocaleString("en-GB", { timeZone: "UTC", ...(day ? { month: "short", day: "2-digit" } : {}), hour: "2-digit", minute: "2-digit" });
const msText = (v: number | null | undefined) => v === null || v === undefined || !Number.isFinite(v) ? "—" : `${Math.round(v)} ms`;
const tpsText = (v: number | null | undefined) => v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toLocaleString("en-US", { maximumFractionDigits: v < 10 ? 2 : 1 });
const outlierLabel = (o: OutlierWindow) => o.kind === "block" ? "Slow block cadence" : "Low indexed volume";
const outlierDetail = (o: OutlierWindow) => o.kind === "block" ? `Bucket mean up to ${msText(o.value)}` : `${o.value.toFixed(0)}% of the cadence-implied block count`;

export function Metrics({ d, hours, onHours }: { d: Dashboard; hours: number; onHours: (h: number) => void }) {
  const m = d.metrics;
  const ranges = m?.allowed_hours?.length ? m.allowed_hours : d.config?.metric_hours?.length ? d.config.metric_hours : DEFAULT_RANGES;
  const shown = m?.hours ?? hours, label = rangeLabel(shown);
  const end = d.metricsUpdatedAt?.getTime() ?? Date.now();
  const start = end - shown * 3_600_000;
  const usable = m ? dataStart(m, start) : start;
  const step = bucketMs(m, shown);
  const day = shown > 24;
  const series = m?.series ?? [];
  const tps = useMemo(() => chartPoints(series, "tps", { step, start: usable, end, completeOnly: true }), [m, end]);
  const bt = useMemo(() => chartPoints(series, "avg_block_time_ms"), [m]);
  const gas = useMemo(() => chartPoints(series, "gas_utilization"), [m]);
  const txs = useMemo(() => chartPoints(series, "txs", { step, start: usable, end, completeOnly: true }), [m, end]);
  const vol = useMemo(() => chartPoints(series, "blocks", { step, start: usable, end, completeOnly: true }), [m, end]);
  const outliers = useMemo(() => m ? outlierWindows(m, end) : [], [m, end]);
  const coverage = useMemo(() => m ? sampleCoverage(m, end) : null, [m, end]);
  const [outlierPage, setOutlierPage] = useState(0);
  const pages = Math.max(1, Math.ceil(outliers.length / 4)), page = Math.min(pages - 1, outlierPage);
  const top = m?.proposers.find(p => p.share !== null);
  const topName = top ? top.name ?? `Validator #${top.id}` : "No proposer sample";
  const btExt = seriesExtent(bt), tpsExt = seriesExtent(tps), gasExt = seriesExtent(gas);
  const average = m?.stats.avg_block_time_ms ?? null;
  const gasUtil = m?.stats.gas_utilization == null ? null : m.stats.gas_utilization * 100;
  const btTone = average === null ? "muted" : average <= THRESHOLDS.blockTimeMs ? "ok" : "warn";
  const summary: { label: string; value: string; note: string; icon: string; tone: string; points?: ChartPoint[] }[] = [
    { label: `Blocks · ${label}`, value: fmt(m?.stats.blocks), note: "Finalized blocks indexed in the window", icon: "block", tone: "normal", points: vol },
    { label: `Transactions · ${label}`, value: fmt(m?.stats.txs), note: "Transactions in those blocks", icon: "bars", tone: "normal", points: txs },
    { label: `Avg block time · ${label}`, value: msText(average), note: `Window span ÷ blocks · display target ≤ ${THRESHOLDS.blockTimeMs} ms`, icon: "clock", tone: btTone, points: bt },
    { label: `TPS · ${label}`, value: tpsText(m?.stats.tps), note: "Transactions ÷ seconds spanned", icon: "pulse", tone: "normal", points: tps },
    { label: `Gas utilization · ${label}`, value: pct(gasUtil, 2), note: "Gas used ÷ gas limit, all blocks", icon: "gauge", tone: "normal", points: gas },
    { label: `Max txs in a block · ${label}`, value: fmt(m?.stats.max_txs_in_block), note: "Busiest single block in the window", icon: "people", tone: "normal" },
  ];
  const thresholds = [
    { label: "Average block time", current: msText(average), target: `≤ ${THRESHOLDS.blockTimeMs} ms`, pass: average === null ? null : average <= THRESHOLDS.blockTimeMs },
    { label: "Slowest bucket mean", current: msText(btExt.max), target: `≤ ${THRESHOLDS.blockTimeMs} ms`, pass: btExt.max === null ? null : btExt.max <= THRESHOLDS.blockTimeMs },
    { label: "Bucket coverage", current: pct(coverage, 1), target: `≥ ${THRESHOLDS.coverage}%`, pass: coverage === null ? null : coverage >= THRESHOLDS.coverage },
  ];
  const allHealthy = thresholds.every(row => row.pass === true);
  const loading = !m && !d.metricsError;
  return <div className="ane-page">
    <div className="ane-toolbar"><span>{m ? `${time(start, true)} – ${time(end, true)} UTC` : "Loading network history…"}</span><div className="ane-ranges" aria-label="Analytics time range">{ranges.map(h => <button key={h} type="button" aria-pressed={hours === h} onClick={() => { onHours(h); setOutlierPage(0); }}>{rangeLabel(h)}</button>)}</div></div>
    {m && usable > start + 1 && <div className="ane-notice" role="status"><span>Indexed history starts {time(usable, true)} UTC, after the start of this {label} window; earlier buckets are empty, not missing.</span></div>}
    {(d.metricsError || (m && hours !== shown)) && <div className="ane-notice" role="status"><span>{d.metricsError ? `Analytics could not refresh.${m ? ` Showing the last loaded ${label} snapshot.` : ""}` : `Loading ${rangeLabel(hours)} · showing ${label} until it arrives.`}</span>{d.metricsError && <button type="button" onClick={d.refresh}>Retry</button>}</div>}
    <div className="ane-stats">{summary.map(s => <section className={`ane-panel ane-stat ${s.tone}`} key={s.label}><div className="ane-stat-label"><Icon name={s.icon} /><span>{s.label}</span></div><div className="ane-stat-value"><strong>{s.value}</strong>{s.points && <Sparkline points={s.points} step={step} />}</div><p title={s.note}>{s.note}</p></section>)}</div>
    <div className="ane-main-grid">
      <section className="ane-panel ane-chart-card"><PanelHeading title="Throughput (TPS)" description="Transactions per second, per bucket. Partial edge buckets are left out." icon="pulse" right={<span className="ane-range-label">{label}</span>} /><HistoryChart label="TPS" points={tps} start={start} end={end} step={step} day={day} domain={chartDomain(tps, 1)} format={tpsText} tick={v => tpsText(v)} loading={loading} /><div className="ane-chart-footer"><Legend label="TPS" /><span>Window <b>{tpsText(m?.stats.tps)}</b> <i>·</i> Peak bucket <b>{tpsText(tpsExt.max)}</b></span></div></section>
      <section className="ane-panel ane-chart-card"><PanelHeading title="Block time" description="Average interval between finalized blocks in each bucket (timestamps are whole seconds)." icon="clock" right={<span className="ane-range-label">{label}</span>} /><HistoryChart label="Block time" points={bt} start={start} end={end} step={step} day={day} domain={chartDomain(bt, THRESHOLDS.blockTimeMs * 1.2)} format={msText} tick={v => `${Math.round(v)}`} unit="ms" target={THRESHOLDS.blockTimeMs} loading={loading} /><div className="ane-chart-footer"><Legend label="Bucket mean" /><Legend label={`Target ≤ ${THRESHOLDS.blockTimeMs} ms`} target /><span>Avg <b>{msText(average)}</b> <i>·</i> Slowest <b>{msText(btExt.max)}</b></span></div></section>
      <section className="ane-panel ane-chart-card"><PanelHeading title="Gas utilization" description="Gas used as a share of the block gas limit, per bucket." icon="gauge" right={<span className="ane-range-label">{label}</span>} /><HistoryChart label="Gas utilization" points={gas} start={start} end={end} step={step} day={day} domain={chartDomain(gas, 5)} format={v => pct(v, 2)} tick={v => `${Number(v.toFixed(1))}%`} loading={loading} /><div className="ane-chart-footer"><Legend label="Gas utilization" /><span>Window <b>{pct(gasUtil, 2)}</b> <i>·</i> Peak bucket <b>{pct(gasExt.max, 2)}</b></span></div></section>
    </div>
    <div className="ane-support-grid">
      <section className="ane-panel ane-volume"><PanelHeading title={`Blocks per ${bucketLabel(m?.bucket_secs)}`} description="Finalized blocks indexed by this explorer, per bucket." icon="block" right={<span className="ane-range-label">{label}</span>} />{m ? <VolumeChart metrics={m} end={end} /> : <Empty loading={!d.metricsError} />}</section>
      <section className="ane-panel ane-proposers"><Proposers d={d} label={label} /></section>
      <section className="ane-panel ane-outliers"><PanelHeading title="Outlier windows" description="Aggregate buckets outside the display thresholds." icon="alert" right={<span className="ane-count">{m ? outliers.length : "—"}</span>} /><div className="ane-outlier-table"><div className="ane-outlier-head"><span>Time (UTC)</span><span>Type & observation</span></div>{outliers.slice(page * 4, page * 4 + 4).map(o => <div className="ane-outlier-row" key={`${o.kind}-${o.start}`}><time title={`${time(o.start, true)} – ${time(o.end, true)} UTC`}>{time(o.start, day)}<small>to {time(o.end)}</small></time><div><strong><Dot tone={o.kind === "block" ? "warn" : "bad"} />{outlierLabel(o)}</strong><span>{outlierDetail(o)}</span></div></div>)}{!outliers.length && <Empty loading={loading} text={m?.series.length ? "No threshold breaches in the measured buckets." : "No measured buckets in this window."} />}</div><footer className="ane-outlier-footer"><span>Bucket windows, not exact incident durations.</span>{pages > 1 && <div><button type="button" aria-label="Previous outlier page" disabled={page === 0} onClick={() => setOutlierPage(page - 1)}>‹</button><span>{page + 1}/{pages}</span><button type="button" aria-label="Next outlier page" disabled={page === pages - 1} onClick={() => setOutlierPage(page + 1)}>›</button></div>}</footer></section>
      <section className="ane-panel ane-summary"><PanelHeading title="Performance summary" icon="pulse" /><ul className="ane-observations">
        <li><Dot tone={btTone} /><div><strong>{average === null ? "Block timing unavailable" : average <= THRESHOLDS.blockTimeMs ? "Average block time within target" : "Average block time above target"}</strong><span>{msText(average)} average · slowest bucket {msText(btExt.max)} over {label}.</span></div></li>
        <li><Dot tone="brand" /><div><strong>{tpsText(m?.stats.tps)} TPS across {fmt(m?.stats.txs)} transactions</strong><span>{tpsExt.max === null ? "Waiting for complete buckets." : `Peak bucket ${tpsText(tpsExt.max)} TPS · busiest block ${fmt(m?.stats.max_txs_in_block)} txs.`}</span></div></li>
        <li><Dot tone="brand" /><div><strong>Gas utilization {pct(gasUtil, 2)}</strong><span>{gasExt.max === null ? "Waiting for gas samples." : `Bucket range ${pct(gasExt.min, 2)} – ${pct(gasExt.max, 2)} of the block gas limit.`}</span></div></li>
        <li><Dot tone="brand" /><div><strong>Top proposer {pct(top?.share == null ? null : top.share * 100)}</strong><span>{topName} · share of blocks proposed over {label}.</span></div></li>
      </ul></section>
      <section className="ane-panel ane-thresholds"><PanelHeading title="Health thresholds" description="Explorer display targets, not protocol requirements." icon="shield" /><div className="ane-table-wrap"><table><thead><tr><th>Metric</th><th>Current</th><th>Target</th><th>Status</th></tr></thead><tbody>{thresholds.map(row => <tr key={row.label}><td>{row.label}</td><td>{row.current}</td><td>{row.target}</td><td><span className={`ane-health ${row.pass === null ? "muted" : row.pass ? "ok" : "warn"}`}><Dot tone={row.pass === null ? "muted" : row.pass ? "ok" : "warn"} />{row.pass === null ? "Unknown" : row.pass ? "Within" : "Outside"}</span></td></tr>)}</tbody></table></div><p className="ane-footnote">Coverage counts complete buckets since indexing began that hold at least one indexed block. Proposer share reflects block production, not stake.</p></section>
      <section className="ane-panel ane-notes"><PanelHeading title="Observed notes" icon="notes" right={<span className="ane-updated">{d.metricsUpdatedAt ? `Updated ${time(end)} UTC` : "Waiting for data"}</span>} /><ul className="ane-observations">{outliers.slice(0, 2).map(o => <li key={`${o.kind}-${o.start}`}><Dot tone="warn" /><div><strong>{time(o.start, day)} · {outlierLabel(o)}</strong><span>{outlierDetail(o)}. Based on recorded buckets.</span></div></li>)}<li><Dot tone={m && allHealthy ? "ok" : "muted"} /><div><strong>{m ? allHealthy ? "Window metrics are within display targets" : "Review the measured values against targets" : "Waiting for network metrics"}</strong><span>Charts show bucket averages; short per-block spikes can be hidden.</span></div></li><li><Dot tone="muted" /><div><strong>Read gaps as missing observations</strong><span>Only finalized blocks are indexed. A gap or low bucket can mean the indexer was behind, not that the chain stalled.</span></div></li></ul></section>
    </div>
    <UsageSection hours={hours} />
    <div className="ane-method-note">All times UTC · {Math.round(step / 60_000)}-minute buckets · block timestamps have 1-second resolution, so block time is reported only as a bucket average · finalized blocks only · the database keeps a rolling {d.config?.indexer.retain_hours ?? 72}-hour window · proposer distribution covers the selected window (top {m?.proposers.length || 12} returned).</div>
  </div>;
}

/** Who uses Monad: top contracts by gas from the hourly rollup, plus base fee and block fullness. */
function UsageSection({ hours: requested }: { hours: number }) {
  const hours = Math.min(requested, USAGE_MAX_HOURS);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [loadedAt, setLoadedAt] = useState<number>(() => Date.now());
  const [all, setAll] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const load = () => getUsage(hours).then(r => { if (!cancelled) { setUsage(r); setError(false); setLoadedAt(Date.now()); } }).catch(() => { if (!cancelled) setError(true); });
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 60_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [hours, retry]);
  const shown = usage?.hours ?? hours, label = rangeLabel(shown);
  const end = loadedAt, start = end - shown * 3_600_000, step = usageBucketMs(shown), day = shown > 24;
  const baseFee = useMemo(() => usagePoints(usage?.fee_series ?? [], "base_fee"), [usage]);
  const fullness = useMemo(() => usagePoints(usage?.fee_series ?? [], "fullness"), [usage]);
  const peak = useMemo(() => seriesExtent(usagePoints(usage?.fee_series ?? [], "max_fullness")).max, [usage]);
  const feeExt = seriesExtent(baseFee), fullExt = seriesExtent(fullness);
  const partial = usage ? usagePartialSince(usage, end) : null;
  const t = usage?.totals;
  const rows = usage?.contracts ?? [], visible = all ? rows : rows.slice(0, 10);
  const maxShare = Math.max(1e-9, ...rows.map(r => r.share ?? 0));
  const loading = !usage && !error;
  const gwei = (v: number) => `${v.toLocaleString("en-US", { maximumFractionDigits: v < 10 ? 3 : 1 })} gwei`;
  const since = t?.since ? `${time(Date.parse(t.since), true)} UTC` : null;
  return <section className="ane-usage" aria-labelledby="ane-usage-title">
    <header className="ane-usage-head">
      <div><h2 id="ane-usage-title"><Icon name="people" />Who uses Monad</h2><p>Contracts that consumed the most gas · {label}{requested > USAGE_MAX_HOURS ? ` (usage is limited to ${USAGE_MAX_HOURS}h)` : ""}. Built from an hourly rollup of indexed transactions: whole hours, including the current partial hour.</p></div>
      <span className="ane-range-label">{since ? `Data since ${since}` : usage ? "No rollup data yet" : "—"}</span>
    </header>
    {(error || partial !== null || (usage && usage.hours !== hours)) && <div className="ane-notice" role="status"><span>{error ? `Usage data could not be loaded.${usage ? ` Showing the last loaded ${label} snapshot.` : ""}` : usage && usage.hours !== hours ? `Loading ${rangeLabel(hours)} · showing ${label} until it arrives.` : `The usage rollup is still backfilling: totals cover ${time(partial!, true)} UTC onward, not the full ${label} window.`}</span>{error && <button type="button" onClick={() => setRetry(n => n + 1)}>Retry</button>}</div>}
    <div className="ane-usage-totals">
      <div><span>Transactions</span><strong>{t ? fmt(t.txs) : "—"}</strong></div>
      <div><span>Gas used</span><strong>{t ? t.gas.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 }) : "—"}</strong></div>
      <div><span>Contracts called</span><strong>{t ? fmt(t.contracts) : "—"}</strong></div>
      <div><span>Fees paid</span><strong>{t ? mon(t.fees, 0) : "—"}</strong></div>
      <div><span>Success rate</span><strong>{t ? pct(t.success == null ? null : t.success * 100) : "—"}</strong></div>
      <div><span>Contract creations</span><strong>{t ? fmt(t.creations) : "—"}</strong></div>
    </div>
    <div className="ane-usage-grid">
      <section className="ane-panel ane-usage-table">
        <PanelHeading title="Top contracts by gas" description="Share of all gas used in the window. Fees are what callers paid; on Monad that is the full gas limit." icon="bars" right={<span className="ane-count">{usage ? rows.length : "—"}</span>} />
        <div className="ane-table-wrap" tabIndex={0} role="region" aria-label="Top contracts by gas"><table><thead><tr><th>#</th><th>Contract</th><th>Share of gas</th><th>Txs</th><th>Fees</th><th>Success</th></tr></thead><tbody>
          {visible.map((r, i) => <tr key={r.address}><td>{i + 1}</td><td><a className="ane-usage-name" href={addressRoute(r.address)} title={r.address}><span>{r.label?.name ?? middle(r.address, 8, 4)}</span>{r.label && <small>{middle(r.address, 6, 4)}</small>}</a></td><td><span className="ane-share"><i><b style={{ width: `${(r.share ?? 0) / maxShare * 100}%` }} /></i>{pct(r.share == null ? null : r.share * 100)}</span></td><td>{fmt(r.txs)}</td><td>{mon(r.fees, 0)}</td><td className={r.success != null && r.success < 0.9 ? "ane-warn-text" : undefined}>{pct(r.success == null ? null : r.success * 100)}</td></tr>)}
        </tbody></table>{!rows.length && <Empty loading={loading} text={error ? "Usage data is unavailable." : "No contract calls in the rollup for this window yet."} />}</div>
        {rows.length > 10 && <button type="button" className="ane-usage-more" onClick={() => setAll(!all)}>{all ? "Show top 10" : `Show all ${rows.length}`}</button>}
      </section>
      <section className="ane-panel ane-usage-charts">
        <PanelHeading title="Base fee" description={`Average base fee per ${Math.round(step / 60_000)}-minute bucket.`} icon="pulse" right={<span className="ane-range-label">{label}</span>} />
        <HistoryChart label="Base fee" points={baseFee} start={start} end={end} step={step} day={day} domain={chartDomain(baseFee, 1)} format={gwei} tick={v => `${Number(v.toFixed(v < 10 ? 2 : 0))}`} unit="gwei" loading={loading} />
        <div className="ane-chart-footer"><Legend label="Base fee" /><span>Range <b>{feeExt.min === null ? "—" : gwei(feeExt.min)}</b> – <b>{feeExt.max === null ? "—" : gwei(feeExt.max)}</b></span></div>
        <div className="ane-usage-gap" />
        <PanelHeading title="Block fullness" description="Gas used ÷ block gas limit, averaged per bucket." icon="gauge" />
        <HistoryChart label="Block fullness" points={fullness} start={start} end={end} step={step} day={day} domain={chartDomain(fullness, 5)} format={v => pct(v, 2)} tick={v => `${Number(v.toFixed(1))}%`} loading={loading} />
        <div className="ane-chart-footer"><Legend label="Average fullness" /><span>Peak bucket <b>{pct(fullExt.max, 2)}</b> <i>·</i> Fullest block <b>{pct(peak, 1)}</b></span></div>
      </section>
    </div>
  </section>;
}

function bucketLabel(secs: number | undefined) { return !secs ? "bucket" : secs % 3600 === 0 ? (secs === 3600 ? "hour" : `${secs / 3600} hours`) : secs === 60 ? "minute" : `${secs / 60} minutes`; }
function PanelHeading({ title, description, icon, right }: { title: string; description?: string; icon: string; right?: React.ReactNode }) { return <header className="ane-panel-heading"><div><h2><Icon name={icon} />{title}</h2>{description && <p>{description}</p>}</div>{right}</header>; }
function Dot({ tone }: { tone: string }) { return <i className={`ane-dot ${tone}`} aria-hidden="true" />; }
function Legend({ label, target = false }: { label: string; target?: boolean }) { return <span className="ane-legend">{target ? <i className="ane-target-key" /> : <Dot tone="brand" />}{label}</span>; }
function Empty({ loading = false, text = "No measured data in this window." }: { loading?: boolean; text?: string }) { return <div className="ane-empty" role="status">{loading ? "Loading measurements…" : text}</div>; }

function Sparkline({ points, step }: { points: ChartPoint[]; step: number }) {
  const ext = seriesExtent(points), segments = chartSegments(points, step);
  if (ext.count < 2) return null;
  const start = points[0].t, width = Math.max(1, points[points.length - 1].t - start), span = Math.max(1e-9, ext.max! - ext.min!);
  return <svg className="ane-spark" viewBox="0 0 100 32" aria-hidden="true">{segments.map((segment, i) => <polyline key={i} points={segment.map(p => `${(p.t - start) / width * 100},${27 - (p.value - ext.min!) / span * 21}`).join(" ")} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />)}</svg>;
}

function HistoryChart({ label, points, start, end, step, day, domain, format, tick, unit, target, loading }: { label: string; points: ChartPoint[]; start: number; end: number; step: number; day: boolean; domain: [number, number]; format: (v: number) => string; tick: (v: number) => string; unit?: string; target?: number; loading: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const [min, max] = domain, ext = seriesExtent(points);
  const segments = chartSegments(points, step);
  const x = (t: number) => Math.max(0, Math.min(1000, (t - start) / (end - start) * 1000));
  const y = (v: number) => 200 - (Math.max(min, Math.min(max, v)) - min) / (max - min || 1) * 200;
  const fmtValue = (v: number | null) => v === null ? "—" : format(v);
  const selected = hover !== null ? points[Math.min(hover, points.length - 1)] : undefined;
  const ticks = [0, 1, 2, 3, 4];
  const selectNearest = (clientX: number, rect: DOMRect) => {
    const targetTime = start + Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * (end - start);
    let nearest = 0; points.forEach((p, i) => { if (Math.abs(p.t - targetTime) < Math.abs(points[nearest].t - targetTime)) nearest = i; });
    if (points.length) setHover(nearest);
  };
  return <div className="ane-history"><div className="ane-y-axis">{ticks.map(t => <span key={t}>{tick(max - (max - min) * t / 4)}{unit && t === 0 ? ` ${unit}` : ""}</span>)}</div><div className="ane-history-plot" tabIndex={0} role="group" aria-label={`${label} chart. Use left and right arrow keys to inspect measured buckets.`} onFocus={() => points.length && setHover(points.length - 1)} onBlur={() => setHover(null)} onKeyDown={event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) && points.length) { event.preventDefault(); setHover(event.key === "Home" ? 0 : event.key === "End" ? points.length - 1 : Math.max(0, Math.min(points.length - 1, (hover ?? 0) + (event.key === "ArrowRight" ? 1 : -1)))); } }} onPointerMove={event => selectNearest(event.clientX, event.currentTarget.getBoundingClientRect())} onPointerLeave={() => setHover(null)}>
      <svg viewBox="0 0 1000 200" preserveAspectRatio="none" aria-hidden="true">{target !== undefined && <rect x="0" y={y(target)} width="1000" height={200 - y(target)} fill="var(--ok)" opacity=".035" />}{ticks.map(t => <line key={t} x1="0" x2="1000" y1={t * 50} y2={t * 50} className="ane-grid-line" />)}{[0, 1, 2, 3, 4, 5, 6, 7, 8].map(t => <line key={t} y1="0" y2="200" x1={t * 125} x2={t * 125} className="ane-grid-line" />)}{target !== undefined && <line x1="0" x2="1000" y1={y(target)} y2={y(target)} className="ane-target-line" />}{segments.map((segment, i) => { const line = segment.map(p => `${x(p.t)},${y(p.value)}`).join(" "); return <g key={i}>{segment.length > 1 && <polygon points={`${x(segment[0].t)},200 ${line} ${x(segment[segment.length - 1].t)},200`} fill="var(--brandSoft)" />}<polyline points={line} className="ane-series-line" />{segment.length === 1 && <circle cx={x(segment[0].t)} cy={y(segment[0].value)} r="3" fill="var(--brand2)" />}</g>; })}{selected && <line x1={x(selected.t)} x2={x(selected.t)} y1="0" y2="200" className="ane-cursor-line" />}</svg>
      {!ext.count && <Empty loading={loading} />}{selected && <div className="ane-chart-tooltip" role="status" style={{ left: `${Math.min(72, Math.max(0, x(selected.t) / 10 - 12))}%` }}><span>{time(selected.t, day)} UTC</span><strong>{selected.value === null ? "No reading" : fmtValue(selected.value)}</strong><small>{selected.value === null ? "Partial or empty bucket" : "Bucket value"}</small></div>}
    </div><div className="ane-x-axis">{ticks.map(t => <span key={t}>{time(start + (end - start) * t / 4, day)}</span>)}</div><div className="ane-chart-extents"><span>Bucket min <b>{fmtValue(ext.min)}</b></span><span>Bucket max <b>{fmtValue(ext.max)}</b></span><span>{ext.count} readings</span></div></div>;
}

function VolumeChart({ metrics, end }: { metrics: MetricsData; end: number }) {
  const buckets = volumeBuckets(metrics, end), expected = expectedVolume(metrics);
  const max = Math.max(1, ...buckets.map(p => p.n), expected ?? 0) * 1.12;
  const [selected, setSelected] = useState<number | null>(null);
  const hovered = selected === null ? null : buckets[selected];
  const day = metrics.hours > 24;
  return <><div className="ane-volume-total"><span>Total ({rangeLabel(metrics.hours)}) <strong>{fmt(metrics.stats.blocks)}</strong></span><span>{expected === null ? "Expected volume unavailable" : `~${fmt(Math.round(expected))}/${bucketLabel(metrics.bucket_secs)} at the average cadence`}</span></div><div className="ane-volume-chart"><div className="ane-volume-axis">{[1, .5, 0].map(f => <span key={f}>{Math.round(max * f).toLocaleString("en-US", { notation: "compact" })}</span>)}</div><div className={`ane-volume-plot ${buckets.length > 48 ? "dense" : ""}`}>{expected !== null && <i className="ane-volume-target" style={{ bottom: `${expected / max * 100}%` }} />}{buckets.map((b, i) => <button type="button" key={b.t} className={`${b.complete ? "" : "partial"} ${b.complete && expected !== null && b.n < expected * THRESHOLDS.volume ? "low" : ""}`} style={{ height: `${Math.max(1, b.n / max * 100)}%` }} aria-label={`${time(b.t, true)} UTC: ${fmt(b.n)} indexed blocks${b.complete ? "" : ", partial bucket"}`} onPointerEnter={() => setSelected(i)} onPointerLeave={() => setSelected(null)} onFocus={() => setSelected(i)} onBlur={() => setSelected(null)} />)}</div></div><div className="ane-volume-x"><span>{time(buckets[0]?.t ?? end, day)}</span><span>UTC</span><span>{time(buckets[buckets.length - 1]?.t ?? end, day)}</span></div><p className="ane-volume-note" aria-live="polite">{hovered ? `${time(hovered.t, true)} UTC · ${fmt(hovered.n)} blocks${hovered.complete ? "" : " · partial bucket"}` : "Lighter bars are partial buckets. Dashed line: block count implied by the window's average cadence."}</p></>;
}

function Proposers({ d, label }: { d: Dashboard; label: string }) {
  const [limit, setLimit] = useState(5);
  const dist = d.metrics?.proposers ?? [], shown = dist.slice(0, limit);
  const known = dist.every(p => p.share !== null);
  // The API returns the top proposers only; the remainder also covers blocks with no attributed proposer.
  const rest = known && dist.length ? Math.max(0, 1 - shown.reduce((sum, p) => sum + p.share!, 0)) : null;
  const max = Math.max(1e-9, ...shown.map(p => p.share ?? 0), rest ?? 0);
  return <><PanelHeading title="Proposer distribution" description={`Share of finalized blocks proposed · ${label}.`} icon="people" right={<select aria-label="Number of proposers" value={limit} onChange={event => setLimit(Number(event.target.value))}><option value={5}>Top 5</option><option value={10}>Top 10</option><option value={1000}>All returned</option></select>} /><div className="ane-proposer-list" tabIndex={0} aria-label="Proposer rankings">{shown.map((p, i) => { const name = p.name ?? `Validator #${p.id}`; return <div className="ane-proposer-row" key={p.id} title={`${name} · #${p.id} · ${fmt(p.n)} blocks · ${pct(p.share === null ? null : p.share * 100, 2)}`}><span className="ane-rank">{i + 1}</span><a className="ane-proposer-name" href={`#/validators/${p.id}`}><ValidatorAvatar id={p.id} seed={String(p.id)} hasLogo={!!p.logo} size={16} /><span>{name}</span></a><i><b style={{ width: `${(p.share ?? 0) / max * 100}%` }} /></i><strong>{pct(p.share === null ? null : p.share * 100)}</strong></div>; })}{rest !== null && rest > 0 && <div className="ane-proposer-row others"><span /><span className="ane-proposer-name">Others / unattributed</span><i><b style={{ width: `${Math.min(100, rest / max * 100)}%` }} /></i><strong>{pct(rest * 100)}</strong></div>}{!dist.length && <Empty loading={!d.metrics && !d.metricsError} />}</div><p className="ane-footnote">Ranked by blocks proposed in the window; the API returns the top {dist.length || 12}. Shares are of all indexed blocks, so unequal shares can reflect different stake.</p></>;
}

function Icon({ name }: { name: string }) {
  const paths: Record<string, string> = { clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4v5l3 2", bars: "M4 20V12h3v8H4Zm6 0V7h3v13h-3Zm6 0V3h3v17h-3Z", block: "m12 3 9 5v9l-9 5-9-5V8l9-5ZM3 8l9 5 9-5m-9 5v9M7 6l9 5", shield: "m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z", people: "M9 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm8 1a3 3 0 0 1 0 6M3 20v-4a6 6 0 0 1 12 0v4H3Zm14-7a5 5 0 0 1 4 5v2h-3", alert: "m12 3 10 18H2L12 3Zm0 6v5m0 3v1", pulse: "M3 12h4l3-8 4 16 3-8h4", notes: "M5 3h10l4 4v14H5V3Zm9 0v5h5M8 12h8m-8 4h8", gauge: "M4 17a8 8 0 1 1 16 0M12 17l4-6M7 17h0m10 0h0" };
  return <svg className="ane-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] ?? paths.pulse} /></svg>;
}
