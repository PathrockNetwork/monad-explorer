/** Address page extras: internal transfers, staking positions and history, sampled gas overpayment. */
import { useEffect, useState } from "react";
import { getAddressInternal, getAddressStaking, type AddressGas, type AddressInternal, type AddressStaking, type Delegation, type Labels, type StakingEvent } from "../api";
import { fmt, middle, pct } from "../lib";
import { Chip, Skeleton } from "./ui";
import { Timestamp } from "./Timestamp";
import { addressName, effText, effTone, isPositiveWei, monAuto } from "./GasFormat";
import { addressRoute } from "../transactionExplorer";

type InternalRow = AddressInternal["internal"][number];

function Addr({ address, current, labels }: { address: string | null; current: string; labels: Labels }) {
  if (!address) return <span className="txe-muted-inline">—</span>;
  if (address.toLowerCase() === current) return <span className="txe-self" title={address}>{middle(address, 8, 4)}</span>;
  return <a className="txe-address-link" href={addressRoute(address)} title={address} onClick={(e) => e.stopPropagation()}>{addressName(address, null, labels, 8, 4)}</a>;
}

function SkeletonRows({ cols, n = 5 }: { cols: number; n?: number }) {
  return <>{Array.from({ length: n }, (_, i) => <tr key={i}><td colSpan={cols}><Skeleton h={22} w={`${95 - i * 4}%`} /></td></tr>)}</>;
}

/* ───────────── Internal transfers ───────────── */

export function AddressInternalTab({ address, onInspect }: { address: string; onInspect: (hash: string) => void }) {
  const [rows, setRows] = useState<InternalRow[] | null>(null);
  const [labels, setLabels] = useState<Labels>({});
  const [traceEvery, setTraceEvery] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setRows(null); setError(null); setMore(false);
    getAddressInternal(address).then((r) => {
      if (cancelled) return;
      setRows(r.internal); setLabels(r.labels); setTraceEvery(r.trace_every); setMore(r.internal.length >= 50);
    }).catch(() => { if (!cancelled) setError("Internal transfers are temporarily unavailable."); });
    return () => { cancelled = true; };
  }, [address, attempt]);
  const last = rows?.[rows.length - 1];
  const loadOlder = async () => {
    if (!last || loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await getAddressInternal(address, `${last.block_number}:${last.tx_hash}:${last.idx}`);
      setRows((old) => [...(old ?? []), ...r.internal]);
      setLabels((old) => ({ ...old, ...r.labels }));
      setMore(r.internal.length >= 50);
    } catch { setError("Older internal transfers could not be loaded."); }
    finally { setLoadingMore(false); }
  };
  const cols = 8;
  return <>
    <div className="txe-sample-note txe-transfers-note"><span>Value-moving inner calls (CALL with value, CREATE/CREATE2, SELFDESTRUCT) involving this address, from call traces of {traceEvery && traceEvery > 1 ? `every ${traceEvery}th indexed block` : traceEvery === 1 ? "every indexed block" : "sampled blocks"}. {traceEvery && traceEvery > 1 ? "Transfers in other blocks are not listed." : ""}</span></div>
    {error && rows && <div className="txe-notice" role="status">{error}</div>}
    <div className="txe-table-scroll" tabIndex={0} role="region" aria-label="Internal transfers">
      <table className="txe-table txe-transfer-table">
        <thead><tr><th>Tx hash</th><th>Block</th><th>Age</th><th>Type</th><th>From</th><th><span className="txe-visually-hidden">Direction</span></th><th>To</th><th>Value</th></tr></thead>
        <tbody>
          {rows === null ? (error ? <tr><td className="txe-empty" colSpan={cols}>{error}<button type="button" onClick={() => setAttempt((n) => n + 1)}>Retry</button></td></tr> : <SkeletonRows cols={cols} />)
            : rows.map((r, i) => {
              const type = r.call_type || "CALL";
              const out = r.from?.toLowerCase() === address, inn = r.to?.toLowerCase() === address;
              return <tr key={`${r.tx_hash}-${r.idx}-${i}`} onClick={() => onInspect(r.tx_hash)}>
                <td><button className="txe-hash" type="button" onClick={(e) => { e.stopPropagation(); onInspect(r.tx_hash); }}>{middle(r.tx_hash, 8, 4)}</button></td>
                <td><a className="txe-address-link" href={`#/blocks/${r.block_number}`} onClick={(e) => e.stopPropagation()}>{fmt(r.block_number)}</a></td>
                <td>{r.time ? <Timestamp value={r.time} /> : "—"}</td>
                <td><span className="txe-call-type">{type}</span>{r.error && <small className="txe-bad-text" title={r.error}>{r.error}</small>}</td>
                <td><Addr address={r.from} current={address} labels={labels} /></td>
                <td><span className={`txe-direction ${out && inn ? "self" : out ? "out" : "in"}`}>{out && inn ? "Self" : out ? "Out" : "In"}</span></td>
                <td><Addr address={r.to} current={address} labels={labels} /></td>
                <td className={r.error ? "txe-struck" : undefined}>{monAuto(r.value)}</td>
              </tr>;
            })}
          {rows !== null && !rows.length && <tr><td className="txe-empty" colSpan={cols}>No internal transfers for this address in the sampled blocks of the indexed window.</td></tr>}
        </tbody>
      </table>
    </div>
    {more && last && <button type="button" className="txe-load-older" disabled={loadingMore} onClick={() => void loadOlder()}>{loadingMore ? "Loading…" : `Load older (before block ${fmt(last.block_number)})`}</button>}
    <footer className="txe-footer"><span>{rows ? `${fmt(rows.length)} internal transfer${rows.length === 1 ? "" : "s"} loaded` : "—"}</span></footer>
  </>;
}

