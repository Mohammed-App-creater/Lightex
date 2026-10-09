"use client";

import type { ISODate } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";
import { CalendarChip } from "./calendar-chip";
import { DOWS, type CalCtx } from "./calendar-month";
import { addDays, fmtDow, isWeekend } from "./schedule-lib";

/* Calendar week (design .cl-wk): 7 columns, every chip shown (large, with avatar), "—" when empty. */

export function CalendarWeek({ start, ctx }: { start: ISODate; ctx: CalCtx }) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid flex-none border-b border-line" style={{ gridTemplateColumns: "repeat(7,minmax(0,1fr))" }}>
        {days.map((day, i) => {
          const weekend = isWeekend(day);
          const today = day === ctx.today;
          return (
            <div
              key={day}
              aria-hidden
              className={cn(
                "flex h-11 items-center gap-1.5 border-r border-line px-2.5 font-mono text-[11px] font-medium uppercase tracking-[.06em] text-fg-2 last:border-r-0",
                today && "shadow-[inset_0_-2px_0_var(--accent-t)]",
              )}
            >
              {DOWS[i]}
              <b className={cn("font-sans text-[18px] font-semibold normal-case tracking-[-.02em]", weekend ? "text-fg-3" : "text-fg", today && "text-accent-t")}>{Number(day.slice(8))}</b>
            </div>
          );
        })}
      </div>
      <div className="grid min-h-0 flex-1 overflow-y-auto" style={{ gridTemplateColumns: "repeat(7,minmax(0,1fr))" }}>
        {days.map((day) => {
          const list = ctx.tasksOn(day);
          const weekend = isWeekend(day);
          return (
            <div
              key={day}
              role="group"
              data-day={day}
              aria-label={`${fmtDow(day)}, ${list.length} ${list.length === 1 ? "task" : "tasks"}`}
              className={cn(
                "relative flex min-w-0 flex-col gap-1.5 border-r border-line px-1.5 py-2 transition-[background-color,box-shadow] duration-[var(--dur-fast)] last:border-r-0",
                weekend && "bg-fg-3/[0.05]",
                day === ctx.today && "bg-accent-s/45",
                ctx.overDay === day && "bg-accent-s shadow-[inset_0_0_0_1px_var(--accent)]",
              )}
            >
              {list.map((t) => (
                <CalendarChip key={t.id} {...ctx.chipProps(t, day)} lg />
              ))}
              {list.length === 0 && <span className="px-1 py-1 font-mono text-[11px] text-fg-3">—</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
