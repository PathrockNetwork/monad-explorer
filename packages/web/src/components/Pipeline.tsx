/**
 * Recent blocks as a strip, NEWEST ON THE LEFT so the live edge is always
 * visible without scrolling. Only finalized blocks are indexed on Monad, so
 * every card is final by definition (no reorgs). The proposer comes from the
 * block's ValidatorRewarded event. Each card also carries a compact MonadBFT
 * commit-stage indicator (Proposed → Voted → Finalized → Verified), fed by the
 * `stages` server-sent-event stream and keyed by block number; the full view
 * lives on the Finality pipeline page (#/live).
 */
import { useEffect, useRef, useState } from "react";
import { Timestamp } from "./Timestamp";
import { getBlocks, getPipeline, subscribeStages, type Block, type StageRow } from "../api";
import { ValidatorAvatar } from "./ui";
import { LiveStageDots } from "./LiveStages";
import { fmt, short } from "../lib";
import { BRAND, OK, TX, TX3, mono, panel, sans } from "./ui";

/** ~3 blocks/s; a 3 s poll keeps the strip moving without hammering the API. */
const POLL_MS = 3_000;
const COUNT = 8;
/** Stage rows kept per strip: the stream covers the head, the strip trails it slightly. */
const STAGE_KEEP = 64;

/**
 * Commit stages by block number. Several proposals can share a height; the
 * one that finalized (or matches the indexed hash) wins.
 */
function useStagesByNumber(live: boolean): Map<number, StageRow[]> {
  const [map, setMap] = useState<Map<number, StageRow[]>>(() => new Map());
  const open = useRef(false);
  useEffect(() => {
    let cancelled = false;
    const add = (rows: StageRow[]) => {
      if (cancelled || !rows.length) return;
      setMap((prev) => {
        const next = new Map(prev);
        for (const r of rows) {
          if (!r || !Number.isFinite(r.number)) continue;
          const list = (next.get(r.number) ?? []).filter((x) => x.block_id !== r.block_id);
          next.set(r.number, [...list, r]);
        }
        const keys = [...next.keys()].sort((a, b) => b - a);
        for (const k of keys.slice(STAGE_KEEP)) next.delete(k);
        return next;
      });
    };
    const seed = () => getPipeline(10).then((p) => add(p.recent ?? [])).catch(() => undefined);
    void seed();
    if (!live) return () => {
      cancelled = true;
    };
    const stop = subscribeStages(add, (o) => {
      open.current = o;
    });
    // Fallback while the stream is down: refresh from the summary at the strip's cadence.
    const id = setInterval(() => {
      if (!open.current && document.visibilityState === "visible") void seed();
    }, POLL_MS);
    return () => {
      cancelled = true;
      stop();
      clearInterval(id);
      open.current = false;
    };
  }, [live]);
  return map;
}

function stageFor(rows: StageRow[] | undefined, b: Block): StageRow | null {
  if (!rows?.length) return null;
  return rows.find((r) => r.hash && r.hash === b.hash) ?? rows.find((r) => r.finalized_at) ?? null;
}

