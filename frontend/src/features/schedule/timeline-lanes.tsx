"use client";

import { Flag, RefreshCcw } from "lucide-react";
import Link from "next/link";
import { forwardRef, type ReactNode } from "react";
import type { Milestone, Sprint, TimelineZoom } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";
import { barGeometry, dayCenter, fmtDay, overlaps, type Tick, type Window } from "./schedule-lib";

/* Board 32 timeline chrome: axis (design .tl-head), overlay (.tl-ov), Milestones and Sprints lanes. */

/** Two tick rows + the "Today" pill. Sticky to the top of the timeline's own scroller. */
export const TimelineAxis = forwardRef<HTMLDivElement, { label: string; labelWidth: number; ticks: { row1: Tick[]; row2: Tick[] }; today: number | null }>(
  function TimelineAxis({ label, labelWidth, ticks, today }, laneRef) {
    return (
      <div className="sticky top-0 z-[8] grid border-b border-line bg-bg" style={{ gridTemplateColumns: `${labelWidth}px minmax(0,1fr)` }}>
        <div className="sticky left-0 z-[1] flex items-end border-r border-line bg-bg px-3 pb-[9px] font-mono text-[11px] font-medium uppercase leading-none tracking-[.06em] text-fg-3">
          {label}
        </div>
        <div ref={laneRef} aria-hidden className="relative h-[52px] overflow-hidden">
          <div className="absolute inset-x-0 top-0 h-[26px]">
            {ticks.row1.map((t) => (
              <span
                key={`a${t.x}`}
                className="absolute inset-y-0 flex items-center overflow-hidden whitespace-nowrap border-l border-line-2 pl-2 font-mono text-[11px] font-semibold text-fg-2"
                style={{ left: `${t.x}%`, width: `${t.w}%` }}
              >
                {t.label}
              </span>
            ))}
          </div>
          <div className="absolute inset-x-0 top-[26px] h-[26px] border-t border-line">
            {ticks.row2.map((t) => (
              <span
                key={`b${t.x}`}
                className={cn(
                  "absolute inset-y-0 flex items-center overflow-hidden whitespace-nowrap border-l border-line font-mono text-[11px] font-medium text-fg-3",
                  t.centered ? "justify-center" : "pl-2",
                  t.weekend && "bg-fg-3/[0.06]",
                  t.today && "font-semibold text-accent-t",
                )}
                style={{ left: `${t.x}%`, width: `${t.w}%` }}
              >
                {t.label}
              </span>
            ))}
          </div>
          {today !== null && (
            <span
              className="absolute top-1 z-[2] h-[18px] -translate-x-1/2 whitespace-nowrap rounded-[5px] bg-bg px-1.5 font-mono text-[10.5px] font-semibold leading-[18px] text-accent-t shadow-[inset_0_0_0_1px_var(--accent-t)]"
              style={{ left: `${today}%` }}
            >
              Today
            </span>
          )}
        </div>
      </div>
    );
  },
);

/** Weekend bands, gridlines, milestone guides and the today line, under the bars. */
export function TimelineOverlay({
  labelWidth,
  weekends,
  lines,
  guides,
  today,
}: {
  labelWidth: number;
  weekends: { x: number; w: number }[];
  lines: { x: number; major: boolean }[];
  guides: number[];
  today: number | null;
}) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 overflow-hidden" style={{ left: labelWidth }}>
      {weekends.map((w) => (
        <span key={`w${w.x}`} className="absolute inset-y-0 bg-fg-3/[0.05]" style={{ left: `${w.x}%`, width: `${w.w}%` }} />
      ))}
      {lines.map((l) => (
        <span key={`l${l.x}${l.major}`} className={cn("absolute inset-y-0 w-0 border-l", l.major ? "border-line-2" : "border-line")} style={{ left: `${l.x}%` }} />
      ))}
      {guides.map((x) => (
        <span key={`g${x}`} className="absolute inset-y-0 w-0 border-l border-dashed border-line-2" style={{ left: `${x}%` }} />
      ))}
      {today !== null && <span className="absolute inset-y-0 w-0 border-l-[1.5px] border-accent-t opacity-85" style={{ left: `${today}%` }} />}
    </div>
  );
}

