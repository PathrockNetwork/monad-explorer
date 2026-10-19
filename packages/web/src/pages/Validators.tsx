/** Monad validator directory and inspector: stake, commission, set membership and block proposals. */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { preferredScrollBehavior } from "../appearance";
import { Timestamp } from "../components/Timestamp";
import type { Dashboard } from "../useDashboard";
import { getRewardRates, type Validator } from "../api";
import { Chip, Skeleton, ValidatorAvatar } from "../components/ui";
import { ValidatorDrop, ValidatorStatus, RATE_NOTE, commissionText, rateText, Fact, AbandonedChip } from "../components/ValidatorDrop";
import { APR_NOTE, NOISE_NOTE, aprText } from "../components/StakingShared";
import { copyText, downloadCsv, fmt, formatUnits, monCompact, pct, short, toCsv } from "../lib";
import {
  LOW_RATE, commissionHistogram, commissionStats, directoryRows, isLowRate, isNoisyApr, matchesValidatorFilter, median,
  nakamotoCoefficient, setMembership, stakeMovers, validatorName, type ValidatorFilter, type ValidatorSort,
} from "../validatorDirectory";
import { validatorSummary } from "../validatorSummary";
import "./validators.css";

const FILTERS: { id: ValidatorFilter; label: string; title?: string }[] = [
  { id: "all", label: "All" },
  { id: "active", label: "Active", title: "In the current epoch's consensus set" },
  { id: "inactive", label: "Inactive" },
  { id: "vdp", label: "VDP", title: "Validator Delegation Program participants" },
  { id: "unregistered", label: "Unregistered", title: "No entry in the validator-info registry" },
  { id: "low-rate", label: "Low proposal rate", title: `Proposal rate estimate below ${LOW_RATE * 100}%` },
];
const COLUMNS = [
  ["stake", "Stake"], ["commission", "Comm."], ["proposed", "Proposed 1k"], ["rate", "Proposal rate"],
  ["apr", "Delegator APR"], ["last", "Last proposed"], ["status", "Status"],
] as const;
type Column = typeof COLUMNS[number][0];