export function Pipeline({ live }: { live: boolean }) {
  const [blocks, setBlocks] = useState<Block[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [animationCycle, setAnimationCycle] = useState(0);
  const [freshHeight, setFreshHeight] = useState<number | null>(null);
  const previousHead = useRef<number | null>(null);
  const stages = useStagesByNumber(live);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      getBlocks(COUNT)
        .then((r) => {
          if (cancelled) return;
          // The API returns newest first, which is the render order.
          setBlocks(r.blocks);
          setError(null);
          const head = r.blocks[0]?.number ?? null;
          if (head !== null && previousHead.current !== null && head !== previousHead.current) {
            setFreshHeight(head);
            setAnimationCycle((cycle) => cycle + 1);
            window.setTimeout(() => setFreshHeight((current) => (current === head ? null : current)), 1800);
          }
          if (head !== null) previousHead.current = head;
        })
        .catch((e: Error) => !cancelled && setError(e.message));
    void load();
    if (!live) return () => {
      cancelled = true;
    };
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [live]);

  return (
    <section className="pipeline-panel" style={{ ...panel, overflow: "hidden" }}>
      <div
        className="pipeline-head"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          padding: "14px 16px 12px",
          borderBottom: "1px solid var(--line)",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <h2 style={{ margin: 0, font: `650 16px/1 ${sans}`, color: TX }}><span className="pipeline-title-desktop">Recent Blocks / Finalized Proposals</span><span className="pipeline-title-mobile">Recent Blocks</span></h2>
          <span style={{ font: `400 13px/1 ${sans}`, color: TX3 }}>Latest finalized blocks and their proposers — newest on the left.</span>
        </div>
        <span className="pipeline-meta" style={{ font: `400 13px/1 ${mono}`, color: TX3 }}>
          {error
            ? `unavailable (${error})`
            : blocks
              ? `newest ${blocks.length} blocks · all finalized`
              : "loading…"}
        </span>
        <div className="pipeline-links">
          <a className="pipeline-finality-link" href="#/live" title="Every block through MonadBFT: proposed, voted, finalized, verified">
            <span className="pipeline-title-desktop">Finality pipeline&nbsp;→</span><span className="pipeline-title-mobile">Finality&nbsp;→</span>
          </a>
          <a className="pipeline-view-all" href="#/blocks">View all&nbsp; →</a>
        </div>
      </div>
      <div
        className="pipeline-track"
        role="region"
        aria-label="Latest finalized blocks"
        tabIndex={0}
        style={{
          display: "flex",
          alignItems: "stretch",
          gap: 0,
          padding: "12px 16px 14px",
          overflowX: "auto",
        }}
      >
        {(blocks ?? []).map((b, i) => (
          <div
            key={`${b.number}-${animationCycle}`}
            className={`pipeline-item ${b.number === freshHeight ? "pipeline-item-new" : animationCycle > 0 ? "pipeline-item-shift" : ""}`}
            style={{ display: "flex", alignItems: "stretch", flex: "none" }}
          >
            {i > 0 && <div className="pipeline-arrow" style={arrowStyle}>→</div>}
            <BlockCard b={b} newest={i === 0} fresh={b.number === freshHeight} stage={stageFor(stages.get(b.number), b)} />
          </div>
        ))}
        {blocks?.length === 0 && (
          <span style={{ font: `400 14px/1 ${sans}`, color: TX3 }}>
            No blocks indexed yet — the strip fills as the first finalized blocks arrive.
          </span>
        )}
      </div>
    </section>
  );
}

function BlockCard({ b, newest, fresh, stage }: { b: Block; newest: boolean; fresh: boolean; stage: StageRow | null }) {
  const proposer = b.proposer_name ?? (b.proposer_id !== null ? `Validator #${b.proposer_id}` : null);
  const open = () => {
    window.location.hash = `/blocks/${b.number}`;
  };
  return (
    <div
      role="link"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      title={`block ${fmt(b.number)} · finalized\nproposed by ${proposer ?? "unattributed"}\n` +
        `${b.tx_count} transactions\n${new Date(b.time).toUTCString()}`}
      className={fresh ? "pipeline-card pipeline-card-new" : "pipeline-card"}
      style={{
        minWidth: 198,
        maxWidth: 220,
        minHeight: 76,
        padding: "10px 12px",
        borderRadius: 10,
        border: `1px solid ${newest ? "var(--brand)" : "var(--line)"}`,
        background: "var(--panel2)",
        display: "grid",
        gridTemplateColumns: "38px minmax(0,1fr) auto",
        columnGap: 10,
        alignItems: "center",
        cursor: "pointer",
      }}
    >
      <div className="pipeline-logo">
        {b.proposer_id !== null ? (
          <ValidatorAvatar
            id={b.proposer_id}
            seed={b.miner || String(b.proposer_id)}
            hasLogo={!!b.proposer_logo}
            title={proposer ?? undefined}
            size={36}
          />
        ) : (
          <span className="pipeline-logo-fallback">◇</span>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 5, minWidth: 0 }}>
        <span style={{ color: newest ? BRAND : TX, font: `600 13px/1 ${mono}` }}>#{fmt(b.number)}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          {proposer ? (
            <span
              style={{
                font: `600 13px/1 ${sans}`,
                color: TX,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {proposer}
            </span>
          ) : <span style={{ color: TX3, font: `400 13px/1 ${sans}` }} title={b.miner}>{short(b.miner)}</span>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 7, font: `400 12px/1 ${sans}`, color: TX3 }}>
          <span>{fmt(b.tx_count)} tx · <Timestamp value={b.time} /></span>
          <span className="pipeline-stage" style={{ color: OK, marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }} title="Monad indexes finalized blocks only">
            <LiveStageDots row={stage} />
            {stage?.verified_at ? "Verified" : "Finalized"}
          </span>
        </div>
      </div>
      <span className="pipeline-chevron" aria-hidden="true">›</span>
    </div>
  );
}

const arrowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  padding: "0 7px",
  font: `400 15px/1 ${mono}`,
  color: TX3,
};
