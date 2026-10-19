/** Formatting, identicon and SVG-geometry helpers ported from the mockup. */

export function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US");
}

export function pct(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${n.toFixed(digits)}%`;
}

export function secs(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${n.toFixed(digits)}s`;
}

/** Consensus addresses are long hex; the mockup shows head-6 … tail-4. */
export function short(a: string | null | undefined): string {
  if (!a) return "—";
  return a.length <= 12 ? a : `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function agoText(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)} d`;
}

export function agoFrom(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  return agoText((now - t) / 1000);
}

/** Flag emoji for a 2-letter country code ("MT" → 🇲🇹); "" when unknown. */
export function flag(code: string | null | undefined): string {
  if (!code || code.length !== 2) return "";
  const base = 0x1f1e6 - 65; // 'A' → regional indicator A
  const cc = code.toUpperCase();
  return String.fromCodePoint(base + cc.charCodeAt(0), base + cc.charCodeAt(1));
}

/** FNV-1a — deterministic identicon seed from an address. */
export function hash(s: string): number {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) {
    x ^= s.charCodeAt(i);
    x = Math.imul(x, 16777619);
  }
  return x >>> 0;
}

export type Identicon = { hue: number; cells: string[]; chip: string };

/**
 * A 4×4 horizontally-mirrored bit grid keyed off the address hash — the same
 * construction the mockup uses, so a given address renders identically.
 */
export function identicon(address: string): Identicon {
  const h = hash(address);
  const hue = h % 340;
  const bits: number[] = [];
  for (let row = 0; row < 4; row++) {
    const a = (h >> (row * 4)) & 1;
    const b = (h >> (row * 4 + 2)) & 1;
    bits.push(a, b, b, a);
  }
  return {
    hue,
    cells: bits.map((b) => (b ? `hsl(${hue} 68% 58%)` : "transparent")),
    chip: `hsl(${hue} 60% 50% / .16)`,
  };
}

/**
 * Gaps in a bucketed series are carried forward rather than drawn as zero — a
 * minute with no blocks means "no sample", not "block time collapsed".
 */
export function fill(values: (number | null)[]): number[] {
  const out: number[] = [];
  let last: number | null = null;
  for (const v of values) {
    if (v !== null && Number.isFinite(v)) last = v;
    if (last !== null) out.push(last);
  }
  return out;
}

/** Polyline points for a series clamped into [min,max] over a w×h viewBox. */
export function pts(arr: number[], w: number, h: number, min: number, max: number): string {
  const n = arr.length;
  if (n === 0) return "";
  if (n === 1) {
    const y = h - ((clamp(arr[0], min, max) - min) / (max - min)) * h;
    return `0,${y.toFixed(1)} ${w},${y.toFixed(1)}`;
  }
  return arr
    .map((v, i) => {
      const x = ((i / (n - 1)) * w).toFixed(1);
      const y = (h - ((clamp(v, min, max) - min) / (max - min)) * h).toFixed(1);
      return `${x},${y}`;
    })
    .join(" ");
}

/** Closed path under the same polyline, for the soft area fill. */
export function area(arr: number[], w: number, h: number, min: number, max: number): string {
  const p = pts(arr, w, h, min, max);
  if (!p) return "";
  return `M0,${h} L${p.split(" ").join(" L")} L${w},${h} Z`;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function clampPct(v: number, min: number, max: number): string {
  const t = ((v - min) / (max - min)) * 100;
  return `${Math.max(2, Math.min(100, t)).toFixed(0)}%`;
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* clipboard blocked (insecure origin) — the copy affordance just no-ops */
  }
}