/** `#/validators/<id>` → id; `#/validators` → null; any other page → undefined. */
function idFromHash(): number | null | undefined {
  const parts = window.location.hash.replace(/^#\/?/, "").split("/");
  if (parts[0] !== "validators") return undefined;
  if (!parts[1]) return null;
  return /^\d+$/.test(parts[1]) ? Number(parts[1]) : null;
}

export function Validators({ d, selected, onSelect }: { d: Dashboard; selected: number | null; onSelect: (id: number | null) => void }) {
  const [filter, setFilter] = useState<ValidatorFilter>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ValidatorSort>("stake");
  const [descending, setDescending] = useState(true);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [columns, setColumns] = useState<Column[]>(COLUMNS.map(([id]) => id));
  const [copied, setCopied] = useState<string | null>(null);

  const list = d.validators;
  const validators = useMemo(() => list?.validators ?? [], [list]);
  const rewardBlocks = useRewardBlocks(list);
  const rows = useMemo(() => directoryRows(validators, query, filter, sort, descending), [validators, query, filter, sort, descending]);
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.min(page, pages - 1);
  const visible = rows.slice(current * pageSize, (current + 1) * pageSize);
  const commissions = commissionStats(validators);
  const loading = !list && (d.state === "loading" || d.state === "normal" || d.state === "backfill");
  const failed = !list && d.state === "dberror";
  const unavailable = !list || validators.length === 0;

  // Deep links: the hash is the source of truth for the selected validator.
  useEffect(() => {
    const sync = () => {
      const id = idFromHash();
      if (id === undefined) return;
      onSelect(id);
    };
    const initial = idFromHash();
    if (typeof initial === "number") onSelect(initial);
    else if (initial === null && selected !== null) window.location.hash = `/validators/${selected}`;
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSelect]);

  // A selection made elsewhere (e.g. header search) is mirrored into the hash.
  useEffect(() => {
    if (selected !== null && idFromHash() !== undefined && idFromHash() !== selected) window.location.hash = `/validators/${selected}`;
  }, [selected]);

  const select = useCallback((id: number) => {
    onSelect(id);
    window.location.hash = `/validators/${id}`;
  }, [onSelect]);
  const close = useCallback(() => {
    onSelect(null);
    window.location.hash = "/validators";
  }, [onSelect]);

  useEffect(() => { setPage(0); }, [query, filter, sort, descending, pageSize]);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(null), 1800); return () => clearTimeout(timer); }, [copied]);
  const onCopy = (value: string) => { void copyText(value); setCopied(value); };

  const exportCsv = () => downloadCsv("monad-validators.csv", toCsv([
    ["rank", "id", "name", "auth_address", "beneficiary", "registered", "vdp", "in_consensus_set", "in_execution_set", "live_stake_mon", "epoch_stake_mon", "next_epoch_stake_mon", "stake_share", "epoch_commission", "next_epoch_commission", "unclaimed_rewards_mon", "proposed_1000", "proposed_sample", "expected_sample", "proposal_ratio", "rewards_24h_mon", "reward_apr", "delegator_apr", "abandoned_24h", "last_proposed_block", "last_proposed_time", "flags"],
    ...rows.map((v) => [v.rank, v.id, v.name, v.auth_address, v.beneficiary, v.registered ? "yes" : "no", v.vdp == null ? null : v.vdp ? "yes" : "no", v.in_consensus_set ? "yes" : "no", v.in_execution_set ? "yes" : "no",
      units(v.stake), units(v.active_stake), units(v.next_stake), v.stake_share, v.active_commission, v.next_commission, units(v.unclaimed_rewards),
      v.proposed_1000, v.proposed_sample, v.expected_sample, v.proposal_ratio, units(v.rewards_24h), v.reward_apr, v.delegator_apr, v.abandoned_24h, v.last_proposed_block, v.last_proposed_time, v.flags]),
  ]));

  const ratios = validators.map((v) => v.proposal_ratio).filter((r): r is number => r !== null);
  const medianRate = median(ratios);
  const nakamoto = nakamotoCoefficient(validators, list?.total_consensus_stake);
  const topShare = validators.reduce((m, v) => Math.max(m, v.stake_share), 0);
  const registered = validators.filter((v) => v.registered).length;
  const epoch = list?.epoch ?? d.net?.epoch ?? null;
  const delay = list?.epoch_delay_period ?? d.net?.epoch_delay_period ?? null;
  const stats = [
    { label: "Active validators", value: `${fmt(list?.active)} / ${fmt(list?.count)}`, note: "In the consensus set", tone: "ok" },
    { label: "Total stake", value: monCompact(list?.total_consensus_stake).replace(/ MON$/, ""), note: "MON · consensus, this epoch", tone: "brand" },
    { label: "Epoch", value: fmt(epoch), note: delay ? "In epoch delay period" : delay === false ? "Validator set fixed for this epoch" : "—", tone: delay ? "warn" : "blue" },
    { label: "Median proposal rate", value: rateText(medianRate), note: `Estimate · ${ratios.length} validators with enough sample`, tone: medianRate !== null && medianRate < LOW_RATE ? "warn" : "ok", title: RATE_NOTE },
    { label: "Avg. commission", value: commissionText(commissions.mean), note: `${commissions.values.length} validators`, tone: "blue" },
    { label: "Nakamoto coefficient", value: fmt(nakamoto), note: "Validators holding > ⅓ of stake", tone: "warn" },
    { label: "Top validator share", value: validators.length ? pct(topShare * 100, 1) : "—", note: "Of consensus stake", tone: "brand" },
    { label: "Registered", value: `${fmt(registered)} / ${fmt(validators.length)}`, note: "In validator-info registry", tone: "ok" },
    { label: "Network reward APR", value: aprText(list?.network_apr), note: list?.reward_coverage != null && list.reward_coverage < 0.95 ? `Measured 24h · rewards known for ${pct(list.reward_coverage * 100, 0)} of blocks` : "Measured over 24h, before commission", tone: "ok", title: APR_NOTE },
  ];

  const row = selected === null ? undefined : validators.find((v) => v.id === selected);
  const sample = list?.ratio_sample.blocks ?? null;

  return <div className="vpage">
    <div className="vstats">{stats.map((s, i) => <section className="vstat" key={s.label} title={s.title}>
      <span className={`vstat-icon ${s.tone}`} aria-hidden="true"><StatGlyph index={i} /></span><div><span className="v-eyebrow">{s.label}</span>{loading ? <Skeleton h={22} w="70%" /> : <strong className={s.tone}>{unavailable ? "—" : s.value}</strong>}<small>{s.note}</small></div>
    </section>)}</div>
    <div className="vtoolbar">
      <label className="vsearch"><span aria-hidden="true">⌕</span><input aria-label="Filter validators" placeholder="Filter validators by name, auth address or id…" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
      <div className="vfilters" aria-label="Validator filters">{FILTERS.map((f) => <button type="button" key={f.id} title={f.title} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label} <small>({validators.filter((v) => matchesValidatorFilter(v, f.id)).length})</small></button>)}</div>
      <div className="vsort"><label>Sort by <select aria-label="Sort validators" value={sort} onChange={(e) => setSort(e.target.value as ValidatorSort)}><option value="stake">Stake</option><option value="commission">Commission</option><option value="proposed">Proposed (1k)</option><option value="rate">Proposal rate</option><option value="apr">Delegator APR</option><option value="last">Last proposed</option><option value="name">Name</option><option value="id">Validator id</option></select></label><button type="button" onClick={() => setDescending((v) => !v)} aria-label="Reverse sort direction">{descending ? "↓ Desc" : "↑ Asc"}</button>
        <details className="vcolumns"><summary>Columns <span>⌄</span></summary><div>{COLUMNS.map(([id, name]) => <label key={id}><input type="checkbox" checked={columns.includes(id)} onChange={(e) => setColumns((old) => e.target.checked ? [...old, id] : old.filter((c) => c !== id))} />{name}</label>)}</div></details>
        <button type="button" onClick={exportCsv} disabled={unavailable}>↓ Export CSV</button>
      </div>
    </div>
    <div className={selected === null ? "vworkspace vworkspace-solo" : "vworkspace"}>
      <div className="vdirectory">
      <section className="vtable-panel">
        <div className="vtable-scroll"><table className="vtable"><thead><tr><th>#</th><th>Validator</th>{COLUMNS.filter(([id]) => columns.includes(id)).map(([id, name]) => <th key={id} title={id === "rate" ? RATE_NOTE : id === "apr" ? APR_NOTE : undefined}>{name}{(id === "rate" || id === "apr") && <span className="vhint" aria-hidden="true"> ⓘ</span>}</th>)}<th aria-label="Actions" /></tr></thead><tbody>
          {unavailable ? <tr><td colSpan={columns.length + 3} className="vempty">{loading ? "Loading validators…" : failed ? "Validator data is temporarily unavailable." : "No validators synced yet."}</td></tr> : visible.length === 0 ? <tr><td colSpan={columns.length + 3} className="vempty">No validators match this filter. <button onClick={() => { setQuery(""); setFilter("all"); }}>Clear filters</button></td></tr> : visible.map((v) => <tr key={v.id} className={`${selected === v.id ? "selected" : ""} ${isLowRate(v) ? "at-risk" : ""}`} onClick={() => select(v.id)}>
            <td className="vmuted">{v.rank}</td><td><button className="videntity" onClick={(e) => { e.stopPropagation(); select(v.id); }} aria-pressed={selected === v.id}><ValidatorAvatar id={v.id} seed={v.auth_address} hasLogo={!!v.logo} size={26} /><span><strong title={validatorName(v)}>{validatorName(v)}</strong><small>#{v.id} · {short(v.auth_address)}</small></span></button></td>
            {COLUMNS.filter(([id]) => columns.includes(id)).map(([id]) => <td key={id}>{cell(id, v, rewardBlocks.get(v.id))}</td>)}
            <td><button className="vinspect" aria-label={`Inspect ${validatorName(v)}`} onClick={(e) => { e.stopPropagation(); select(v.id); requestAnimationFrame(() => document.querySelector(".vinspector")?.scrollIntoView({ behavior: preferredScrollBehavior(), block: "nearest" })); }}>···</button></td>
          </tr>)}
        </tbody></table></div>
        <footer className="vtable-footer"><span>{rows.length ? `Showing ${current * pageSize + 1}–${Math.min((current + 1) * pageSize, rows.length)} of ${rows.length} validators` : "0 validators"}</span><nav aria-label="Validator pages"><button aria-label="Previous page" disabled={current === 0} onClick={() => setPage(current - 1)}>‹</button>{Array.from({ length: pages }, (_, i) => <button key={i} aria-label={`Page ${i + 1}`} aria-current={i === current ? "page" : undefined} onClick={() => setPage(i)}>{i + 1}</button>)}<button aria-label="Next page" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>›</button></nav><label>Rows per page <select aria-label="Rows per page" value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>{[25, 50, 100, 200].map((n) => <option key={n}>{n}</option>)}</select></label></footer>
      </section>
      {!unavailable && <Analytics validators={validators} commissions={commissions} onSelect={select} onViewProposers={() => { setFilter("all"); setQuery(""); setSort("proposed"); setDescending(true); document.querySelector(".vtable-panel")?.scrollIntoView({ behavior: preferredScrollBehavior(), block: "start" }); }} />}
      </div>
      {selected !== null && <ValidatorDrop key={selected} id={selected} row={row} list={list} rewardBlocks={row ? rewardBlocks.get(row.id) : undefined} refreshKey={list} earliestIndexed={d.net?.earliest_indexed_time ?? null} copied={copied} onCopy={onCopy} onClose={close} />}
    </div>
    <div className="vfootnote"><span>Proposal rate = proposed ÷ stake-expected over the last {sample ? fmt(sample) : "—"} fully attributed blocks · estimate</span><span>MONAD EXPLORER · VALIDATORS · CHAIN {d.net?.chain_id ?? 143}</span><span>Identity from the monad-developers/validator-info registry.</span></div>
  </div>;
}

