import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Dashboard } from "../useDashboard";
import { getTransactions } from "../api";
import { STAKING_PRECOMPILE } from "../lib";
import { API_BASE, API_CATEGORIES, API_ENDPOINTS, apiCurl, apiPreview, apiRequestPath, filterApiEndpoints, type ApiEndpoint } from "../apiReference";
import "./api-reference.css";

function Icon({ type = "code" }: { type?: string }) {
  const paths: Record<string, ReactNode> = {
    code: <path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-14-2 18" />,
    layers: <><path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5" /></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3" /></>,
    file: <><path d="M14 3H6v18h12V7l-4-4Zm0 0v5h4M9 12h6m-6 4h6" /></>,
    pulse: <path d="M2 12h5l3-8 4 16 3-8h5" />,
    search: <><circle cx="10" cy="10" r="6" /><path d="m15 15 6 6" /></>,
  };
  return <svg className="are-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[type] ?? paths.code}</svg>;
}
function CopyButton({ value, label = "Copy", className = "" }: { value: string; label?: string; className?: string }) {
  const [message, setMessage] = useState("");
  useEffect(() => { if (!message) return; const t = setTimeout(() => setMessage(""), 2200); return () => clearTimeout(t); }, [message]);
  return <button type="button" className={`are-copy ${className}`} onClick={async () => { try { await navigator.clipboard.writeText(value); setMessage("Copied"); } catch { setMessage("Copy failed"); } }} aria-label={message || label}><span aria-hidden="true">▢</span> <span aria-live="polite">{message || label}</span></button>;
}
function JsonCode({ text }: { text: string }) {
  return <pre className="are-json"><code>{text.split(/("(?:\\.|[^"\\])*"\s*:|"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|\b-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)/g).map((part, i) => <span key={i} className={/^".*:\s*$/.test(part) ? "key" : part.startsWith('"') ? "string" : /^(true|false|null)$/.test(part) ? "literal" : /^-?\d/.test(part) ? "number" : undefined}>{part}</span>)}</code></pre>;
}
type Sample = { text: string; status: number; ok: boolean; ms: number; at: Date; path: string };
/** An event stream never ends: show its first couple of events, then hang up. */
async function firstEvents(response: Response, abort: AbortController, want = 2, maxMs = 6000): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + maxMs;
  try {
    while (Date.now() < deadline && (text.match(/^event:/gm)?.length ?? 0) < want) {
      const { value, done } = await Promise.race([reader.read(), new Promise<{ value?: undefined; done: true }>((r) => setTimeout(() => r({ done: true }), Math.max(0, deadline - Date.now())))]);
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    abort.abort();
  }
  return `${text.trim()}\n\n… stream continues (preview closed after ${want} events)`;
}
type Samples = Record<string, string | undefined>;
/** Real values from this deployment so every example request resolves. */
const sampleFor = (e: ApiEndpoint, name: string, samples: Samples) => samples[`${e.id}.${name}`] ?? samples[name];
function EndpointCard({ endpoint: e, origin, samples }: { endpoint: ApiEndpoint; origin: string; samples: Samples }) {
  const [expanded, setExpanded] = useState(false);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries((e.parameters ?? []).map(p => [p.name, p.default || (p.location === "path" || p.required ? sampleFor(e, p.name, samples) ?? "" : "")])));
  const [sample, setSample] = useState<Sample | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null), generation = useRef(0), initialized = useRef(false);
  const request = apiRequestPath(e, values);
  const body = sample?.text;
  async function run(params: Record<string, string>, open = false) {
    if (open) setExpanded(true);
    const compiled = apiRequestPath(e, params);
    if (!compiled.path) { setError(compiled.error ?? "Invalid request."); return; }
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    const id = ++generation.current;
    setBusy(true); setError("");
    const start = performance.now();
    const timer = setTimeout(() => abort.abort(), 20000);
    try {
      const response = await fetch(compiled.path, { headers: { Accept: "application/json" }, signal: abort.signal });
      const type = (response.headers.get("content-type") ?? "").split(";")[0].trim();
      let text: string;
      if (type === "text/event-stream") text = await firstEvents(response, abort);
      else if (type.startsWith("image/")) text = `<${type} image · ${(await response.arrayBuffer()).byteLength.toLocaleString("en-US")} bytes>`;
      else {
        const raw = await response.text();
        text = raw;
        try { text = JSON.stringify(JSON.parse(raw), null, 2); } catch { /* Preserve non-JSON error responses. */ }
      }
      if (id !== generation.current) return;
      setSample({ text, status: response.status, ok: response.ok, ms: Math.round(performance.now() - start), at: new Date(), path: compiled.path });
    } catch (err) {
      if (id === generation.current) setError(abort.signal.aborted ? "Request timed out. Try again." : err instanceof Error ? err.message : "Request failed.");
    } finally { clearTimeout(timer); if (id === generation.current) setBusy(false); }
  }
  const sampleKey = (e.parameters ?? []).map(p => sampleFor(e, p.name, samples) ?? "").join("|");
  useEffect(() => {
    if (initialized.current) return;
    const initial = { ...values };
    for (const p of e.parameters ?? []) if (!initial[p.name] && (p.location === "path" || p.required)) initial[p.name] = sampleFor(e, p.name, samples) ?? "";
    if (apiRequestPath(e, initial).error) return;
    initialized.current = true; setValues(initial); void run(initial);
  }, [sampleKey]);
  useEffect(() => () => { generation.current++; controller.current?.abort(); initialized.current = false; }, []);
  return <article className={`are-endpoint ${expanded ? "expanded" : ""}`} id={`api-${e.id}`}>
    <div className="are-endpoint-summary">
      <div className="are-endpoint-description"><div className="are-route"><span className={`are-method ${e.method.toLowerCase()}`}>{e.method}</span><h3>{e.path}</h3></div><p>{e.description}</p><p className="are-returns"><strong>Returns</strong> {e.response}</p><div className="are-tags">{e.tags.map(tag => <span key={tag}>{tag}</span>)}</div></div>
      <div className="are-response-preview"><div className="are-response-toolbar"><span>{sample ? "Live response" : "Response preview"}{sample && <b className={sample.ok ? "ok" : "warn"}>{sample.status}</b>}</span><div>{body !== undefined && <CopyButton value={body} label="Copy JSON" />}{<button type="button" className="are-try" disabled={busy} onClick={() => void run(values, true)}>{busy ? "Loading…" : "▷ Try request"}</button>}<button type="button" className="are-expand" aria-expanded={expanded} aria-controls={`api-detail-${e.id}`} aria-label={`${expanded ? "Collapse" : "Expand"} ${e.title}`} onClick={() => setExpanded(!expanded)}>{expanded ? "⌃" : "⌄"}</button></div></div>
        {error ? <p className="are-error" role="alert">{error}</p> : body !== undefined ? <JsonCode text={apiPreview(body)} /> : <div className="are-preview-empty"><Icon type="code" /><span>{busy ? "Fetching a live response…" : "Enter the required parameter to load a live response."}</span></div>}
        {sample && <div className="are-sample-meta">{sample.ms} ms · {sample.at.toLocaleTimeString("en-GB", { timeZone: "UTC" })} UTC · response snapshot</div>}
      </div>
    </div>
    {expanded && <div className="are-detail" id={`api-detail-${e.id}`}>
      <div className="are-request"><h4>Request parameters</h4>{<form onSubmit={event => { event.preventDefault(); void run(values); }}>
        {e.parameters?.length ? e.parameters.map(p => <label key={p.name} className="are-parameter"><span><strong>{p.name}</strong><em>{p.location}{p.location === "path" || p.required ? " · required" : " · optional"}</em></span>{p.choices ? <select value={values[p.name] ?? ""} onChange={event => setValues(v => ({ ...v, [p.name]: event.target.value }))}>{p.choices.map(choice => <option key={choice}>{choice}</option>)}</select> : <input autoComplete="off" spellCheck={false} inputMode={p.min !== undefined ? "numeric" : "text"} value={values[p.name] ?? ""} placeholder={p.name === "hash" ? "Paste a transaction hash" : p.name === "addr" || p.name === "address" ? "0x… address" : p.name} onChange={event => setValues(v => ({ ...v, [p.name]: event.target.value }))} />}<small>{p.description}</small></label>) : <p>This endpoint takes no parameters.</p>}
        <button type="submit" className="are-primary" disabled={busy}>{busy ? "Sending request…" : "Send GET request →"}</button>
      </form>}
      {<div className="are-curl"><div><h4>cURL</h4>{request.path && <CopyButton value={apiCurl(origin, request.path)} label="Copy cURL" />}</div>{request.path ? <pre><code>{apiCurl(origin, request.path)}</code></pre> : <p>Complete valid parameters to generate a cURL command.</p>}</div>}
      </div>
      <div className="are-full-response"><div className="are-full-heading"><h4>Response</h4>{sample && <span className={sample.ok ? "ok" : "warn"}>HTTP {sample.status} · {sample.ms} ms</span>}</div>{sample && <p className="are-executed">GET {sample.path}</p>}{body !== undefined ? <><JsonCode text={body.slice(0, 100000)} />{body.length > 100000 && <p className="are-truncated">Display limited to 100,000 characters. Copy JSON includes the full response.</p>}</> : <p>Send a request to inspect its response here.</p>}</div>
    </div>}
  </article>;
}
export function ApiDocs({ d }: { d: Dashboard }) {
  const [category, setCategory] = useState("Overview"), [search, setSearch] = useState("");
  const [txHash, setTxHash] = useState<string | undefined>();
  const origin = window.location.origin;
  const endpoints = filterApiEndpoints(category, search);
  useEffect(() => { let stopped = false; getTransactions(1).then(r => { if (!stopped) setTxHash(r.txs[0]?.hash); }).catch(() => undefined); return () => { stopped = true; }; }, []);
  const head = d.net?.indexed_head ?? undefined;
  const validator = d.validators?.validators.find(v => v.logo) ?? d.validators?.validators[0];
  const samples: Samples = { "block.id": head === undefined ? undefined : String(head), "block-parallelism.n": head === undefined ? undefined : String(head - 5), "validator.id": validator ? String(validator.id) : undefined, "logo.id": validator ? String(validator.id) : undefined, hash: txHash, addr: STAKING_PRECOMPILE, q: head === undefined ? undefined : String(head) };
  return <div className="are-page">
    <section className="are-intro"><div className="are-intro-copy"><span className="are-emblem"><Icon type="layers" /></span><div><h2>Access indexed Monad mainnet data.</h2><p>REST API for finalized blocks, transactions, addresses, validators, staking, MonadBFT finality, parallel execution and gas analytics on Monad (chain {d.config?.chain.chain_id ?? 143}). Same-origin, read-only JSON.</p></div></div><div className="are-base"><span>Base URL</span><div><code>{origin}{API_BASE}</code><CopyButton value={origin + API_BASE} label="Copy" className="are-primary" /></div></div></section>
    <nav className="are-tabs" aria-label="API categories">{API_CATEGORIES.map((tab, i) => <button key={tab} type="button" className={category === tab && !search ? "active" : ""} aria-pressed={category === tab && !search} onClick={() => { setCategory(tab); setSearch(""); }}><span aria-hidden="true">{["⌂", "◎", "▤", "⇄", "◇", "♧", "$", "⟳", "∥", "▥", "⚙"][i]}</span>{tab}</button>)}</nav>
    <section className="are-features" aria-label="API usage"><div><Icon type="lock" /><span><strong>No authentication</strong><small>Every endpoint is a public GET; responses are never cached (no-store).</small></span></div><div><Icon type="file" /><span><strong>JSON, wei strings</strong><small>Amounts, fees and stake are decimal wei strings (1 MON = 10^18 wei). Times are ISO 8601 UTC.</small></span></div><div><Icon type="pulse" /><span><strong>Rolling {d.config?.indexer.retain_hours ?? 72} h window</strong><small>Only finalized blocks are indexed. Older blocks and transactions are read through from RPC and marked source: "rpc".</small></span></div></section>
    <section className="are-catalog" aria-label="Endpoint reference"><div className="are-catalog-heading"><div><h2>Endpoints <span>{endpoints.length}</span></h2><p>{search ? "Search results across all categories." : "Expand an endpoint for parameters, cURL, and a live response from this deployment."}</p></div><label className="are-search"><Icon type="search" /><input aria-label="Search API endpoints" placeholder="Search endpoints…" value={search} onChange={e => setSearch(e.target.value)} />{search && <button type="button" aria-label="Clear endpoint search" onClick={() => setSearch("")}>×</button>}</label></div>
      <div className="are-endpoints">{endpoints.map(endpoint => <EndpointCard key={endpoint.id} endpoint={endpoint} origin={origin} samples={samples} />)}{!endpoints.length && <div className="are-empty"><Icon type="search" /><h3>No matching endpoints</h3><p>Try a route, category, or keyword such as validators.</p><button type="button" className="are-try" onClick={() => setSearch("")}>Clear search</button></div>}</div>
    </section>
    <footer className="are-footer"><span>{API_ENDPOINTS.length} documented read endpoints · API v1 · samples are live snapshots</span><a href="#/rpc">Need raw chain data? Open the JSON-RPC console →</a></footer>
  </div>;
}
