import { preferredScrollBehavior } from "../appearance";
import { Timestamp } from "../components/Timestamp";
/** Recent Monad transactions, a transaction inspector, and address history. */
import { useEffect, useRef, useState } from "react";
import type { Dashboard } from "../useDashboard";
import { ApiError, getAddress, getAddressGas, getTransaction, getTransactions, type AddressGas, type AddressInfo, type Transfer, type Tx, type TxDetail } from "../api";
import { CallTree, GasAnalysis, InternalTransfers, StateChanges, useTxTrace } from "../components/TxTrace";
import { AddressGasCell, AddressInternalTab, AddressStakingTab } from "../components/AddressInsights";
import { fmt, formatUnits, gwei, methodLabel, middle, mon, pct, pts, STAKING_PRECOMPILE } from "../lib";
import { Chip, CopyButton, Skeleton, ValidatorAvatar } from "../components/ui";
import {
  addressFromHash, addressRoute, defaultTransactionFilters, direction, filterTransactions, paidFees, searchTarget, tokenAmount,
  transactionCategories, transactionKind, txCursor, txHashFromHash, txRoute, weiToNumber, type Direction, type TransactionFilters,
} from "../transactionExplorer";
import "./transactions.css";

const PAGE = 100;
const label = (tx: Pick<Tx, "method" | "input_size" | "to">) => methodLabel(tx.method, tx.input_size, tx.to);

