/** Shared icon badges for the overview cards and metrics. */
export type MetricIcon = "block" | "clock" | "signing" | "validators" | "lag" | "health" | "changes" | "transactions" | "insights";

export function MetricGlyph({ icon }: { icon: MetricIcon }) {
  const paths: Record<MetricIcon, string> = {
    transactions: "M3 6h13m-3-3 3 3-3 3M17 14H4m3-3-3 3 3 3",
    insights: "M4 3h12a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm3 10V9m3 4V6m3 7V8",
    block: "M10 2.7 16.2 6v8L10 17.3 3.8 14V6L10 2.7ZM3.8 6 10 9.4 16.2 6M10 9.4v7.9",
    clock: "M10 3.2a6.8 6.8 0 1 0 0 13.6 6.8 6.8 0 0 0 0-13.6ZM10 6.2v4l2.7 1.7",
    signing: "M11.2 2.8 4.6 11h4.8l-1 6.2 6.6-8.2h-4.8l1-6.2Z",
    validators: "M10 9a2.7 2.7 0 1 0 0-5.4A2.7 2.7 0 0 0 10 9Zm-5.3 7.2c.2-3 2-4.7 5.3-4.7s5.1 1.7 5.3 4.7M4.2 9a2.2 2.2 0 0 1 2-3.4M15.8 9a2.2 2.2 0 0 0-2-3.4",
    lag: "M4 6.2 10 3l6 3.2-6 3.3-6-3.3ZM4 10.1l6 3.2 6-3.2M4 14l6 3 6-3",
    health: "M10 16.8S3.2 13 3.2 8.5A3.4 3.4 0 0 1 10 7.1a3.4 3.4 0 0 1 6.8 1.4c0 4.5-6.8 8.3-6.8 8.3Z",
    changes: "M6.3 8.6a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM13.8 9.2a2.2 2.2 0 1 0 0-4.4M2.8 16.5c.2-3 1.3-4.5 3.5-4.5s3.3 1.5 3.5 4.5M11.2 12.2c2.8-.9 4.7.5 5.2 3.8",
  };
  return <span className={`metric-glyph metric-glyph-${icon}`} aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round"><path d={paths[icon]} /></svg></span>;
}

