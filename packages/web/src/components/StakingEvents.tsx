/** Live staking-precompile event feed with a kind filter and cursor pagination. */
import { useCallback, useEffect, useRef, useState } from "react";
import { getStakingEvents, type StakingEvent } from "../api";
import { Skeleton } from "./ui";
import { Timestamp } from "./Timestamp";
import { fmt, short } from "../lib";
import { KindChip, ValidatorLink, eventAmount, eventCursor, eventKey, mergeEvents } from "./StakingShared";

const PAGE = 25;
const REFRESH_MS = 30_000;
const FILTERS = [
  { id: "", label: "All" },
  { id: "delegate", label: "Delegate" },
  { id: "undelegate", label: "Undelegate" },
  { id: "withdraw", label: "Withdraw" },
  { id: "claim", label: "Claim" },
  { id: "commission", label: "Commission" },
] as const;

export function StakingEvents({ logos }: { logos: Map<number, { logo: boolean; seed: string }> }) {
  const [kind, setKind] = useState("");
  const [events, setEvents] = useState<StakingEvent[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [more, setMore] = useState<"idle" | "loading" | "done" | "error">("idle");
  const kindRef = useRef(kind);
  kindRef.current = kind;

  const loadFirst = useCallback((k: string, replace: boolean) => {
    getStakingEvents({ limit: PAGE, kind: k || undefined })
      .then((r) => {
        if (kindRef.current !== k) return;
        setFailed(false);
        setEvents((old) => (replace || !old ? r.events : mergeEvents(r.events, old)));
        if (replace) setMore(r.events.length < PAGE ? "done" : "idle");
      })
      .catch(() => { if (kindRef.current === k) setFailed(true); });
  }, []);

  useEffect(() => {
    setEvents(null);
    setFailed(false);
    loadFirst(kind, true);
    const id = setInterval(() => { if (document.visibilityState === "visible") loadFirst(kind, false); }, REFRESH_MS);
    return () => clearInterval(id);
  }, [kind, loadFirst]);

  const loadMore = () => {
    const last = events?.at(-1);
    if (!last) return;
    const k = kind;
    setMore("loading");
    getStakingEvents({ limit: PAGE, kind: k || undefined, before: eventCursor(last) })
      .then((r) => {
        if (kindRef.current !== k) return;
        setEvents((old) => mergeEvents([], [...(old ?? []), ...r.events]));
        setMore(r.events.length < PAGE ? "done" : "idle");
      })
      .catch(() => setMore("error"));
  };

  return <section className="sk-panel sk-feed" aria-labelledby="sk-feed-title">
    <header className="sk-heading">
      <div><h2 id="sk-feed-title">Live staking events</h2><p>Straight from the staking precompile's logs. Refreshes every 30 seconds.</p></div>
      <div className="sk-pills" role="group" aria-label="Filter events by kind">{FILTERS.map((f) => <button key={f.id || "all"} type="button" aria-pressed={kind === f.id} onClick={() => setKind(f.id)}>{f.label}</button>)}</div>
    </header>
    <div className="sk-table-scroll">
      <table className="sk-table">
        <thead><tr><th>Kind</th><th>Validator</th><th>Address</th><th className="sk-num">Amount</th><th className="sk-num" title="Delegations activate at this epoch; undelegations take effect at it">Epoch</th><th>Time</th><th>Tx</th></tr></thead>
        <tbody>
          {events === null ? (failed
            ? <tr><td colSpan={7} className="sk-empty">Staking events are temporarily unavailable. <button type="button" onClick={() => loadFirst(kind, true)}>Retry</button></td></tr>
            : Array.from({ length: 5 }, (_, i) => <tr key={i}><td colSpan={7}><Skeleton h={18} w="100%" /></td></tr>))
            : events.length === 0 ? <tr><td colSpan={7} className="sk-empty">No {kind ? `${FILTERS.find((f) => f.id === kind)?.label.toLowerCase()} ` : ""}events in the collected history yet.</td></tr>
            : events.map((e) => {
              const l = e.validator_id === null ? undefined : logos.get(e.validator_id);
              return <tr key={eventKey(e)}>
                <td><KindChip kind={e.kind} /></td>
                <td><ValidatorLink id={e.validator_id} name={e.validator_name} logo={l?.logo} seed={l?.seed} size={18} /></td>
                <td>{e.address ? <a className="sk-mono-link" href={`#/transactions/address/${e.address}`} title={e.address}>{short(e.address)}</a> : <span className="sk-muted">—</span>}</td>
                <td className="sk-num">{eventAmount(e)}</td>
                <td className="sk-num">{e.epoch == null ? <span className="sk-muted">—</span> : fmt(e.epoch)}</td>
                <td className="sk-time">{e.time ? <Timestamp value={e.time} /> : <span className="sk-muted">—</span>}</td>
                <td><a className="sk-mono-link" href={`#/transactions/${e.tx_hash}`} title={`${e.tx_hash} · block ${fmt(e.block_number)}`}>{short(e.tx_hash)}</a></td>
              </tr>;
            })}
        </tbody>
      </table>
    </div>
    {events && events.length > 0 && <footer className="sk-table-footer">
      <span>{fmt(events.length)} event{events.length === 1 ? "" : "s"} shown{failed ? " · refresh failed, retrying" : ""}</span>
      {more === "done" ? <span>End of collected history</span>
        : <button type="button" onClick={loadMore} disabled={more === "loading"}>{more === "loading" ? "Loading…" : more === "error" ? "Retry load more" : "Load more"}</button>}
    </footer>}
  </section>;
}
