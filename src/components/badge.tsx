export type BadgeTone = "good" | "bad" | "warn" | "neutral";

const TONE_COLOR: Record<BadgeTone, string> = {
  good: "var(--accent)",
  bad: "var(--danger)",
  warn: "var(--warn)",
  neutral: "var(--muted)",
};

/**
 * Shape-and-color status pill (not color alone), so state reads at a glance
 * for a colorblind viewer and under time pressure. See callers for the
 * status -> tone mapping, which is domain-specific per entity.
 */
export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: React.ReactNode }) {
  const color = TONE_COLOR[tone];
  return (
    <span
      className="badge"
      style={{
        color,
        background: `color-mix(in srgb, ${color} 14%, white)`,
        borderColor: `color-mix(in srgb, ${color} 30%, white)`,
      }}
    >
      <span className="badge-dot" style={{ background: color }} />
      {children}
    </span>
  );
}