const units = (wei: string) => formatUnits(wei, 18, 18).replace(/,/g, "");

/**
 * Rewarded-block counts per validator over 24h: the sample size behind each
 * measured APR, used to mute noisy rates. Refetched at most once a minute.
 */
function useRewardBlocks(refreshKey: unknown): Map<number, number> {
  const [blocks, setBlocks] = useState<Map<number, number>>(() => new Map());
  const last = useRef(0);
  useEffect(() => {
    if (Date.now() - last.current < 60_000) return;
    last.current = Date.now();
    let cancelled = false;
    getRewardRates(24)
      .then((r) => { if (!cancelled) setBlocks(new Map(r.validators.map((v) => [v.id, v.blocks]))); })
      .catch(() => { last.current = 0; });
    return () => { cancelled = true; };
  }, [refreshKey]);
  return blocks;
}

function DelegatorApr({ v, blocks }: { v: Validator; blocks: number | undefined }) {
  if (v.delegator_apr === null) return <span className="vunknown" title="No measured rate: no stake this epoch or no rewards in the last 24h">—</span>;
  const noisy = isNoisyApr(blocks);
  return <span className={`vmetric ${noisy ? "vnoisy" : ""}`} title={noisy ? NOISE_NOTE(blocks ?? 0) : `Reward APR ${aprText(v.reward_apr)} before ${commissionText(v.active_commission)} commission${blocks !== undefined ? ` · ${fmt(blocks)} rewarded blocks in 24h` : ""}. ${APR_NOTE}`}>
    <strong className={noisy ? undefined : "ok"}>{aprText(v.delegator_apr)}</strong><small>{noisy ? `${fmt(blocks)} blocks · noisy` : `${aprText(v.reward_apr)} gross`}</small>
  </span>;
}

