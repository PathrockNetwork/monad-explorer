/** Formatting shared by the gas page, the transaction trace views and the address page. */
import type { AddressLabel, Labels } from "../api";
import { formatUnits, middle, pct } from "../lib";

/** wei → "1,234 MON" / "12.34 MON" / "0.0012 MON": fewer decimals as the amount grows. */
export function monAuto(wei: string | null | undefined): string {
  if (wei == null || !/^-?\d+$/.test(wei)) return "—";
  const abs = wei.startsWith("-") ? BigInt(wei.slice(1)) : BigInt(wei);
  const one = 10n ** 18n;
  const digits = abs >= 1000n * one ? 0 : abs >= one ? 2 : abs >= one / 100n ? 4 : 6;
  return `${formatUnits(wei, 18, digits)} MON`;
}

/** Signed MON delta between two wei amounts; null when either side is unknown. */
export function monDelta(before: string | null, after: string | null): { text: string; sign: -1 | 0 | 1 } | null {
  if (before == null || after == null || !/^\d+$/.test(before) || !/^\d+$/.test(after)) return null;
  const d = BigInt(after) - BigInt(before);
  if (d === 0n) return { text: "0 MON", sign: 0 };
  return { text: `${d > 0n ? "+" : ""}${formatUnits(d.toString(), 18, 6)} MON`, sign: d > 0n ? 1 : -1 };
}

export const isPositiveWei = (wei: string | null | undefined) => !!wei && /^\d+$/.test(wei) && BigInt(wei) > 0n;

/** Efficiency (0–1) → percentage text; "—" when unknown. */
export const effText = (e: number | null | undefined, digits = 1) => (e == null || !Number.isFinite(e) ? "—" : pct(e * 100, digits));

/** Display tone for an efficiency figure: most of the limit used is good. */
export function effTone(e: number | null | undefined): "ok" | "warn" | "bad" | "muted" {
  if (e == null || !Number.isFinite(e)) return "muted";
  return e >= 0.8 ? "ok" : e >= 0.5 ? "warn" : "bad";
}

export const toneVar = (tone: string) => (tone === "ok" ? "var(--ok)" : tone === "warn" ? "var(--warn)" : tone === "bad" ? "var(--bad)" : "var(--tx3)");

/** Known label for an address, else a shortened address. */
export function addressName(address: string | null | undefined, label?: AddressLabel | null, labels?: Labels, head = 8, tail = 4): string {
  if (!address) return "—";
  const l = label ?? labels?.[address.toLowerCase()] ?? null;
  return l?.name ?? middle(address, head, tail);
}

/** Compact integer: 1,658,050 → "1.66M". */
export const compactNum = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "—" : n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 });

export const isAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s.trim());
