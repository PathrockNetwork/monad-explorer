import { Timestamp } from "../components/Timestamp";
/** Overview: stat tiles, recent blocks, validator table and analytics rows for Monad mainnet (chain 143). */
import { useEffect, useMemo, useState } from "react";
import type { Dashboard } from "../useDashboard";
import { getMetrics, type Metrics, type Validator } from "../api";
import { ValidatorSummary } from "../components/ValidatorSummary";
import { OverviewLatestTransactions, OverviewQuickInsights } from "../components/OverviewWatchlist";
import { blockTimeSummary, fullMinutes, pendingStakeChanges, previousHourChange } from "../overviewStats";
import { Pipeline } from "../components/Pipeline";
import { MetricGlyph, type MetricIcon } from "../components/OverviewGlyph";
import {
  BRAND,
  Bar,
  Chip,
  CopyButton,
  EmptyState,
  Label,
  TimeSeriesChart,
  OK,
  Section,
  ValidatorAvatar,
  Skeleton,
  StatusPill,
  TX,
  TX2,
  TX3,
  WARN,
  mono,
  panel,
  sans,
} from "../components/ui";
import { area, clampPct, fmt, monCompact, pct, pts, short } from "../lib";

/** Overview-local charts refresh once a minute — they plot one-minute buckets. */
const CHART_REFRESH_MS = 60_000;

export function Overview({
  d,
  live,
  selected,
  onSelect,
  copied,
  onCopy,
}: {
  d: Dashboard;
  live: boolean;
  selected: number | null;
  onSelect: (id: number) => void;
  copied: string | null;
  onCopy: (v: string) => void;
}) {
  const loading = d.state === "loading";
  const dash = d.state === "empty" || d.state === "dberror";
  const stopped = d.state === "stopped";
  const net = d.net;

  // The shared dashboard's metrics follow the Metrics page's range picker, so
  // the overview fetches its own fixed horizons: 1 h of 1-minute buckets for
  // the chart and 6 h of 5-minute buckets for the hour-over-hour comparison.
  const [m1, setM1] = useState<Metrics | null>(null);
  const [m6, setM6] = useState<Metrics | null>(null);
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void getMetrics(1).then((r) => !cancelled && setM1(r)).catch(() => undefined);
      void getMetrics(6).then((r) => !cancelled && setM6(r)).catch(() => undefined);
    };
    refresh();
    const timer = live ? window.setInterval(refresh, CHART_REFRESH_MS) : undefined;
    return () => {
      cancelled = true;
      if (timer !== undefined) clearInterval(timer);
    };
  }, [live]);

  const chartPoints = useMemo(() => (m1?.series ?? []).filter((p) => p.avg_block_time_ms !== null), [m1]);
  const blockStats = useMemo(() => blockTimeSummary(chartPoints), [chartPoints]);
  const hourChange = m6 ? previousHourChange(m6.series, m6.bucket_secs, Date.now()) : null;

  const inspectValidator = (id: number) => {
    onSelect(id);
    window.location.hash = `/validators/${id}`;
  };

  const minutes = useMemo(() => fullMinutes(net?.recent_minutes ?? []), [net]);
  const blocksSpark = useMemo(() => minutes.map((m) => m.blocks), [minutes]);
  const tpsSpark = useMemo(() => minutes.map((m) => m.txs / 60), [minutes]);
  const btSpark = useMemo(
    () => chartPoints.slice(-24).map((p) => p.avg_block_time_ms as number),
    [chartPoints],
  );

  const chartMin = blockStats.min === null ? 0 : Math.max(0, Math.floor((blockStats.min - 20) / 50) * 50);
  const chartMax = blockStats.max === null ? 500 : Math.ceil((blockStats.max + 20) / 50) * 50;

  return (
    <div className="overview-page" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {loading ? (
        <div className="g5 tiles-sticky">
          {[0, 1, 2, 3, 4].map((i) => (
            <div
              key={i}
              style={{ ...panel, padding: "15px 16px 16px", display: "flex", flexDirection: "column", gap: 12 }}
            >
              <Skeleton h={9} w="64%" />
              <Skeleton h={26} w="78%" r={6} />
              <Skeleton h={22} w="100%" r={5} />
            </div>
          ))}
        </div>
      ) : (
        <div className="g5 tiles-sticky">
          <HeightTile
            dash={dash}
            stopped={stopped}
            height={net?.chain_finalized ?? net?.indexed_head ?? null}
            last10={net?.blocks_10m ?? null}
            spark={blocksSpark}
            lastUpdate={net?.indexer_updated_at ?? null}
          />
          <BlockTimeTile dash={dash} ms={net?.avg_block_time_ms ?? null} spark={btSpark} />
          <TpsTile dash={dash} tps={net?.tps ?? null} txs24h={net?.txs_24h ?? null} spark={tpsSpark} />
          <ValidatorsTile dash={dash} d={d} />
          <LagTile dash={dash} d={d} />
        </div>
      )}

      <Pipeline live={live} />

      <div className="overview-main-grid">
        <div className="overview-column overview-primary">
          <ValidatorTable
            d={d}
            selected={selected}
            onSelect={inspectValidator}
            copied={copied}
            onCopy={onCopy}
          />
        </div>
        <div className="overview-column overview-secondary">
          <ValidatorSummary d={d} />
        </div>
      </div>
      <div className="overview-analytics-row">
        <NetworkHealth d={d} dash={dash} />
        <MiniChart
          now={blockStats.latest}
          series={chartPoints.map((p) => p.avg_block_time_ms as number)}
          times={chartPoints.map((p) => p.t)}
          min={chartMin}
          max={chartMax}
          stroke={BRAND}
          fillColor="var(--brandSoft)"
          dash={dash || !blockStats.count}
          stats={blockStats}
          change={dash || stopped ? null : hourChange}
        />
        <EpochCard d={d} onInspect={inspectValidator} />
      </div>
      <div className="overview-bottom-row">
        <OverviewLatestTransactions d={d} live={live} />
        <OverviewQuickInsights d={d} metrics1h={m1} />
      </div>
    </div>
  );
}