/** CSV escaping for the validators export. */
export function toCsv(rows: (string | number | null)[][]): string {
  return rows
    .map((r) =>
      r
        .map((c) => {
          const s = c === null || c === undefined ? "" : String(c);
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(","),
    )
    .join("\n");
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Head…tail truncation for bech32 addresses and hashes (secret1q9…7xk4). */
export function middle(a: string | null | undefined, head = 10, tail = 6): string {
  if (!a) return "—";
  return a.length <= head + tail + 1 ? a : `${a.slice(0, head)}…${a.slice(-tail)}`;
}

type DenomInfo = { display: string; base: string; exponent: number } | null | undefined;

/**
 * Base-denom amount → display units ("1613481588" uscrt → "1,613.48 SCRT").
 * String math up front so 15+ digit token counts don't lose precision before
 * rounding; unknown denoms (IBC vouchers) are shown raw with their denom.
 */
export function coin(amount: string | null | undefined, denom: string, info: DenomInfo, digits = 2): string {
  if (amount === null || amount === undefined || !/^\d+$/.test(amount)) return "—";
  if (!info || denom !== info.base) {
    const d = denom.startsWith("ibc/") ? `${denom.slice(0, 8)}…` : denom;
    return `${BigInt(amount).toLocaleString("en-US")} ${d}`;
  }
  const v = Number(amount) / 10 ** info.exponent;
  const shown =
    v !== 0 && Math.abs(v) < 10 ** -digits
      ? v.toPrecision(2)
      : v.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits });
  return `${shown} ${info.display}`;
}

/** Compact display amount: 841,102,213.79 → "841.1M". */
export function compactUnits(amount: string | null | undefined, info: DenomInfo): string {
  if (!amount || !/^\d+$/.test(amount) || !info) return "—";
  const v = Number(amount) / 10 ** info.exponent;
  return v.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 });
}

/** Seconds → "4d 12h", "36m 22s"; for countdowns and periods. */
export function duration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

/* ── Monad / EVM formatting ────────────────────────────────────────────── */

/** Wei-like integer string → decimal string with `decimals`, trimmed, grouped. */
export function formatUnits(value: string | null | undefined, decimals = 18, maxFraction = 6): string {
  if (value === null || value === undefined || !/^-?\d+$/.test(value)) return "—";
  const v = BigInt(value);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").slice(0, maxFraction).replace(/0+$/, "");
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (abs !== 0n && whole === 0n && !frac) return `<0.${"0".repeat(Math.max(0, maxFraction - 1))}1`;
  return `${neg ? "-" : ""}${wholeStr}${frac ? `.${frac}` : ""}`;
}

export const mon = (wei: string | null | undefined, maxFraction = 4) => (wei == null ? "—" : `${formatUnits(wei, 18, maxFraction)} MON`);

/** Compact MON: "2,214,658,182 MON" → "2.21B MON". */
export function monCompact(wei: string | null | undefined): string {
  if (!wei || !/^\d+$/.test(wei)) return "—";
  const v = Number(BigInt(wei) / 10n ** 12n) / 1e6;
  return `${v.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 })} MON`;
}

/** Gas price in gwei (Monad's base fee sits around 100 gwei). */
export const gwei = (wei: string | null | undefined, digits = 2) => (wei ? `${formatUnits(wei, 9, digits)} gwei` : "—");

/** Monad's staking precompile; block rewards arrive as system calls to it. */
export const STAKING_PRECOMPILE = "0x0000000000000000000000000000000000001000";

/**
 * Well-known 4-byte selectors. A name here is a guess from the selector alone
 * (collisions exist), so the UI shows it as a label, never as decoded intent.
 */
const SELECTORS: Record<string, string> = {
  "0xa9059cbb": "transfer",
  "0x23b872dd": "transferFrom",
  "0x095ea7b3": "approve",
  "0xd0e30db0": "deposit",
  "0x2e1a7d4d": "withdraw",
  "0x38ed1739": "swapExactTokensForTokens",
  "0x7ff36ab5": "swapExactETHForTokens",
  "0x18cbafe5": "swapExactTokensForETH",
  "0x3593564c": "execute",
  "0x5ae401dc": "multicall",
  "0xac9650d8": "multicall",
  "0x1fad948c": "handleOps",
  "0x765e827f": "handleOps",
  "0x40c10f19": "mint",
  "0x42966c68": "burn",
  "0xa694fc3a": "stake",
  "0x2e17de78": "unstake",
  "0x4e71d92d": "claim",
  "0xb6b55f25": "deposit",
  "0x6a761202": "execTransaction",
  "0xf2fde38b": "transferOwnership",
};

export function methodLabel(method: string | null | undefined, inputSize = 0, to: string | null = "0x"): string {
  if (!to) return "Create";
  if (to === STAKING_PRECOMPILE && method && !SELECTORS[method]) return "Staking";
  if (!method) return inputSize ? "Call" : "Transfer";
  return SELECTORS[method] ?? method;
}

export const isAddr = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s);
export const isTxHash = (s: string) => /^0x[0-9a-fA-F]{64}$/.test(s);
