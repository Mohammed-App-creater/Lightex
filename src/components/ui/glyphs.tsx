"use client";

import { cn } from "@/lib/utils/cn";

export type GlyphKind = "backlog" | "todo" | "progress" | "review" | "done" | "canceled";

/** Colour per glyph kind (board 01 "Status"). Status is always glyph + colour. */
export const glyphColor: Record<GlyphKind, string> = {
  backlog: "var(--text-3)",
  todo: "var(--todo)",
  progress: "var(--warn)",
  review: "var(--info)",
  done: "var(--ok)",
  canceled: "var(--text-3)",
};

export const glyphLabel: Record<GlyphKind, string> = {
  backlog: "Backlog",
  todo: "Todo",
  progress: "In progress",
  review: "In review",
  done: "Done",
  canceled: "Canceled",
};

export function StatusGlyph({
  kind,
  spark,
  label,
  className,
  color,
}: {
  kind: GlyphKind;
  /** Play the completion spark (only meaningful for "done"). */
  spark?: boolean;
  /** Accessible name. Omit when a visible label sits next to the glyph. */
  label?: string;
  className?: string;
  color?: string;
}) {
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("glyph", `glyph-${kind}`, spark && kind === "done" && "spark", className)}
      style={{ color: color ?? glyphColor[kind] }}
    />
  );
}

export function ErrorGlyph({ tone = "danger", className }: { tone?: "danger" | "warn"; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("glyph glyph-error", className)}
      style={{ color: tone === "warn" ? "var(--warn)" : "var(--danger)" }}
    />
  );
}

export type PriorityLevel = 0 | 1 | 2 | 3 | 4;

export const priorityMeta: Record<PriorityLevel, { label: string; color: string; short: string }> = {
  4: { label: "Urgent", color: "var(--danger)", short: "urgent" },
  3: { label: "High", color: "var(--orange)", short: "high" },
  2: { label: "Medium", color: "var(--warn)", short: "medium" },
  1: { label: "Low", color: "var(--low)", short: "low" },
  0: { label: "No priority", color: "var(--text-3)", short: "none" },
};

/** Urgent renders as a filled "!" tile; others as 4 signal bars (board 03). */
export function PriorityIcon({
  level,
  label,
  className,
  bars,
}: {
  level: PriorityLevel;
  label?: string;
  className?: string;
  /** Force bars even for Urgent (list cells use 4 filled bars). */
  bars?: boolean;
}) {
  const meta = priorityMeta[level];
  const a11y = label ? { role: "img" as const, "aria-label": label } : { "aria-hidden": true as const };
  if (level === 4 && !bars) {
    return (
      <span
        {...a11y}
        className={cn("relative inline-flex size-3.5 flex-none items-center justify-center rounded-xs", className)}
        style={{ background: meta.color }}
      >
        <span className="text-[10px] font-bold leading-none" style={{ color: "var(--bg)" }}>
          !
        </span>
      </span>
    );
  }
  return (
    <span {...a11y} className={cn("prio", className)} data-level={level} style={{ color: meta.color }}>
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}