/* ── stat tiles ─────────────────────────────────────────────────────────── */

const tile: React.CSSProperties = {
  ...panel,
  padding: "15px 16px 14px",
  display: "flex",
  flexDirection: "column",
  gap: 9,
};

const bigValue: React.CSSProperties = {
  font: `600 31px/1 ${mono}`,
  letterSpacing: "-.02em",
};

function Spark({ values, stroke = BRAND, fillArea = true }: { values: number[]; stroke?: string; fillArea?: boolean }) {
  const max = Math.max(1e-9, ...values);
  const min = fillArea ? 0 : Math.min(...values);
  return (
    <svg width="76" height="26" viewBox="0 0 76 26" fill="none" style={{ flex: "none", overflow: "visible" }}>
      {fillArea && <path d={area(values, 76, 26, min, max)} fill="var(--brandSoft)" />}
      <polyline
        points={pts(values, 76, 26, min, max === min ? min + 1 : max)}
        fill="none"
        stroke={stroke}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function HeightTile({
  dash,
  stopped,
  height,
  last10,
  spark,
  lastUpdate,
}: {
  dash: boolean;
  stopped: boolean;
  height: number | null;
  last10: number | null;
  spark: number[];
  lastUpdate: string | null;
}) {
  return (
    <div className="overview-stat-tile overview-height-tile" style={tile}>
      <MetricHeading icon="block" label="Latest Finalized Block" />
      <span style={{ ...bigValue, color: dash ? TX3 : TX }}>{dash ? "—" : fmt(height)}</span>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 10 }}>
        <span style={{ font: `500 14px/1.3 ${sans}`, color: TX2, whiteSpace: "nowrap" }}>
          {dash ? "no blocks" : stopped ? <>stalled <Timestamp value={lastUpdate} /></> : last10 === null ? "—" : `+${fmt(last10)} in last 10 min`}
        </span>
        {!dash && spark.length > 1 && <Spark values={spark} />}
      </div>
    </div>
  );
}

