import type { Dashboard } from "../useDashboard";
import { setSummary } from "../overviewStats";
import { fmt, monCompact, pct } from "../lib";
import { Skeleton, panel } from "./ui";
import { medianDelegatorApr } from "../validatorSummary";

/** Compact consensus-set composition; the full directory carries validator detail. */
export function ValidatorSummary({ d }: { d: Dashboard }) {
  const list = d.validators?.validators ?? [];
  const s = setSummary(list);
  const rate = (value: number | null) => (value === null ? "—" : pct(value * 100));
  const loading = d.state === "loading" || (!d.validators && d.state !== "dberror");
  const unavailable = d.state === "dberror" && !d.validators;
  const segments = s.buckets
    ? [
        { key: "top10", label: "Top 10", share: s.buckets.top10, color: "var(--brand)" },
        { key: "mid", label: "Ranks 11–50", share: s.buckets.mid, color: "var(--brand2)" },
        { key: "rest", label: "Rest of set", share: s.buckets.rest, color: "var(--line2)" },
      ]
    : [];
  let offset = 0;

  return <section className="validator-summary-panel" style={panel}>
    <header className="overview-panel-heading">
      <h2><span className="explainer-title-icon"><ShieldGlyph /></span>Validator Set Summary</h2>
      <a href="#/validators">View details <span aria-hidden="true">→</span></a>
    </header>
    {loading ? <div className="validator-summary-loading"><Skeleton h={120} w="100%" /></div> :
      unavailable || s.total === 0 ? <div className="validator-summary-empty">{unavailable ? "Validator data is temporarily unavailable." : "Waiting for the first validator-set sync."}</div> :
      <div className="validator-summary-body">
        <div className="validator-status-summary">
          <div className="validator-donut">
            <svg viewBox="0 0 120 120" role="img" aria-label={`Consensus stake: top 10 hold ${rate(s.buckets?.top10 ?? null)}, ranks 11–50 ${rate(s.buckets?.mid ?? null)}, the rest ${rate(s.buckets?.rest ?? null)}`}>
              <circle cx="60" cy="60" r="49" fill="none" stroke="var(--line)" strokeWidth="10" />
              {segments.map((seg) => {
                const share = seg.share * 100;
                const start = offset;
                offset += share;
                return <circle key={seg.key} cx="60" cy="60" r="49" pathLength="100" fill="none" stroke={seg.color} strokeWidth="10" strokeDasharray={`${share} ${100 - share}`} strokeDashoffset={-start} transform="rotate(-90 60 60)" />;
              })}
            </svg>
            <div><strong>{fmt(s.active)}</strong><span>Active</span></div>
          </div>
          <ul className="validator-status-legend">
            {segments.map((seg) => <li key={seg.key}>
              <i style={{ background: seg.color }} /><span>{seg.label}</span>
              <strong>{rate(seg.share)} <small>of stake</small></strong>
            </li>)}
          </ul>
        </div>
        <div className="validator-summary-detail">
          <div className="validator-summary-metrics">
            <div><span className="summary-metric-icon" aria-hidden="true">▱</span><div><span>Active Stake (MON)</span><strong title={`${s.consensusStake} wei`}>{monCompact(s.consensusStake).replace(" MON", "")}</strong><small>active set, epoch {d.validators?.epoch ?? "—"}</small></div></div>
            <div><span className="summary-metric-icon" aria-hidden="true">⅓</span><div><span>Nakamoto Coefficient</span><strong>{s.nakamoto ?? "—"}</strong><small>validators to exceed ⅓ of stake</small></div></div>
          </div>
          <div className="validator-summary-metrics">
            <div><span className="summary-metric-icon" aria-hidden="true">10</span><div><span>Top-10 Share</span><strong>{rate(s.top10Share)}</strong><small>of consensus stake</small></div></div>
            <div><span className="summary-metric-icon" aria-hidden="true">✓</span><div><span>In Registry</span><strong>{fmt(s.registered)} <small>/ {fmt(s.total)}</small></strong><small>monad-developers/validator-info</small></div></div>
          </div>
          <div className="validator-summary-metrics">
            <div title="Measured, backward-looking: block rewards actually paid over 24h, annualised against the stake in force this epoch. Not a promise."><span className="summary-metric-icon" aria-hidden="true">%</span><div><span>Network Reward APR</span><strong>{rate(d.validators?.network_apr ?? null)}</strong><small>{d.validators?.reward_coverage != null && d.validators.reward_coverage < 0.95 ? `measured 24h · ${pct(d.validators.reward_coverage * 100, 0)} of blocks covered` : "measured over 24h, before commission"}</small></div></div>
            <div><span className="summary-metric-icon" aria-hidden="true">↗</span><div><span>Median Delegator APR</span><strong>{rate(medianDelegatorApr(list))}</strong><small><a href="#/staking">net of commission · staking →</a></small></div></div>
          </div>
        </div>
      </div>}
  </section>;
}

function ShieldGlyph() {
  return <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M10 2.8 16 5v4.6c0 3.7-2.5 6.4-6 7.6-3.5-1.2-6-3.9-6-7.6V5l6-2.2Z" /><path d="m7.4 10 1.8 1.8 3.5-3.6" />
  </svg>;
}