export function Transactions({ d, live }: { d: Dashboard; live: boolean }) {
  const [transactions, setTransactions] = useState<Tx[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState(defaultTransactionFilters);
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(10);
  const [open, setOpen] = useState<string | null>(() => txHashFromHash(window.location.hash));
  /** Address whose history is shown (#/transactions/address/<addr>), else the live feed. */
  const [address, setAddress] = useState<string | null>(() => addressFromHash(window.location.hash));
  /** Older pages fetched with "Load older". While any are loaded the newest page stops refreshing, so the list stays contiguous. */
  const [older, setOlder] = useState<Tx[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [reload, setReload] = useState(0);
  const [addrTab, setAddrTab] = useState<"transactions" | "transfers" | "internal" | "staking">("transactions");
  const [addrGas, setAddrGas] = useState<AddressGas | null>(null);
  const [addrGasError, setAddrGasError] = useState(false);
  const [info, setInfo] = useState<AddressInfo | null>(null);
  const [infoError, setInfoError] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const initialized = useRef(false);
  const frozen = useRef(false);
  frozen.current = older.length > 0;
  const inspector = useRef<HTMLDivElement>(null);
  const retainHours = d.config?.indexer.retain_hours ?? 72;

  useEffect(() => {
    const sync = () => {
      const next = addressFromHash(window.location.hash);
      setAddress(next);
      if (!next) setOpen(txHashFromHash(window.location.hash));
    };
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  useEffect(() => {
    let cancelled = false;
    frozen.current = false;
    setLoading(true); setOlder([]); setCursor(null); setPage(1);
    if (address) { initialized.current = false; setOpen(null); setAddrTab("transactions"); }
    const load = async () => {
      if (frozen.current) return;
      try {
        const result = await getTransactions(PAGE, { address: address ?? undefined });
        if (cancelled || frozen.current) return;
        setTransactions(result.txs); setError(null); setLoading(false);
        const last = result.txs[result.txs.length - 1];
        setCursor(result.txs.length >= PAGE && last ? txCursor(last) : null);
        if (!initialized.current && result.txs.length && !address) {
          initialized.current = true;
          setOpen((current) => current ?? result.txs[0]!.hash);
        }
      } catch {
        if (!cancelled) { setError(address ? "This address history is temporarily unavailable." : "The transaction feed is temporarily unavailable."); setLoading(false); }
      }
    };
    void load();
    const timer = live ? window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 15_000) : undefined;
    return () => { cancelled = true; if (timer !== undefined) clearInterval(timer); };
  }, [live, address, reload]);
  useEffect(() => {
    if (!address) { setInfo(null); return; }
    let cancelled = false;
    setInfo(null); setInfoError(false);
    const load = () => getAddress(address).then((r) => { if (!cancelled) { setInfo(r); setInfoError(false); } }).catch(() => { if (!cancelled) setInfoError(true); });
    void load();
    const timer = live ? window.setInterval(load, 30_000) : undefined;
    return () => { cancelled = true; if (timer !== undefined) clearInterval(timer); };
  }, [address, live]);

  useEffect(() => {
    setAddrGas(null); setAddrGasError(false);
    if (!address) return;
    let cancelled = false;
    getAddressGas(address).then((r) => { if (!cancelled) setAddrGas(r); }).catch(() => { if (!cancelled) setAddrGasError(true); });
    return () => { cancelled = true; };
  }, [address]);

  const loadOlder = async () => {
    if (cursor === null || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const result = await getTransactions(PAGE, { address: address ?? undefined, before: cursor });
      setOlder((rows) => [...rows, ...result.txs]);
      const last = result.txs[result.txs.length - 1];
      setCursor(result.txs.length >= PAGE && last ? txCursor(last) : null);
    } catch { setError("Older transactions could not be loaded."); }
    finally { setLoadingOlder(false); }
  };
  const backToNewest = () => { setOlder([]); setPage(1); setReload((n) => n + 1); };
  const rows = [...new Map([...transactions, ...older].map((tx) => [tx.hash, tx])).values()];

  const updateFilter = <K extends keyof TransactionFilters>(key: K, value: TransactionFilters[K]) => { setFilters((old) => ({ ...old, [key]: value })); setPage(1); };
  const onCopy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); setCopied(value); window.setTimeout(() => setCopied((current) => current === value ? null : current), 2000); } catch { /* Leave the selectable value visible when clipboard access is unavailable. */ }
  };
  const inspect = (hash: string) => {
    initialized.current = true; setOpen(hash);
    if (!address) window.history.replaceState(null, "", txRoute(hash));
    if (window.innerWidth < 1800) requestAnimationFrame(() => inspector.current?.scrollIntoView({ behavior: preferredScrollBehavior(), block: "start" }));
  };
  const shown = filterTransactions(rows, filters, label);
  const pages = Math.max(1, Math.ceil(shown.length / perPage));
  const currentPage = Math.min(page, pages);
  const start = (currentPage - 1) * perPage;
  const visible = shown.slice(start, start + perPage);
  const methods = [...new Set(rows.map(label))].sort();
  const successful = rows.filter((tx) => tx.status === 1).length;
  const failed = rows.filter((tx) => tx.status === 0).length;
  const fees = paidFees(rows);
  const averageFee = fees.length ? fees.reduce((sum, value) => sum + value, 0n) / BigInt(fees.length) : null;
  const feeSeries = fees.slice(0, 24).reverse().map(weiToNumber);
  const blocks = new Map<number, number>();
  for (const tx of rows) blocks.set(tx.block_number, (blocks.get(tx.block_number) ?? 0) + 1);
  const blockCounts = [...blocks.entries()].sort((a, b) => a[0] - b[0]).slice(-12).map(([, count]) => count);
  const unavailable = loading || (!rows.length && !!error);
  // A full address, hash or height in the filter box reaches beyond the loaded rows.
  const target = searchTarget(filters.query);
  const jump = target?.kind === "address" && target.address !== address ? target
    : target?.kind === "transaction" && !rows.some((tx) => tx.hash === target.hash) ? target
    : target?.kind === "block" && !rows.some((tx) => tx.block_number === target.height) ? target : null;
  const followJump = () => {
    if (!jump) return;
    setFilters(defaultTransactionFilters); setPage(1);
    if (jump.kind === "address") window.location.hash = addressRoute(jump.address).slice(1);
    else if (jump.kind === "block") window.location.hash = `/blocks/${jump.height}`;
    else inspect(jump.hash);
  };
  const activeFilters = (Object.keys(defaultTransactionFilters) as (keyof TransactionFilters)[]).some((key) => filters[key] !== defaultTransactionFilters[key]);
  const cols = address ? 11 : 10;

  return <div className="txe-page">
    <div className="txe-workspace">
      <div className="txe-primary">
        <div className="txe-kpis">
          <Stat icon="transactions" label={address ? "Address transactions" : "Recent transactions"} value={unavailable ? "—" : fmt(rows.length)} note={address ? `Loaded from the ${retainHours} h indexed window${cursor !== null ? " · more available" : ""}` : `Newest finalized transactions · ${PAGE} per page`}>
            <div className="txe-mini-bars" role="img" aria-label="Loaded transaction count by block, oldest to newest">{blockCounts.map((count, i) => <i key={i} style={{ height: `${count / Math.max(1, ...blockCounts) * 100}%` }} title={`${count} loaded transactions`} />)}</div>
          </Stat>
          <Stat icon="success" label="Successful" value={unavailable || !rows.length ? "—" : pct(successful / rows.length * 100)} note={`${successful} of ${rows.length} loaded transactions`}>
            <div className="txe-stat-meter success"><i style={{ width: `${rows.length ? successful / rows.length * 100 : 0}%` }} /></div>
          </Stat>
          <Stat icon="failed" label="Failed" value={unavailable || !rows.length ? "—" : pct(failed / rows.length * 100)} note={`${failed} of ${rows.length} loaded transactions`}>
            <div className="txe-stat-meter failed"><i style={{ width: `${rows.length ? failed / rows.length * 100 : 0}%` }} /></div>
          </Stat>
          <Stat icon="fee" label="Average fee" value={unavailable || averageFee === null ? "—" : mon(averageFee.toString(), 6)} note={fees.length ? `${fees.length} fee-paying transactions · zero-gas system calls excluded` : "No fee data in this sample"}>
            {feeSeries.length > 1 && <svg className="txe-fee-chart" viewBox="0 0 180 24" preserveAspectRatio="none" role="img" aria-label="Fees in the loaded sample, oldest to newest"><polyline points={pts(feeSeries, 180, 22, 0, Math.max(...feeSeries) || 1)} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" /></svg>}
          </Stat>
        </div>
        {address && <section className="txe-card txe-address" aria-label="Address history">
          <div><span>Address{info?.is_contract ? " · contract" : ""}</span><strong title={address}>{address}</strong></div>
          <AddressBadges info={info} />
          <CopyButton value={address} copied={copied === address} onCopy={onCopy} size={26} />
          <a href="#/transactions">Back to all transactions</a>
        </section>}
        {address && <AddressCard info={info} failed={infoError} retainHours={retainHours} gas={addrGas} gasFailed={addrGasError} />}
        <section className="txe-card txe-directory" aria-label={address ? "Address transactions" : "Recent transactions"}>
          {address && <div className="txe-address-tabs" role="tablist" aria-label="Address history"><button type="button" role="tab" aria-selected={addrTab === "transactions"} onClick={() => setAddrTab("transactions")}>Transactions</button><button type="button" role="tab" aria-selected={addrTab === "transfers"} onClick={() => setAddrTab("transfers")}>Token transfers{info ? ` (${info.transfers.length}${info.transfers.length >= 25 ? "+" : ""})` : ""}</button><button type="button" role="tab" aria-selected={addrTab === "internal"} onClick={() => setAddrTab("internal")}>Internal</button><button type="button" role="tab" aria-selected={addrTab === "staking"} onClick={() => setAddrTab("staking")}>Staking</button></div>}
          {address && addrTab === "internal" ? <AddressInternalTab address={address} onInspect={inspect} /> : address && addrTab === "staking" ? <AddressStakingTab address={address} onInspect={inspect} /> : address && addrTab === "transfers" ? <TransfersTable transfers={info?.transfers ?? null} address={address} failed={infoError} retainHours={retainHours} onInspect={inspect} /> : <>
          <div className="txe-directory-top">
            <div className="txe-categories" aria-label="Filter by kind">{transactionCategories.map((category) => <button type="button" key={category} aria-pressed={filters.category === category} onClick={() => updateFilter("category", category)}>{category}</button>)}</div>
          </div>
          <div className="txe-toolbar">
            <label className="txe-search"><Glyph name="search" /><input aria-label="Search loaded transactions, or enter an address, hash or block" placeholder="Search hash, address, method, block…" value={filters.query} onChange={(event) => updateFilter("query", event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && jump) { event.preventDefault(); followJump(); } }} />{jump && <button type="button" className="txe-search-jump" onClick={followJump}>{jump.kind === "address" ? "Address history" : jump.kind === "block" ? "Open block" : "Open transaction"} ↵</button>}</label>
            <select aria-label="Transaction status" value={filters.status} onChange={(event) => updateFilter("status", event.target.value)}><option value="all">All statuses</option><option value="success">Successful</option><option value="failed">Failed</option></select>
            <select aria-label="Method" value={filters.method} onChange={(event) => updateFilter("method", event.target.value)}><option value="all">All methods</option>{methods.map((m) => <option key={m} value={m}>{m}</option>)}</select>
          </div>
          <div className="txe-sample-note"><span>Filters and statistics cover the loaded transactions.{address ? ` History covers the ${retainHours} h indexed window only.` : ""}</span><span className={error ? "txe-warning" : ""}>{error ? "Feed unavailable" : older.length ? <>Updates paused while older pages are loaded · <button type="button" className="txe-inline-button" onClick={backToNewest}>Back to newest</button></> : live ? "Updates every 15s" : "Updates paused"}</span></div>
          {error && <div className="txe-notice" role="status">{error}{rows.length > 0 ? " Showing the last loaded sample." : " Please try again when the feed returns."}</div>}
          <div className="txe-table-scroll" tabIndex={0} role="region" aria-label="Transaction results">
            <table className={`txe-table ${address ? "with-direction" : ""}`}>
              <thead><tr><th>#</th><th>Tx hash</th><th>Method</th><th>Block</th><th>From</th>{address && <th><span className="txe-visually-hidden">Direction</span></th>}<th>To</th><th>Value</th><th>Fee</th><th>Age</th><th>Status</th></tr></thead>
              <tbody>
                {loading ? Array.from({ length: 10 }, (_, i) => <tr key={i}><td colSpan={cols}><Skeleton h={22} w={`${95 - i * 3}%`} /></td></tr>) : visible.map((tx, i) => <tr key={tx.hash} className={open === tx.hash ? "selected" : undefined} onClick={() => inspect(tx.hash)}>
                  <td>{start + i + 1}</td>
                  <td><button className="txe-hash" type="button" aria-label={`Inspect transaction ${tx.hash}`} aria-pressed={open === tx.hash} onClick={(event) => { event.stopPropagation(); inspect(tx.hash); }}>{middle(tx.hash, 8, 4)}</button></td>
                  <td><span className={`txe-type ${kindTone(tx)}`}><Glyph name={kindGlyph(tx)} /><span title={tx.method ?? undefined}>{label(tx)}</span></span></td>
                  <td><a className="txe-address-link" href={`#/blocks/${tx.block_number}`} onClick={(event) => event.stopPropagation()}>{fmt(tx.block_number)}</a><small>#{tx.tx_index}</small></td>
                  <td title={tx.from}><AddressLink value={tx.from} current={address} /></td>
                  {address && <td><DirectionChip dir={direction(tx.from, tx.to, address)} /></td>}
                  <td title={tx.to ?? tx.contract_address ?? undefined}>{tx.to ? <AddressLink value={tx.to} current={address} /> : <span className="txe-create"><em>Create</em>{tx.contract_address && <AddressLink value={tx.contract_address} current={address} />}</span>}</td>
                  <td>{mon(tx.value, 4)}</td>
                  <td>{tx.fee === "0" ? <span className="txe-zero-fee" title="Zero-gas system call">0 MON</span> : mon(tx.fee, 6)}</td>
                  <td title={tx.time}><Timestamp value={tx.time} /></td>
                  <td><Chip tone={tx.status === 1 ? "ok" : "bad"}>{tx.status === 1 ? "Success" : "Failed"}</Chip></td>
                </tr>)}
                {!loading && !visible.length && <tr><td className="txe-empty" colSpan={cols}>{error ? "Transaction data is unavailable." : rows.length ? "No transactions match these filters." : address ? `No transactions for this address in the ${retainHours} h indexed window.` : "No transactions in the newest indexed blocks."}{jump && <button type="button" onClick={followJump}>{jump.kind === "address" ? "Open this address" : jump.kind === "block" ? "Open this block" : "Look up this transaction"}</button>}{activeFilters && <button type="button" onClick={() => { setFilters(defaultTransactionFilters); setPage(1); }}>Clear filters</button>}</td></tr>}
              </tbody>
            </table>
          </div>
          {cursor !== null && currentPage >= pages && <button type="button" className="txe-load-older" disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? "Loading…" : `Load older transactions (before block ${fmt(Number(cursor.split(":")[0]))})`}</button>}
          <footer className="txe-footer"><span>{shown.length ? `${start + 1}–${Math.min(start + perPage, shown.length)} of ${shown.length}` : "0"} transactions</span>
            <nav aria-label="Transaction pages"><button type="button" aria-label="Previous page" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>‹</button><span>{currentPage} / {pages}</span><button type="button" aria-label="Next page" disabled={currentPage >= pages} onClick={() => setPage(currentPage + 1)}>›</button></nav>
            <label>Rows <select aria-label="Transactions per page" value={perPage} onChange={(event) => { setPerPage(Number(event.target.value)); setPage(1); }}>{[10, 25, 50].map((count) => <option key={count} value={count}>{count}</option>)}</select></label>
          </footer>
          </>}
        </section>
      </div>
      <div className="txe-inspector-column" ref={inspector}>
        {open ? <TxDetailPanel key={open} hash={open} finalized={d.net?.chain_finalized ?? null} copied={copied} onCopy={onCopy} onClose={() => { initialized.current = true; setOpen(null); if (!address) window.history.replaceState(null, "", "#/transactions"); }} /> : <aside className="txe-card txe-inspector-placeholder"><Glyph name="transactions" /><h2>Transaction inspector</h2><p>Select a transaction to explore its value, fee, token transfers, input data and logs.</p><div><Glyph name="block" />Read live from the Monad RPC.</div></aside>}
      </div>
    </div>
  </div>;
}

