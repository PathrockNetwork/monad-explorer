import { useSyncExternalStore } from "react";
import { agoFrom } from "./lib";

export type Appearance = { density: "compact" | "default" | "spacious"; relativeTimes: boolean; reduceMotion: boolean; codeSize: 12 | 14 | 16 };
export const APPEARANCE_KEY = "monad-explorer-appearance";
export const DEFAULT_APPEARANCE: Appearance = { density: "default", relativeTimes: true, reduceMotion: false, codeSize: 14 };
export function parseAppearance(raw: string | null): Appearance {
  try {
    const value = JSON.parse(raw ?? "null");
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_APPEARANCE };
    return {
      density: ["compact", "default", "spacious"].includes(value.density) ? value.density : DEFAULT_APPEARANCE.density,
      relativeTimes: typeof value.relativeTimes === "boolean" ? value.relativeTimes : DEFAULT_APPEARANCE.relativeTimes,
      reduceMotion: typeof value.reduceMotion === "boolean" ? value.reduceMotion : DEFAULT_APPEARANCE.reduceMotion,
      codeSize: [12, 14, 16].includes(value.codeSize) ? value.codeSize : DEFAULT_APPEARANCE.codeSize,
    };
  } catch { return { ...DEFAULT_APPEARANCE }; }
}
function read(): Appearance { try { return parseAppearance(localStorage.getItem(APPEARANCE_KEY)); } catch { return { ...DEFAULT_APPEARANCE }; } }
let current = read();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function updateAppearance(patch: Partial<Appearance>): void {
  current = parseAppearance(JSON.stringify({ ...current, ...patch }));
  try { localStorage.setItem(APPEARANCE_KEY, JSON.stringify(current)); } catch { /* Preferences remain usable for this tab when storage is unavailable. */ }
  listeners.forEach(listener => listener());
}
if (typeof window !== "undefined") window.addEventListener("storage", event => {
  if (event.key !== APPEARANCE_KEY && event.key !== null) return;
  current = read(); listeners.forEach(listener => listener());
});
export function useAppearance(): Appearance { return useSyncExternalStore(subscribe, () => current, () => DEFAULT_APPEARANCE); }
export function preferredScrollBehavior(): ScrollBehavior { return current.reduceMotion || (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) ? "instant" : "smooth"; }
export function displayTimestamp(value: string | null | undefined, relative: boolean, now = Date.now()): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return relative ? `${agoFrom(value, now)} ago` : `${new Date(value).toISOString().replace("T", " ").slice(0, 19)} UTC`;
}