function BlockTimeTile({ dash, ms, spark }: { dash: boolean; ms: number | null; spark: number[] }) {
  const lo = spark.length ? Math.min(...spark) : null;
  const hi = spark.length ? Math.max(...spark) : null;
  return (
    <div className="overview-stat-tile" style={tile}>
      <MetricHeading icon="clock" label="Avg Block Time" />
      <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
        <span style={{ ...bigValue, color: dash ? TX3 : TX }}>{dash || ms === null ? "—" : fmt(Math.round(ms))}</span>
        <span style={{ font: `500 15px/1 ${sans}`, color: TX3 }}>{dash || ms === null ? "" : "ms"}</span>
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 10 }}>
        <span style={{ font: `500 14px/1.3 ${sans}`, color: TX2 }}>recent blocks</span>
        <div style={{ position: "relative", flex: "none" }}>
          <svg width="76" height="26" viewBox="0 0 76 26" fill="none" style={{ display: "block", overflow: "visible" }}>
            <line x1="0" y1="0.5" x2="76" y2="0.5" stroke="var(--line2)" strokeWidth="1" strokeDasharray="2 3" />
            <line x1="0" y1="25.5" x2="76" y2="25.5" stroke="var(--line2)" strokeWidth="1" strokeDasharray="2 3" />
            {!dash && spark.length > 1 && lo !== null && hi !== null && (
              <polyline
                points={pts(spark, 76, 26, lo - 5, hi + 5)}
                fill="none"
                stroke={OK}
                strokeWidth="1.5"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            )}
          </svg>
          {!dash && hi !== null && lo !== null && <>
            <span style={{ position: "absolute", right: -2, top: -11, font: `400 12px/1 ${mono}`, color: TX3 }}>{Math.round(hi)}</span>
            <span style={{ position: "absolute", right: -2, bottom: -11, font: `400 12px/1 ${mono}`, color: TX3 }}>{Math.round(lo)}</span>
          </>}
        </div>
      </div>
    </div>
  );
}

function TpsTile({ dash, tps, txs24h, spark }: { dash: boolean; tps: number | null; txs24h: number | null; spark: number[] }) {
  return (
    <div className="overview-stat-tile" style={tile}>
      <MetricHeading icon="signing" label="Throughput" />
      <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
        <span style={{ ...bigValue, color: dash ? TX3 : TX }}>{dash || tps === null ? "—" : tps.toFixed(1)}</span>
        <span style={{ font: `500 15px/1 ${sans}`, color: TX3 }}>{dash || tps === null ? "" : "TPS"}</span>
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 10 }}>
        <span style={{ font: `500 14px/1.3 ${sans}`, color: TX2, whiteSpace: "nowrap" }}>
          {dash || txs24h === null ? "—" : `${fmt(txs24h)} tx · 24h`}
        </span>
        {!dash && spark.length > 1 && <Spark values={spark} />}
      </div>
    </div>
  );
}

function ValidatorsTile({ dash, d }: { dash: boolean; d: Dashboard }) {
  const net = d.net;
  const list = d.validators?.validators ?? [];
  const dots = list.length
    ? list.map((v) =>
        dash
          ? "var(--line)"
          : !v.in_consensus_set
            ? "var(--line2)"
            : v.proposal_ratio !== null && v.proposal_ratio < 0.8
              ? WARN
              : "color-mix(in srgb, var(--ok) 70%, transparent)",
      )
    : new Array(20).fill("var(--line)");
  return (
    <div className="overview-stat-tile" style={tile}>
      <MetricHeading icon="validators" label="Active Validators" />
      <div style={{ display: "flex", alignItems: "baseline", gap: 3 }}>
        <span style={{ ...bigValue, color: dash ? TX3 : TX }}>
          {dash || !net ? "—" : fmt(net.validators_active)}
        </span>
        <span style={{ font: `500 19px/1 ${mono}`, color: TX3 }}>
          {dash || !net ? "" : `/ ${fmt(net.validators_total)}`}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: "auto" }}>
        <div style={{ display: "flex", gap: list.length > 60 ? 0 : 2, flex: 1 }}>
          {dots.map((c, i) => (
            <div key={i} style={{ flex: 1, height: 14, borderRadius: list.length > 60 ? 0 : 2, background: c }} />
          ))}
        </div>
      </div>
      <span style={{ font: `500 14px/1.3 ${sans}`, color: TX2, whiteSpace: "nowrap" }}>
        {dash || !net
          ? "set unknown"
          : net.epoch === null
            ? "epoch unknown"
            : `epoch ${fmt(net.epoch)}${net.epoch_delay_period ? " · boundary delay" : ""}`}
      </span>
    </div>
  );
}

