/** Delegator lookup: live positions from the staking precompile plus this address's staking history. */
import { useEffect, useState } from "react";
import { getAddressStaking, ApiError, type AddressStaking, type Delegation } from "../api";
import { Skeleton } from "./ui";
import { fmt, isAddr, short } from "../lib";
import { StakingEventList, ValidatorLink, aprText, big, monExact, monFloat, monNumber, monShort } from "./StakingShared";

type State = { address: string; data: AddressStaking | null; error: string | null };

export function StakingLookup({ logos, epoch }: { logos: Map<number, { logo: boolean; seed: string }>; epoch: number | null }) {
  const [input, setInput] = useState("");
  const [state, setState] = useState<State | null>(null);
  const [nonce, setNonce] = useState(0);
  const trimmed = input.trim();
  const valid = isAddr(trimmed);

  const address = state?.address ?? null;
  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    getAddressStaking(address)
      .then((data) => { if (!cancelled) setState({ address, data, error: null }); })
      .catch((e) => { if (!cancelled) setState({ address, data: null, error: e instanceof ApiError && e.status === 400 ? "That is not a valid address." : "The lookup failed; the RPC may be slow. Try again in a moment." }); });
    return () => { cancelled = true; };
  }, [address, nonce]);

  const submit = () => {
    if (!valid) return;
    const a = trimmed.toLowerCase();
    if (a === address) setNonce((n) => n + 1);
    setState({ address: a, data: null, error: null });
  };

  // Look up as soon as a complete address is pasted.
  useEffect(() => {
    if (valid && trimmed.toLowerCase() !== address) {
      const t = setTimeout(submit, 350);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trimmed, valid]);

  const data = state?.data ?? null;
  const loading = state !== null && !data && !state.error;

  return <section className="sk-panel sk-lookup" aria-labelledby="sk-lookup-title">
    <header className="sk-heading"><div><h2 id="sk-lookup-title">Delegator lookup</h2><p>Live delegations read from the staking precompile, with this address's collected staking history.</p></div></header>
    <form className="sk-lookup-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <label className="sk-search"><span aria-hidden="true">⌕</span><input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Delegator address 0x…" aria-label="Delegator address" aria-invalid={trimmed !== "" && !valid} spellCheck={false} autoComplete="off" /></label>
      <button type="submit" disabled={!valid || loading}>{loading ? "Looking up…" : "Look up"}</button>
    </form>
    {trimmed !== "" && !valid && <p className="sk-inline-warn">Enter a full 0x address (40 hex characters).</p>}
    {state === null ? <p className="sk-muted sk-lookup-hint">Paste an address to see its positions, pending stake and unclaimed rewards.</p>
      : state.error ? <div className="sk-empty">{state.error} <button type="button" onClick={() => setNonce((n) => n + 1)}>Retry</button></div>
      : loading ? <div className="sk-lookup-loading" role="status" aria-label="Loading delegations"><p className="sk-muted">Reading delegations from the precompile; addresses with many positions take several seconds…</p><Skeleton h={60} w="100%" /><Skeleton h={32} w="100%" /><Skeleton h={32} w="100%" /><Skeleton h={32} w="100%" /></div>
      : data && <Positions data={data} logos={logos} epoch={epoch} />}
  </section>;
}

