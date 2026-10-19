/**
 * Transaction dependency graph of one block, drawn as lanes: each column is a
 * depth level (level 0 = depends on nothing earlier), each box a transaction,
 * each curve "tx `to` read or overwrote state tx `from` wrote". Hovering,
 * focusing or clicking a box traces what it waits on and what waits on it.
 * Shared by the Parallelism drill-down and the block inspector.
 */
import { useMemo, useState, type CSSProperties } from "react";
import type { Labels } from "../api";
import { methodLabel, short } from "../lib";
import { txRoute } from "../transactionExplorer";
import "../pages/parallelism.css";

export type LaneTx = { index: number; hash: string; to: string | null; method: string | null };

type Props = {
  levels: number[];
  edges: [number, number][];
  /** Edges the server counted; `edges` may be capped below this. */
  totalEdges?: number;
  txs?: LaneTx[];
  labels?: Labels;
  compact?: boolean;
  /** Most edges drawn at once; the rest are summarised in the footer. */
  maxEdges?: number;
  /** Controlled highlight (e.g. a hovered table row); omit for internal state. */
  active?: number | null;
  onActive?: (index: number | null) => void;
};

type Geometry = { x: number; y: number };

const DIM = {
  full: { w: 38, h: 24, gy: 6, gx: 6, lane: 34, rows: 10, top: 22 },
  compact: { w: 25, h: 17, gy: 4, gx: 4, lane: 20, rows: 6, top: 16 },
};

export const labelFor = (labels: Labels | undefined, addr: string | null | undefined) =>
  addr ? labels?.[addr.toLowerCase()]?.name ?? labels?.[addr]?.name ?? null : null;

