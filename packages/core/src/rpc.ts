/**
 * Minimal Ethereum JSON-RPC client shared by the indexer and the API.
 *
 * The public Monad endpoints allow ~50 requests/second per IP and count each
 * item of a batch as one request, so every call goes through a token bucket
 * sized well under that. Endpoints are tried in order; one that errors or
 * throttles is benched for a cooldown and the next takes over, so a single
 * flaky gateway never stalls ingestion.
 */

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    /** The method whose item failed, for per-item errors inside a batch. */
    readonly method?: string,
  ) {
    super(message);
  }
}

export type RpcEndpointStatus = {
  url: string;
  healthy: boolean;
  benchedUntil: number;
  lastError: string | null;
  latencyMs: number | null;
};

type Endpoint = RpcEndpointStatus & {
  failures: number;
  /** Methods this endpoint refused (e.g. debug_* on a gateway that gates them). */
  unsupported: Set<string>;
  /** Largest batch it accepted after refusing a bigger one. */
  maxBatch: number;
};

/** Node answered "you may not call this here", not "your call is wrong". */
const METHOD_REFUSED = new Set([-32053, -32601]);

/** Strip userinfo and path secrets (API keys often live in the path) for logs. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "rpc";
  }
}

/** Comma-separated RPC_URLS, falling back to the public Monad mainnet gateways. */
export function rpcUrlsFromEnv(): string[] {
  const raw = process.env.RPC_URLS ?? "https://rpc.monad.xyz,https://rpc3.monad.xyz,https://rpc2.monad.xyz";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const BENCH_MS = 30_000;
const TIMEOUT_MS = 15_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class JsonRpc {
  private endpoints: Endpoint[];
  private tokens: number;
  private lastRefill = Date.now();
  private nextId = 1;

  /**
   * @param urls endpoints in priority order
   * @param rps request budget per second across all endpoints (batch items count)
   */
  constructor(
    urls: string[],
    private rps = Number(process.env.RPC_RPS ?? 25),
  ) {
    if (!urls.length) throw new Error("no RPC endpoints configured");
    this.endpoints = urls.map((url) => ({
      url,
      healthy: true,
      benchedUntil: 0,
      lastError: null,
      latencyMs: null,
      failures: 0,
      unsupported: new Set<string>(),
      maxBatch: Number.POSITIVE_INFINITY,
    }));
    this.tokens = rps;
  }

  status(): RpcEndpointStatus[] {
    return this.endpoints.map(({ failures: _f, unsupported: _u, maxBatch: _m, ...e }) => ({ ...e, url: redactUrl(e.url) }));
  }

  /** The endpoint the next call will use (redacted). */
  get active(): string {
    return redactUrl(this.pick().url);
  }

  async call<T = any>(method: string, params: unknown[] = []): Promise<T> {
    const [res] = await this.batch<T>([{ method, params }]);
    return res as T;
  }

  /**
   * Send several calls as one JSON-RPC batch; results come back in request
   * order. Any per-item error fails the whole batch so callers never persist
   * a block with half its receipts.
   */
  async batch<T = any>(calls: { method: string; params: unknown[] }[]): Promise<T[]> {
    if (!calls.length) return [];
    await this.take(calls.length);
    let lastErr: unknown;
    const methods = [...new Set(calls.map((c) => c.method))];
    for (let attempt = 0; attempt < 4; attempt++) {
      const ep = this.pick(methods, calls.length);
      const started = Date.now();
      try {
        const out = await this.send<T>(ep.url, calls);
        ep.latencyMs = Date.now() - started;
        ep.healthy = true;
        ep.failures = 0;
        ep.lastError = null;
        return out;
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        // Capability limits are per endpoint: remember them and try another.
        if (err instanceof RpcError && err.code !== undefined && METHOD_REFUSED.has(err.code)) {
          if (methods.length === 1 || err.method) ep.unsupported.add(err.method ?? methods[0]!);
          continue;
        }
        if (err instanceof RpcError && err.code === 413) {
          ep.maxBatch = Math.max(1, Math.min(ep.maxBatch, calls.length - 1));
          continue;
        }
        // A JSON-RPC error from the node itself (bad params, reverted call)
        // is the answer, not an endpoint fault: do not fail over on it.
        if (err instanceof RpcError && err.code !== undefined && !isThrottle(err)) throw err;
        ep.failures++;
        ep.lastError = msg;
        if (isThrottle(err) || ep.failures >= 2) {
          ep.healthy = false;
          ep.benchedUntil = Date.now() + BENCH_MS;
        }
        await sleep(200 * 2 ** attempt);
      }
    }
    throw lastErr instanceof Error ? lastErr : new RpcError(String(lastErr));
  }

  /**
   * First endpoint that is not benched and can serve these methods at this
   * batch size; failing that, the capable one benched the shortest; failing
   * that, any (the caller then gets that endpoint's real error).
   */
  private pick(methods: string[] = [], size = 1): Endpoint {
    const now = Date.now();
    const capable = this.endpoints.filter((e) => size <= e.maxBatch && !methods.some((m) => e.unsupported.has(m)));
    const pool = capable.length ? capable : this.endpoints;
    return pool.find((e) => e.benchedUntil <= now) ?? pool.reduce((a, b) => (a.benchedUntil <= b.benchedUntil ? a : b));
  }

  /** Token bucket: wait until `n` request tokens are available. */
  private async take(n: number): Promise<void> {
    const need = Math.min(n, this.rps);
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(this.rps, this.tokens + ((now - this.lastRefill) / 1000) * this.rps);
      this.lastRefill = now;
      if (this.tokens >= need) {
        this.tokens -= n; // may go negative for oversized batches; later callers wait it off
        return;
      }
      await sleep(Math.ceil(((need - this.tokens) / this.rps) * 1000));
    }
  }

  private async send<T>(url: string, calls: { method: string; params: unknown[] }[]): Promise<T[]> {
    const ids = calls.map(() => this.nextId++);
    const body = calls.map((c, i) => ({ jsonrpc: "2.0", id: ids[i], method: c.method, params: c.params }));
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 429) throw new RpcError(`${redactUrl(url)}: HTTP 429`, 429);
    if (res.status === 413 && calls.length > 1) throw new RpcError(`${redactUrl(url)}: batch of ${calls.length} too large`, 413);
    if (!res.ok) throw new RpcError(`${redactUrl(url)}: HTTP ${res.status}`);
    const json: any = await res.json();
    // Some gateways answer a throttled batch with a single error object.
    if (!Array.isArray(json)) {
      const e = json?.error ?? json;
      throw new RpcError(`${redactUrl(url)}: ${e?.message ?? "unexpected response"}`, e?.code === -32007 ? 429 : undefined);
    }
    const byId = new Map<number, any>(json.map((r: any) => [r.id, r]));
    return ids.map((id) => {
      const r = byId.get(id);
      if (!r) throw new RpcError(`${redactUrl(url)}: missing response for id ${id}`);
      if (r.error) {
        const i = ids.indexOf(id);
        throw new RpcError(r.error.message ?? "rpc error", r.error.code === -32007 ? 429 : (r.error.code ?? -1), calls[i]?.method);
      }
      return r.result as T;
    });
  }
}

function isThrottle(err: unknown): boolean {
  return err instanceof RpcError && err.code === 429;
}
