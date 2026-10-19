import { displayTimestamp, useAppearance } from "../appearance";
export function Timestamp({ value, now }: { value: string | null | undefined; now?: number }) {
  const { relativeTimes } = useAppearance();
  return <span className="explorer-timestamp" title={value && Number.isFinite(Date.parse(value)) ? new Date(value).toUTCString() : undefined}>{displayTimestamp(value, relativeTimes, now)}</span>;
}
