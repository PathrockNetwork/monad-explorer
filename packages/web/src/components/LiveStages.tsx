/**
 * MonadBFT commit stages shared by the Finality page and the overview strip.
 *
 * Every proposal moves Proposed → Voted → Finalized → Verified. "Verified"
 * means the block's execution state root was confirmed; Monad executes
 * asynchronously, so it trails finality by a few blocks. Times are when this
 * explorer first observed each stage, so stage-to-stage gaps are reliable
 * while absolute values include network latency.
 */
import type { StageRow } from "../api";
import "./LiveStages.css";

export const STAGES = [
  { key: "proposed_at", label: "Proposed", short: "P" },
  { key: "voted_at", label: "Voted", short: "V" },
  { key: "finalized_at", label: "Finalized", short: "F" },
  { key: "verified_at", label: "Verified", short: "X" },
] as const;

export type StageKey = (typeof STAGES)[number]["key"];

/** Epoch ms for an ISO timestamp; null for missing or unparsable values. */
export function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** Gap between two stages in ms; null unless both were observed in order. */
export function gap(a: string | null | undefined, b: string | null | undefined): number | null {
  const x = ms(a), y = ms(b);
  return x === null || y === null || y < x ? null : y - x;
}

/** "286 ms", "1.24 s"; "—" for anything that is not a finite number. */
export function msLabel(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return v >= 10_000 ? `${(v / 1000).toFixed(1)} s` : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`;
}

/** How many stages, counted in order, a proposal has reached (0–4). */
export function reached(row: Pick<StageRow, StageKey> | null | undefined): number {
  if (!row) return 0;
  let n = 0;
  for (const s of STAGES) {
    if (!row[s.key]) break;
    n++;
  }
  return n;
}

/** Overview card indicator: four dots, lit in order, with a tooltip of the gaps. */
export function LiveStageDots({ row, abandoned = false }: { row: StageRow | null | undefined; abandoned?: boolean }) {
  const n = reached(row);
  const title = row
    ? STAGES.map((s, i) => {
        const t = row[s.key];
        const d = i > 0 ? gap(row[STAGES[i - 1].key], t) : null;
        return `${s.label}: ${t ? (i === 0 ? "observed" : `+${msLabel(d)}`) : "pending"}`;
      }).join("\n")
    : "Commit stages not observed for this block";
  return (
    <span className={`lv-mini${abandoned ? " lv-mini-abandoned" : ""}${row ? "" : " lv-mini-none"}`} title={title} aria-label={row ? `${n} of 4 commit stages: ${STAGES[Math.max(0, n - 1)].label}` : "Commit stages not observed"} role="img">
      {STAGES.map((s, i) => (
        <i key={s.key} className={i < n ? `on s${i}` : i === n && !abandoned && row ? "next" : undefined} />
      ))}
    </span>
  );
}