export function DependencyLanes({ levels, edges, totalEdges, txs, labels, compact = false, maxEdges, active: controlled, onActive }: Props) {
  const d = compact ? DIM.compact : DIM.full;
  const cap = maxEdges ?? (compact ? 160 : 700);
  const n = levels.length;
  const [hover, setHover] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const active = controlled !== undefined && controlled !== null ? controlled : hover ?? pinned;
  const setActive = (i: number | null) => { setHover(i); onActive?.(i); };

  const graph = useMemo(() => {
    const valid = edges.filter(([a, b]) => Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b < n && a < b);
    const preds: number[][] = Array.from({ length: n }, () => []);
    const succs: number[][] = Array.from({ length: n }, () => []);
    for (const [a, b] of valid) { preds[b]!.push(a); succs[a]!.push(b); }
    // Columns: one per level, split into sub-columns of `rows` boxes.
    const maxLevel = n ? Math.max(0, ...levels.map((l) => (Number.isFinite(l) && l >= 0 ? l : 0))) : 0;
    const byLevel: number[][] = Array.from({ length: maxLevel + 1 }, () => []);
    levels.forEach((l, i) => byLevel[Number.isFinite(l) && l >= 0 ? l : 0]!.push(i));
    const pos: Geometry[] = new Array(n);
    const columns: { level: number; x: number; width: number; count: number }[] = [];
    let x = 0, rowsUsed = 1;
    byLevel.forEach((members, level) => {
      const sub = Math.max(1, Math.ceil(members.length / d.rows));
      const width = sub * d.w + (sub - 1) * d.gx;
      members.forEach((tx, k) => {
        const col = Math.floor(k / d.rows), row = k % d.rows;
        pos[tx] = { x: x + col * (d.w + d.gx), y: d.top + row * (d.h + d.gy) };
      });
      rowsUsed = Math.max(rowsUsed, Math.min(d.rows, members.length));
      columns.push({ level, x, width, count: members.length });
      x += width + d.lane;
    });
    const width = Math.max(d.w, x - d.lane);
    // Edges that skip levels bow below the boxes instead of running through them.
    const bowMax = compact ? 22 : 44;
    const hasLong = valid.some(([a, b]) => (levels[b] ?? 0) - (levels[a] ?? 0) > 1);
    const height = d.top + rowsUsed * (d.h + d.gy) - d.gy + (hasLong ? bowMax : 0);
    const rowsBottom = d.top + rowsUsed * (d.h + d.gy) - d.gy;
    // One longest chain, walked back from the deepest transaction.
    const chain = new Set<string>();
    const chainTx = new Set<number>();
    let cur = levels.findIndex((l) => l === maxLevel);
    if (cur >= 0 && maxLevel > 0) {
      chainTx.add(cur);
      while (levels[cur]! > 0) {
        const p = preds[cur]!.find((q) => levels[q] === levels[cur]! - 1);
        if (p === undefined) break;
        chain.add(`${p}-${cur}`); chainTx.add(p); cur = p;
      }
    }
    return { valid, preds, succs, pos, columns, width, height, chain, chainTx, maxLevel, bowMax, rowsBottom };
  }, [levels, edges, n, d]);

  const reach = useMemo(() => {
    if (active === null || active >= n) return null;
    const walk = (start: number, next: number[][]) => {
      const seen = new Set<number>(), stack = [start];
      while (stack.length) for (const v of next[stack.pop()!]!) if (!seen.has(v)) { seen.add(v); stack.push(v); }
      return seen;
    };
    return { anc: walk(active, graph.preds), desc: walk(active, graph.succs) };
  }, [active, graph, n]);

  const drawn = useMemo(() => {
    const { valid, chain } = graph;
    const key = (e: [number, number]) => `${e[0]}-${e[1]}`;
    let base = valid;
    if (valid.length > cap) {
      const crit = valid.filter((e) => chain.has(key(e)));
      base = [...crit, ...valid.filter((e) => !chain.has(key(e))).slice(0, Math.max(0, cap - crit.length))];
    }
    if (!reach || active === null) return { list: base, extra: 0 };
    const anc = new Set([...reach.anc, active]), desc = new Set([...reach.desc, active]);
    const rel = (e: [number, number]) => (anc.has(e[0]) && anc.has(e[1])) || (desc.has(e[0]) && desc.has(e[1]));
    const inBase = new Set(base.map(key));
    const extra = valid.filter((e) => rel(e) && !inBase.has(key(e))).slice(0, cap);
    // Relevant edges last so they paint on top.
    const list = [...base.filter((e) => !rel(e)), ...base.filter(rel), ...extra];
    return { list, extra: extra.length };
  }, [graph, reach, active, cap]);

  if (!n) return <div className="dl-empty">No transactions to lay out.</div>;

  const { pos, columns, width, height, chain, chainTx, preds, succs } = graph;
  const path = (a: number, b: number) => {
    const p = pos[a], q = pos[b];
    if (!p || !q) return "";
    const x1 = p.x + d.w, y1 = p.y + d.h / 2, x2 = q.x, y2 = q.y + d.h / 2;
    const span = (levels[b] ?? 0) - (levels[a] ?? 0);
    if (span > 1) {
      // Leave from the box's bottom, dip under the rows, rise into the target's bottom.
      const sx = p.x + d.w / 2, sy = p.y + d.h, tx = q.x + d.w / 2, ty = q.y + d.h;
      const floor = graph.rowsBottom + Math.min(graph.bowMax - 4, 6 + span * 2);
      return `M${sx},${sy} C${sx},${floor} ${tx},${floor} ${tx},${ty}`;
    }
    const c = Math.max(10, (x2 - x1) * 0.5);
    return `M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2},${y2}`;
  };
  const edgeClass = (a: number, b: number) => {
    if (reach && active !== null) {
      const inA = (v: number) => v === active || reach.anc.has(v), inD = (v: number) => v === active || reach.desc.has(v);
      if (inA(a) && inA(b)) return "anc";
      if (inD(a) && inD(b)) return "desc";
      return "dim";
    }
    return chain.has(`${a}-${b}`) ? "crit" : "";
  };
  const boxClass = (i: number) => {
    const cls = [i === 0 ? "sys" : preds[i]!.length ? "dep" : "free"];
    if (chainTx.has(i) && active === null) cls.push("crit");
    if (active !== null && reach) cls.push(i === active ? "active" : reach.anc.has(i) ? "anc" : reach.desc.has(i) ? "desc" : "dim");
    if (pinned === i) cls.push("pinned");
    return cls.join(" ");
  };
  const info = (i: number) => txs?.find((t) => t.index === i) ?? txs?.[i];
  const describe = (i: number) => {
    const t = info(i);
    const target = t ? (t.to ? labelFor(labels, t.to) ?? short(t.to) : "contract creation") : null;
    const parts = [`Tx #${i}`, `level ${levels[i] ?? 0}`];
    if (i === 0) parts.push("block reward syscall, excluded");
    else parts.push(`waits on ${preds[i]!.length}`, `${succs[i]!.length} wait on it`);
    if (t) parts.push(`${methodLabel(t.method, t.method ? 4 : 0, t.to)} → ${target}`);
    return parts.join(" · ");
  };
  const total = totalEdges ?? graph.valid.length;
  const hiddenEdges = Math.max(0, graph.valid.length - drawn.list.length);
  const serverCapped = total > graph.valid.length;
  const current = active !== null && active < n ? active : null;
  const t = current !== null ? info(current) : undefined;

  return <div className={`dl ${compact ? "dl-compact" : ""}`}>
    <div className="dl-scroll" tabIndex={-1}>
      <div className="dl-canvas" style={{ width, height } as CSSProperties} role="group" aria-label={`Dependency lanes: ${n} transactions in ${columns.length} levels. Focus a transaction to trace its dependencies.`} onPointerLeave={() => setActive(null)}>
        {columns.map((c) => <span key={c.level} className="dl-level" style={{ left: c.x, width: c.width }} aria-hidden="true">{compact ? c.level : `L${c.level}`}</span>)}
        <svg className="dl-edges" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
          {drawn.list.map(([a, b]) => <path key={`${a}-${b}`} d={path(a, b)} className={edgeClass(a, b)} />)}
        </svg>
        {levels.map((_, i) => pos[i] && <button key={i} type="button" className={`dl-tx ${boxClass(i)}`} style={{ left: pos[i]!.x, top: pos[i]!.y, width: d.w, height: d.h }}
          title={describe(i)} aria-label={describe(i)} aria-pressed={pinned === i}
          onPointerEnter={() => setActive(i)} onFocus={() => setActive(i)} onBlur={() => setActive(null)}
          onKeyDown={(e) => { if (e.key === "Escape") { setPinned(null); (e.currentTarget as HTMLButtonElement).blur(); } }}
          onClick={() => setPinned(pinned === i ? null : i)}>{compact && n > 99 ? "" : i}</button>)}
      </div>
    </div>
    <div className="dl-info" aria-live="polite">
      {current !== null && reach ? <>
        <span className="dl-info-main"><strong>Tx #{current}</strong> level {levels[current] ?? 0}{current === 0 ? " · block reward syscall, excluded from the analysis" : <> · <em className="anc">waits on {reach.anc.size}</em> · <em className="desc">{reach.desc.size} wait on it</em></>}{t && !compact && <> · {methodLabel(t.method, t.method ? 4 : 0, t.to)} → {t.to ? labelFor(labels, t.to) ?? short(t.to) : "create"}</>}</span>
        {t && <a href={txRoute(t.hash)}>Open tx ↗</a>}
      </> : <>
        <span className="dl-legend"><i className="free" />Independent<i className="dep" />Dependent<i className="sys" />Syscall (excluded){graph.maxLevel > 0 && <><b className="crit" />Longest chain</>}</span>
        {!compact && <span className="dl-hint">Hover, focus or click a transaction to trace what it waits on and what waits on it.</span>}
      </>}
    </div>
    {(hiddenEdges > 0 || serverCapped) && <p className="dl-cap">{hiddenEdges > 0 ? `Drawing ${drawn.list.length.toLocaleString("en-US")} of ${graph.valid.length.toLocaleString("en-US")} edges (longest chain first); highlighting a transaction draws all of its own.` : ""}{serverCapped ? ` The API returns the first ${graph.valid.length.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} edges; levels and the critical path still count them all.` : ""}</p>}
  </div>;
}
