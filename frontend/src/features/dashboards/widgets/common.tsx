"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import { TipCard, type TipRow } from "@/features/reports/chart-kit";
import { useProjectMembers } from "@/features/projects/queries";
import type { Project, User } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";

/* Shared bits of the bar-list widgets (design `.hb` rows) and the people lookup for toasts. */

export type WidgetProps = {
  project: Project;
  /** The widget's height in rows (My tasks shows as many rows as fit). */
  h: number;
  mobile: boolean;
  reduce: boolean;
};

/** userId → { name, hue } from the project members (toasts, activity rows). */
export function useWho(projectId: string) {
  const { data: members = [] } = useProjectMembers(projectId);
  const byId = new Map<string, Pick<User, "name" | "hue">>(members.map((m) => [m.userId, m.user]));
  return (id: string) => byId.get(id) ?? null;
}

/**
 * One bar row: hover / focus shows the tooltip card above it (design `.tip.row`). The row is a
 * button so keyboard users reach the tooltip; its aria-label carries the same numbers.
 */
export function BarRow({
  columns,
  label,
  tipHead,
  tipRows,
  flash,
  children,
}: {
  columns: string;
  label: string;
  tipHead: ReactNode;
  tipRows: TipRow[];
  flash?: boolean;
  children: ReactNode;
}) {
  const [on, setOn] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      onMouseEnter={() => setOn(true)}
      onMouseLeave={() => setOn(false)}
      onFocus={() => setOn(true)}
      onBlur={() => setOn(false)}
      className={cn(
        "relative -mx-1.5 grid h-7 w-[calc(100%+12px)] flex-none cursor-default items-center gap-2.5 rounded-sm border-0 bg-transparent px-1.5 text-left text-[12.5px] text-fg hover:bg-hover focus-visible:bg-hover",
        on && "z-[5]",
        flash && "hl",
      )}
      style={{ gridTemplateColumns: columns }}
    >
      {children}
      {on && <TipCard head={tipHead} rows={tipRows} className="absolute bottom-[calc(100%+4px)] right-0 z-[8]" />}
    </button>
  );
}

/** Track + fill(s) + tick (design `.hb-tr` / `.hb-f` / `.hb-f2` / `.hb-tg`). Widths in %. */
export function BarTrack({ fills, tick, neutral }: { fills: { from: number; width: number; color: string; round?: "all" | "end" }[]; tick?: number | null; neutral?: boolean }) {
  return (
    <span aria-hidden className={cn("relative h-2 rounded-[4px]", neutral ? "bg-raised" : "bg-c1-t")}>
      {fills.map((f, i) => (
        <span
          key={i}
          className={cn("absolute bottom-0 top-0 origin-left transition-transform duration-[600ms] ease-out motion-reduce:transition-none", f.round === "end" ? "rounded-r-[4px]" : "rounded-[4px]")}
          style={{ left: `${f.from}%`, width: `${Math.max(0, f.width)}%`, background: f.color } as CSSProperties}
        />
      ))}
      {tick != null && (
        <span className="absolute -bottom-1 -top-1 -ml-px w-0.5 rounded-[1px] bg-fg shadow-[0_0_0_1px_var(--surface)]" style={{ left: `${Math.max(0, Math.min(100, tick))}%` }} />
      )}
    </span>
  );
}

export const pct = (v: number, scale: number) => (scale > 0 ? (v / scale) * 100 : 0);