/** Label cell (sticky left on narrow screens, where the lanes scroll sideways). */
export function LabelCell({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("sticky left-0 z-[3] flex min-w-0 items-center gap-2 border-r border-line bg-bg pl-3 pr-2.5", className)}>{children}</div>;
}

export function MilestonesLane({ milestones, win, zoom, href }: { milestones: Milestone[]; win: Window; zoom: TimelineZoom; href: string }) {
  const shown = milestones.map((m) => ({ m, x: dayCenter(m.dueDate, win) })).filter((x): x is { m: Milestone; x: number } => x.x !== null);
  return (
    <>
      <LabelCell>
        <Flag size={14} strokeWidth={1.4} aria-hidden className="text-fg-3" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-fg-2">Milestones</span>
      </LabelCell>
      <div className="relative min-w-0 overflow-x-clip">
        {shown.map(({ m, x }) => {
          const done = Boolean(m.completedAt);
          const date = `${fmtDay(m.dueDate)}${done ? " · done" : ""}`;
          return (
            <Link
              key={m.id}
              href={href}
              aria-label={`${m.name}, ${fmtDay(m.dueDate)}${done ? ", done" : ""}`}
              className="group absolute inset-y-0 z-[2] w-0 outline-none"
              style={{ left: `${x}%` }}
            >
              <span
                className={cn(
                  "absolute left-0 top-1/2 -ml-1.5 -mt-1.5 size-3 rotate-45 rounded-[2px] border-2 group-focus-visible:shadow-[0_0_0_3px_var(--ring)]",
                  done ? "border-ok bg-ok" : "border-accent-t bg-bg",
                )}
              />
              <span className={cn("absolute left-3 top-1/2 -mt-1.5 truncate whitespace-nowrap font-mono text-[11px] leading-3 text-fg-2", zoom === "quarter" && "max-w-[64px]")}>{m.name}</span>
              <span className="pointer-events-none absolute bottom-[calc(50%+12px)] left-0 -translate-x-1/2 whitespace-nowrap rounded-[6px] border border-line-2 bg-raised px-[7px] py-1 font-mono text-[11px] leading-none text-fg opacity-0 shadow-pop transition-opacity duration-[var(--dur-fast)] group-hover:opacity-100 group-focus-visible:opacity-100">
                {zoom === "quarter" ? `${m.name} · ${date}` : date}
              </span>
            </Link>
          );
        })}
      </div>
    </>
  );
}

export function SprintsLane({ sprints, win, hrefFor }: { sprints: Sprint[]; win: Window; hrefFor: ((s: Sprint) => string) | null }) {
  const shown = sprints.filter((s) => overlaps({ start: s.startDate, end: s.endDate }, win.from, win.to));
  return (
    <>
      <LabelCell>
        <RefreshCcw size={13} strokeWidth={1.5} aria-hidden className="text-fg-3" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-fg-2">Sprints</span>
      </LabelCell>
      <div className="relative min-w-0 overflow-x-clip">
        {shown.map((s) => {
          const g = barGeometry({ start: s.startDate, end: s.endDate }, win);
          const label = `${s.name}${s.state === "active" ? " (active)" : s.state === "completed" ? " (completed)" : ""}, ${fmtDay(s.startDate)} to ${fmtDay(s.endDate)}`;
          const cls = cn(
            "absolute top-1/2 z-[2] -mt-[9px] flex h-[18px] items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-[5px] border px-2 text-[11px] font-medium",
            s.state === "active" && "border-accent bg-accent-s text-accent-t",
            s.state === "completed" && "border-line bg-raised text-fg-3 opacity-70",
            s.state === "planned" && "border-dashed border-line-2 bg-bg text-fg-2",
          );
          const body = (
            <>
              <span className="flex-none">{s.name}</span>
              <span className="min-w-0 truncate font-mono text-[10.5px] opacity-80">
                {fmtDay(s.startDate)} → {fmtDay(s.endDate)}
              </span>
            </>
          );
          const style = { left: `${g.left}%`, width: `${g.width}%` };
          return hrefFor ? (
            <Link key={s.id} href={hrefFor(s)} aria-label={label} className={cn(cls, "hover:brightness-110")} style={style}>
              {body}
            </Link>
          ) : (
            <div key={s.id} role="img" aria-label={label} className={cls} style={style}>
              {body}
            </div>
          );
        })}
      </div>
    </>
  );
}