function LagTile({ dash, d }: { dash: boolean; d: Dashboard }) {
  const lag = d.net?.lag_blocks ?? null;
  const unknown = lag === null;
  // ~0.3 s blocks: 100 blocks is about half a minute behind.
  const warn = lag !== null && lag > 100;
  const fg = dash || unknown ? TX3 : warn ? WARN : OK;
  const icon = dash || unknown || warn ? "M10 6v5M10 14h.01" : "M4 10.5l4 4 8-9";
  return (
    <div
      className="overview-stat-tile overview-lag-tile"
      style={{
        ...tile,
        border: `1px solid ${warn ? "var(--warn)" : "var(--line)"}`,
      }}
    >
      <MetricHeading icon="lag" label="Indexer Lag" />
      <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
        <span style={{ ...bigValue, color: fg }}>{dash || unknown ? "—" : fmt(lag)}</span>
        <span style={{ font: `500 15px/1 ${sans}`, color: TX3 }}>
          {dash || unknown ? "" : "blocks"}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: "auto" }}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 18,
            height: 18,
            borderRadius: "50%",
            flex: "none",
            background: dash || unknown ? "var(--panel2)" : warn ? "var(--warnSoft)" : "var(--okSoft)",
          }}
        >
          <svg width="11" height="11" viewBox="0 0 20 20" fill="none" stroke={fg} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d={icon} />
          </svg>
        </span>
        <span style={{ font: `600 14px/1.3 ${sans}`, whiteSpace: "nowrap", color: fg }}>
          {dash
            ? "Not started"
            : unknown
              ? "Finalized head unavailable"
              : warn
                ? "Behind finalized head"
                : "Up to date"}
        </span>
      </div>
    </div>
  );
}

function MetricHeading({ icon, label }: { icon: MetricIcon; label: string }) {
  return (
    <div className="metric-heading">
      <MetricGlyph icon={icon} />
      <Label>{label}</Label>
    </div>
  );
}

/* ── validator table ────────────────────────────────────────────────────── */