function Positions({ data, logos, epoch }: { data: AddressStaking; logos: Map<number, { logo: boolean; seed: string }>; epoch: number | null }) {
  const rows = data.delegations.slice().sort((a, b) => (big(b.stake) > big(a.stake) ? 1 : big(b.stake) < big(a.stake) ? -1 : a.validatorId - b.validatorId));
  const sum = (f: (d: Delegation) => string) => rows.reduce((s, d) => s + big(f(d)), 0n).toString();
  const stake = sum((d) => d.stake), unclaimed = sum((d) => d.unclaimedRewards);
  const pending = rows.reduce((s, d) => s + big(d.deltaStake) + big(d.nextDeltaStake), 0n).toString();
  const yearly = rows.reduce((s, d) => s + (d.delegator_apr === null ? 0 : monFloat(d.stake) * d.delegator_apr), 0);
  const covered = rows.some((d) => d.delegator_apr !== null);
  const [all, setAll] = useState(false);
  const visible = all ? rows : rows.slice(0, 15);
  return <>
    <div className="sk-lookup-summary">
      <div><span>Address</span><strong><a href={`#/transactions/address/${data.address}`} title={data.address}>{short(data.address)} →</a></strong></div>
      <div><span>Positions</span><strong>{fmt(rows.length)}</strong></div>
      <div><span>Active stake</span><strong title={monExact(stake)}>{monShort(stake)}</strong></div>
      <div><span>Pending</span><strong title={monExact(pending)}>{monShort(pending)}</strong></div>
      <div><span>Unclaimed rewards</span><strong className="ok" title={monExact(unclaimed)}>{monShort(unclaimed)}</strong></div>
      <div><span>Est. per year</span><strong title="Active stake × each validator's measured delegator APR; an estimate">{covered ? `≈ ${monNumber(yearly)}` : "—"}</strong></div>
    </div>
    {rows.length === 0 ? <div className="sk-empty">This address has no active delegations.</div> : <div className="sk-table-scroll">
      <table className="sk-table">
        <thead><tr><th>Validator</th><th className="sk-num">Stake</th><th className="sk-num">Pending</th><th className="sk-num">Unclaimed rewards</th><th className="sk-num" title="Measured over the last 24 hours, net of commission">Delegator APR</th><th className="sk-num">Est. / year</th></tr></thead>
        <tbody>{visible.map((d) => {
          const l = logos.get(d.validatorId);
          const pend = [[d.deltaStake, d.deltaEpoch], [d.nextDeltaStake, d.nextDeltaEpoch]].filter(([s]) => big(s as string) > 0n) as [string, number][];
          return <tr key={d.validatorId}>
            <td><span className="sk-cell-stack"><ValidatorLink id={d.validatorId} name={d.validator_name} logo={l?.logo} seed={l?.seed} />{d.in_consensus_set === false && <small className="warn">Not in active set</small>}</span></td>
            <td className="sk-num" title={monExact(d.stake)}>{monShort(d.stake)}</td>
            <td className="sk-num">{pend.length === 0 ? <span className="sk-muted">—</span> : pend.map(([s, ep]) => <span key={ep} className="sk-cell-stack sk-right" title={monExact(s)}>+{monShort(s)}<small>activates epoch {fmt(ep)}{epoch !== null && ep > epoch ? ` (in ${ep - epoch})` : ""}</small></span>)}</td>
            <td className="sk-num ok" title={monExact(d.unclaimedRewards)}>{monShort(d.unclaimedRewards)}</td>
            <td className="sk-num">{aprText(d.delegator_apr)}</td>
            <td className="sk-num">{d.delegator_apr === null ? <span className="sk-muted">—</span> : `≈ ${monNumber(monFloat(d.stake) * d.delegator_apr)}`}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>}
    {rows.length > 15 && <footer className="sk-table-footer"><span>{all ? `All ${fmt(rows.length)} positions` : `Largest 15 of ${fmt(rows.length)} positions`}</span><button type="button" onClick={() => setAll((a) => !a)}>{all ? "Show fewer" : "Show all"}</button></footer>}
    <div className="sk-subhead"><h3>Recent staking events</h3><span>{data.events.length ? `${fmt(data.events.length)} latest collected` : ""}</span></div>
    {data.events.length === 0 ? <p className="sk-muted">No staking events collected for this address. History is still being backfilled, so older activity may be missing.</p>
      : <div className="sk-lookup-events"><StakingEventList events={data.events.slice(0, 20)} show="validator" /></div>}
  </>;
}
