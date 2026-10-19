/**
 * Finality pipeline: every proposal through MonadBFT's commit stages
 * (Proposed → Voted → Finalized → Verified) as this explorer observes them.
 *
 * Live rows come from the `stages` server-sent-event stream, merged by
 * block_id. `getPipeline` seeds the view, supplies the latency percentiles,
 * heads and abandoned proposals, and doubles as the 2 s fallback feed while
 * the stream is down. The global Live/Paused toggle stops both.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dashboard } from "../useDashboard";
import { getPipeline, subscribeStages, type PipelineState, type Percentiles, type StageRow } from "../api";
import { EmptyState, Skeleton, ValidatorAvatar } from "../components/ui";
import { Timestamp } from "../components/Timestamp";
import { STAGES, gap, ms, msLabel, reached } from "../components/LiveStages";
import { fmt, short } from "../lib";
import "./live.css";

const WINDOWS = [
  { minutes: 10, label: "10 min" },
  { minutes: 60, label: "1 h" },
  { minutes: 1440, label: "24 h" },
] as const;
const FEED_HEIGHTS = 18;
const KEEP_HEIGHTS = 48;
const POLL_MS = 2_000;
/** While the stream carries the rows, the summary (percentiles, abandoned) refreshes slowly. */
const SUMMARY_MS = 10_000;

type Conn = "connecting" | "streaming" | "polling" | "paused";
/** A row plus what the client saw arrive: `fresh` = bitmask of stages lit after first sight. */
type Entry = StageRow & { fresh: number; isNew: boolean };

const windowLabel = (m: number) => WINDOWS.find((w) => w.minutes === m)?.label ?? `${m} min`;
const proposerName = (r: { proposer_name: string | null; proposer_id: number | null }) =>
  r.proposer_name ?? (r.proposer_id !== null ? `Validator #${r.proposer_id}` : null);
const utc = (iso: string | null | undefined) => {
  const t = ms(iso);
  return t === null ? "—" : new Date(t).toLocaleString("en-GB", { timeZone: "UTC", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }) + " UTC";
};

/** Merge stage rows into the map; stages never go back to unobserved. */
function merge(prev: Map<string, Entry>, rows: StageRow[], animate: boolean): Map<string, Entry> {
  if (!rows.length) return prev;
  const next = new Map(prev);
  let top = 0;
  for (const r of rows) {
    if (!r || typeof r.block_id !== "string" || !Number.isFinite(r.number)) continue;
    const old = next.get(r.block_id);
    if (!old) {
      next.set(r.block_id, { ...r, fresh: 0, isNew: animate });
    } else {
      let fresh = old.fresh;
      const merged: Entry = { ...old, ...r, proposer_name: r.proposer_name ?? old.proposer_name, fresh: 0, isNew: old.isNew };
      STAGES.forEach((s, i) => {
        merged[s.key] = r[s.key] ?? old[s.key];
        if (animate && !old[s.key] && merged[s.key]) fresh |= 1 << i;
      });
      merged.fresh = fresh;
      next.set(r.block_id, merged);
    }
  }
  for (const e of next.values()) top = Math.max(top, e.number);
  for (const [k, e] of next) if (e.number <= top - KEEP_HEIGHTS) next.delete(k);
  return next;
}

