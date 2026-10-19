/**
 * Primitives shared across pages. Styling is inline and token-driven, matching
 * the mockup's structure so the rendered result is the same box model.
 */
import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { identicon } from "../lib";
import { validatorLogoUrl } from "../api";

export const OK = "var(--ok)";
export const WARN = "var(--warn)";
export const BAD = "var(--bad)";
export const TX = "var(--tx)";
export const TX2 = "var(--tx2)";
export const TX3 = "var(--tx3)";
export const BRAND = "var(--brand)";

export const panel: CSSProperties = {
  background: "var(--panel)",
  border: "1px solid var(--line)",
  borderRadius: 12,
  boxShadow: "var(--shadow)",
};

export const mono = "'JetBrains Mono Variable', 'JetBrains Mono',ui-monospace,monospace";
export const sans = "'Inter Variable', Inter,system-ui,sans-serif";

/** Uppercase micro-label used above every value in the design. */
export function Label({ children, size = 10 }: { children: ReactNode; size?: number }) {
  return (
    <span
      style={{
        font: `600 ${Math.max(12, Math.round(size * 1.25))}px/1.3 ${sans}`,
        letterSpacing: size <= 9 ? ".06em" : ".07em",
        color: TX3,
        textTransform: "uppercase",
      }}
    >
      {children}
    </span>
  );
}

export function Skeleton({ h, w, r = 4 }: { h: number; w: string | number; r?: number }) {
  return (
    <span
      style={{
        display: "block",
        height: h,
        width: w,
        borderRadius: r,
        background:
          "linear-gradient(90deg,var(--skel) 25%,var(--line) 50%,var(--skel) 75%)",
        backgroundSize: "200% 100%",
        animation: "shim 1.4s linear infinite",
      }}
    />
  );
}

export function StatusPill({
  status,
  size = "sm",
}: {
  status: "active" | "degraded" | "inactive" | string;
  size?: "sm" | "md";
}) {
  const map: Record<string, { bg: string; fg: string; label: string }> = {
    active: { bg: "var(--okSoft)", fg: OK, label: "Active" },
    degraded: { bg: "var(--warnSoft)", fg: WARN, label: "Degraded" },
    inactive: { bg: "var(--badSoft)", fg: BAD, label: "Inactive" },
  };
  const s = map[status] ?? { bg: "var(--panel2)", fg: TX3, label: status };
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: size === "md" ? "4px 8px" : "3px 7px",
        borderRadius: 20,
        font: `600 ${size === "md" ? 13 : 12}px/1.2 ${sans}`,
        background: s.bg,
        color: s.fg,
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ width: 4, height: 4, borderRadius: "50%", background: "currentColor" }} />
      {s.label}
    </span>
  );
}


export function Identicon({ address, size = 16 }: { address: string; size?: number }) {
  const ic = identicon(address);
  return (
    <span
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(4,1fr)",
        gap: 1,
        width: size,
        height: size,
        padding: size >= 20 ? 2.5 : 2,
        borderRadius: size >= 20 ? 5 : 4,
        flex: "none",
        background: ic.chip,
      }}
    >
      {ic.cells.map((c, i) => (
        <span key={i} style={{ borderRadius: 0.5, background: c }} />
      ))}
    </span>
  );
}

/**
 * Validator avatar: the operator's registry logo (served same-origin by the
 * API's logo proxy) with an address-derived identicon as fallback. A logo
 * that fails to load falls back client-side too, so a dead URL never leaves
 * a blank slot.
 */
