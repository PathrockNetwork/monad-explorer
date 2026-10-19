import type { Endpoint } from "./api";

/** The public Monad RPC gateways; all send CORS headers allowing browser POSTs. */
export const PUBLIC_RPCS = ["https://rpc.monad.xyz", "https://rpc3.monad.xyz", "https://rpc2.monad.xyz"];
export const isPublicRpc = (url: string) => PUBLIC_RPCS.includes(url.replace(/\/+$/, "").toLowerCase());
/** Per-IP request budget of the public gateways; batch items count individually. */
export const PUBLIC_RATE_LIMIT = 50;

export type EndpointFilter = "all" | "healthy" | "unhealthy" | "saved";
export const host = (url: string) => { try { return new URL(url).host; } catch { return url; } };

export function matchesEndpoint(entry: Endpoint, filter: EndpointFilter, saved: string[]) {
  return filter === "all" || (filter === "healthy" ? entry.healthy : filter === "unhealthy" ? !entry.healthy : saved.includes(entry.url));
}
export function filterEndpoints(entries: Endpoint[], query: string, filter: EndpointFilter, saved: string[], sort: string) {
  const q = query.trim().toLowerCase();
  return entries
    .filter(e => matchesEndpoint(e, filter, saved) && (!q || [e.url, e.client].some(v => v?.toLowerCase().includes(q))))
    .sort((a, b) => sort === "latency" ? (a.latency_ms ?? Infinity) - (b.latency_ms ?? Infinity) || a.priority - b.priority
      : sort === "height" ? (b.height ?? -1) - (a.height ?? -1) || a.priority - b.priority
      : a.priority - b.priority);
}
export function median(values: (number | null)[]) {
  const known = values.filter((v): v is number => v !== null && Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  const middle = Math.floor(known.length / 2);
  return known.length ? known.length % 2 ? known[middle] : (known[middle - 1] + known[middle]) / 2 : null;
}
export function endpointSummary(entries: Endpoint[]) {
  return {
    total: entries.length,
    healthy: entries.filter(e => e.healthy).length,
    unhealthy: entries.filter(e => !e.healthy).length,
    median: median(entries.filter(e => e.healthy).map(e => e.latency_ms)),
  };
}
/**
 * Signed distance from the indexer's finalized block. Endpoints report
 * `eth_blockNumber` (the latest proposed block), which normally sits a few
 * blocks ahead of finalized; a negative value means the endpoint is behind.
 */
export function finalizedDelta(height: number | null, finalized: number | null | undefined): number | null {
  return height === null || finalized === null || finalized === undefined ? null : height - finalized;
}
export function deltaText(delta: number | null): string {
  if (delta === null) return "—";
  if (delta === 0) return "at finalized";
  return delta > 0 ? `+${delta.toLocaleString("en-US")} ahead` : `${(-delta).toLocaleString("en-US")} behind`;
}

export type ProbeObservation = { at: number; latency: number | null; healthy: boolean; height: number | null };
export function appendObservation(history: ProbeObservation[], observation: ProbeObservation) {
  const recent = history.filter(p => p.at >= observation.at - 3_600_000);
  const previous = recent.at(-1);
  if (previous && previous.latency === observation.latency && previous.healthy === observation.healthy && previous.height === observation.height) return recent;
  return [...recent, observation].slice(-360);
}

/** Deep link into the RPC console with an endpoint and a method preselected. */
export function consoleLink(url: string, method = "eth_blockNumber") {
  return `#/rpc/connect?url=${encodeURIComponent(url)}&method=${encodeURIComponent(method)}`;
}
export function rpcConsoleRequest(hash: string): { url: string; method: string | null } | null {
  if (!hash.startsWith("#/rpc/connect?")) return null;
  const params = new URLSearchParams(hash.slice(hash.indexOf("?") + 1));
  const value = params.get("url");
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return { url: value, method: params.get("method") };
  } catch { return null; }
}