export function Live({ d, live }: { d: Dashboard; live: boolean }) {
  const [minutes, setMinutes] = useState<number>(10);
  const [summary, setSummary] = useState<PipelineState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<Map<string, Entry>>(() => new Map());
  const [conn, setConn] = useState<Conn>(live ? "connecting" : "paused");
  const seeded = useRef(false);
  const streaming = useRef(false);

  /** Rows merged before the first summary arrives are the baseline: no entry animation. */
  const ingest = useCallback((incoming: StageRow[], seed = false) => {
    const animate = seeded.current;
    if (seed) seeded.current = true;
    setRows((prev) => merge(prev, incoming, animate));
  }, []);

  // Live stage stream.
  useEffect(() => {
    if (!live) {
      streaming.current = false;
      setConn("paused");
      return;
    }
    setConn("connecting");
    const stop = subscribeStages((r) => ingest(r), (open) => {
      streaming.current = open;
      setConn(open ? "streaming" : "polling");
    });
    return () => {
      stop();
      streaming.current = false;
    };
  }, [live, ingest]);

  // Summary + fallback feed. Fast while the stream is down, slow while it is up.
  const [retryTick, setRetryTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const load = () =>
      getPipeline(minutes)
        .then((s) => {
          if (cancelled) return;
          setSummary(s);
          setError(null);
          ingest(s.recent ?? [], true);
        })
        .catch((e: Error) => !cancelled && setError(e.message || "request failed"));
    let last = 0;
    const tick = () => {
      const due = streaming.current ? SUMMARY_MS : POLL_MS;
      if (document.visibilityState === "visible" && Date.now() - last >= due - 50) {
        last = Date.now();
        void load();
      }
      timer = window.setTimeout(tick, POLL_MS);
    };
    last = Date.now();
    void load();
    if (live) timer = window.setTimeout(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [live, minutes, ingest, retryTick]);

  const validatorLogos = useMemo(() => {
    const m = new Map<number, boolean>();
    for (const v of d.validators?.validators ?? []) m.set(v.id, !!v.logo);
    return m;
  }, [d.validators]);

  const all = useMemo(() => [...rows.values()], [rows]);
  const finalizedAt = useMemo(() => {
    const s = new Set<number>();
    for (const r of all) if (r.finalized_at) s.add(r.number);
    return s;
  }, [all]);
  const feed = useMemo(() => {
    const sorted = all.slice().sort((a, b) => b.number - a.number || (ms(b.proposed_at) ?? 0) - (ms(a.proposed_at) ?? 0));
    const heights: number[] = [];
    for (const r of sorted) if (heights[heights.length - 1] !== r.number) heights.push(r.number);
    const floor = heights[Math.min(FEED_HEIGHTS, heights.length) - 1] ?? Infinity;
    return sorted.filter((r) => r.number >= floor);
  }, [all]);

  // Heads: the larger of the summary and what the stream has delivered since.
  const heads = useMemo(() => {
    const h = { proposed: summary?.heads.proposed ?? null, voted: summary?.heads.voted ?? null, finalized: summary?.heads.finalized ?? null, verified: summary?.heads.verified ?? null };
    const keys = ["proposed", "voted", "finalized", "verified"] as const;
    for (const r of all) STAGES.forEach((s, i) => {
      if (r[s.key]) h[keys[i]] = Math.max(h[keys[i]] ?? 0, r.number);
    });
    const lag = h.finalized !== null && h.verified !== null ? Math.max(0, h.finalized - h.verified) : summary?.heads.execution_lag ?? null;
    return { ...h, lag };
  }, [all, summary]);

  const shown = summary?.minutes ?? minutes;
  const loading = !summary && !error;
  const observedSince = summary?.observed_since ?? null;

  return (
    <div className={`lv-page${live ? "" : " lv-paused"}`}>
      <div className="lv-toolbar">
        <div className="lv-toolbar-left">
          <ConnPill conn={conn} />
          <span className="lv-since">{observedSince ? <>Observed since {utc(observedSince)} · {fmt(summary?.observed_24h)} proposals in 24 h</> : loading ? "Connecting to the pipeline…" : "No stage observations yet"}</span>
        </div>
        <div className="lv-ranges" role="group" aria-label="Latency window">
          {WINDOWS.map((w) => (
            <button key={w.minutes} type="button" aria-pressed={minutes === w.minutes} onClick={() => setMinutes(w.minutes)}>{w.label}</button>
          ))}
        </div>
      </div>

      {error && (
        <div className="lv-notice" role="status">
          <span>{summary ? `Pipeline summary could not refresh (${error}). Showing the last loaded snapshot.` : `Pipeline data is unavailable (${error}).`}</span>
          <button type="button" onClick={() => setRetryTick((t) => t + 1)}>Retry</button>
        </div>
      )}
      {summary && shown !== minutes && !error && (
        <div className="lv-notice muted" role="status"><span>Loading the {windowLabel(minutes)} window · showing {windowLabel(shown)} until it arrives.</span></div>
      )}

      <Heads heads={heads} loading={loading} />

      <LatencyTiles summary={summary} loading={loading} label={windowLabel(shown)} />

      <div className="lv-main">
        <section className="lv-panel lv-feed-panel">
          <header className="lv-heading">
            <div>
              <h2>Live commit stages</h2>
              <p>The last {FEED_HEIGHTS} heights, newest first. Each dot lights when this explorer observes that stage; gaps are ms between stages.</p>
            </div>
            <Legend />
          </header>
          <Feed rows={feed} finalizedAt={finalizedAt} logos={validatorLogos} loading={loading} error={!!error && rows.size === 0} empty={!!summary && rows.size === 0} />
        </section>
        <div className="lv-side">
          <Abandoned summary={summary} loading={loading} logos={validatorLogos} />
          <HowToRead since={observedSince} />
        </div>
      </div>
    </div>
  );
}

function ConnPill({ conn }: { conn: Conn }) {
  const map: Record<Conn, { label: string; tone: string; title: string }> = {
    streaming: { label: "Streaming", tone: "ok", title: "Receiving stage updates over server-sent events as they land" },
    connecting: { label: "Connecting", tone: "warn", title: "Opening the live stream; polling every 2 s meanwhile" },
    polling: { label: "Polling", tone: "warn", title: "The live stream is down; refreshing every 2 s until it reconnects" },
    paused: { label: "Paused", tone: "muted", title: "Live updates are paused (header toggle)" },
  };
  const c = map[conn];
  return <span className={`lv-conn ${c.tone}`} title={c.title} role="status"><i aria-hidden="true" />{c.label}</span>;
}

function Legend() {
  return (
    <div className="lv-legend" aria-hidden="true">
      {STAGES.map((s, i) => <span key={s.key}><i className={`lv-dot on s${i}`} />{s.label}</span>)}
    </div>
  );
}

function Heads({ heads, loading }: { heads: { proposed: number | null; voted: number | null; finalized: number | null; verified: number | null; lag: number | null }; loading: boolean }) {
  const cells = [
    { label: "Proposed", value: heads.proposed, note: "Latest block proposed by a leader" },
    { label: "Voted", value: heads.voted, note: "Latest block with a quorum certificate" },
    { label: "Finalized", value: heads.finalized, note: "Latest block final; cannot revert" },
    { label: "Verified", value: heads.verified, note: "Latest block with a confirmed state root" },
  ];
  const lagTone = heads.lag === null ? "muted" : heads.lag <= 4 ? "ok" : "warn";
  return (
    <section className="lv-panel lv-heads" aria-label="Pipeline heads">
      <div className="lv-heads-row">
        {cells.map((c, i) => (
          <div className={`lv-head s${i}`} key={c.label}>
            <span className="lv-label"><i className={`lv-dot on s${i}`} aria-hidden="true" />{c.label}</span>
            {loading ? <Skeleton h={26} w="80%" /> : <strong>{c.value === null ? "—" : `#${fmt(c.value)}`}</strong>}
            <small>{i > 0 && heads.proposed !== null && c.value !== null ? `head − ${fmt(heads.proposed - c.value)} · ` : ""}{c.note}</small>
          </div>
        ))}
        <div className={`lv-head lv-lag ${lagTone}`}>
          <span className="lv-label">Execution lag</span>
          {loading ? <Skeleton h={26} w="60%" /> : <strong>{heads.lag === null ? "—" : `${fmt(heads.lag)} ${heads.lag === 1 ? "block" : "blocks"}`}</strong>}
          <small>Finalized minus verified head</small>
        </div>
      </div>
      <p className="lv-async">
        <b>Asynchronous execution:</b> MonadBFT agrees on a block's order before it is executed, so execution runs behind consensus and a block's state root is confirmed about three blocks after it finalizes. That confirmation is the Verified stage.
      </p>
    </section>
  );
}

function LatencyTiles({ summary, loading, label }: { summary: PipelineState | null; loading: boolean; label: string }) {
  const l = summary?.latency_ms;
  const tiles: { title: string; sub: string; p: Percentiles | undefined; note: string; primary?: boolean }[] = [
    { title: "Proposed → Voted", sub: "Vote", p: l?.vote, note: "Proposal seen until its quorum certificate" },
    { title: "Voted → Finalized", sub: "Finalize", p: l?.finalize, note: "Quorum certificate until finality" },
    { title: "Time to finality", sub: "Proposed → Finalized", p: l?.total, note: "End to end consensus, per block", primary: true },
    { title: "Finalized → Verified", sub: "Execution", p: l?.verify, note: "Finality until the state root is confirmed" },
  ];
  const scale = Math.max(1, ...tiles.map((t) => t.p?.p95 ?? 0));
  return (
    <section className="lv-latency" aria-label={`Stage latency, ${label}`}>
      <div className="lv-stats">
        {tiles.map((t) => {
          const p50 = t.p?.p50 ?? null, p95 = t.p?.p95 ?? null;
          return (
            <section className={`lv-panel lv-stat${t.primary ? " primary" : ""}`} key={t.title}>
              <div className="lv-stat-label"><span>{t.title}</span><em>{t.sub} · {label}</em></div>
              {loading ? <Skeleton h={30} w="55%" /> : (
                <div className="lv-stat-value"><strong>{p50 === null ? "—" : msLabel(p50)}</strong><span>p50</span></div>
              )}
              <div className="lv-range" aria-hidden="true">
                {p95 !== null && <b className="p95" style={{ width: `${Math.min(100, (p95 / scale) * 100)}%` }} />}
                {p50 !== null && <b className="p50" style={{ width: `${Math.min(100, (p50 / scale) * 100)}%` }} />}
              </div>
              <p><span className="lv-p95">p95 <b>{p95 === null ? "—" : msLabel(p95)}</b></span><span title={t.note}>{t.note}</span></p>
            </section>
          );
        })}
      </div>
      <p className="lv-footnote">
        {summary
          ? summary.latency_ms.blocks > 0
            ? `Percentiles over ${fmt(summary.latency_ms.blocks)} blocks proposed in the last ${label} that were both voted and finalized. Bars share one scale (longest p95); the light segment runs to p95.`
            : `No block in the last ${label} has both a vote and finality observed yet.`
          : " "}
      </p>
    </section>
  );
}

function Feed({ rows, finalizedAt, logos, loading, error, empty }: { rows: Entry[]; finalizedAt: Set<number>; logos: Map<number, boolean>; loading: boolean; error: boolean; empty: boolean }) {
  if (error) return <EmptyState title="Live stages unavailable" text="The pipeline API could not be reached. The feed resumes as soon as it answers." />;
  if (!rows.length && loading)
    return (
      <div className="lv-feed" aria-busy="true">
        {Array.from({ length: 8 }, (_, i) => (
          <div className="lv-row lv-row-skel" key={i}><Skeleton h={14} w="70%" /><Skeleton h={14} w="80%" /><Skeleton h={14} w="70%" /><Skeleton h={14} w="100%" /><Skeleton h={14} w="60%" /></div>
        ))}
      </div>
    );
  if (!rows.length || empty)
    return <EmptyState title="No stages observed yet" text="Rows appear as soon as the indexer records the next proposal." />;
  return (
    <div className="lv-feed" role="table" aria-label="Recent proposals and their commit stages">
      <div className="lv-row lv-row-head" role="row">
        <span role="columnheader">Height</span>
        <span role="columnheader">Proposer</span>
        <span role="columnheader" className="lv-id">Block ID</span>
        <span role="columnheader" className="lv-track lv-track-head">{STAGES.map((s) => <span key={s.key}>{s.label}</span>)}</span>
        <span role="columnheader" className="lv-num">Finality</span>
      </div>
      {rows.map((r) => <FeedRow key={r.block_id} r={r} abandoned={!r.finalized_at && finalizedAt.has(r.number)} logo={r.proposer_id !== null && !!logos.get(r.proposer_id)} />)}
    </div>
  );
}

function FeedRow({ r, abandoned, logo }: { r: Entry; abandoned: boolean; logo: boolean }) {
  const name = proposerName(r);
  const n = reached(r);
  const total = gap(r.proposed_at, r.finalized_at);
  const gaps = [gap(r.proposed_at, r.voted_at), gap(r.voted_at, r.finalized_at), gap(r.finalized_at, r.verified_at)];
  const height = `#${fmt(r.number)}`;
  return (
    <div className={`lv-row${r.isNew ? " new" : ""}${abandoned ? " abandoned" : ""}`} role="row">
      <span role="cell" className="lv-height">
        {r.finalized_at && !abandoned ? <a href={`#/blocks/${r.number}`}>{height}</a> : <span>{height}</span>}
        {abandoned && <span className="lv-tag bad" title="Never finalized: a competing proposal at this height did">Abandoned</span>}
      </span>
      <span role="cell" className="lv-proposer">
        {r.proposer_id !== null ? (
          <a href={`#/validators/${r.proposer_id}`} title={name ?? undefined}>
            <ValidatorAvatar id={r.proposer_id} seed={r.miner || String(r.proposer_id)} hasLogo={logo} size={20} />
            <span>{name}</span>
          </a>
        ) : (
          <span className="lv-unattr" title={r.miner ?? undefined}>{r.miner ? short(r.miner) : "Unattributed"}</span>
        )}
      </span>
      <span role="cell" className="lv-id" title={r.block_id}>{short(r.block_id)}</span>
      <span role="cell" className="lv-track" aria-label={`${n} of 4 stages${abandoned ? ", abandoned" : ""}`}>
        {STAGES.map((s, i) => {
          const on = i < n;
          const pending = !abandoned && i === n;
          const linkOn = i + 1 < n;
          return (
            <span className="lv-seg" key={s.key}>
              <i className={`lv-dot${on ? ` on s${i}` : pending ? " next" : abandoned && i >= n ? " dead" : ""}${on && r.fresh & (1 << i) ? " pop" : ""}`} title={`${s.label}: ${r[s.key] ? utc(r[s.key]) : abandoned ? "never" : "pending"}`} />
              {i < 3 && (
                <span className={`lv-link${linkOn ? " on" : ""}${!abandoned && i + 1 === n ? " flowing" : ""}`}>
                  {gaps[i] !== null && <em className={r.fresh & (1 << (i + 1)) ? "pop" : undefined}>{msLabel(gaps[i])}</em>}
                </span>
              )}
            </span>
          );
        })}
      </span>
      <span role="cell" className={`lv-num lv-total${total === null ? " muted" : ""}`}>{abandoned ? "never" : msLabel(total)}</span>
    </div>
  );
}

function Abandoned({ summary, loading, logos }: { summary: PipelineState | null; loading: boolean; logos: Map<number, boolean> }) {
  const list = summary?.abandoned ?? [];
  const by = summary?.abandoned_by_proposer ?? [];
  const count = summary?.abandoned_24h ?? 0;
  return (
    <section className="lv-panel lv-abandoned">
      <header className="lv-heading">
        <div>
          <h2>Abandoned proposals · 24 h</h2>
          <p>A proposal that never finalized while a competing proposal at the same height did.</p>
        </div>
        <span className={`lv-count${summary && count === 0 ? " ok" : ""}`}>{summary ? fmt(count) : "—"}</span>
      </header>
      {loading ? (
        <div className="lv-skel-stack"><Skeleton h={14} w="90%" /><Skeleton h={14} w="75%" /><Skeleton h={14} w="82%" /></div>
      ) : !summary ? (
        <div className="lv-empty">Abandoned proposals load with the pipeline summary.</div>
      ) : count === 0 ? (
        <div className="lv-all-clear">
          <span className="lv-check" aria-hidden="true"><svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M4.5 10.5l3.5 3.5 7.5-8" /></svg></span>
          <div>
            <strong>No abandoned proposals in the last 24 h</strong>
            <span>Every height observed finalized the proposal it first saw. Zero is the normal state; one appears when a leader's proposal times out and the next round's proposal wins the height.</span>
          </div>
        </div>
      ) : (
        <>
          <div className="lv-table-wrap">
            <table className="lv-table">
              <thead><tr><th>Block</th><th>Proposer</th><th>Proposed</th><th>Vote</th></tr></thead>
              <tbody>
                {list.map((a) => {
                  const name = proposerName(a);
                  return (
                    <tr key={a.block_id}>
                      <td className="mono" title={a.block_id}>#{fmt(a.number)}</td>
                      <td>
                        {a.proposer_id !== null ? (
                          <a className="lv-proposer-link" href={`#/validators/${a.proposer_id}`}>
                            <ValidatorAvatar id={a.proposer_id} seed={a.miner || String(a.proposer_id)} hasLogo={!!logos.get(a.proposer_id)} size={16} />
                            <span>{name}</span>
                          </a>
                        ) : <span className="lv-unattr">{a.miner ? short(a.miner) : "Unattributed"}</span>}
                      </td>
                      <td><Timestamp value={a.proposed_at} /></td>
                      <td>{a.voted_at ? <span className="lv-tag warn" title="Reached a quorum certificate, then lost the height">Voted</span> : <span className="lv-tag muted">No vote</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {list.length < count && <p className="lv-footnote">Showing the newest {fmt(list.length)} of {fmt(count)}.</p>}
          {by.length > 0 && (
            <div className="lv-by">
              <h3>By proposer</h3>
              <ul>
                {by.map((p) => {
                  const name = p.name ?? (p.id !== null ? `Validator #${p.id}` : "Unattributed");
                  const max = Math.max(1, ...by.map((x) => x.n));
                  return (
                    <li key={p.id ?? "none"}>
                      {p.id !== null ? <a href={`#/validators/${p.id}`}>{name}</a> : <span>{name}</span>}
                      <i><b style={{ width: `${(p.n / max) * 100}%` }} /></i>
                      <strong>{fmt(p.n)}</strong>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function HowToRead({ since }: { since: string | null }) {
  return (
    <section className="lv-panel lv-howto">
      <header className="lv-heading"><div><h2>How to read this</h2></div></header>
      <ul>
        <li><i className="lv-dot on s0" /><div><strong>Proposed</strong><span>The round's leader broadcast the block.</span></div></li>
        <li><i className="lv-dot on s1" /><div><strong>Voted</strong><span>A quorum of stake voted for it (a quorum certificate formed).</span></div></li>
        <li><i className="lv-dot on s2" /><div><strong>Finalized</strong><span>The next round certified it too; it can no longer revert.</span></div></li>
        <li><i className="lv-dot on s3" /><div><strong>Verified</strong><span>Its execution state root was confirmed, roughly three blocks after finality.</span></div></li>
      </ul>
      <p className="lv-footnote">
        Times are when this explorer observed each stage over its RPC WebSocket, so absolute values include network latency; stage-to-stage gaps are reliable.
        {since ? <> Observed since {utc(since)}.</> : null}
      </p>
    </section>
  );
}