function Stat({ icon, label, value, note, children }: { icon: string; label: string; value: string; note: string; children: React.ReactNode }) {
  return <section className={`txe-card txe-stat ${icon}`}><div className="txe-stat-label"><Glyph name={icon} /><span>{label}</span></div><strong>{value}</strong><span className="txe-stat-note">{note}</span><div className="txe-stat-chart">{children}</div></section>;
}
function kindTone(tx: Pick<Tx, "to" | "method" | "input_size">) { return ({ "Contract calls": "contract", Transfers: "transfer", Creates: "create", Staking: "staking" } as const)[transactionKind(tx)]; }
function kindGlyph(tx: Pick<Tx, "to" | "method" | "input_size">) { return ({ "Contract calls": "contract", Transfers: "transfer", Creates: "create", Staking: "staking" } as const)[transactionKind(tx)]; }
function AddressLink({ value, current, head = 8, tail = 4 }: { value: string; current?: string | null; head?: number; tail?: number }) {
  if (value === current) return <span className="txe-self" title={value}>{middle(value, head, tail)}</span>;
  return <a className="txe-address-link" href={addressRoute(value)} title={value} onClick={(event) => event.stopPropagation()}>{value === STAKING_PRECOMPILE ? "Staking precompile" : middle(value, head, tail)}</a>;
}
function DirectionChip({ dir }: { dir: Direction }) { return <span className={`txe-direction ${dir}`}>{dir === "in" ? "In" : dir === "out" ? "Out" : "Self"}</span>; }
function TokenLabel({ t }: { t: Transfer }) {
  const symbol = t.token_meta?.symbol ?? null;
  return <span className="txe-token"><a className="txe-address-link" href={addressRoute(t.token)} title={t.token_meta?.name ?? t.token} onClick={(event) => event.stopPropagation()}>{symbol ?? middle(t.token, 8, 4)}</a>{t.standard === "erc721" && <em className="txe-nft">NFT</em>}</span>;
}
function Amount({ t }: { t: Transfer }) {
  const a = tokenAmount(t.value, t.standard, t.token_meta);
  return <span className="txe-amount" title={t.value}>{a.text}{a.raw && <small> (raw)</small>}</span>;
}

