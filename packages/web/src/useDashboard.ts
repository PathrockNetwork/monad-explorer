/**
 * Single polling loop behind every page.
 *
 * The system state is derived from what the API reports, with one addition the
 * server cannot make: if the request itself fails we are in `dberror` — the
 * API can't tell us its database is unreachable when we never reached the API.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  getConfig,
  getEndpoints,
  getMetrics,
  getNetwork,
  getValidators,
  type Config,
  type EndpointList,
  type Metrics,
  type Network,
  type SystemState,
  type ValidatorList,
} from "./api";

/** Monad finalizes ~3 blocks a second; the fast loop matches the header cadence. */
const REFRESH_MS = 4_000;
const VALIDATOR_REFRESH_MS = 15_000;
const SLOW_REFRESH_MS = 30_000;
/** The indexer writes sync state every few blocks; a minute of silence means it stopped. */
const STALL_MS = 60_000;
/** Behind by more than this many blocks, the explorer reports catching up. */
const BACKFILL_LAG = 100;

export type Dashboard = {
  net: Network | null;
  validators: ValidatorList | null;
  metrics: Metrics | null;
  metricsError: boolean;
  metricsUpdatedAt: Date | null;
  config: Config | null;
  endpoints: EndpointList | null;
  /** Effective state. */
  state: SystemState;
  error: string | null;
  lastUpdated: Date | null;
  /** Seconds since the last successful poll — drives the "Updated Ns ago". */
  agoSeconds: number;
  refresh: () => void;
};

export function useDashboard(opts: { live: boolean; metricsHours: number }): Dashboard {
  const { live, metricsHours } = opts;

  const [net, setNet] = useState<Network | null>(null);
  const [validators, setValidators] = useState<ValidatorList | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [metricsError, setMetricsError] = useState(false);
  const [metricsUpdatedAt, setMetricsUpdatedAt] = useState<Date | null>(null);
  const [endpoints, setEndpoints] = useState<EndpointList | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [agoSeconds, setAgoSeconds] = useState(0);
  const [tick, setTick] = useState(0);
  const booted = useRef(false);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  /** Run `fn` now and every `ms` while live; cancels cleanly on change. */
  function usePoll(fn: () => Promise<void>, ms: number, deps: unknown[]) {
    useEffect(() => {
      let cancelled = false;
      const run = () => {
        if (!cancelled) void fn();
      };
      run();
      if (!live) return () => {
        cancelled = true;
      };
      const id = setInterval(() => {
        if (document.visibilityState === "visible") run();
      }, ms);
      return () => {
        cancelled = true;
        clearInterval(id);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [live, tick, ...deps]);
  }

  // Fast loop: the numbers that change every block.
  usePoll(
    async () => {
      try {
        const n = await getNetwork();
        setNet(n);
        setError(null);
        setLastUpdated(new Date());
        setAgoSeconds(0);
        booted.current = true;
      } catch (e) {
        setError((e as Error).message);
      }
    },
    REFRESH_MS,
    [],
  );

  usePoll(
    async () => {
      try {
        setValidators(await getValidators());
      } catch {
        /* keep the last good list; the header state already reports API trouble */
      }
    },
    VALIDATOR_REFRESH_MS,
    [],
  );

  // Slow loop: aggregates. The metrics horizon is a dependency so switching
  // ranges refetches immediately.
  usePoll(
    async () => {
      const [m, e] = await Promise.allSettled([getMetrics(metricsHours), getEndpoints()]);
      if (m.status === "fulfilled") {
        setMetrics(m.value);
        setMetricsUpdatedAt(new Date());
        setMetricsError(false);
      } else setMetricsError(true);
      if (e.status === "fulfilled") setEndpoints(e.value);
    },
    SLOW_REFRESH_MS,
    [metricsHours],
  );

  // Config is static for the process lifetime.
  useEffect(() => {
    let cancelled = false;
    getConfig()
      .then((c) => !cancelled && setConfig(c))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // "Updated Ns ago" ticks independently of the fetch loop.
  useEffect(() => {
    const id = setInterval(() => setAgoSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);

  let state: SystemState;
  if (error) state = "dberror";
  else if (!booted.current || !net) state = "loading";
  else if (!net.blocks_indexed) state = "empty";
  else if (net.indexer_updated_at && Date.now() - new Date(net.indexer_updated_at).getTime() > STALL_MS) state = "stopped";
  else if ((net.lag_blocks ?? 0) > BACKFILL_LAG) state = "backfill";
  else state = "normal";

  return {
    net,
    validators,
    metrics,
    metricsError,
    metricsUpdatedAt,
    config,
    endpoints,
    state,
    error,
    lastUpdated,
    agoSeconds,
    refresh,
  };
}