function ValidatorTable({
  d, selected, onSelect, copied, onCopy,
}: {
  d: Dashboard;
  selected: number | null;
  onSelect: (id: number) => void;
  copied: string | null;
  onCopy: (v: string) => void;
}) {
  const list = d.validators?.validators ?? [];
  const loading = !d.validators && d.state !== "dberror";
  const empty = !loading && list.length === 0;
  const maxShare = Math.max(0.01, ...list.map((v) => v.stake_share));
  const maxProposed = Math.max(1, ...list.map((v) => v.proposed_1000));
  const sample = d.validators?.ratio_sample;
  return (
    <Section
      className="overview-validators"
      bodyStyle={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
      title={<span className="overview-section-title"><MetricGlyph icon="validators" />Validators</span>}
      aside={<div className="overview-validator-actions"><span className="overview-validator-scale" title="Observed ÷ stake-expected proposals over a fully-attributed recent sample. Shown only when at least 5 proposals were expected.">
        Proposal rate is an estimate{sample?.blocks ? ` · ${fmt(sample.blocks)}-block sample` : ""}
      </span><a href="#/validators">View all <span aria-hidden="true">→</span></a></div>}
    >
      {loading && <div className="overview-validator-loading">
        {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} h={42} w="100%" />)}
      </div>}
      {empty && <EmptyState
        title={d.state === "dberror" ? "No data available" : "Awaiting validator sync"}
        text={d.state === "dberror"
          ? "The validator set cannot be read while the API is unreachable."
          : "The validator set appears once the staking precompile has been read."}
      />}
      {!loading && !empty && <>
        <div className="overview-validator-scroll" tabIndex={0} role="region" aria-label="Validators by stake">
          <div className="overview-validator-grid overview-validator-columns">
            <span>#</span><span>Validator / auth address</span><span>Stake share</span>
            <span title="Observed ÷ stake-expected proposals (estimate)">Proposal rate</span><span className="overview-validator-missed">Fee</span>
            <span>Proposed 1k</span><span className="overview-validator-status">Status</span>
          </div>
          {list.map((v) => <Row key={v.id} v={v} selected={v.id === selected}
            onSelect={onSelect} copied={copied === v.auth_address} onCopy={onCopy} maxShare={maxShare} maxProposed={maxProposed} />)}
        </div>
        <footer className="overview-validator-footer">
          <span><strong>{list.length}</strong> validators <span aria-hidden="true">·</span> Scroll to explore</span>
          <span>Stake from the staking precompile · identity from validator-info</span>
        </footer>
      </>}
    </Section>
  );
}

function ratioColor(r: number | null): string {
  if (r === null) return TX3;
  if (r < 0.8) return WARN;
  return r >= 0.95 ? OK : TX;
}

function Row({ v, selected, onSelect, copied, onCopy, maxShare, maxProposed }: {
  v: Validator;
  selected: boolean;
  onSelect: (id: number) => void;
  copied: boolean;
  onCopy: (v: string) => void;
  maxShare: number;
  maxProposed: number;
}) {
  const name = v.name ?? `Validator #${v.id}`;
  const ratioTitle = v.proposal_ratio === null
    ? `Not enough sample: ${v.expected_sample.toFixed(1)} proposals expected (needs ≥ 5)`
    : `${fmt(v.proposed_sample)} observed vs ${v.expected_sample.toFixed(1)} expected by stake`;
  return (
    <div className={`overview-validator-grid overview-validator-row${selected ? " selected" : ""}`}
      onClick={() => onSelect(v.id)} role="button" tabIndex={0}
      aria-pressed={selected} aria-label={`Open ${name}`}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(v.id); }
      }}>
      <span className="overview-validator-rank">{v.rank}</span>
      <div className="overview-validator-identity">
        <ValidatorAvatar id={v.id} seed={v.auth_address} hasLogo={!!v.logo} title={name} size={30} />
        <div className="overview-validator-name">
          <strong title={name}>{name}</strong>
          <div className="overview-validator-address"><span title={v.auth_address}>{short(v.auth_address)}</span><CopyButton value={v.auth_address} copied={copied} onCopy={onCopy} /></div>
        </div>
      </div>
      <div className="overview-validator-meter" title={`${monCompact(v.active_stake)} stake this epoch`}>
        <span>{pct(v.stake_share * 100, 2)}</span>
        <Bar width={clampPct(v.stake_share, 0, maxShare)} color={BRAND} />
      </div>
      <div className="overview-validator-meter" title={ratioTitle}>
        <span style={{ color: ratioColor(v.proposal_ratio) }}>{v.proposal_ratio === null ? "—" : `≈ ${pct(v.proposal_ratio * 100, 0)}`}</span>
        <Bar width={v.proposal_ratio === null ? "0%" : clampPct(v.proposal_ratio, 0, 1.5)} color={ratioColor(v.proposal_ratio)} />
      </div>
      <span className="overview-validator-missed" style={{ color: TX2 }}>{pct(v.active_commission * 100, 0)}</span>
      <div className="overview-validator-meter">
        <span>{fmt(v.proposed_1000)}</span>
        <Bar width={v.proposed_1000 ? clampPct(v.proposed_1000, 0, maxProposed) : "0%"} color={BRAND} />
      </div>
      <span className="overview-validator-status">
        {v.flags !== 0 && <Chip tone="muted" title="Raw, undocumented staking flags">flags {v.flags}</Chip>}
        <StatusPill status={v.in_consensus_set ? "active" : "inactive"} />
      </span>
    </div>
  );
}

