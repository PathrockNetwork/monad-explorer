/**
 * Monad staking: delegation flows, measured reward rates, a delegation
 * calculator, delegator lookup and the live staking-precompile event feed.
 * Deep link `#/staking/<validatorId>` preselects that validator in the calculator.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Dashboard } from "../useDashboard";
import { getRewardRates, getStaking, type RewardRates, type StakingSummary } from "../api";
import { Skeleton } from "../components/ui";
import { Timestamp } from "../components/Timestamp";
import { preferredScrollBehavior } from "../appearance";
import { fmt, pct } from "../lib";
import { StakingCalculator, type CalcOption } from "../components/StakingCalculator";
import { StakingEvents } from "../components/StakingEvents";
import { StakingLookup } from "../components/StakingLookup";
import {
  APR_NOTE, MIN_BLOCKS, NOISE_NOTE, SortTh, ValidatorLink, aprText, big, cmpBig, monExact, monShort, monSigned, useSorted, validatorLabel,
} from "../components/StakingShared";
import "./staking.css";

const WINDOWS = [{ hours: 24, label: "24h" }, { hours: 168, label: "7d" }, { hours: 720, label: "30d" }];
const COVERAGE_OK = 0.95;
const SUMMARY_REFRESH_MS = 30_000;
const RATES_REFRESH_MS = 60_000;

/** `#/staking/<id>` → id; anything else → null. */
function idFromHash(): number | null {
  const [page, id] = window.location.hash.replace(/^#\/?/, "").split("/");
  return page === "staking" && id && /^\d+$/.test(id) ? Number(id) : null;
}

const windowLabel = (h: number) => WINDOWS.find((w) => w.hours === h)?.label ?? (h % 24 === 0 ? `${h / 24}d` : `${h}h`);
const commissionPct = (n: number | null | undefined) => {
  if (n == null || !Number.isFinite(n)) return "—";
  const p = Math.round(n * 10_000) / 100;
  return pct(p, Number.isInteger(p) ? 0 : 2);
};

/** Polls a fetcher while the page is visible; keeps the last good value on failure. */
function usePolled<T>(fetcher: () => Promise<T>, ms: number, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const run = () => fetcher().then((r) => { if (!cancelled) { setData(r); setFailed(false); } }).catch(() => { if (!cancelled) setFailed(true); });
    void run();
    const id = setInterval(() => { if (document.visibilityState === "visible") void run(); }, ms);
    return () => { cancelled = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, failed };
}

export function Staking({ d }: { d: Dashboard }) {
  const [hours, setHours] = useState(24);
  const retain = d.config?.indexer.retain_hours ?? 0;
  const rateHours = retain > 0 ? Math.min(24, retain) : 24;
  const summary = usePolled<StakingSummary>(() => getStaking(hours), SUMMARY_REFRESH_MS, [hours]);
  const rates = usePolled<RewardRates>(() => getRewardRates(rateHours), RATES_REFRESH_MS, [rateHours]);
  const s = summary.data && summary.data.hours === hours ? summary.data : null;
  const stale = !s && summary.data ? summary.data : null;
  const shown = s ?? stale;
  const r = rates.data;

  const list = d.validators?.validators;
  const logos = useMemo(() => new Map((list ?? []).map((v) => [v.id, { logo: !!v.logo, seed: v.auth_address }])), [list]);
  const active = useMemo(() => new Map((list ?? []).map((v) => [v.id, v.in_consensus_set])), [list]);

  // Calculator selection: the hash wins; otherwise the best-measured delegator APR with enough blocks.
  const [picked, setPicked] = useState<number | null>(idFromHash);
  useEffect(() => {
    const sync = () => { const id = idFromHash(); if (id !== null) setPicked(id); };
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  const options: CalcOption[] = useMemo(() => (r?.validators ?? [])
    .filter((v) => big(v.stake) > 0n || v.blocks > 0)
    .map((v) => ({
      id: v.id, name: v.name, logo: logos.get(v.id)?.logo ?? false, seed: logos.get(v.id)?.seed ?? String(v.id),
      blocks: v.blocks, commission: v.commission, apr: v.apr, delegator_apr: v.delegator_apr, active: active.get(v.id) ?? true,
    }))
    .sort((a, b) => validatorLabel(a.id, a.name).localeCompare(validatorLabel(b.id, b.name))), [r, logos, active]);
  const fallback = useMemo(() => options
    .filter((o) => o.blocks >= MIN_BLOCKS && o.delegator_apr !== null && o.active)
    .sort((a, b) => (b.delegator_apr ?? 0) - (a.delegator_apr ?? 0))[0]?.id ?? null, [options]);
  const selected = picked ?? fallback;
  const choose = useCallback((id: number) => {
    setPicked(id);
    // replaceState: shareable URL without a history entry or a page re-route.
    window.history.replaceState(null, "", `#/staking/${id}`);
  }, []);
  const calculate = (id: number) => {
    choose(id);
    requestAnimationFrame(() => document.getElementById("sk-calculator")?.scrollIntoView({ behavior: preferredScrollBehavior(), block: "start" }));
  };

  const loading = !shown && !summary.failed;
  const net = big(shown?.totals.net);
  const coverage = r?.coverage ?? null;
  const windowStart = Date.now() - hours * 3_600_000;
  const oldest = shown?.history.oldest_event ? Date.parse(shown.history.oldest_event) : NaN;
  const partialWindow = Number.isFinite(oldest) && oldest > windowStart + 3_600_000;
  const label = windowLabel(hours);

  const tiles = [
    { label: `Network reward APR · ${rateHours}h`, value: aprText(r?.network_apr), note: coverage !== null && coverage < COVERAGE_OK ? `Measured · rewards known for ${pct(coverage * 100, 0)} of blocks` : "Measured from rewards paid, before commission", tone: "ok", title: APR_NOTE, wait: !r && !rates.failed },
    { label: `Delegated · ${label}`, value: monShort(shown?.totals.delegated), note: `${fmt(shown?.kinds.find((k) => k.kind === "delegate")?.n ?? 0)} delegate events`, tone: "ok", title: monExact(shown?.totals.delegated), wait: loading },
    { label: `Undelegated · ${label}`, value: monShort(shown?.totals.undelegated), note: shown && big(shown.totals.withdrawn) > 0n ? `${monShort(shown.totals.withdrawn)} withdrawn` : `${fmt(shown?.kinds.find((k) => k.kind === "undelegate")?.n ?? 0)} undelegate events`, tone: "bad", title: monExact(shown?.totals.undelegated), wait: loading },
    { label: `Net stake flow · ${label}`, value: monSigned(shown?.totals.net), note: "Delegated − undelegated", tone: net > 0n ? "ok" : net < 0n ? "bad" : "muted", title: shown ? `${net < 0n ? "−" : ""}${monExact((net < 0n ? -net : net).toString())}` : undefined, wait: loading },
    { label: `Rewards claimed · ${label}`, value: monShort(shown?.totals.claimed), note: `${fmt(shown?.kinds.find((k) => k.kind === "claim")?.n ?? 0)} claims`, tone: "brand", title: monExact(shown?.totals.claimed), wait: loading },
    { label: `Active stakers · ${label}`, value: fmt(shown?.totals.addresses), note: `Addresses across ${fmt(shown?.totals.events)} events`, tone: "normal", wait: loading },
  ];

  return <div className="sk-page">
    <div className="sk-toolbar">
      <span>Flows over the last {label} · reward rates measured over the last {rateHours}h</span>
      <div className="sk-ranges" role="group" aria-label="Flow window">{WINDOWS.map((w) => <button key={w.hours} type="button" aria-pressed={hours === w.hours} onClick={() => setHours(w.hours)}>{w.label}</button>)}</div>
    </div>
    {stale && <div className="sk-notice" role="status">Loading the {label} window · showing {windowLabel(stale.hours)} until it arrives.</div>}
    {summary.failed && <div className="sk-notice" role="status">Staking flows could not refresh.{shown ? " Showing the last loaded snapshot." : ""}</div>}
    {coverage !== null && coverage < COVERAGE_OK && <div className="sk-notice" role="status">Block rewards are known for {pct(coverage * 100, 0)} of the {fmt(r?.blocks)} blocks in the last {rateHours}h. A repair job is still filling older blocks; rates are scaled to the covered blocks, so treat them as estimates until coverage nears 100%.</div>}
    {partialWindow && <div className="sk-notice" role="status">Staking history is collected back to <Timestamp value={shown?.history.oldest_event} />, which is inside this {label} window, so flow totals are partial.</div>}

    <div className="sk-tiles">{tiles.map((t) => <section key={t.label} className={`sk-panel sk-tile ${t.tone}`} title={t.title}>
      <span className="sk-eyebrow">{t.label}</span>
      {t.wait ? <Skeleton h={26} w="70%" /> : <strong>{t.value}</strong>}
      <p>{t.note}</p>
    </section>)}</div>

    <div className="sk-grid">
      <Flows summary={shown} failed={summary.failed} label={label} logos={logos} />
      <StakingCalculator options={options} selected={selected} onSelect={choose} loading={!r && !rates.failed} failed={rates.failed} hours={rateHours} />
    </div>

    <Rates rates={r} failed={rates.failed} logos={logos} onCalculate={calculate} selected={selected} />

    <StakingLookup logos={logos} epoch={d.validators?.epoch ?? d.net?.epoch ?? null} />

    <StakingEvents logos={logos} />

    <footer className="sk-history">
      <strong>History coverage</strong>
      <span>{shown
        ? <>Staking history collected back to {shown.history.scanned_from_block !== null ? <>block <a href={`#/blocks/${shown.history.scanned_from_block}`}>#{fmt(shown.history.scanned_from_block)}</a></> : "the start of indexing"}{shown.history.oldest_event ? <> (oldest event <Timestamp value={shown.history.oldest_event} />)</> : null} · {fmt(shown.history.events)} events collected.</>
        : "Loading history coverage…"}</span>
      <span>New events are captured live. A background crawler walks backwards with eth_getLogs, which the public RPC limits to {fmt(d.config?.features.staking_logs_range ?? 100)} blocks per call, so older history fills in slowly{d.config && !d.config.features.staking_history ? " (the crawler is disabled on this deployment)" : ""}. A private RPC with wider log ranges makes it complete.</span>
      <span>Reward APRs are measured from the ValidatorRewarded block rewards each pool received over the last {rateHours}h, annualised against the stake in force this epoch. They look backwards and are not promises. Epochs last about 5.5 hours; amounts are MON (18 decimals).</span>
    </footer>
  </div>;
}

type Logos = Map<number, { logo: boolean; seed: string }>;
type Flow = StakingSummary["flows"][number];
type FlowKey = "name" | "delegated" | "undelegated" | "net" | "claimed" | "delegators";
const FLOW_SORT: Record<FlowKey, (a: Flow, b: Flow) => number> = {
  name: (a, b) => validatorLabel(a.id, a.name).localeCompare(validatorLabel(b.id, b.name)),
  delegated: (a, b) => cmpBig(big(a.delegated), big(b.delegated)),
  undelegated: (a, b) => cmpBig(big(a.undelegated), big(b.undelegated)),
  net: (a, b) => cmpBig(big(a.net), big(b.net)),
  claimed: (a, b) => cmpBig(big(a.claimed), big(b.claimed)),
  delegators: (a, b) => a.delegators - b.delegators,
};

function Flows({ summary, failed, label, logos }: { summary: StakingSummary | null; failed: boolean; label: string; logos: Logos }) {
  const [all, setAll] = useState(false);
  const flows = useMemo(() => summary?.flows ?? [], [summary]);
  const { sorted, sort, toggle } = useSorted<Flow, FlowKey>(flows, FLOW_SORT, { key: "net", desc: true });
  const visible = all ? sorted : sorted.slice(0, 12);
  return <section className="sk-panel sk-flows" aria-labelledby="sk-flows-title">
    <header className="sk-heading"><div><h2 id="sk-flows-title">Delegation flows</h2><p>Stake delegated to and undelegated from each validator over the last {label}.</p></div><span className="sk-count">{summary ? fmt(flows.length) : "—"}</span></header>
    <div className="sk-table-scroll">
      <table className="sk-table">
        <thead><tr>
          <SortTh id="name" label="Validator" sort={sort} onSort={toggle} />
          <SortTh id="delegated" label="Delegated" sort={sort} onSort={toggle} align="right" />
          <SortTh id="undelegated" label="Undelegated" sort={sort} onSort={toggle} align="right" />
          <SortTh id="net" label="Net" sort={sort} onSort={toggle} align="right" />
          <SortTh id="claimed" label="Claimed" sort={sort} onSort={toggle} align="right" />
          <SortTh id="delegators" label="Delegators" sort={sort} onSort={toggle} align="right" title="Distinct addresses that delegated or undelegated" />
        </tr></thead>
        <tbody>
          {!summary ? (failed ? <tr><td colSpan={6} className="sk-empty">Delegation flows are temporarily unavailable.</td></tr>
            : Array.from({ length: 4 }, (_, i) => <tr key={i}><td colSpan={6}><Skeleton h={18} w="100%" /></td></tr>))
            : visible.length === 0 ? <tr><td colSpan={6} className="sk-empty">No delegations or undelegations collected in the last {label}.</td></tr>
            : visible.map((f) => {
              const n = big(f.net);
              const l = logos.get(f.id);
              return <tr key={f.id}>
                <td><ValidatorLink id={f.id} name={f.name} logo={l?.logo} seed={l?.seed} /></td>
                <td className="sk-num" title={monExact(f.delegated)}>{big(f.delegated) > 0n ? monShort(f.delegated) : <span className="sk-muted">0</span>}</td>
                <td className="sk-num" title={monExact(f.undelegated)}>{big(f.undelegated) > 0n ? monShort(f.undelegated) : <span className="sk-muted">0</span>}</td>
                <td className={`sk-num ${n > 0n ? "ok" : n < 0n ? "bad" : "sk-muted"}`}>{monSigned(f.net)}</td>
                <td className="sk-num" title={monExact(f.claimed)}>{big(f.claimed) > 0n ? monShort(f.claimed) : <span className="sk-muted">0</span>}</td>
                <td className="sk-num">{fmt(f.delegators)}</td>
              </tr>;
            })}
        </tbody>
      </table>
    </div>
    {flows.length > 12 && <footer className="sk-table-footer"><span>{all ? `All ${fmt(flows.length)} validators` : `Top 12 of ${fmt(flows.length)}`}</span><button type="button" onClick={() => setAll((a) => !a)}>{all ? "Show fewer" : "Show all"}</button></footer>}
  </section>;
}

type Rate = RewardRates["validators"][number];
type RateKey = "name" | "blocks" | "rewards" | "stake" | "commission" | "apr" | "delegator_apr";
const nullLast = (a: number | null, b: number | null) => (a === null ? (b === null ? 0 : -1) : b === null ? 1 : a - b);
const RATE_SORT: Record<RateKey, (a: Rate, b: Rate) => number> = {
  name: (a, b) => validatorLabel(a.id, a.name).localeCompare(validatorLabel(b.id, b.name)),
  blocks: (a, b) => a.blocks - b.blocks,
  rewards: (a, b) => cmpBig(big(a.rewards), big(b.rewards)),
  stake: (a, b) => cmpBig(big(a.stake), big(b.stake)),
  commission: (a, b) => a.commission - b.commission,
  apr: (a, b) => nullLast(a.apr, b.apr),
  delegator_apr: (a, b) => nullLast(a.delegator_apr, b.delegator_apr),
};

function Rates({ rates, failed, logos, onCalculate, selected }: { rates: RewardRates | null; failed: boolean; logos: Logos; onCalculate: (id: number) => void; selected: number | null }) {
  const [all, setAll] = useState(false);
  const [query, setQuery] = useState("");
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^#/, "");
    return (rates?.validators ?? []).filter((v) => (big(v.stake) > 0n || v.blocks > 0) && (!q || String(v.id) === q || validatorLabel(v.id, v.name).toLowerCase().includes(q)));
  }, [rates, query]);
  const { sorted, sort, toggle } = useSorted<Rate, RateKey>(rows, RATE_SORT, { key: "stake", desc: true });
  const visible = all || query ? sorted : sorted.slice(0, 25);
  const h = rates?.hours ?? 24;
  return <section className="sk-panel sk-rates" aria-labelledby="sk-rates-title">
    <header className="sk-heading">
      <div><h2 id="sk-rates-title">Measured reward rates</h2><p>Block rewards each validator's pool received over the last {h}h, annualised against its stake this epoch. Muted rows have fewer than {MIN_BLOCKS} rewarded blocks, too few to read much into.</p></div>
      <label className="sk-search sk-search-sm"><span aria-hidden="true">⌕</span><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter validators…" aria-label="Filter reward rates by validator" /></label>
    </header>
    <div className="sk-table-scroll">
      <table className="sk-table">
        <thead><tr>
          <SortTh id="name" label="Validator" sort={sort} onSort={toggle} />
          <SortTh id="blocks" label={`Blocks ${h}h`} sort={sort} onSort={toggle} align="right" title="Blocks proposed with a known reward: the sample size behind the rate" />
          <SortTh id="rewards" label="Rewards" sort={sort} onSort={toggle} align="right" />
          <SortTh id="stake" label="Stake" sort={sort} onSort={toggle} align="right" title="Stake in force this epoch" />
          <SortTh id="commission" label="Comm." sort={sort} onSort={toggle} align="right" />
          <SortTh id="apr" label="Reward APR" sort={sort} onSort={toggle} align="right" title={APR_NOTE} />
          <SortTh id="delegator_apr" label="Delegator APR" sort={sort} onSort={toggle} align="right" title={APR_NOTE} />
          <th aria-label="Calculate" />
        </tr></thead>
        <tbody>
          {!rates ? (failed ? <tr><td colSpan={8} className="sk-empty">Reward rates are temporarily unavailable.</td></tr>
            : Array.from({ length: 6 }, (_, i) => <tr key={i}><td colSpan={8}><Skeleton h={18} w="100%" /></td></tr>))
            : visible.length === 0 ? <tr><td colSpan={8} className="sk-empty">{query ? "No validator matches this filter." : "No reward data in the window yet."}</td></tr>
            : visible.map((v) => {
              const noisy = v.blocks < MIN_BLOCKS;
              const l = logos.get(v.id);
              return <tr key={v.id} className={`${noisy ? "sk-row-noisy" : ""} ${selected === v.id ? "selected" : ""}`} title={noisy ? NOISE_NOTE(v.blocks) : undefined}>
                <td><ValidatorLink id={v.id} name={v.name} logo={l?.logo} seed={l?.seed} /></td>
                <td className="sk-num">{fmt(v.blocks)}{noisy && <span className="sk-hint" aria-label="small sample"> ⓘ</span>}</td>
                <td className="sk-num" title={monExact(v.rewards)}>{monShort(v.rewards)}</td>
                <td className="sk-num" title={monExact(v.stake)}>{monShort(v.stake)}</td>
                <td className="sk-num">{commissionPct(v.commission)}</td>
                <td className="sk-num">{aprText(v.apr)}</td>
                <td className={`sk-num sk-strong ${noisy || v.delegator_apr === null ? "" : "ok"}`}>{aprText(v.delegator_apr)}</td>
                <td><button type="button" className="sk-link-btn" onClick={() => onCalculate(v.id)} aria-label={`Calculate delegation returns for ${validatorLabel(v.id, v.name)}`}>Calc →</button></td>
              </tr>;
            })}
        </tbody>
      </table>
    </div>
    {rates && <footer className="sk-table-footer">
      <span>{fmt(rates.blocks)} blocks in the window · {monShort(rates.total_rewards)} paid to the active set{rates.coverage < COVERAGE_OK ? ` · rewards known for ${pct(rates.coverage * 100, 0)} of blocks` : ""}</span>
      {!query && sorted.length > 25 && <button type="button" onClick={() => setAll((a) => !a)}>{all ? "Show top 25" : `Show all ${fmt(sorted.length)}`}</button>}
    </footer>}
  </section>;
}
