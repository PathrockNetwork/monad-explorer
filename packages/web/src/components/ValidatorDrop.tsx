/**
 * The validator inspector on the Validators page: registry identity, stake
 * across the execution / consensus / snapshot views, commission, and the
 * block-proposal record (rate estimate, hourly proposals, recent blocks).
 */
import { useEffect, useState, type ReactNode } from "react";
import { getStakingEvents, getValidatorDetail, ApiError, type StakingEvent, type Validator, type ValidatorDetail, type ValidatorList } from "../api";
import { Chip, CopyButton, Skeleton, ValidatorAvatar } from "./ui";
import { Timestamp } from "./Timestamp";
import { fmt, mon, monCompact, pct, short } from "../lib";
import { LOW_RATE, isNoisyApr, validatorName } from "../validatorDirectory";
import { APR_NOTE, NOISE_NOTE, StakingEventList, aprText, monExact, monShort } from "./StakingShared";

type Tab = "Overview" | "Proposals" | "Stake" | "Identity";
const TABS: Tab[] = ["Overview", "Proposals", "Stake", "Identity"];

export function commissionText(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const p = Math.round(n * 10_000) / 100;
  return pct(p, Number.isInteger(p) ? 0 : 2);
}
export const rateText = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "—" : pct(n * 100, 0));
export const RATE_NOTE =
  "Estimate: blocks this validator proposed ÷ blocks expected from its share of consensus stake, over a recent fully-attributed sample. Monad's leader schedule is stake-weighted; stake shifts between epochs and small samples are noisy. Shown only when at least 5 proposals were expected.";

export function safeUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

export const abandonedNote = (n: number) =>
  `${fmt(n)} proposal${n === 1 ? "" : "s"} in the last 24h never finalized while a competing proposal at the same height did`;

/** Small warning chip for proposals abandoned in favour of a competing block; nothing when zero. */
export function AbandonedChip({ n }: { n: number | null | undefined }) {
  if (!n || n <= 0) return null;
  return <Chip tone="warn" title={abandonedNote(n)}>⚠ {fmt(n)} abandoned</Chip>;
}

export function ValidatorStatus({ v }: { v: Validator }) {
  return v.in_consensus_set
    ? <Chip tone="ok" title="In the current epoch's consensus set">▪ Active</Chip>
    : <Chip tone="muted" title={v.in_execution_set ? "In the execution set but not in this epoch's consensus set" : "Not in the active set"}>Inactive</Chip>;
}