function StatGlyph({ index }: { index: number }) {
  const paths = [
    "M8 11h8l3 8H5l3-8Zm1-5a3 3 0 1 0 6 0 3 3 0 0 0-6 0ZM9 15h6",
    "m12 3 9 9-9 9-9-9 9-9Zm0 5 4 4-4 4-4-4 4-4Z",
    "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4v5l3 2",
    "m12 3 9 9-9 9-9-9 9-9Zm-4 9 3 3 5-6",
    "m6 19 12-14M5 6a2 2 0 1 0 4 0 2 2 0 0 0-4 0Zm10 12a2 2 0 1 0 4 0 2 2 0 0 0-4 0Z",
    "M10 5a2 2 0 1 0 4 0 2 2 0 0 0-4 0ZM3 18a2 2 0 1 0 4 0 2 2 0 0 0-4 0Zm14 0a2 2 0 1 0 4 0 2 2 0 0 0-4 0ZM12 7v5m0 0-6 4m6-4 6 4",
    "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z",
    "M4 4h16v16H4V4Zm5 0v16m6-16v16",
    "M4 18 9 12l4 3 7-9m0 0h-5m5 0v5",
  ];
  return <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d={paths[index]} /></svg>;
}

function ProposalRate({ value }: { value: number | null }) {
  const tone = value === null ? "" : value < LOW_RATE ? "bad" : "ok";
  return <span title={value === null ? "Fewer than 5 proposals expected in the sample — too few to estimate" : RATE_NOTE} className={`vuptime ${tone}`}><strong>{rateText(value)}</strong><i><b style={{ width: `${value === null ? 0 : Math.min(100, value * 100)}%` }} /></i></span>;
}

