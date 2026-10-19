/**
 * Delegation calculator: an amount in MON and a validator, projected over an
 * epoch, a month and a year from that validator's measured delegator APR.
 */
import { useId, useMemo, useRef, useState } from "react";
import { ValidatorAvatar } from "./ui";
import { fmt, pct } from "../lib";
import { EPOCH_HOURS, MIN_BLOCKS, NOISE_NOTE, YEAR_HOURS, aprText, monNumber, validatorLabel } from "./StakingShared";

export type CalcOption = {
  id: number;
  name: string | null;
  logo: boolean;
  seed: string;
  blocks: number;
  commission: number;
  apr: number | null;
  delegator_apr: number | null;
  active: boolean;
};

const commissionPct = (n: number) => (Number.isFinite(n) ? pct(Math.round(n * 10_000) / 100, Number.isInteger(Math.round(n * 10_000) / 100) ? 0 : 2) : "—");

export function StakingCalculator({ options, selected, onSelect, loading, failed, hours }: {
  options: CalcOption[];
  selected: number | null;
  onSelect: (id: number) => void;
  loading: boolean;
  failed: boolean;
  hours: number;
}) {
  const [amount, setAmount] = useState("10000");
  const value = Number(amount.replace(/[,_\s]/g, ""));
  const valid = amount.trim() !== "" && Number.isFinite(value) && value >= 0;
  const v = options.find((o) => o.id === selected) ?? null;
  const apr = v?.delegator_apr ?? null;
  const noisy = v !== null && v.blocks < MIN_BLOCKS;
  const earn = (h: number) => (valid && apr !== null ? (value * apr * h) / YEAR_HOURS : null);
  const rows = [
    { label: "Per epoch", note: `~${EPOCH_HOURS} hours`, value: earn(EPOCH_HOURS) },
    { label: "Per month", note: "1/12 of a year", value: earn(YEAR_HOURS / 12) },
    { label: "Per year", note: "Simple, not compounded", value: earn(YEAR_HOURS) },
  ];

  return <section className="sk-panel sk-calc" id="sk-calculator" aria-labelledby="sk-calc-title">
    <header className="sk-heading"><div><h2 id="sk-calc-title">Delegation calculator</h2><p>Estimated earnings from the measured delegator APR ({hours}h window).</p></div></header>
    <div className="sk-calc-body"><div className="sk-calc-col">
    <div className="sk-calc-form">
      <label className="sk-field"><span>Amount</span>
        <span className="sk-amount"><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={!valid} aria-label="Amount to delegate in MON" /><b>MON</b></span>
      </label>
      <div className="sk-field"><span>Validator</span>
        {loading ? <div className="sk-combo-placeholder">Loading validators…</div>
          : failed && !options.length ? <div className="sk-combo-placeholder">Reward rates are unavailable right now.</div>
          : <ValidatorCombo options={options} selected={v} onSelect={onSelect} />}
      </div>
    </div>
    {!valid && <p className="sk-inline-warn">Enter an amount of zero or more MON.</p>}
    <div className="sk-calc-rate">
      <div><span>Delegator APR</span><strong className={noisy ? "sk-noisy" : "ok"} title={noisy ? NOISE_NOTE(v!.blocks) : undefined}>{aprText(apr)}</strong></div>
      <div><span>Reward APR</span><strong>{aprText(v?.apr)}</strong></div>
      <div><span>Commission</span><strong>{v ? commissionPct(v.commission) : "—"}</strong></div>
      <div><span>Blocks ({hours}h)</span><strong className={noisy ? "sk-noisy" : undefined}>{v ? fmt(v.blocks) : "—"}</strong></div>
    </div>
    </div><div className="sk-calc-col">
    <div className="sk-calc-results">{rows.map((r) => <div key={r.label}><span>{r.label}<small>{r.note}</small></span><strong>{r.value === null ? "—" : `≈ ${monNumber(r.value)}`}</strong></div>)}</div>
    {v && apr === null && <p className="sk-inline-warn">No measured rate for {validatorLabel(v.id, v.name)}: it holds no stake this epoch or received no rewards in the window.</p>}
    {noisy && <p className="sk-inline-warn">{NOISE_NOTE(v!.blocks)}</p>}
    {v && !v.active && <p className="sk-inline-warn">This validator is not in the current active set, so it is not proposing blocks or earning rewards now.</p>}
    <p className="sk-disclaimer">Estimates only, not a promise or financial advice. The rate is what this validator's pool actually earned over the last {hours} hours, annualised and net of its current commission; future rewards depend on block rewards, its stake, commission changes and the proposer lottery. A new delegation activates at an epoch boundary and earns nothing before then, and rewards accrue unclaimed until you claim or compound them.</p>
    </div></div>
  </section>;
}

function ValidatorCombo({ options, selected, onSelect }: { options: CalcOption[]; selected: CalcOption | null; onSelect: (id: number) => void }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const list = useId();
  const input = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^#/, "");
    const rows = !q ? options : options.filter((o) => String(o.id) === q || validatorLabel(o.id, o.name).toLowerCase().includes(q));
    return rows.slice(0, 60);
  }, [options, query]);
  const choose = (o: CalcOption) => { onSelect(o.id); setQuery(""); setOpen(false); input.current?.blur(); };
  const label = selected ? validatorLabel(selected.id, selected.name) : "";

  return <div className="sk-combo">
    {selected && !open && <span className="sk-combo-avatar"><ValidatorAvatar id={selected.id} seed={selected.seed} hasLogo={selected.logo} size={20} /></span>}
    <input ref={input} role="combobox" aria-expanded={open} aria-controls={list} aria-autocomplete="list" aria-label="Search validators"
      aria-activedescendant={open && matches[cursor] ? `${list}-${matches[cursor].id}` : undefined}
      className={selected && !open ? "with-avatar" : undefined}
      placeholder={open ? "Search by name or id…" : "Choose a validator"} value={open ? query : label}
      onFocus={() => { setOpen(true); setCursor(0); }}
      onBlur={() => setTimeout(() => setOpen(false), 120)}
      onChange={(e) => { setQuery(e.target.value); setCursor(0); setOpen(true); }}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(matches.length - 1, c + 1)); }
        else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
        else if (e.key === "Enter" && matches[cursor]) { e.preventDefault(); choose(matches[cursor]); }
        else if (e.key === "Escape") { setOpen(false); setQuery(""); input.current?.blur(); }
      }} />
    <span className="sk-combo-caret" aria-hidden="true">⌄</span>
    {open && <ul className="sk-combo-list" id={list} role="listbox">
      {matches.length === 0 ? <li className="sk-combo-empty">No validator matches.</li> : matches.map((o, i) => <li key={o.id} id={`${list}-${o.id}`} role="option" aria-selected={selected?.id === o.id}
        className={i === cursor ? "active" : undefined} onMouseDown={(e) => { e.preventDefault(); choose(o); }} onMouseEnter={() => setCursor(i)}>
        <ValidatorAvatar id={o.id} seed={o.seed} hasLogo={o.logo} size={18} />
        <span>{validatorLabel(o.id, o.name)} <small>#{o.id}</small></span>
        <b className={o.blocks < MIN_BLOCKS ? "sk-noisy" : undefined} title={o.blocks < MIN_BLOCKS ? NOISE_NOTE(o.blocks) : "Measured delegator APR"}>{aprText(o.delegator_apr)}</b>
      </li>)}
    </ul>}
  </div>;
}