function AddressBadges({ info }: { info: AddressInfo | null }) {
  if (!info) return null;
  return <div className="txe-badges">
    {info.is_contract && <Chip tone="brand">Contract</Chip>}
    {info.token && <Chip tone="ok" title={info.token.name ?? undefined}>{info.token.symbol ?? "Token"} · {info.token.standard.toUpperCase()}</Chip>}
    {info.validator && <a className="txe-validator-badge" href={`#/validators/${info.validator.id}`}><ValidatorAvatar id={info.validator.id} seed={info.address} hasLogo={!!info.validator.logo} size={18} />{info.validator.name ?? `Validator #${info.validator.id}`}</a>}
  </div>;
}

/** Balance, nonce, code and window activity for the address on display. */
function AddressCard({ info, failed, retainHours, gas, gasFailed }: { info: AddressInfo | null; failed: boolean; retainHours: number; gas: AddressGas | null; gasFailed: boolean }) {
  const capped = (n: number, cap: number) => (n >= cap ? `${fmt(cap)}+` : fmt(n));
  const show = (v: string | undefined) => (info ? v ?? "—" : "—");
  return <section className="txe-card txe-funds" aria-label="Address overview">
    <div className="txe-funds-head">
      <span>{info?.is_contract ? "Contract" : "Account"}</span>
      {info?.validator && <em>Validator #{info.validator.id} · {info.validator.role === "auth" ? "auth address" : "block beneficiary"}</em>}
      {info?.token && <em>{info.token.name ?? "Unnamed token"} · {info.token.standard.toUpperCase()}</em>}
    </div>
    {failed && !info ? <p className="txe-funds-note">Address details are temporarily unavailable.</p> : <>
      <div className="txe-funds-grid">
        <div className="total"><span>Balance</span><strong title={info ? `${formatUnits(info.balance, 18, 18)} MON` : undefined}>{show(info ? mon(info.balance, 4) : undefined)}</strong></div>
        <div><span>Nonce</span><strong>{show(info ? fmt(info.nonce) : undefined)}</strong></div>
        <div><span>Code size</span><strong>{show(info ? (info.code_size ? `${fmt(info.code_size)} B` : "No code") : undefined)}</strong></div>
        <div><span>Sent · window</span><strong>{show(info ? capped(info.window.sent, info.window.count_cap) : undefined)}</strong></div>
        <div><span>Received · window</span><strong>{show(info ? capped(info.window.received, info.window.count_cap) : undefined)}</strong></div>
        <AddressGasCell gas={gas} failed={gasFailed} />
      </div>
      {info?.token && <ul className="txe-funds-list" aria-label="Token">
        <li><span>Token name</span><b>{info.token.name ?? "—"}</b></li>
        <li><span>Symbol</span><b>{info.token.symbol ?? "—"}</b></li>
        <li><span>Decimals</span><b>{info.token.decimals ?? "—"}</b></li>
        <li><span>Standard</span><b>{info.token.standard.toUpperCase()}</b></li>
        <li><span>First seen in block</span><b><a className="txe-address-link" href={`#/blocks/${info.token.first_seen_block}`}>{fmt(Number(info.token.first_seen_block))}</a></b></li>
      </ul>}
      {info?.validator && <ul className="txe-funds-list" aria-label="Validator">
        <li><span>Validator</span><b><a className="txe-address-link" href={`#/validators/${info.validator.id}`}>{info.validator.name ?? `#${info.validator.id}`}</a></b></li>
        <li><span>Blocks proposed · window</span><b>{fmt(info.window.blocks_proposed)}</b></li>
      </ul>}
      <p className="txe-funds-note">Balance and nonce are live from the RPC. Activity counts cover the {retainHours} h indexed window only and stop at {info ? fmt(info.window.count_cap) : "the cap"} (shown as “N+”).</p>
    </>}
  </section>;
}

function TransfersTable({ transfers, address, failed, retainHours, onInspect }: { transfers: Transfer[] | null; address: string; failed: boolean; retainHours: number; onInspect: (hash: string) => void }) {
  return <>
    <div className="txe-sample-note txe-transfers-note"><span>Latest token transfers involving this address (or of this token) in the {retainHours} h indexed window · up to 25.</span></div>
    <div className="txe-table-scroll" tabIndex={0} role="region" aria-label="Token transfers">
      <table className="txe-table txe-transfer-table">
        <thead><tr><th>Tx hash</th><th>Block</th><th>Age</th><th>Token</th><th>From</th><th><span className="txe-visually-hidden">Direction</span></th><th>To</th><th>Amount</th></tr></thead>
        <tbody>
          {transfers === null ? (failed ? <tr><td className="txe-empty" colSpan={8}>Token transfers are temporarily unavailable.</td></tr> : Array.from({ length: 5 }, (_, i) => <tr key={i}><td colSpan={8}><Skeleton h={22} w={`${95 - i * 4}%`} /></td></tr>))
            : transfers.map((t, i) => <tr key={`${t.tx_hash}-${t.log_index ?? t.logIndex ?? i}`} onClick={() => t.tx_hash && onInspect(t.tx_hash)}>
              <td>{t.tx_hash ? <button className="txe-hash" type="button" onClick={(event) => { event.stopPropagation(); onInspect(t.tx_hash!); }}>{middle(t.tx_hash, 8, 4)}</button> : "—"}</td>
              <td>{t.block_number != null ? <a className="txe-address-link" href={`#/blocks/${t.block_number}`} onClick={(event) => event.stopPropagation()}>{fmt(t.block_number)}</a> : "—"}</td>
              <td>{t.time ? <Timestamp value={t.time} /> : "—"}</td>
              <td><TokenLabel t={t} /></td>
              <td><AddressLink value={t.from} current={address} /></td>
              <td>{t.from === address || t.to === address ? <DirectionChip dir={direction(t.from, t.to, address)} /> : <span className="txe-direction token">Token</span>}</td>
              <td><AddressLink value={t.to} current={address} /></td>
              <td><Amount t={t} /></td>
            </tr>)}
          {transfers !== null && !transfers.length && <tr><td className="txe-empty" colSpan={8}>No ERC-20 or ERC-721 transfers for this address in the indexed window.</td></tr>}
        </tbody>
      </table>
    </div>
  </>;
}

const TX_TYPES: Record<number, string> = { 0: "Legacy", 1: "EIP-2930", 2: "EIP-1559", 3: "EIP-4844", 4: "EIP-7702" };
type DetailTab = "overview" | "transfers" | "calls" | "internal" | "state" | "input" | "logs" | "raw";

function TxDetailPanel({ hash, finalized, copied, onCopy, onClose }: { hash: string; finalized: number | null; copied: string | null; onCopy: (v: string) => void; onClose: () => void }) {
  const [detail, setDetail] = useState<TxDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [tab, setTab] = useState<DetailTab>("overview");
  const [fullInput, setFullInput] = useState(false);
  const trace = useTxTrace(hash);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    void getTransaction(hash).then((result) => { if (!cancelled) setDetail(result); }).catch((e) => { if (!cancelled) setError(e instanceof ApiError && e.status === 404 ? "Transaction not found on the Monad RPC." : "This transaction could not be loaded."); });
    return () => { cancelled = true; };
  }, [hash, retry]);
  const tx = detail?.tx;
  const isFinal = tx?.block_number != null && finalized !== null ? tx.block_number <= finalized : null;
  const selector = tx && tx.input.length >= 10 ? tx.input.slice(0, 10) : null;
  const inputBytes = tx ? Math.max(0, (tx.input.length - 2) / 2) : 0;
  const methodName = tx ? methodLabel(selector, inputBytes, tx.to) : "—";
  const status = !tx ? null : tx.pending ? <Chip tone="warn">Pending</Chip> : tx.status === 1 ? <Chip tone="ok">Success</Chip> : tx.status === 0 ? <Chip tone="bad">Failed</Chip> : <Chip tone="muted">Unknown</Chip>;
  const systemCall = tx?.to === STAKING_PRECOMPILE && tx.fee === "0";
  const t = trace.trace;
  const tabs: [DetailTab, string][] = detail ? [["overview", "Overview"], ["transfers", `Token transfers (${detail.transfers.length})`], ["calls", t ? `Call tree (${fmt(t.call_count + 1)})` : "Call tree"], ["internal", t ? `Internal (${t.internal.length})` : "Internal"], ["state", t ? `State (${t.state.length})` : "State"], ["input", "Input data"], ["logs", `Logs (${detail.logs.length})`], ["raw", "Raw JSON"]] : [];
  const INPUT_PREVIEW = 642;
  return <>
    <aside className="txe-card txe-inspector" aria-label="Transaction inspector">
      <header><div><h2><Glyph name="transactions" />Transaction</h2><div className="txe-selected-hash"><strong title={hash}>{middle(hash, 10, 8)}</strong><CopyButton value={hash} copied={copied === hash} onCopy={onCopy} size={26} /></div></div><button type="button" className="txe-close" onClick={onClose} aria-label="Close transaction">×</button></header>
      {error ? <div className="txe-empty" role="status">{error}<button type="button" onClick={() => setRetry((value) => value + 1)}>Retry</button></div> : !detail || !tx ? <div className="txe-detail-loading"><Skeleton h={25} w="70%" /><Skeleton h={150} w="100%" /></div> : <>
        <div className="txe-detail-meta"><span title={tx.time ?? undefined}>{tx.time ? <Timestamp value={tx.time} /> : "Time unavailable"}</span>{tx.block_number !== null && <a href={`#/blocks/${tx.block_number}`}>Block #{fmt(tx.block_number)}</a>}{status}{isFinal !== null && <span className={isFinal ? "txe-final" : "txe-warning"}>{isFinal ? `Finalized · ${fmt(tx.confirmations)} confirmations` : "Not yet finalized"}</span>}</div>
        <div className="txe-detail-tabs" role="tablist" aria-label="Transaction details">{tabs.map(([value, text]) => <button key={value} id={`txe-tab-${value}`} type="button" role="tab" aria-selected={tab === value} aria-controls="txe-detail-content" onClick={() => setTab(value)}>{text}</button>)}</div>
        <div className="txe-detail-content" id="txe-detail-content" role="tabpanel" aria-labelledby={`txe-tab-${tab}`}>
          {tab === "overview" && <>
            <dl className="txe-facts">
              <Fact label="Status">{status}</Fact>
              <Fact label="Block">{tx.block_number !== null ? <a className="txe-address-link" href={`#/blocks/${tx.block_number}`}>#{fmt(tx.block_number)}</a> : "Pending"}{tx.confirmations !== null && <span className="txe-muted-inline">· {fmt(tx.confirmations)} conf.</span>}</Fact>
              <Fact label="Time (UTC)">{tx.time ? new Date(tx.time).toISOString().replace("T", " ").replace(".000Z", "") : "—"}</Fact>
              <Fact label="Method"><span className="txe-type"><Glyph name={kindGlyph({ to: tx.to, method: selector, input_size: inputBytes })} />{methodName}</span>{selector && selector !== methodName && <code className="txe-selector">{selector}</code>}</Fact>
              <Fact label="From"><AddressLink value={tx.from} head={10} tail={6} /><CopyButton value={tx.from} copied={copied === tx.from} onCopy={onCopy} size={24} /></Fact>
              <Fact label={tx.to ? "To" : "Contract created"}>{tx.to ? <><AddressLink value={tx.to} head={10} tail={6} /><CopyButton value={tx.to} copied={copied === tx.to} onCopy={onCopy} size={24} /></> : tx.contract_address ? <><AddressLink value={tx.contract_address} head={10} tail={6} /><CopyButton value={tx.contract_address} copied={copied === tx.contract_address} onCopy={onCopy} size={24} /></> : "—"}</Fact>
              <Fact label="Value">{`${formatUnits(tx.value, 18, 18)} MON`}</Fact>
              <Fact label="Fee">{tx.fee === null ? "—" : mon(tx.fee, 9)}</Fact>
              <Fact label="Gas price">{gwei(tx.effective_gas_price ?? tx.gas_price, 4)}</Fact>
              <Fact label="Gas limit · used">{fmt(tx.gas_limit)} · {fmt(tx.gas_used)}</Fact>
              <Fact label="Max fee · priority fee">{tx.max_fee_per_gas ? `${gwei(tx.max_fee_per_gas)} · ${gwei(tx.max_priority_fee_per_gas)}` : "— (not EIP-1559)"}</Fact>
              <Fact label="Type · nonce · position">{TX_TYPES[tx.type] ?? `Type ${tx.type}`} · {fmt(tx.nonce)} · {tx.tx_index === null ? "—" : `#${tx.tx_index}`}</Fact>
            </dl>
            {systemCall && <div className="txe-privacy-note"><Glyph name="staking" /><div><strong>Staking system call</strong><p>The first transaction of every Monad block is a zero-gas system call to the staking precompile ({middle(STAKING_PRECOMPILE, 6, 4)}).</p></div></div>}
            <div className="txe-privacy-note public"><Glyph name="fee" /><div><strong>Gas is charged on the gas limit</strong><p>Monad charges for the full gas limit, so the receipt reports gas used equal to the gas limit and the fee is gas limit × gas price.</p></div></div>
            <GasAnalysis state={trace} />
            {detail.transfers.length > 0 && <section className="txe-message"><h3>Token transfers</h3><TransferList transfers={detail.transfers} /></section>}
          </>}
          {tab === "calls" && <CallTree state={trace} />}
          {tab === "internal" && <InternalTransfers state={trace} />}
          {tab === "state" && <StateChanges state={trace} />}
          {tab === "transfers" && (detail.transfers.length ? <TransferList transfers={detail.transfers} /> : <p className="txe-muted">No ERC-20 or ERC-721 Transfer events were emitted by this transaction.</p>)}
          {tab === "input" && <section className="txe-message"><h3>Input data</h3>
            <dl className="txe-fields"><div><dt>Selector</dt><dd><code>{selector ?? "— (no calldata)"}</code></dd></div><div><dt>Method label</dt><dd><code>{methodName}</code></dd></div><div><dt>Size</dt><dd><code>{fmt(inputBytes)} bytes</code></dd></div></dl>
            {inputBytes > 0 && <><div className="txe-input-actions"><button type="button" onClick={() => setFullInput(!fullInput)} disabled={tx.input.length <= INPUT_PREVIEW}>{fullInput || tx.input.length <= INPUT_PREVIEW ? "Hide" : "Show all"}</button><button type="button" onClick={() => onCopy(tx.input)}>{copied === tx.input ? "Copied ✓" : "Copy input"}</button></div>
              <pre className="txe-input">{fullInput || tx.input.length <= INPUT_PREVIEW ? tx.input : `${tx.input.slice(0, INPUT_PREVIEW)}…`}</pre></>}
            <p className="txe-muted">Method labels come from well-known 4-byte selectors and can collide; calldata is not decoded.</p>
          </section>}
          {tab === "logs" && (detail.logs.length ? detail.logs.map((log) => <section className="txe-message" key={log.log_index}><h3>Log #{log.log_index}</h3><div className="txe-event-attribute"><span>Address</span><code><AddressLink value={log.address} head={10} tail={6} /></code></div>{log.topics.map((topic, i) => <div className="txe-event-attribute" key={i}><span>Topic {i}</span><code>{topic}</code></div>)}<div className="txe-event-attribute"><span>Data</span><code>{log.data === "0x" ? "0x (empty)" : log.data}</code></div></section>) : <p className="txe-muted">No logs emitted.</p>)}
          {tab === "raw" && <><p className="txe-muted">Explorer API response, read from the Monad RPC.</p><pre className="txe-json">{JSON.stringify(detail, null, 2)}</pre></>}
        </div>
      </>}
    </aside>
    {tx && <section className="txe-card txe-related"><h3>Related</h3>{tx.block_number !== null && <a href={`#/blocks/${tx.block_number}`}><Glyph name="block" /><span>View block #{fmt(tx.block_number)}</span><span>→</span></a>}<a href={addressRoute(tx.from)}><Glyph name="transfer" /><span>Sender history</span><span>→</span></a><button type="button" onClick={() => onCopy(`${location.origin}${location.pathname}${txRoute(hash)}`)}><Glyph name="link" /><span>{copied?.endsWith(txRoute(hash)) ? "Link copied" : "Copy transaction link"}</span><span>↗</span></button></section>}
  </>;
}
function TransferList({ transfers }: { transfers: Transfer[] }) {
  return <div className="txe-table-scroll"><table className="txe-mini-table"><thead><tr><th>Token</th><th>From</th><th>To</th><th>Amount</th></tr></thead><tbody>{transfers.map((t, i) => <tr key={`${t.log_index ?? t.logIndex ?? i}`}><td><TokenLabel t={t} /></td><td><AddressLink value={t.from} /></td><td><AddressLink value={t.to} /></td><td><Amount t={t} /></td></tr>)}</tbody></table></div>;
}
function Fact({ label, children }: { label: string; children: React.ReactNode }) { return <div><dt>{label}</dt><dd>{children}</dd></div>; }
function Glyph({ name }: { name: string }) {
  const paths: Record<string, string> = {
    transactions: "M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4", success: "m5 12 4 4L19 6", failed: "m6 6 12 12M6 18 18 6", fee: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M15 8h-4a2 2 0 0 0 0 4h2a2 2 0 0 1 0 4H9m3-10v12", search: "M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15M16 16l5 5", contract: "M7 3h10v18H7zM10 7h4M10 11h4M10 15h4", transfer: "M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4", staking: "m12 3 9 5-9 5-9-5 9-5M3 12l9 5 9-5M3 16l9 5 9-5", create: "M12 5v14M5 12h14", block: "m12 3 9 5v9l-9 5-9-5V8l9-5M3 8l9 5 9-5M12 13v9", link: "m10 14 4-4M8 16l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M16 8l1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0",
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] ?? paths.transactions} /></svg>;
}