export function ValidatorAvatar({
  id,
  seed,
  hasLogo,
  title,
  size = 20,
}: {
  /** On-chain validator id; null for an unattributed proposer. */
  id: number | null;
  /** Identicon seed (auth address or id) for the fallback. */
  seed: string;
  hasLogo: boolean;
  title?: string;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  const showLogo = id !== null && hasLogo && !failed;
  return showLogo ? (
    <img
      src={validatorLogoUrl(id)}
      alt=""
      title={title}
      loading="lazy"
      onError={() => setFailed(true)}
      style={{
        width: size,
        height: size,
        borderRadius: size >= 20 ? 5 : 4,
        flex: "none",
        objectFit: "cover",
        background: "var(--panel2)",
      }}
    />
  ) : (
    <Identicon address={seed} size={size} />
  );
}

/** Thin progress bar used for uptime and proposer share. */
export function Bar({ width, color, h = 3 }: { width: string; color: string; h?: number }) {
  return (
    <span
      style={{
        height: h,
        borderRadius: 2,
        background: "var(--line)",
        overflow: "hidden",
        display: "block",
      }}
    >
      <span
        style={{ display: "block", height: "100%", borderRadius: 2, width, background: color }}
      />
    </span>
  );
}

export function CopyButton({
  value,
  copied,
  onCopy,
  size = 18,
}: {
  value: string;
  copied: boolean;
  onCopy: (v: string) => void;
  size?: number;
}) {
  const d = copied
    ? "M4 10.5l4 4 8-9"
    : "M7 7V5.5A1.5 1.5 0 018.5 4h6A1.5 1.5 0 0116 5.5v6a1.5 1.5 0 01-1.5 1.5H13M4 8.5A1.5 1.5 0 015.5 7h6A1.5 1.5 0 0113 8.5v6a1.5 1.5 0 01-1.5 1.5h-6A1.5 1.5 0 014 14.5z";
  return (
    <button
      type="button"
      title="Copy address"
      className={copied ? "copy-glow" : undefined}
      onClick={(e) => {
        e.stopPropagation();
        onCopy(value);
      }}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        flex: "none",
        border: "none",
        background: "none",
        padding: 0,
        cursor: "pointer",
        color: copied ? OK : TX3,
      }}
    >
      <svg
        width={size - 6}
        height={size - 6}
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={d} />
      </svg>
    </button>
  );
}

export function Section({
  className,
  title,
  aside,
  children,
  style,
  bodyStyle,
}: {
  className?: string;
  title?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  style?: CSSProperties;
  bodyStyle?: CSSProperties;
}) {
  return (
    <section className={className} style={{ ...panel, display: "flex", flexDirection: "column", overflow: "hidden", ...style }}>
      {title !== undefined && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            padding: "14px 16px 12px",
            borderBottom: "1px solid var(--line)",
          }}
        >
          <h2 style={{ margin: 0, font: `600 16px/1 ${sans}`, color: TX }}>{title}</h2>
          {aside}
        </div>
      )}
      <div style={bodyStyle}>{children}</div>
    </section>
  );
}

export function EmptyState({
  title,
  text,
  dashed,
}: {
  title: string;
  text: string;
  dashed?: boolean;
}) {
  return (
    <div
      style={{
        padding: dashed ? "48px 24px" : "64px 24px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: dashed ? 8 : 10,
        textAlign: "center",
        border: dashed ? "1px dashed var(--line2)" : undefined,
        borderRadius: dashed ? 10 : undefined,
      }}
    >
      {!dashed && (
        <svg width="26" height="26" viewBox="0 0 20 20" fill="none" stroke={TX3} strokeWidth="1.3" strokeLinecap="round">
          <path d="M3 6h14M3 10h14M3 14h14" />
        </svg>
      )}
      <span style={{ font: `600 16px/1.3 ${sans}`, color: TX2 }}>{title}</span>
      <span
        style={{
          font: `400 15px/1.5 ${sans}`,
          color: TX3,
          maxWidth: dashed ? 320 : 300,
        }}
      >
        {text}
      </span>
    </div>
  );
}