/* ───────────── Staking ───────────── */

const KIND_LABEL: Record<StakingEvent["kind"], string> = { delegate: "Delegate", undelegate: "Undelegate", withdraw: "Withdraw", claim: "Claim rewards", commission: "Commission change", created: "Validator created", status: "Status change" };
const KIND_TONE: Record<StakingEvent["kind"], "ok" | "warn" | "bad" | "brand" | "muted"> = { delegate: "ok", undelegate: "warn", withdraw: "muted", claim: "brand", commission: "muted", created: "brand", status: "muted" };
const sumWei = (xs: string[]) => xs.reduce((s, x) => (/^\d+$/.test(x) ? s + BigInt(x) : s), 0n).toString();

export function AddressStakingTab({ address, onInspect }: { address: string; onInspect: (hash: string) => void }) {
  const [data, setData] = useState<AddressStaking | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [allDelegations, setAllDelegations] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setData(null); setError(null);
    getAddressStaking(address).then((r) => { if (!cancelled) setData(r); }).catch(() => { if (!cancelled) setError("Staking data is temporarily unavailable."); });
    return () => { cancelled = true; };
  }, [address, attempt]);

  if (!data) return <div className="txe-staking">
    {error ? <div className="txe-empty" role="status">{error}<button type="button" onClick={() => setAttempt((n) => n + 1)}>Retry</button></div> : <>
      <p className="txe-staking-note">Reading delegations from the staking precompile. Addresses with many delegations can take several seconds.</p>
      <div className="txe-staking-loading"><Skeleton h={64} w="100%" r={8} /><Skeleton h={22} w="92%" /><Skeleton h={22} w="86%" /><Skeleton h={22} w="80%" /></div>
    </>}
  </div>;

  const ds = [...data.delegations].sort((a, b) => (BigInt(b.stake || "0") > BigInt(a.stake || "0") ? 1 : -1));
  const shown = allDelegations ? ds : ds.slice(0, 15);
  const rated = ds.filter((d) => d.delegator_apr !== null && isPositiveWei(d.stake));
  const weighted = rated.length ? rated.reduce((s, d) => s + d.delegator_apr! * Number(BigInt(d.stake) / 10n ** 12n), 0) / rated.reduce((s, d) => s + Number(BigInt(d.stake) / 10n ** 12n), 0) : null;
  const pendingTotal = sumWei(ds.flatMap((d) => [d.deltaStake, d.nextDeltaStake]));
  return <div className="txe-staking">
    {ds.length ? <>
      <div className="txe-funds-grid txe-staking-totals">
        <div className="total"><span>Active stake</span><strong>{monAuto(sumWei(ds.map((d) => d.stake)))}</strong></div>
        <div><span>Pending stake</span><strong>{monAuto(pendingTotal)}</strong></div>
        <div><span>Unclaimed rewards</span><strong>{monAuto(sumWei(ds.map((d) => d.unclaimedRewards)))}</strong></div>
        <div><span>Validators</span><strong>{fmt(ds.length)}</strong></div>
        <div><span>Delegator APR · stake-weighted</span><strong>{weighted === null || !Number.isFinite(weighted) ? "—" : pct(weighted * 100, 2)}</strong></div>
      </div>
      <div className="txe-table-scroll" tabIndex={0} role="region" aria-label="Delegations">
        <table className="txe-table txe-staking-table">
          <thead><tr><th>Validator</th><th>Active stake</th><th>Pending</th><th>Unclaimed rewards</th><th>Delegator APR</th></tr></thead>
          <tbody>{shown.map((d) => <DelegationRow key={d.validatorId} d={d} />)}</tbody>
        </table>
      </div>
      {ds.length > 15 && <button type="button" className="txe-load-older" onClick={() => setAllDelegations(!allDelegations)}>{allDelegations ? "Show top 15" : `Show all ${ds.length} delegations`}</button>}
      <p className="txe-staking-note">Live from the staking precompile. Pending stake activates at the epoch shown. APR is measured from block rewards paid over the last 24 h, net of commission, and is noisy for small validators.</p>
    </> : <div className="txe-empty">No delegations. This address has no stake with any validator right now.</div>}

    <h3 className="txe-staking-title">Staking history</h3>
    <div className="txe-table-scroll" tabIndex={0} role="region" aria-label="Staking history">
      <table className="txe-table txe-staking-table">
        <thead><tr><th>Event</th><th>Validator</th><th>Amount</th><th>Epoch</th><th>Age</th><th>Tx</th></tr></thead>
        <tbody>
          {data.events.map((e) => <tr key={`${e.tx_hash}-${e.log_index}`} onClick={() => onInspect(e.tx_hash)}>
            <td><Chip tone={KIND_TONE[e.kind] ?? "muted"}>{KIND_LABEL[e.kind] ?? e.kind}</Chip></td>
            <td>{e.validator_id !== null ? <a className="txe-address-link" href={`#/validators/${e.validator_id}`} onClick={(ev) => ev.stopPropagation()}>{e.validator_name ?? `Validator #${e.validator_id}`}</a> : "—"}</td>
            <td>{e.kind === "commission" && e.new_commission !== null ? `${pct(e.old_commission === null ? null : e.old_commission * 100, 2)} → ${pct(e.new_commission * 100, 2)}` : e.amount ? monAuto(e.amount) : "—"}</td>
            <td>{e.epoch !== null ? fmt(e.epoch) : "—"}</td>
            <td>{e.time ? <Timestamp value={e.time} /> : "—"}</td>
            <td><button className="txe-hash" type="button" onClick={(ev) => { ev.stopPropagation(); onInspect(e.tx_hash); }}>{middle(e.tx_hash, 8, 4)}</button></td>
          </tr>)}
          {!data.events.length && <tr><td className="txe-empty" colSpan={6}>No staking events recorded for this address in the collected staking history.</td></tr>}
        </tbody>
      </table>
    </div>
    {data.events.length >= 100 && <p className="txe-staking-note">Showing the latest 100 events.</p>}
  </div>;
}