export function ValidatorDrop({
  id,
  row,
  list,
  refreshKey,
  earliestIndexed,
  copied,
  onCopy,
  onClose,
  rewardBlocks,
}: {
  id: number;
  /** The list row for this id, if the list has loaded; used until the detail arrives. */
  row: Validator | undefined;
  list: ValidatorList | null;
  /** Changes whenever the dashboard re-polls validators; triggers a detail refetch. */
  refreshKey: unknown;
  /** Start of the indexed window; earlier hours are "no data", not zero. */
  earliestIndexed: string | null;
  copied: string | null;
  onCopy: (value: string) => void;
  onClose: () => void;
  /** Rewarded blocks over 24h behind the measured APR, when known. */
  rewardBlocks?: number;
}) {
  const [tab, setTab] = useState<Tab>("Overview");
  const [events, setEvents] = useState<{ id: number; rows: StakingEvent[] } | null>(null);
  const [eventsFailed, setEventsFailed] = useState(false);
  const [detail, setDetail] = useState<ValidatorDetail | null>(null);
  const [error, setError] = useState<{ id: number; notFound: boolean } | null>(null);

  useEffect(() => {
    setDetail(null);
    setError(null);
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    getValidatorDetail(id)
      .then((r) => {
        if (cancelled) return;
        setDetail(r);
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError({ id, notFound: e instanceof ApiError && e.status === 404 });
      });
    return () => {
      cancelled = true;
    };
  }, [id, refreshKey]);

  useEffect(() => {
    let cancelled = false;
    getStakingEvents({ validator: id, limit: 10 })
      .then((r) => { if (!cancelled) { setEvents({ id, rows: r.events }); setEventsFailed(false); } })
      .catch(() => { if (!cancelled) setEventsFailed(true); });
    return () => { cancelled = true; };
  }, [id, refreshKey]);
  const activity = <StakingActivity id={id} events={events?.id === id ? events.rows : null} failed={eventsFailed} />;

  const fresh = detail?.validator.id === id ? detail : null;
  const v = fresh?.validator ?? row;

  if (!v) {
    return <aside className="vinspector" aria-label="Selected validator details">
      <header className="vinspector-head"><div><h2>Validator #{id}</h2></div><CloseButton onClose={onClose} /></header>
      <div className="vempty">{error?.id === id ? (error.notFound ? `No validator with id ${id} exists.` : "Validator details are temporarily unavailable.") : "Loading validator details…"}</div>
    </aside>;
  }

  const name = validatorName(v);
  const website = safeUrl(v.website);
  const x = safeUrl(v.x);
  const total = list?.validators.length ?? null;
  const sample = list?.ratio_sample.blocks ?? null;

  return <aside className="vinspector" aria-label="Selected validator details">
    <header className="vinspector-head">
      <ValidatorAvatar id={v.id} seed={v.auth_address} hasLogo={!!v.logo} size={36} title={name} />
      <div><h2 title={name}>{name}</h2><span>{short(v.auth_address)} <CopyButton value={v.auth_address} copied={copied === v.auth_address} onCopy={onCopy} /></span></div>
      <ValidatorStatus v={v} />
      <CloseButton onClose={onClose} />
    </header>
    <div className="vinspector-links">
      {v.vdp && <Chip tone="brand" title="Validator Delegation Program participant">VDP</Chip>}
      {v.decommissioned && <Chip tone="muted" title="Marked decommissioned in the validator-info registry">Decommissioned</Chip>}
      {website && <a href={website} target="_blank" rel="noopener noreferrer">Website ↗</a>}
      {x && <a href={x} target="_blank" rel="noopener noreferrer">X ↗</a>}
      <a href={`#/transactions/address/${v.auth_address}`}>Auth address →</a>
    </div>
    <nav className="vdetail-tabs" aria-label="Validator detail sections">{TABS.map((t) => <button key={t} type="button" aria-pressed={tab === t} onClick={() => setTab(t)}>{t}</button>)}</nav>
    <div className="vinspector-body">
      {tab === "Overview" && <>
        {v.description && <p className="vdescription">{v.description}</p>}
        <div className="vdetail-facts">
          <Fact label="Stake (this epoch)" value={monCompact(v.active_stake)} note={`${pct(v.stake_share * 100, 2)} of total`} />
          <Fact label="Commission" value={commissionText(v.active_commission)} note={v.next_commission !== v.active_commission ? `${commissionText(v.next_commission)} from next epoch` : "This & next epoch"} />
          <Fact label="Proposal rate" value={<span title={RATE_NOTE} className={rateTone(v.proposal_ratio)}>{rateText(v.proposal_ratio)}</span>} note="Estimate" />
          <Fact label="Rank" value={`#${v.rank}${total ? ` of ${total}` : ""}`} note="By stake" />
          <Fact label="Proposed" value={fmt(v.proposed_1000)} note="Last 1,000 blocks" />
          <Fact label="Last proposed" value={v.last_proposed_block === null ? "—" : <a href={`#/blocks/${v.last_proposed_block}`}>#{fmt(v.last_proposed_block)}</a>} note={v.last_proposed_time ? undefined : "None indexed"} />
        </div>
        <Rewards v={v} blocks={rewardBlocks} />
        <ProposalRate v={v} sample={sample} />
        <Hourly detail={fresh} earliestIndexed={earliestIndexed} />
        {activity}
      </>}
      {tab === "Proposals" && <>
        <ProposalRate v={v} sample={sample} />
        <Hourly detail={fresh} earliestIndexed={earliestIndexed} />
        <RecentBlocks detail={fresh} failed={error?.id === id} />
      </>}
      {tab === "Stake" && <>
        <section className="vdetail-section">
          <div className="vsection-title"><h3>Stake</h3><span>Epoch {fmt(fresh?.epoch ?? list?.epoch)}</span></div>
          <div className="vstake-views">
            <StakeRow label="Live" note="Including delegations made this epoch" value={v.stake} />
            <StakeRow label="This epoch" note="In force for consensus and rewards now" value={v.active_stake} />
            <StakeRow label="Next epoch" note="Takes effect at the next epoch" value={v.next_stake} delta={delta(v.next_stake, v.active_stake)} />
          </div>
        </section>
        <div className="vdetail-facts">
          <Fact label="Commission" value={commissionText(v.active_commission)} note="This epoch" />
          <Fact label="Next epoch" value={commissionText(v.next_commission)} note="Takes effect next epoch" />
          <Fact label="Stake share" value={pct(v.stake_share * 100, 2)} note="Of this epoch's active stake" />
        </div>
        <div className="videntity-details">
          <Fact label="Unclaimed rewards" value={mon(v.unclaimed_rewards, 2)} />
          <Fact label="Set membership" value={[v.in_consensus_set && "Consensus set", v.in_execution_set && "Execution set"].filter(Boolean).join(" · ") || "Neither set"} />
        </div>
        {activity}
        <p className="vmuted">Monad's active set is the top 200 validators by stake that hold at least 10,000,000 MON total delegation and 100,000 MON self-delegated by the auth address. Look up any delegator's positions on the <a href="#/staking">Staking</a> page.</p>
      </>}
      {tab === "Identity" && <div className="videntity-details">
        <Fact label="Name" value={v.name ?? "—"} note={v.registered ? "From the validator-info registry" : "Not in the validator-info registry"} />
        <Fact label="Validator id" value={String(v.id)} />
        <Fact label="Auth address" value={<span className="vcopy-row"><a href={`#/transactions/address/${v.auth_address}`}>{v.auth_address}</a><CopyButton value={v.auth_address} copied={copied === v.auth_address} onCopy={onCopy} /></span>} />
        <Fact label="Beneficiary" value={v.beneficiary ? <span className="vcopy-row"><a href={`#/transactions/address/${v.beneficiary}`}>{v.beneficiary}</a><CopyButton value={v.beneficiary} copied={copied === v.beneficiary} onCopy={onCopy} /></span> : "—"} note={v.beneficiary ? "Block miner address, learned from indexed blocks" : "Learned once the validator proposes an indexed block"} />
        <Fact label="SECP public key" value={<span className="vcopy-row"><span>{v.secp}</span><CopyButton value={v.secp} copied={copied === v.secp} onCopy={onCopy} /></span>} />
        <Fact label="Description" value={v.description ?? "No description published."} />
        <Fact label="Validator Delegation Program" value={v.vdp == null ? "—" : v.vdp ? "Yes" : "No"} />
        {v.decommissioned && <Fact label="Registry status" value="Decommissioned" />}
        {v.flags !== 0 && <Fact label="Raw flags" value={`0x${v.flags.toString(16)}`} note="Undocumented on-chain status flags, shown raw" />}
        <Fact label="Synced" value={<Timestamp value={v.synced_at} />} />
      </div>}
    </div>
  </aside>;
}

/** Measured block rewards over 24h, the APR they imply, and abandoned proposals. */
function Rewards({ v, blocks }: { v: Validator; blocks: number | undefined }) {
  const noisy = isNoisyApr(blocks);
  return <section className="vdetail-section">
    <div className="vsection-title"><h3 title={APR_NOTE}>Rewards <span className="vhint" aria-hidden="true">ⓘ</span></h3><span>Measured · last 24 h</span></div>
    <div className="vdetail-facts vdetail-facts-2">
      <Fact label="Delegator APR" value={<span className={noisy || v.delegator_apr === null ? "vmuted-inline" : "ok"} title={noisy ? NOISE_NOTE(blocks ?? 0) : APR_NOTE}>{aprText(v.delegator_apr)}</span>} note={`Net of ${commissionText(v.active_commission)} commission`} />
      <Fact label="Reward APR" value={<span className={noisy ? "vmuted-inline" : undefined} title={noisy ? NOISE_NOTE(blocks ?? 0) : APR_NOTE}>{aprText(v.reward_apr)}</span>} note="Before commission" />
      <Fact label="Rewards (24h)" value={<span title={monExact(v.rewards_24h)}>{monShort(v.rewards_24h)}</span>} note={blocks !== undefined ? `${fmt(blocks)} rewarded blocks` : "Block rewards to the pool"} />
      <Fact label="Abandoned (24h)" value={<span className={v.abandoned_24h > 0 ? "warn" : undefined} title={v.abandoned_24h > 0 ? abandonedNote(v.abandoned_24h) : undefined}>{fmt(v.abandoned_24h ?? 0)}</span>} note={v.abandoned_24h > 0 ? "Lost to a competing proposal" : "No abandoned proposals"} />
    </div>
    <p className="vmuted vnote">{noisy ? `${NOISE_NOTE(blocks ?? 0)} ` : ""}Measured, backward-looking rates from block rewards actually paid, annualised against this epoch's stake; not a promise.</p>
    <a className="vcalc-link" href={`#/staking/${v.id}`}>Calculate delegation returns →</a>
  </section>;
}

function StakingActivity({ id, events, failed }: { id: number; events: StakingEvent[] | null; failed: boolean }) {
  return <section className="vdetail-section">
    <div className="vsection-title"><h3>Recent staking activity</h3><a href={`#/staking/${id}`}>Staking →</a></div>
    {events === null ? (failed ? <p className="vmuted">Staking activity is temporarily unavailable.</p> : <Skeleton h={90} w="100%" />)
      : events.length === 0 ? <p className="vmuted">No delegations, undelegations or claims collected for this validator yet. Staking history is still being backfilled.</p>
      : <div className="vstaking-events"><StakingEventList events={events} show="address" /></div>}
  </section>;
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return <button type="button" className="vclose" aria-label="Close validator inspector" title="Close" onClick={onClose}>×</button>;
}

function rateTone(r: number | null) {
  if (r === null) return "vmuted-inline";
  return r < LOW_RATE ? "warn" : "ok";
}

function delta(next: string, current: string): string | null {
  if (!/^\d+$/.test(next) || !/^\d+$/.test(current)) return null;
  const d = BigInt(next) - BigInt(current);
  if (d === 0n) return null;
  return `${d > 0n ? "+" : "−"}${monCompact((d > 0n ? d : -d).toString())} vs. this epoch`;
}

function StakeRow({ label, note, value, delta: change }: { label: string; note: string; value: string; delta?: string | null }) {
  return <div className="vstake-row"><div><strong>{label}</strong><small>{note}</small></div><div><strong title={mon(value, 4)}>{mon(value, 0)}</strong>{change && <small className={change.startsWith("+") ? "ok" : "warn"}>{change}</small>}</div></div>;
}

function ProposalRate({ v, sample }: { v: Validator; sample: number | null }) {
  const r = v.proposal_ratio;
  return <section className="vdetail-section">
    <div className="vsection-title"><h3 title={RATE_NOTE}>Proposal rate <span className="vhint" aria-hidden="true">ⓘ</span></h3><span>{sample ? `${fmt(sample)}-block sample` : "Recent sample"}</span></div>
    <div className="vsigning-summary"><span>{fmt(v.proposed_sample)} proposed / {v.expected_sample.toFixed(1)} expected</span><strong className={rateTone(r)}>{rateText(r)}</strong></div>
    <div className="vrate-bar" aria-hidden="true"><b className={rateTone(r)} style={{ width: `${r === null ? 0 : Math.min(100, r * 100 / 1.5)}%` }} /><i style={{ left: `${100 / 1.5}%` }} /></div>
    <p className="vmuted vnote">{r === null ? "Too few proposals expected in the sample (under 5) to estimate a rate. " : ""}{RATE_NOTE}</p>
  </section>;
}

/** 24 hourly slots ending at the current hour; hours before indexing began are "no data". */
function Hourly({ detail, earliestIndexed }: { detail: ValidatorDetail | null; earliestIndexed: string | null }) {
  const HOUR = 3_600_000;
  const end = Math.floor(Date.now() / HOUR) * HOUR;
  const start = earliestIndexed ? Date.parse(earliestIndexed) : NaN;
  const counts = new Map((detail?.hourly ?? []).map((h) => [Math.floor(Date.parse(h.t) / HOUR) * HOUR, h.n]));
  const slots = Array.from({ length: 24 }, (_, i) => {
    const t = end - (23 - i) * HOUR;
    const n = counts.get(t);
    const known = n !== undefined || !Number.isFinite(start) || t + HOUR > start;
    return { t, n: n ?? (known ? 0 : null) };
  });
  const max = Math.max(1, ...slots.map((s) => s.n ?? 0));
  const sum = slots.reduce((s, x) => s + (x.n ?? 0), 0);
  return <section className="vdetail-section">
    <div className="vsection-title"><h3>Hourly proposals</h3><span>{detail ? `${fmt(sum)} in the last 24 h` : "Last 24 h"}</span></div>
    {!detail ? <Skeleton h={72} w="100%" /> : <>
      <div className="vhourly" role="img" aria-label={`Blocks proposed per hour over the last 24 hours, ${fmt(sum)} total`}>
        {slots.map((s) => <div key={s.t} title={`${new Date(s.t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} · ${s.n === null ? "not indexed" : `${fmt(s.n)} blocks`}`}><i className={s.n === null ? "nodata" : undefined} style={{ height: s.n === null ? "100%" : `${(s.n / max) * 100}%` }} /></div>)}
      </div>
      <div className="vchart-axis"><span>−24h</span><span>−12h</span><span>now</span></div>
    </>}
  </section>;
}

function RecentBlocks({ detail, failed }: { detail: ValidatorDetail | null; failed: boolean }) {
  return <section className="vdetail-section">
    <div className="vsection-title"><h3>Recent proposed blocks</h3><span>{detail ? `${detail.recent_blocks.length} latest` : ""}</span></div>
    {!detail ? (failed ? <p className="vmuted">Block history is temporarily unavailable.</p> : <Skeleton h={120} w="100%" />)
      : detail.recent_blocks.length === 0 ? <p className="vmuted">No proposed blocks in the indexed window.</p>
      : <div className="vblocks">{detail.recent_blocks.map((b) => <a key={b.number} className="vblock" href={`#/blocks/${b.number}`}>
        <strong>#{fmt(b.number)}</strong>
        <span>{fmt(b.tx_count)} txs · {b.gas_limit ? pct((b.gas_used / b.gas_limit) * 100, 0) : "—"} gas</span>
        <time><Timestamp value={b.time} /></time>
      </a>)}</div>}
  </section>;
}

function Fact({ label, value, note }: { label: string; value: ReactNode; note?: string }) {
  return <div className="vfact"><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</div>;
}
export { Fact };
