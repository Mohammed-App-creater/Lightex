"use client";

import type { ISODate, Task } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";
import { CalendarChip, type ChipProps } from "./calendar-chip";
import { MorePopover } from "./more-popover";
import { addDays, fmtDay, fmtDow, isWeekend, splitOverflow } from "./schedule-lib";

/* Calendar month grid (design .cl-dh / .cl-grid / .cl-cell): Mon-first, 4–6 rows, up to 3 chips a cell. */

export type CalCtx = {
  today: ISODate;
  overDay: ISODate | null;
  /** Chips on a day, already sorted (§1.3 order). */
  tasksOn: (day: ISODate) => Task[];
  /** Ids that must stay visible in their cell (a chip moved by keyboard keeps focus). */
  pinned: ReadonlySet<string>;
  chipProps: (t: Task, day: ISODate) => Omit<ChipProps, "lg" | "avatar">;
  drop: (t: Task, day: ISODate) => void;
};

export const DOWS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function CalendarMonth({ start, rows, first, last, ctx }: { start: ISODate; rows: number; first: ISODate; last: ISODate; ctx: CalCtx }) {
  const days = Array.from({ length: rows * 7 }, (_, i) => addDays(start, i));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div aria-hidden className="grid flex-none border-b border-line" style={{ gridTemplateColumns: "repeat(7,minmax(0,1fr))" }}>
        {DOWS.map((d) => (
          <span key={d} className="flex h-[30px] items-center px-2.5 font-mono text-[11px] font-medium uppercase tracking-[.06em] text-fg-3">
            {d}
          </span>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 overflow-y-auto" style={{ gridTemplateColumns: "repeat(7,minmax(0,1fr))", gridTemplateRows: `repeat(${rows},minmax(96px,1fr))` }}>
        {days.map((day) => {
          const list = ctx.tasksOn(day);
          const { shown, more } = splitOverflow(list, 3);
          const visible = [...shown, ...list.filter((t) => ctx.pinned.has(t.id) && !shown.includes(t))];
          const out = day < first || day > last;
          const weekend = isWeekend(day);
          const today = day === ctx.today;
          const dn = day.endsWith("-01") ? fmtDay(day) : String(Number(day.slice(8)));
          return (
            <div
              key={day}
              role="group"
              data-day={day}
              aria-label={`${fmtDow(day)}, ${list.length} ${list.length === 1 ? "task" : "tasks"}`}
              className={cn(
                "relative flex min-h-0 min-w-0 flex-col gap-0.5 border-b border-r border-line px-[5px] py-1 transition-[background-color,box-shadow] duration-[var(--dur-fast)] [&:nth-child(7n)]:border-r-0",
                weekend && "bg-fg-3/[0.05]",
                ctx.overDay === day && "bg-accent-s shadow-[inset_0_0_0_1px_var(--accent)]",
              )}
            >
              <span
                className={cn(
                  "inline-flex h-[22px] min-w-[22px] flex-none items-center justify-center self-start rounded-[11px] px-[5px] font-mono text-[11.5px] font-medium",
                  weekend ? "text-fg-3" : "text-fg-2",
                  out && "opacity-45",
                  today && "bg-accent-s font-semibold text-accent-t",
                )}
              >
                {dn}
              </span>
              {visible.map((t) => (
                <CalendarChip key={t.id} {...ctx.chipProps(t, day)} />
              ))}
              {more > 0 && <MorePopover day={day} tasks={list} more={more} ctx={ctx} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
