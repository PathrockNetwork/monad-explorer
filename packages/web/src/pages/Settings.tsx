/** Deployment information and browser-local display preferences. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Dashboard } from "../useDashboard";
import type { Theme } from "../App";
import { get, type Endpoint } from "../api";
import { probeNode, type NodeProbe } from "../nodeRpc";
import { fmt, monCompact } from "../lib";
import { useAppearance, updateAppearance, type Appearance } from "../appearance";
import { Timestamp } from "../components/Timestamp";
import { consoleLink, host, isPublicRpc, PUBLIC_RATE_LIMIT } from "../networkExplorer";
import "./settings.css";

function Icon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    chain: "m9 15 6-6m-7 3-3 3a3 3 0 0 0 4 4l3-3m0-8 3-3a3 3 0 0 1 4 4l-3 3",
    server: "M4 4h16v6H4zM4 14h16v6H4zM7 7h.01M7 17h.01m4-10h6m-6 10h6",
    cube: "m12 3 9 5v9l-9 5-9-5V8l9-5Zm0 9 9-4M12 12 3 8m9 4v10M8 5l9 5",
    lock: "M6 10h12v11H6zM8 10V7a4 4 0 0 1 8 0v3m-4 4v3",
    gear: "m10 3 4 0 1 3 3 1 3 3v4l-3 1-1 3-3 3h-4l-1-3-3-1-3-3v-4l3-1 1-3 3-3Zm2 5a4 4 0 1 0 0 8 4 4 0 0 0 0-8",
    monitor: "M3 4h18v13H3zM8 21h8m-4-4v4",
    governance: "m3 8 9-5 9 5H3Zm2 3v7m5-7v7m4-7v7m5-7v7M3 21h18",
    shield: "m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Zm-4 9 3 3 5-6",
    coins: "M5 7c0-5 14-5 14 0s-14 5-14 0Zm0 0v5c0 5 14 5 14 0V7M5 12v5c0 5 14 5 14 0v-5",
    archive: "M4 4h16v4H4zM5 8v13h14V8m-10 5h6",
    wifi: "M3 8a14 14 0 0 1 18 0M6 12a9 9 0 0 1 12 0m-9 4a4 4 0 0 1 6 0m-3 4h.01",
    clock: "M12 8v5l3 2m6-3a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
    code: "m8 7-5 5 5 5m8-10 5 5-5 5m-3-14-2 18",
    sun: "M12 2v2m0 16v2M2 12h2m16 0h2M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2m-7 1a4 4 0 1 0 0 8 4 4 0 0 0 0-8",
    density: "M4 5h16M4 12h16M4 19h16M8 3v4m8 3v4m-8 3v4",
    motion: "m3 3 18 18M9 5l3-2 8 9-3 2M6 8l-4 4 10 9 3-5M10 10l4 4",
    file: "M14 3H5v18h14V8l-5-5Zm0 0v5h5M8 12h8m-8 4h8",
    copy: "M8 8h12v13H8zM16 8V3H3v13h5",
    info: "M12 11v6m0-10h.01m9 5a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
    check: "m5 12 4 4L20 5",
    chart: "M4 20V10m6 10V4m6 16v-7m4 7H2",
  };
  return <svg className="ste-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] ?? paths.info} /></svg>;
}
function Badge({ children, tone = "muted" }: { children: ReactNode; tone?: string }) { return <span className={`ste-badge ${tone}`}>{children}</span>; }
function Panel({ name, title, description, aside, children }: { name: string; title: string; description: string; aside?: ReactNode; children: ReactNode }) {
  return <section className={`ste-panel ste-${name}`}><header className="ste-heading"><span className="ste-heading-icon"><Icon name={name} /></span><div><h2>{title}</h2><p>{description}</p></div>{aside}</header>{children}</section>;
}
function Copy({ value, label = "Copy value", iconOnly = false }: { value: string; label?: string; iconOnly?: boolean }) {
  const [message, setMessage] = useState("");
  useEffect(() => { if (!message) return; const timer = setTimeout(() => setMessage(""), 2400); return () => clearTimeout(timer); }, [message]);
  return <button type="button" className={`ste-copy ${iconOnly ? "icon-only" : ""}`} title={message || label} aria-label={message || label} onClick={async () => { try { await navigator.clipboard.writeText(value); setMessage("Copied"); } catch { setMessage("Copy failed"); } }}><Icon name="copy" />{!iconOnly && <span>{message || label}</span>}{iconOnly && <span className="ste-sr" role="status">{message}</span>}</button>;
}
function Segments<T extends string | number>({ label, options, value, onChange }: { label: string; options: { value: T; label: string }[]; value: T; onChange: (value: T) => void }) {
  return <div className="ste-segments" role="group" aria-label={label}>{options.map(option => <button type="button" key={option.value} className={option.value === value ? "selected" : ""} aria-pressed={option.value === value} onClick={() => onChange(option.value)}>{option.label}</button>)}</div>;
}
function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <button type="button" className="ste-toggle" role="switch" aria-label={label} aria-checked={checked} onClick={() => onChange(!checked)}><span /></button>;
}
function Preference({ icon, title, description, children }: { icon: string; title: string; description: string; children: ReactNode }) {
  return <div className="ste-preference"><Icon name={icon} /><div><strong>{title}</strong><small>{description}</small></div>{children}</div>;
}

export function Settings({ d, theme, onTheme }: { d: Dashboard; theme: Theme; onTheme: (theme: Theme) => void }) {
  const appearance = useAppearance();
  const cfg = d.config;
  const [probes, setProbes] = useState<Record<string, NodeProbe | "loading">>({});
  const [deployed, setDeployed] = useState<string | null>(null), [versionError, setVersionError] = useState(false);
  const mounted = useRef(true), probing = useRef(new Set<string>());
  useEffect(() => { mounted.current = true; let stopped = false;
    get<{ web: string | null }>("/api/v1/version").then(v => { if (!stopped) setDeployed(v.web); }).catch(() => { if (!stopped) setVersionError(true); });
    return () => { stopped = true; mounted.current = false; };
  }, []);
  const endpoints = [...(d.endpoints?.endpoints ?? [])].sort((a, b) => a.priority - b.priority);
  const configured = endpoints.length ? endpoints.map(e => e.url) : cfg?.rpc_endpoints ?? [];
  const running = document.querySelector('script[src*="assets/index-"]')?.getAttribute("src")?.match(/index-([^.]+)\.js/)?.[1] ?? null;
  const deployedBuild = deployed?.match(/index-([^.]+)\.js/)?.[1] ?? null;
  const runProbe = async (endpoint: Endpoint) => {
    if (probing.current.has(endpoint.url)) return;
    probing.current.add(endpoint.url); setProbes(previous => ({ ...previous, [endpoint.url]: "loading" }));
    try { const result = await probeNode(endpoint.url); if (mounted.current) setProbes(previous => ({ ...previous, [endpoint.url]: result })); }
    finally { probing.current.delete(endpoint.url); }
  };
  const facts: [string, string | null][] = cfg ? [
    ["Name", `${cfg.chain.name} ${cfg.chain.network}`], ["Chain ID", String(cfg.chain.chain_id)],
    ["Currency", `${cfg.chain.currency.symbol} (${cfg.chain.currency.decimals} decimals)`],
    ["Indexed head", cfg.indexer.head],
    ["Current epoch", d.net?.epoch == null ? null : `${fmt(d.net.epoch)}${d.net.epoch_delay_period ? " · delay period" : ""}`],
    ["Active validators", d.net ? `${fmt(d.net.validators_active)} of ${fmt(d.net.validators_total)}` : null],
    ["Total stake", d.net ? monCompact(d.net.total_stake) : null],
    ["Validator registry", cfg.validator_registry],
  ] : [];
  const firstBlock = d.net?.earliest_indexed ?? null;
  const capabilityCards = cfg ? [
    { name: "Finalized only", icon: "shield", status: "Enabled", tone: "ok", note: "Blocks are indexed once finalized; nothing is reorged out." },
    { name: "Retention window", icon: "clock", status: `${cfg.indexer.retain_hours} hours`, tone: "ok", note: "Rolling window kept in the database." },
    { name: "Indexed history", icon: "archive", status: firstBlock ? `From ${fmt(firstBlock)}` : "Unknown", tone: firstBlock ? "ok" : "muted", note: d.net ? `${fmt(d.net.blocks_indexed)} blocks currently indexed.` : "No indexed starting height reported." },
    { name: "RPC read-through", icon: "server", status: "Enabled", tone: "ok", note: "Older blocks and transactions are fetched from RPC on demand." },
    { name: "Analytics horizons", icon: "chart", status: cfg.metric_hours.map(h => `${h}h`).join(" · ") || "—", tone: cfg.metric_hours.length ? "ok" : "muted", note: "Ranges served by /api/v1/metrics." },
    { name: "Validator metadata", icon: "governance", status: "Registry", tone: "ok", note: "Names and logos from monad-developers/validator-info." },
    ...(cfg.features ? [
      { name: "Execution traces", icon: "code", status: cfg.features.trace_every <= 0 ? "Off" : cfg.features.trace_every === 1 ? "Every block" : `Every ${fmt(cfg.features.trace_every)}th block`, tone: cfg.features.trace_every === 1 ? "ok" : cfg.features.trace_every > 0 ? "warn" : "muted", note: "Internal transfers and the parallelism graph. Any single block or transaction is still traced on demand." },
      { name: "Gas replay", icon: "coins", status: cfg.features.gas_replay ? (cfg.features.trace_every === 1 ? "Every transaction" : "Sampled") : "Off", tone: cfg.features.gas_replay ? (cfg.features.trace_every === 1 ? "ok" : "warn") : "muted", note: "eth_estimateGas on traced blocks: what senders paid for and never used." },
      { name: "Staking history", icon: "archive", status: cfg.features.staking_history ? `${fmt(cfg.features.staking_logs_range)} blocks / call` : "Live only", tone: cfg.features.staking_history ? (cfg.features.staking_logs_range > 100 ? "ok" : "warn") : "muted", note: "Delegation events are kept forever; older ones are crawled backwards over eth_getLogs." },
      { name: "Finality stream", icon: "wifi", status: cfg.features.pipeline ? "Live" : "Off", tone: cfg.features.pipeline ? "ok" : "muted", note: "Proposed → Voted → Finalized → Verified for every block, over monadNewHeads." },
      { name: "Full history", icon: "file", status: cfg.features.full_history ? "Enabled" : "Rolling window", tone: cfg.features.full_history ? "ok" : "muted", note: cfg.features.full_history ? "Nothing is pruned." : "Needs a private RPC and RETAIN_HOURS=0." },
    ] : []),
  ] : [];
  const indexer: { title: string; value: string; note: string; icon: string; extra?: ReactNode }[] = cfg ? [
    { title: "Head tag", value: cfg.indexer.head, note: "Block tag the indexer follows.", icon: "shield" },
    { title: "Retention", value: `${fmt(cfg.indexer.retain_hours)} hours`, note: "Older rows are pruned; analytics ranges stay inside it.", icon: "clock" },
    { title: "Backfill depth", value: `${fmt(cfg.indexer.backfill_depth)} blocks`, note: "Blocks backfilled behind the head on start.", icon: "archive" },
    { title: "Database engine", value: cfg.indexer.database, note: "Storage for indexed chain data.", icon: "coins" },
    { title: "Explorer build", value: running ?? "Development", note: "The bundle running in this browser.", icon: "cube" },
    { title: "Deployed build", value: deployedBuild ?? (versionError ? "Unavailable" : "—"), note: "The bundle currently served by the API.", icon: "cube", extra: running && deployedBuild ? deployedBuild === running ? <Badge tone="ok">Current</Badge> : <button type="button" className="ste-action" onClick={() => location.reload()}>Reload</button> : undefined },
  ] : [];
  const publicConfig = cfg ? JSON.stringify(cfg, null, 2) : "";
  const pending = (text: string) => <p className="ste-empty">{d.error ?? text}</p>;
  return <div className="ste-page">
    <Panel name="chain" title="Chain Configuration" description="Core information about the indexed chain." aside={<Badge><Icon name="lock" />Read only</Badge>}>
      <dl className="ste-facts">{facts.map(([label, value]) => <div className="ste-fact" key={label}><dt>{label}</dt><dd><span className={!value ? "muted" : ""} title={value ?? undefined}>{value && /^https:\/\//.test(value) ? <a href={value} target="_blank" rel="noreferrer">{value.replace(/^https:\/\/(www\.)?/, "")}</a> : value ?? "—"}</span>{value && <Copy value={value} label={`Copy ${label}`} iconOnly />}</dd></div>)}</dl>{!cfg && pending("Loading chain configuration…")}
    </Panel>
    <Panel name="server" title="RPC Endpoints" description="Failover order for the endpoints feeding the indexer." aside={<a className="ste-action" href="#/endpoints">Network health ↗</a>}>
      <div className="ste-endpoint-scroll"><table className="ste-endpoint-table"><colgroup><col style={{ width: "4%" }} /><col style={{ width: "30%" }} /><col style={{ width: "14%" }} /><col style={{ width: "9%" }} /><col style={{ width: "17%" }} /><col style={{ width: "10%" }} /><col style={{ width: "16%" }} /></colgroup><thead><tr><th>#</th><th>Endpoint</th><th>Status</th><th title="Lower priorities are tried first">Priority</th><th>Latest height</th><th>Latency</th><th>Actions</th></tr></thead><tbody>{endpoints.map((endpoint, i) => <tr key={endpoint.url} className={endpoint.used_by_indexer ? "active" : ""}><td>{i + 1}</td><td><div className="ste-endpoint-name"><i className={endpoint.healthy ? "ok" : "bad"} /><span><strong title={endpoint.url}>{host(endpoint.url)}</strong><small title={endpoint.client ?? undefined}>{endpoint.client ?? endpoint.error ?? "—"}</small></span></div></td><td><Badge tone={endpoint.used_by_indexer ? "ok" : endpoint.healthy ? "muted" : "bad"}>{endpoint.used_by_indexer ? "Feeds indexer" : endpoint.healthy ? "Standby" : "Unhealthy"}</Badge></td><td><span className="ste-priority">{endpoint.priority}</span></td><td className="ste-number">{fmt(endpoint.height)}</td><td className={`ste-number ${endpoint.healthy ? "ok" : "muted"}`}>{endpoint.latency_ms === null ? "—" : `${endpoint.latency_ms} ms`}</td><td><div className="ste-endpoint-actions"><button type="button" className="ste-action" disabled={probes[endpoint.url] === "loading"} title="Probe the endpoint from this browser" onClick={() => void runProbe(endpoint)}>{probes[endpoint.url] === "loading" ? "Probing…" : "Probe"}</button><details className="ste-menu"><summary aria-label={`Actions for ${endpoint.url}`}>···</summary><div><a href={consoleLink(endpoint.url)}>Open RPC Console</a><Copy value={endpoint.url} label="Copy URL" /></div></details></div></td></tr>)}</tbody></table></div>
      {!endpoints.length && pending(d.endpoints ? "No RPC endpoints reported." : "Loading endpoint list…")}
      {Object.entries(probes).map(([url, probe]) => <div className="ste-probe-result" key={url} role="status"><strong>{host(url)}</strong><span className={probe !== "loading" && probe.state === "ok" ? "ok" : "warn"}>{probe === "loading" ? "Probing…" : probe.state === "ok" ? `chain ${probe.chainId ?? "—"} · latest ${fmt(probe.latest)} · finalized ${fmt(probe.finalized)} · ${probe.latencyMs} ms from this browser` : probe.error}</span></div>)}
      <div className="ste-notice"><Icon name="info" /><p>The indexer uses the highest-priority healthy endpoint and fails over automatically; endpoints cannot be pinned from the explorer. Public gateways allow about {PUBLIC_RATE_LIMIT} requests per second per IP. Query them directly in the <a href="#/rpc">RPC Console</a>.</p></div>
    </Panel>
    <Panel name="cube" title="Data Coverage" description="What this deployment indexes and serves. Amber items are sampled because of public RPC limits; a private RPC turns them green.">
      <div className="ste-capabilities">{capabilityCards.map(card => <div className={`ste-capability ${card.tone}`} key={card.name}><span className="ste-capability-icon"><Icon name={card.icon} /></span><div><strong>{card.name}</strong><b>{card.status}</b><small>{card.note}</small></div></div>)}</div>{!cfg && pending("Loading deployment configuration…")}
    </Panel>
    <Panel name="lock" title="Security / Access" description="Access and connection information.">
      <div className="ste-security-row"><Icon name="code" /><strong>API mode</strong><p>Every explorer endpoint is a public, read-only GET.</p><Badge tone="ok">Read only</Badge></div>
      <div className="ste-security-row"><Icon name="shield" /><strong>CORS</strong><p>The explorer API serves same-origin browser requests.</p><Badge tone="warn">Same origin</Badge></div>
      <div className="ste-security-row"><Icon name="wifi" /><strong>Browser RPC</strong><p>The RPC Console posts straight to the endpoint; {configured.filter(isPublicRpc).length} configured public gateways allow it.</p><Badge tone="ok">Direct</Badge></div>
      <div className="ste-security-row"><Icon name="file" /><strong>Public configuration</strong><p>The /api/v1/config response; credentials in RPC URLs are redacted.</p>{publicConfig && <Copy value={publicConfig} label="Copy JSON" />}</div>
      <pre className="ste-config-code"><code>{publicConfig || "Loading configuration…"}</code></pre>
    </Panel>
    <Panel name="gear" title="Indexer Settings" description="Configuration for the block indexer and data pipeline.">
      <div>{indexer.map(item => <div className="ste-indexer-row" key={item.title}><Icon name={item.icon} /><div><strong>{item.title}</strong><small>{item.note}</small></div><span className="ste-indexer-value"><code>{item.value}</code>{item.extra}</span></div>)}</div>{!cfg && pending("Loading indexer configuration…")}
    </Panel>
    <Panel name="monitor" title="Appearance" description="Customize how the explorer looks and feels.">
      <Preference icon="sun" title="Theme" description="Choose the interface color theme."><Segments label="Theme" value={theme} options={[{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }, { value: "system", label: "System" }]} onChange={onTheme} /></Preference>
      <Preference icon="density" title="Density" description="Adjust table and settings row spacing."><Segments<Appearance["density"]> label="Density" value={appearance.density} options={[{ value: "compact", label: "Compact" }, { value: "default", label: "Default" }, { value: "spacious", label: "Spacious" }]} onChange={density => updateAppearance({ density })} /></Preference>
      <Preference icon="clock" title="Relative times" description="Show event ages instead of full UTC dates."><Toggle label="Relative times" checked={appearance.relativeTimes} onChange={relativeTimes => updateAppearance({ relativeTimes })} /></Preference>
      <Preference icon="motion" title="Reduce motion" description="Disable animations and smooth scrolling."><Toggle label="Reduce motion" checked={appearance.reduceMotion} onChange={reduceMotion => updateAppearance({ reduceMotion })} /></Preference>
      <Preference icon="code" title="Code font size" description="Text size for code blocks and JSON responses."><Segments<Appearance["codeSize"]> label="Code font size" value={appearance.codeSize} options={[{ value: 12, label: "12px" }, { value: 14, label: "14px" }, { value: 16, label: "16px" }]} onChange={codeSize => updateAppearance({ codeSize })} /></Preference>
      <div className="ste-preview"><span>Display preview</span><code>{JSON.stringify({ chain_id: cfg?.chain.chain_id ?? null, head: d.net?.indexed_head ?? null })}</code><Timestamp value={d.net?.indexer_updated_at} /></div>
      <p className="ste-local-note">Preferences apply immediately and are remembered in this browser. Device motion preferences are also respected.</p>
    </Panel>
  </div>;
}