/** Line chart with dashed gridlines, matching the mockup's 5-line layout. */
export function LineChart({
  points,
  areaPath,
  stroke,
  fill,
  viewW,
  viewH,
  gridLines = 5,
  height,
}: {
  points: string;
  areaPath: string;
  stroke: string;
  fill: string;
  viewW: number;
  viewH: number;
  gridLines?: number;
  height?: number | string;
}) {
  const lines = Array.from({ length: gridLines }, (_, i) => (i / (gridLines - 1)) * viewH);
  return (
    <svg
      viewBox={`0 0 ${viewW} ${viewH}`}
      preserveAspectRatio="none"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: height ?? "100%",
        overflow: "visible",
      }}
    >
      {lines.map((y, i) => (
        <line key={i} x1="0" y1={y} x2={viewW} y2={y} stroke="var(--grid)" strokeWidth="1" />
      ))}
      {areaPath && <path d={areaPath} fill={fill} />}
      {points && (
        <polyline
          points={points}
          fill="none"
          stroke={stroke}
          strokeWidth="1.6"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}

/**
 * Single-series time chart with a crosshair + tooltip — the interaction layer
 * a plotted chart owes its reader. 2px non-scaling stroke, recessive grid, and
 * a ≥8px hover marker; values/labels wear ink tokens, never the series color.
 * `values` should be gap-filled upstream (a missing bucket is "no sample").
 */
export function TimeSeriesChart({
  values,
  times,
  min,
  max,
  stroke,
  fillColor,
  height = 150,
  formatValue,
  formatTime,
  compact = false,
}: {
  values: number[];
  times: string[];
  min: number;
  max: number;
  stroke: string;
  fillColor: string;
  height?: number | "fill";
  formatValue: (v: number) => string;
  formatTime: (t: string) => string;
  compact?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const n = values.length;

  const xFrac = (i: number) => (n <= 1 ? 0.5 : i / (n - 1));
  const yFrac = (v: number) => {
    const t = (Math.max(min, Math.min(max, v)) - min) / (max - min || 1);
    return 1 - t;
  };

  const onMove = (e: React.PointerEvent) => {
    if (!ref.current || n === 0) return;
    const r = ref.current.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    setHover(Math.round(f * (n - 1)));
  };

  const line = n
    ? values.map((v, i) => `${(xFrac(i) * 100).toFixed(2)},${(yFrac(v) * 100).toFixed(2)}`).join(" ")
    : "";
  const areaP = line ? `M0,100 L${line.split(" ").join(" L")} L100,100 Z` : "";

  return (
    <div
      ref={ref}
      style={{ position: "relative", height: height === "fill" ? "100%" : height, touchAction: "none" }}
      onPointerMove={onMove}
      onPointerLeave={() => setHover(null)}
    >
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
        {(compact ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1]).map((g) => (
            <line key={g} x1="0" y1={g * 100} x2="100" y2={g * 100} stroke="var(--grid)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          ))}
        {areaP && <path d={areaP} fill={fillColor} />}
        {line && (
          <polyline points={line} fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        )}
      </svg>

      {hover !== null && values[hover] !== undefined && (
        <>
          <span style={{ position: "absolute", left: `${xFrac(hover) * 100}%`, top: 0, bottom: 0, width: 1, background: "var(--line2)", transform: "translateX(-.5px)" }} />
          <span
            style={{
              position: "absolute",
              left: `${xFrac(hover) * 100}%`,
              top: `${yFrac(values[hover]) * 100}%`,
              width: 9,
              height: 9,
              borderRadius: "50%",
              background: stroke,
              border: "2px solid var(--panel)",
              transform: "translate(-50%, -50%)",
              boxShadow: "0 0 0 1px var(--line2)",
            }}
          />
          <span
            style={{
              position: "absolute",
              left: `${xFrac(hover) * 100}%`,
              top: `${yFrac(values[hover]) * 100}%`,
              transform: `translate(-50%, -130%) translateY(-8px)`,
              padding: "6px 9px",
              borderRadius: 8,
              background: "var(--panel)",
              border: "1px solid var(--line2)",
              boxShadow: "var(--shadow)",
              whiteSpace: "nowrap",
              display: "flex",
              flexDirection: "column",
              gap: 2,
              pointerEvents: "none",
              // keep the tooltip inside the card at either edge
              marginLeft: hover === 0 ? 40 : hover === n - 1 ? -40 : 0,
            }}
          >
            <span style={{ font: `400 12px/1 ${mono}`, color: TX3 }}>
              {formatTime(times[hover] ?? "")}
            </span>
            <span style={{ font: `600 15px/1 ${mono}`, color: TX }}>
              {formatValue(values[hover])}
            </span>
          </span>
        </>
      )}
    </div>
  );
}

export function Meter({
  label,
  value,
  width,
  color,
  scale,
}: {
  label: string;
  value: string;
  width: string;
  color: string;
  scale: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
        <span style={{ font: `500 14px/1 ${sans}`, color: TX2 }}>{label}</span>
        <span style={{ font: `500 14px/1 ${mono}`, color }}>{value}</span>
      </div>
      <Bar width={width} color={color} h={5} />
      <span style={{ font: `400 12px/1 ${mono}`, color: TX3 }}>{scale}</span>
    </div>
  );
}

/** Small rounded status chip in one of the semantic tones. */
export function Chip({ tone, children, title }: { tone: "ok" | "warn" | "bad" | "brand" | "muted"; children: ReactNode; title?: string }) {
  return (
    <span className={`chip chip-${tone}`} title={title}>
      {children}
    </span>
  );
}