/* ── analytics row ──────────────────────────────────────────────────────── */

function NetworkHealth({ d, dash }: { d: Dashboard; dash: boolean }) {
  const net = d.net;
  const ms = net?.avg_block_time_ms ?? null;
  const blocks10 = net?.blocks_10m ?? null;
  const expected10 = ms ? Math.round(600_000 / ms) : null;
  const behind = expected10 !== null && blocks10 !== null && blocks10 < expected10 * 0.9;
  const win = d.validators?.window;
  const attributed = win && win.blocks ? (win.attributed / win.blocks) * 100 : null;

  const verdict = verdictFor(d);

  const meters = dash || d.state === "loading"
    ? [
        { label: "Average block time", value: "—", w: "0%", bg: "var(--line)", c: TX3, scale: "Flagged above 1 s · recent blocks", range: ["0 ms", "1,000 ms"] },
        { label: "Blocks finalized · 10 min", value: "—", w: "0%", bg: "var(--line)", c: TX3, scale: "Waiting for indexed blocks", range: ["0", "—"] },
        { label: "Proposer attribution", value: "—", w: "0%", bg: "var(--line)", c: TX3, scale: "Blocks with a ValidatorRewarded event", range: ["0%", "100%"] },
      ]
    : [
        {
          label: "Average block time",
          value: ms === null ? "—" : `${fmt(Math.round(ms))} ms`,
          w: ms === null ? "0%" : clampPct(ms, 0, Math.max(1000, ms)),
          bg: ms !== null && ms > 1000 ? WARN : OK,
          c: ms === null ? TX3 : ms > 1000 ? WARN : OK,
          scale: "Flagged above 1 s · recent blocks",
          range: ["0 ms", `${fmt(Math.max(1000, Math.ceil(ms ?? 1000)))} ms`],
        },
        {
          label: "Blocks finalized · 10 min",
          value: fmt(blocks10),
          w: expected10 === null || blocks10 === null ? "0%" : clampPct(blocks10, 0, Math.max(expected10, blocks10)),
          bg: expected10 === null ? "var(--line)" : behind ? WARN : OK,
          c: expected10 === null ? TX3 : behind ? WARN : OK,
          scale: expected10 === null ? "Expected count unavailable" : `≈ ${fmt(expected10)} expected at the measured pace`,
          range: ["0", expected10 === null ? "—" : blocks10 !== null && blocks10 > expected10 ? `${fmt(blocks10)} observed` : `${fmt(expected10)} expected`],
        },
        {
          label: "Proposer attribution",
          value: attributed === null ? "—" : pct(attributed, 2),
          w: attributed === null ? "0%" : clampPct(attributed, 0, 100),
          bg: attributed === null ? "var(--line)" : attributed < 99 ? WARN : OK,
          c: attributed === null ? TX3 : attributed < 99 ? WARN : OK,
          scale: win ? `${fmt(win.attributed)} of ${fmt(win.blocks)} indexed blocks` : "Blocks with a ValidatorRewarded event",
          range: ["0%", "100%"],
        },
      ];

  return (
    <section className="overview-health-card" style={panel}>
      <header className="overview-health-heading">
        <div className="analytics-heading"><MetricGlyph icon="health" /><h3>Network Health</h3></div>
        <span className="overview-health-verdict" style={{ color: verdict.color }}><i />{verdict.text}</span>
      </header>
      <p className="overview-health-description">{d.state === "loading" ? "Checking recent network activity…" : d.state === "dberror" ? "Network health is temporarily unavailable." : d.state === "stopped" ? "Indexer stopped. Showing last known activity." : d.state === "empty" ? "Waiting for the first finalized blocks." : d.state === "backfill" ? "The indexer is catching up to the finalized head." : ms !== null && ms > 1000 ? "Block production is slower than usual." : "Monad mainnet is finalizing blocks normally."}</p>
      <div className="overview-health-meters">
        {meters.map((m, index) => (
          <div className="overview-health-metric" key={m.label} title={m.scale}>
            <MetricGlyph icon={(["clock", "block", "validators"] as const)[index]} />
            <div className="overview-health-metric-body">
              <div className="overview-health-metric-row"><span>{m.label}</span><strong style={{ color: m.c }}>{m.value}</strong></div>
              <p>{m.scale}</p>
              <Bar width={m.w} color={m.bg} h={5} />
              <div className="overview-health-range"><span>{m.range[0]}</span><span>{m.range[1]}</span></div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Explorer/indexer health. Validator performance is shown separately as an estimate. */
export function verdictFor(d: Dashboard): { text: string; color: string } {
  if (d.state === "dberror") return { text: "Unknown — no data", color: "var(--bad)" };
  if (d.state === "stopped") return { text: "Stale — indexer stopped", color: WARN };
  if (d.state === "empty") return { text: "Bootstrapping", color: TX3 };
  if (d.state === "loading") return { text: "Loading", color: TX3 };
  if (d.state === "backfill") return { text: "Catching up", color: WARN };
  const ms = d.net?.avg_block_time_ms ?? null;
  if (ms !== null && ms > 1000) return { text: "Slow blocks", color: WARN };
  return { text: "Healthy", color: OK };
}

function MiniChart({
  now,
  series,
  times,
  min,
  max,
  stroke,
  fillColor,
  stats,
  change,
  dash,
}: {
  now: number | null;
  series: number[];
  times: string[];
  min: number;
  max: number;
  stroke: string;
  fillColor: string;
  stats: ReturnType<typeof blockTimeSummary>;
  change: number | null;
  dash: boolean;
}) {
  const ms = (v: number | null) => (v === null ? "—" : `${Math.round(v)} ms`);
  return (
    <section className="overview-mini-chart" style={panel}>
      <header className="overview-chart-heading">
        <div className="analytics-heading">
          <MetricGlyph icon="clock" />
          <h3>Block Time</h3>
        </div>
        <span>Last 60 minutes</span>
      </header>
      <div className="overview-chart-summary">
        <div className="overview-chart-reading">
          <strong style={{ color: dash ? TX3 : TX }}>{dash || now === null ? "—" : <>{Math.round(now)}<span> ms</span></>}</strong>
          <span>Latest 1-minute average</span>
        </div>
        <div className="overview-chart-comparison" title="Block-weighted mean block time, last hour vs. the hour before, from 5-minute buckets. At least 9 of 12 buckets are required in each hour.">
          <strong className={change === null ? "unknown" : change > 0 ? "slower" : "faster"}>{change === null ? "—" : `${change > 0 ? "↑ +" : change < 0 ? "↓ −" : ""}${Math.abs(change).toFixed(1)}%`}</strong>
          <span>vs. previous hour</span>
        </div>
      </div>
      <div className="overview-chart-body">
        <div className="overview-chart-graph">
        <div className="overview-chart-area">
          <div className="overview-chart-y-axis" aria-hidden="true">{[0, 1, 2, 3].map((i) => <span key={i}>{Math.round(max - ((max - min) * i) / 3)}</span>)}</div>
          <div className="overview-mini-chart-plot">
          {!dash ? (
            <TimeSeriesChart
              values={series}
              times={times}
              min={min}
              max={max}
              stroke={stroke}
              fillColor={fillColor}
              height="fill"
              compact
              formatValue={(v) => `${Math.round(v)} ms`}
              formatTime={(t) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
            />
          ) : (
            <svg viewBox="0 0 100 20" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
              {[2, 6, 10, 14, 18].map((y) => (
                <line key={y} x1="0" y1={y} x2="100" y2={y} stroke="var(--grid)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
              ))}
            </svg>
          )}
          </div>
        </div>
        <div className="overview-chart-x-axis">
          <span>60 min ago</span>
          <span>45 min</span><span>30 min</span><span>15 min</span>
          <span>Now</span>
        </div>
        </div>
        <dl className="overview-chart-stats" aria-label="Statistics of one-minute block-time averages">
          <div><dt>Min</dt><dd>{dash ? "—" : ms(stats.min)}</dd></div>
          <div><dt>Avg</dt><dd>{dash ? "—" : ms(stats.avg)}</dd></div>
          <div><dt>Max</dt><dd>{dash ? "—" : ms(stats.max)}</dd></div>
        </dl>
      </div>
    </section>
  );
}

/**
 * Replaces Secret's "validator set changes": Monad's set is fixed per epoch,
 * and live (execution) stake that differs from this epoch's consensus stake
 * takes effect at a later boundary.
 */
function EpochCard({ d, onInspect }: { d: Dashboard; onInspect: (id: number) => void }) {
  const [expanded, setExpanded] = useState(false);
  const vl = d.validators;
  const changes = useMemo(() => pendingStakeChanges(vl?.validators ?? []), [vl]);
  const events = expanded ? changes : changes.slice(0, 5);
  const unavailable = !vl && d.state !== "loading";
  const signed = (delta: bigint) => (delta < 0n ? `−${monCompact((-delta).toString())}` : `+${monCompact(delta.toString())}`);
  return (
    <section className="overview-set-changes" style={panel}>
      <header className="set-changes-heading">
        <div>
          <div className="analytics-heading">
            <MetricGlyph icon="changes" />
            <h3>Epoch {vl?.epoch != null ? fmt(vl.epoch) : "—"}</h3>
          </div>
          <p>
            {vl?.epoch_delay_period
              ? "Boundary delay: the next epoch's validator set and stake are already fixed. "
              : "Mid-epoch: this epoch's validator set and stake are fixed. "}
            Changes below take effect at the next epoch.
            {vl?.synced_at && <> Synced <Timestamp value={vl.synced_at} />.</>}
          </p>
        </div>
        {changes.length > 5 && <button type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>{expanded ? "Show top 5" : `View all ${changes.length}`} <span aria-hidden="true">{expanded ? "↑" : "→"}</span></button>}
      </header>
      {d.state === "loading" && !vl ? <div className="set-changes-empty"><Skeleton h={120} w="100%" /></div> : unavailable ? <p className="set-changes-empty">Validator stake data is unavailable.</p> : events.length === 0 ? <p className="set-changes-empty">Live stake matches this epoch’s consensus stake (moves under 1 MON ignored).</p> :
        <div className="set-changes-scroll" role="region" aria-label="Validator stake changes for next epoch" tabIndex={0}>
          <table>
            <thead><tr><th>Validator</th><th>Change</th><th>Next − this epoch</th><th>Stake next epoch</th></tr></thead>
            <tbody>{events.map((e) => {
              const down = e.kind === "leaving" || e.kind === "decrease";
              return <tr key={e.v.id}>
                <td><button type="button" onClick={() => onInspect(e.v.id)} title={e.v.name ?? e.v.auth_address}><span className={`set-change-symbol ${down ? "removed" : ""}`} aria-hidden="true">{down ? "−" : "+"}</span><span>{e.v.name ?? short(e.v.auth_address)}</span></button></td>
                <td><span className={`set-change-pill ${down ? "removed" : ""}`}>{e.kind === "joining" ? "Joining" : e.kind === "leaving" ? "Leaving" : e.kind === "increase" ? "Stake in" : "Stake out"}</span></td>
                <td><span>{signed(e.delta)}</span></td>
                <td><span>{monCompact(e.v.next_stake)}</span></td>
              </tr>;
            })}</tbody>
          </table>
        </div>}
    </section>
  );
}
