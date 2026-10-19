/**
 * Shared pieces of the staking views (Staking page and the validator
 * inspector): measured-APR formatting, signed MON amounts, event chips and a
 * small sortable-table helper.
 */
import { useMemo, useState, type ReactNode } from "react";
import type { StakingEvent } from "../api";
import { Chip, ValidatorAvatar } from "./ui";
import { Timestamp } from "./Timestamp";
import { fmt, formatUnits, mon, pct, short } from "../lib";
import { MIN_REWARD_BLOCKS } from "../validatorDirectory";
import "../pages/staking.css";

/** Below this many rewarded blocks in the window, a measured rate is mostly lottery noise. */
export const MIN_BLOCKS = MIN_REWARD_BLOCKS;
/** Monad epochs last roughly 5.5 hours. */
export const EPOCH_HOURS = 5.5;
export const YEAR_HOURS = 365 * 24;

export const NOISE_NOTE = (blocks: number) =>
  `Based on only ${fmt(blocks)} rewarded block${blocks === 1 ? "" : "s"} in the window. Proposer selection is a stake-weighted lottery, so a small validator's measured rate swings widely from day to day; read it as noise, not a promise.`;
export const APR_NOTE =
  "Measured, backward-looking: the block rewards this validator's pool actually received over the window, annualised against its stake in force this epoch. Delegator APR is that net of commission. Not a promise of future returns.";

/** 0.1062 → "10.62%"; "—" for null / non-finite. */
export const aprText = (n: number | null | undefined, digits = 2) => (n == null || !Number.isFinite(n) ? "—" : pct(n * 100, digits));

export const big = (s: string | null | undefined): bigint => (s && /^-?\d+$/.test(s) ? BigInt(s) : 0n);
export const cmpBig = (a: bigint, b: bigint) => (a === b ? 0 : a > b ? 1 : -1);

/** Compact MON for wei strings that may be negative: "+1.2K MON" / "−17.66M MON". */
export function monSigned(wei: string | null | undefined, sign = true): string {
  if (!wei || !/^-?\d+$/.test(wei)) return "—";
  const v = BigInt(wei);
  const abs = v < 0n ? -v : v;
  const text = monShort(abs.toString());
  if (v === 0n) return text;
  return `${v < 0n ? "−" : sign ? "+" : ""}${text}`;
}

/** Compact MON that still shows small amounts ("0.09 MON", "<0.01 MON"). */
export function monShort(wei: string | null | undefined): string {
  if (!wei || !/^\d+$/.test(wei)) return "—";
  const v = BigInt(wei);
  if (v === 0n) return "0 MON";
  if (v < 10n ** 16n) return "<0.01 MON";
  const n = Number(v / 10n ** 12n) / 1e6;
  return `${n.toLocaleString("en-US", { notation: n >= 10_000 ? "compact" : "standard", maximumFractionDigits: n >= 10_000 ? 2 : n >= 100 ? 0 : 2 })} MON`;
}

/** Wei → a float MON value; precise enough for estimates. */
export const monFloat = (wei: string | null | undefined) => Number(big(wei) / 10n ** 12n) / 1e6;

/** MON number → readable string with sensible precision. */
export function monNumber(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const digits = Math.abs(n) >= 1000 ? 0 : Math.abs(n) >= 1 ? 2 : 4;
  return `${n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 })} MON`;
}

export const KINDS: Record<StakingEvent["kind"], { label: string; tone: "ok" | "warn" | "bad" | "brand" | "muted"; note: string }> = {
  delegate: { label: "Delegate", tone: "ok", note: "Stake delegated; it activates at the listed epoch." },
  undelegate: { label: "Undelegate", tone: "bad", note: "Stake undelegated; it becomes withdrawable after the withdrawal delay." },
  withdraw: { label: "Withdraw", tone: "warn", note: "Undelegated stake withdrawn back to the delegator." },
  claim: { label: "Claim", tone: "brand", note: "Accumulated rewards claimed (ClaimRewards)." },
  commission: { label: "Commission", tone: "muted", note: "The validator changed its commission rate." },
  created: { label: "Created", tone: "ok", note: "A new validator was registered." },
  status: { label: "Status", tone: "muted", note: "The validator's on-chain status flags changed." },
};

export function KindChip({ kind }: { kind: StakingEvent["kind"] }) {
  const k = KINDS[kind] ?? { label: String(kind), tone: "muted" as const, note: "" };
  return <Chip tone={k.tone} title={k.note}>{k.label}</Chip>;
}