function cell(id: Column, v: Validator, rewardBlocks: number | undefined): ReactNode {
  switch (id) {
    case "stake": return <span className="vmetric" title={`Stake in force this epoch: ${formatUnits(v.active_stake, 18, 2)} MON`}><strong>{monCompact(v.active_stake)}</strong><small>{pct(v.stake_share * 100, 2)}</small></span>;
    case "commission": return <span title={v.next_commission !== v.active_commission ? `${commissionText(v.next_commission)} from next epoch` : undefined}>{commissionText(v.active_commission)}{v.next_commission !== v.active_commission && <sup className="vpartial">*</sup>}</span>;
    case "proposed": return fmt(v.proposed_1000);
    case "rate": return <ProposalRate value={v.proposal_ratio} />;
    case "apr": return <DelegatorApr v={v} blocks={rewardBlocks} />;
    case "last": return v.last_proposed_time ? <span className="vmetric"><strong><Timestamp value={v.last_proposed_time} /></strong><small>#{fmt(v.last_proposed_block)}</small></span> : <span className="vunknown">—</span>;
    case "status": return <span className="vstatus-cell"><ValidatorStatus v={v} /><AbandonedChip n={v.abandoned_24h} />{v.vdp && <Chip tone="brand" title="Validator Delegation Program">VDP</Chip>}{v.flags !== 0 && <Chip tone="muted" title="Raw, undocumented on-chain flags">flags 0x{v.flags.toString(16)}</Chip>}</span>;
  }
}

