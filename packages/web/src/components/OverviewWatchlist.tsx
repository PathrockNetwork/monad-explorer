/**
 * Overview bottom row. Secret's validator watchlist has no Monad equivalent
 * (the API has no watched flag and no write endpoints), so its slot holds the
 * latest transactions; Quick Insights keeps its look with Monad facts.
 */
import { useEffect, useState } from "react";
import type { Dashboard } from "../useDashboard";
import { getTransactions, type Metrics, type Tx } from "../api";
import { fullMinutes, setSummary } from "../overviewStats";
import { fmt, methodLabel, mon, pct, short } from "../lib";
import { Identicon, Skeleton, panel } from "./ui";
import { Timestamp } from "./Timestamp";
import { MetricGlyph } from "./OverviewGlyph";

const TX_POLL_MS = 5_000;

export function OverviewLatestTransactions({ d, live }: { d: Dashboard; live: boolean }) {
  const [txs, setTxs] = useState<Tx[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      getTransactions(8)
        .then((r) => {
          if (cancelled) return;
          setTxs(r.txs);
          setError(false);
        })
        .catch(() => !cancelled && setError(true));
    void load();
    if (!live) return () => {
      cancelled = true;
    };
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, TX_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [live]);

  const loading = txs === null && !error;
  return <section className="overview-watchlist overview-latest-txs" style={panel}>
    <header>
      <h3><MetricGlyph icon="transactions" /> Latest Transactions <small>{txs ? txs.length : "—"}</small></h3>
      <a href="#/transactions" aria-label="View all transactions" title="View all transactions">View all <span aria-hidden="true">→</span></a>
    </header>
    <div className="overview-watchlist-items" role="region" aria-label="Latest transactions" tabIndex={0}>
      {loading ? <Skeleton h={70} w="100%" /> : error && !txs ? <p className="overview-muted">Transactions are unavailable.</p> : !txs || txs.length === 0 ? <div className="overview-watchlist-empty"><span className="watchlist-empty-star" aria-hidden="true">⇄</span><strong>No transactions indexed yet</strong><p>Transactions appear as finalized blocks are indexed.</p></div> : txs.map((t) => {
        const label = methodLabel(t.method, t.input_size, t.to);
        const failed = t.status === 0;
        return <button type="button" key={t.hash} onClick={() => { window.location.hash = `/transactions/${t.hash}`; }} title={`${t.hash}\nfrom ${t.from}\nto ${t.to ?? "contract creation"}\nblock ${fmt(t.block_number)}${failed ? "\nfailed" : ""}`}>
          <Identicon address={t.from} size={20} />
          <span className="olt-hash">{short(t.hash)}</span>
          <span className="olt-meta">{t.value !== "0" ? mon(t.value, 4) : <>→ {short(t.to ?? t.contract_address)}</>} · <Timestamp value={t.time} /></span>
          <small className={`watch-badge ${failed ? "inactive" : "active"}`}>{failed ? "Failed" : label}</small>
        </button>;
      })}
    </div>
    {d.state === "stopped" && <p className="overview-muted">Indexer stopped · showing last known data.</p>}
  </section>;
}

export function OverviewQuickInsights({ d, metrics1h }: { d: Dashboard; metrics1h: Metrics | null }) {
  const net = d.net;
  const list = d.validators?.validators ?? [];
  const s = setSummary(list);
  const loading = d.state === "loading";
  const unavailable = d.state === "dberror" || d.state === "empty";
  const minutes = fullMinutes(net?.recent_minutes ?? []);
  const gasSeries = (metrics1h?.series ?? []).map((p) => p.gas_utilization ?? 0).slice(-30);
  const gasUtil = metrics1h?.stats.gas_utilization ?? null;
  const rows = [
    {
      icon: "M4 4h16v16H4zM7 8h10M7 12h10M7 16h6",
      title: "Transactions · 24h",
      description: "Finalized transactions in the indexed window",
      value: net ? fmt(net.txs_24h) : null,
      note: net?.tps != null ? `${net.tps.toFixed(1)} TPS now` : "per minute",
      values: minutes.map((m) => m.txs),
      chartLabel: "Transactions per full minute, last 30 minutes; oldest to newest",
    },
    {
      icon: "M5 19V9M10 19V5M15 19v-7M20 19v-4",
      title: "Block gas usage · 1h",
      description: "Gas used vs. block gas limit (Monad bills on gas limit)",
      value: gasUtil === null ? null : pct(gasUtil * 100),
      note: "of block gas limit",
      values: gasSeries,
      chartLabel: "Block gas utilization per minute over the last 30 minutes; oldest to newest",
    },
    {
      icon: "M12 8v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
      title: "Low proposal rate",
      description: "Below 80% of stake-expected proposals (estimate)",
      value: d.validators ? fmt(s.lowProposal.length) : null,
      note: d.validators ? `of ${fmt(list.filter((v) => v.proposal_ratio !== null).length)} with a sample` : "current set",
      values: list.map((v) => (v.proposal_ratio !== null && v.proposal_ratio < 0.8 ? 1 : 0)),
      chartLabel: "Current set: one mark per validator; highlighted when its proposal rate is below 80% of expected",
    },
  ];
  return <section className="overview-insights-panel" style={panel}>
    <header><MetricGlyph icon="insights" /><h3>Quick Insights</h3></header>
    {loading ? <Skeleton h={170} w="100%" /> : unavailable ? <p className="overview-muted">Insights will return when data is available.</p> : <ul>
      {rows.map((row) => <li key={row.title} title={row.description}>
        <span className="overview-insight-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d={row.icon} /></svg></span>
        <div className="overview-insight-copy"><strong>{row.title}</strong><span>{row.description}</span></div>
        <div className="overview-insight-value"><strong>{row.value ?? "—"}</strong><span>{row.note}</span></div>
        <div className={`overview-insight-bars${row.values.length > 40 ? " dense" : ""}`} role="img" aria-label={row.chartLabel} title={row.chartLabel}>
          {row.values.length ? row.values.map((value, i) => <i key={i} style={{ height: `${value ? Math.max(12, (value / Math.max(Number.EPSILON, ...row.values)) * 100) : 12}%`, background: value ? "var(--brand2)" : "var(--line2)" }} />) : <span>—</span>}
        </div>
      </li>)}
    </ul>}
  </section>;
}