const commissionPct = (n: number | null | undefined) => {
  if (n == null || !Number.isFinite(n)) return "—";
  const p = Math.round(n * 10_000) / 100;
  return pct(p, Number.isInteger(p) ? 0 : 2);
};

/** What an event moved: MON for flows, old → new % for commission changes. */
export function eventAmount(e: StakingEvent): ReactNode {
  if (e.kind === "commission") return <span>{commissionPct(e.old_commission)} → {commissionPct(e.new_commission)}</span>;
  if (e.kind === "created") return e.new_commission == null ? "—" : <span>{commissionPct(e.new_commission)} commission</span>;
  if (e.kind === "status") return e.flags == null ? "—" : <span>flags 0x{e.flags.toString(16)}</span>;
  if (!e.amount) return "—";
  return <span title={mon(e.amount, 6)}>{monShort(e.amount)}</span>;
}

export const eventKey = (e: StakingEvent) => `${e.tx_hash}:${e.log_index}`;
export const eventCursor = (e: StakingEvent) => `${e.block_number}:${e.log_index}`;

/** Merges a fresh first page into what is already shown, newest first, without duplicates. */
export function mergeEvents(fresh: StakingEvent[], shown: StakingEvent[]): StakingEvent[] {
  const seen = new Set<string>();
  return [...fresh, ...shown].filter((e) => {
    const k = eventKey(e);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => b.block_number - a.block_number || b.log_index - a.log_index);
}

export const validatorLabel = (id: number | null, name: string | null | undefined) => name?.trim() || (id === null ? "—" : `Validator #${id}`);

export function ValidatorLink({ id, name, logo, seed, size = 20 }: { id: number | null; name: string | null | undefined; logo?: boolean; seed?: string; size?: number }) {
  if (id === null) return <span className="sk-muted">—</span>;
  const label = validatorLabel(id, name);
  return <a className="sk-validator" href={`#/validators/${id}`} title={`${label} · #${id}`}>
    <ValidatorAvatar id={id} seed={seed ?? String(id)} hasLogo={!!logo} size={size} />
    <span>{label}</span>
  </a>;
}

/** Compact list of staking events (validator inspector, delegator lookup). */
export function StakingEventList({ events, show }: { events: StakingEvent[]; show: "validator" | "address" }) {
  return <ul className="sk-event-list">{events.map((e) => <li key={eventKey(e)}>
    <KindChip kind={e.kind} />
    <div>
      <strong>{eventAmount(e)}</strong>
      <small>{show === "address"
        ? (e.address ? <a href={`#/transactions/address/${e.address}`} title={e.address}>{short(e.address)}</a> : "—")
        : (e.validator_id === null ? "—" : <a href={`#/validators/${e.validator_id}`}>{validatorLabel(e.validator_id, e.validator_name)}</a>)}
        {e.epoch != null && <> · epoch {fmt(e.epoch)}</>}</small>
    </div>
    <a className="sk-event-time" href={`#/transactions/${e.tx_hash}`} title={`Transaction ${e.tx_hash} · block ${fmt(e.block_number)}`}>{e.time ? <Timestamp value={e.time} /> : `#${fmt(e.block_number)}`} ↗</a>
  </li>)}</ul>;
}

export type SortState<K extends string> = { key: K; desc: boolean };

/** Sorts rows by a keyed comparator; clicking the active key flips direction. */
export function useSorted<T, K extends string>(rows: T[], compare: Record<K, (a: T, b: T) => number>, initial: SortState<K>) {
  const [sort, setSort] = useState<SortState<K>>(initial);
  const sorted = useMemo(() => {
    const cmp = compare[sort.key];
    return rows.slice().sort((a, b) => (sort.desc ? -cmp(a, b) : cmp(a, b)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sort]);
  const toggle = (key: K) => setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key !== "name" }));
  return { sorted, sort, toggle };
}

export function SortTh<K extends string>({ id, label, sort, onSort, title, align }: { id: K; label: string; sort: SortState<K>; onSort: (k: K) => void; title?: string; align?: "right" }) {
  const active = sort.key === id;
  return <th aria-sort={active ? (sort.desc ? "descending" : "ascending") : "none"} className={align === "right" ? "sk-num" : undefined} title={title}>
    <button type="button" className={active ? "sk-sort active" : "sk-sort"} onClick={() => onSort(id)}>{label}<span aria-hidden="true">{active ? (sort.desc ? " ↓" : " ↑") : " ↕"}</span></button>
  </th>;
}

/** wei string → plain decimal MON for tooltips. */
export const monExact = (wei: string | null | undefined) => (wei ? `${formatUnits(wei, 18, 6)} MON` : "—");