function Analytics({ validators, commissions, onSelect, onViewProposers }: { validators: Validator[]; commissions: ReturnType<typeof commissionStats>; onSelect: (id: number) => void; onViewProposers: () => void }) {
  const { total, proposers } = validatorSummary(validators);
  const counts = setMembership(validators);
  const distribution = commissionHistogram(commissions.values);
  const tallest = Math.max(1, ...distribution.buckets.map((b) => b.count));
  const statuses = [
    { key: "consensus", label: "Consensus set", color: "var(--ok)" },
    { key: "execution", label: "Execution set only", color: "var(--warn)" },
    { key: "none", label: "Neither set", color: "var(--tx3)" },
  ] as const;
  let offset = 0;
  const segments = statuses.map((status) => {
    const start = offset;
    offset += total ? counts[status.key] / total * 100 : 0;
    return `${status.color} ${start}% ${offset}%`;
  });
  const movers = stakeMovers(validators);
  const topN = proposers[0]?.proposed_1000 ?? 1;
  return <div className="vanalytics">
    <section className="vanalytic"><h3>Top proposers <small>(last 1,000 blocks)</small><button onClick={onViewProposers}>View all →</button></h3><div className="vtop-head"><span>#　 Validator</span><span>Blocks</span></div>{proposers.map((v, i) => <button className="vtop-row" key={v.id} onClick={() => onSelect(v.id)}><span>{i + 1}</span><ValidatorAvatar id={v.id} seed={v.auth_address} hasLogo={!!v.logo} size={18} /><strong>{validatorName(v)}</strong><i><b style={{ width: `${Math.max(0, Math.min(100, v.proposed_1000 / Math.max(1, topN) * 100))}%` }} /></i><small>{fmt(v.proposed_1000)}</small></button>)}{proposers.length === 0 && <p className="vmuted">No proposer history yet.</p>}</section>
    <section className="vanalytic"><h3>Commission distribution <small>{commissions.values.length} validators</small></h3><div className="vcommission-plot"><div className="vcommission-axis"><span>{tallest}</span><span>{Math.round(tallest / 2)}</span><span>0</span></div><div className="vcommission-chart" role="img" aria-label={`Commission distribution for ${commissions.values.length} validators; median ${commissionText(commissions.median)}`}>{distribution.buckets.map((b) => <div key={b.min} title={`${commissionText(b.min)}–${commissionText(b.max)}: ${b.count} validators`}><i style={{ height: `${b.count / tallest * 100}%` }} /></div>)}{commissions.median !== null && <div className="vcommission-median" style={{ left: `${commissions.median / distribution.max * 100}%` }}><span>Median<br /><b>{commissionText(commissions.median)}</b></span></div>}</div></div><div className="vchart-axis"><span>0%</span><span>{commissionText(distribution.max / 4)}</span><span>{commissionText(distribution.max / 2)}</span><span>{commissionText(distribution.max * .75)}</span><span>{commissionText(distribution.max)}</span></div><div className="vcommission-stats">{([["Min", commissions.min], ["Median", commissions.median], ["Mean", commissions.mean], ["Max", commissions.max]] as const).map(([label, value]) => <Fact key={label} label={label} value={commissionText(value)} />)}</div></section>
    <section className="vanalytic"><h3>Set membership <small>This epoch</small></h3><div className="vstatus-chart"><div className="vstatus-donut" style={{ background: total ? `conic-gradient(${segments.join(",")})` : "var(--line)" }} role="img" aria-label={statuses.map((s) => `${counts[s.key]} ${s.label}`).join(", ")}><div><strong>{total}</strong><small>Total</small></div></div><ul>{statuses.map((s) => <li key={s.key}><i style={{ background: s.color }} /><span>{s.label}</span><strong>{counts[s.key]} <small>({pct(total ? counts[s.key] / total * 100 : null)})</small></strong></li>)}</ul></div><p className="vevents-note">Active set: top 200 by stake with ≥10,000,000 MON delegated and ≥100,000 MON self-delegated.</p></section>
    <section className="vanalytic"><h3>Next-epoch stake changes <small>Next vs. this epoch</small></h3><div className="vevents">{movers.map(({ v, delta }) => {
      const up = delta > 0n;
      return <button className="vevent" key={v.id} onClick={() => onSelect(v.id)}><span className={`vevent-icon ${up ? "ok" : "bad"}`} aria-hidden="true">{up ? "+" : "−"}</span><div><strong className={up ? "ok" : "bad"}>{up ? "+" : "−"}{monCompact((up ? delta : -delta).toString())}</strong><small title={validatorName(v)}>{validatorName(v)}</small></div><time>{monCompact(v.snapshot_stake)}<small>next epoch</small></time></button>;
    })}{movers.length === 0 && <p className="vmuted">No stake changes pending for the next epoch.</p>}</div></section>
  </div>;
}