function DelegationRow({ d }: { d: Delegation }) {
  const pending = [
    isPositiveWei(d.deltaStake) ? { v: d.deltaStake, e: d.deltaEpoch } : null,
    isPositiveWei(d.nextDeltaStake) ? { v: d.nextDeltaStake, e: d.nextDeltaEpoch } : null,
  ].filter((x): x is { v: string; e: number } => x !== null);
  return <tr>
    <td><a className="txe-address-link" href={`#/validators/${d.validatorId}`}>{d.validator_name ?? `Validator #${d.validatorId}`}</a>{d.in_consensus_set === false && <small>Not in the active set</small>}</td>
    <td>{monAuto(d.stake)}</td>
    <td>{pending.length ? pending.map((p, i) => <span key={i} className="txe-pending">{monAuto(p.v)}<small>activates epoch {fmt(p.e)}</small></span>) : "—"}</td>
    <td>{monAuto(d.unclaimedRewards)}</td>
    <td>{d.delegator_apr === null ? "—" : pct(d.delegator_apr * 100, 2)}</td>
  </tr>;
}

/* ───────────── Sampled gas overpayment (summary card cell) ───────────── */

export function AddressGasCell({ gas, failed }: { gas: AddressGas | null; failed: boolean }) {
  const s = gas?.sampled;
  const title = "Gas limit paid minus eth_estimateGas, priced at the fee paid, over this address's transactions in replayed (sampled) blocks. Conservative estimate.";
  return <div title={title}>
    <span>Overpaid gas · sampled</span>
    <strong className={s && s.txs > 0 ? "txe-warn-text" : undefined}>{failed && !gas ? "—" : !gas ? <Skeleton h={18} w="70%" /> : s && s.txs > 0 ? monAuto(s.unused_fee) : "—"}</strong>
    {gas && <small>{s && s.txs > 0 ? <>{fmt(s.txs)} replayed tx{s.txs === 1 ? "" : "s"} · <b className={`txe-eff-${effTone(s.efficiency)}`}>{effText(s.efficiency, 0)}</b> efficient</> : gas.sent_in_window > 0 ? "No sent tx in a replayed block" : "Sent no transactions"}</small>}
  </div>;
}
