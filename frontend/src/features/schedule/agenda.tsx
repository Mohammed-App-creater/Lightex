"use client";

import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import Link from "next/link";
import type { CSSProperties } from "react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/feedback";
import { PriorityIcon, StatusGlyph } from "@/components/ui/glyphs";
import type { Epic, ISODate, Status, Task, User } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";
import { addDays, agendaDays, DOW, fmtDay, fmtDowComma, isWeekend, MONTHS_LONG, weekday } from "./schedule-lib";
import { TimelineIcon } from "./schedule-states";

/*
 * Calendar at ≤ 760 px (design "Mobile" frame, §1.9): a header inside the view, a week strip with
 * ‹ › (§8 #13), and day groups from the selected day (up to 4 within 21 days). Cards open the task
 * sheet; no drag (rescheduling on a phone happens in the sheet's Start / Due fields).
 */

export function Agenda({
  projectName,
  selected,
  weekStart,
  today,
  loading,
  tasksOn,
  statusOf,
  userOf,
  epicOf,
  timelineHref,
  canCreate,
  onSelect,
  onWeek,
  onToday,
  onOpen,
  onCreate,
}: {
  projectName: string;
  selected: ISODate;
  weekStart: ISODate;
  today: ISODate;
  loading: boolean;
  tasksOn: (day: ISODate) => Task[];
  statusOf: (id: string) => Status | undefined;
  userOf: (id: string | null) => User | undefined;
  epicOf: (id: string | null) => Epic | undefined;
  timelineHref: string;
  canCreate: boolean;
  onSelect: (day: ISODate) => void;
  onWeek: (dir: 1 | -1) => void;
  onToday: () => void;
  onOpen: (t: Task, el: HTMLElement) => void;
  onCreate: () => void;
}) {
  const week = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const groups = agendaDays(selected, (d) => tasksOn(d).length > 0);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="flex h-[52px] flex-none items-center gap-0.5 border-b border-line px-1">
        <div className="flex min-w-0 flex-1 flex-col gap-[3px] pl-3">
          <h1 className="m-0 text-[15px] font-semibold leading-none">Calendar</h1>
          <span className="truncate text-[11.5px] leading-none text-fg-3">
            {projectName} · {MONTHS_LONG[Number(selected.slice(5, 7)) - 1]}
          </span>
        </div>
        <Button size="sm" variant="secondary" className="mr-1 h-8" onClick={onToday}>
          Today
        </Button>
        <Link href={timelineHref} aria-label="Switch to timeline" className="inline-flex size-11 items-center justify-center rounded-[10px] text-fg-2 hover:bg-hover hover:text-fg">
          <TimelineIcon size={18} />
        </Link>
      </div>
      <div role="group" aria-label={`Week of ${fmtDay(weekStart)}`} className="flex flex-none items-center gap-0.5 border-b border-line px-1 pb-2.5 pt-2">
        <button type="button" aria-label="Previous week" onClick={() => onWeek(-1)} className="inline-flex size-11 flex-none items-center justify-center rounded-[10px] text-fg-2 hover:bg-hover">
          <ChevronLeft size={16} aria-hidden />
        </button>
        <div className="grid min-w-0 flex-1 gap-0.5" style={{ gridTemplateColumns: "repeat(7,minmax(0,1fr))" }}>
          {week.map((d) => {
            const on = d === selected;
            const n = tasksOn(d).length;
            return (
              <button
                key={d}
                type="button"
                aria-pressed={on}
                aria-label={`${DOW[weekday(d)]} ${fmtDay(d)}, ${n} ${n === 1 ? "task" : "tasks"}`}
                onClick={() => onSelect(d)}
                className={cn(
                  "flex h-[58px] flex-col items-center justify-center gap-[5px] rounded-[12px] font-mono text-[11px] font-medium text-fg-2 transition-[background-color,color] duration-150",
                  on && "bg-accent-s",
                )}
              >
                {DOW[weekday(d)]!.charAt(0)}
                <b className={cn("font-sans text-[16px] font-semibold leading-none", isWeekend(d) ? "text-fg-3" : "text-fg", d === today && "text-accent-t")}>{Number(d.slice(8))}</b>
                <i aria-hidden className={cn("size-1 rounded-full", n ? "bg-fg-3" : "bg-transparent")} />
              </button>
            );
          })}
        </div>
        <button type="button" aria-label="Next week" onClick={() => onWeek(1)} className="inline-flex size-11 flex-none items-center justify-center rounded-[10px] text-fg-2 hover:bg-hover">
          <ChevronRight size={16} aria-hidden />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-24">
        {loading ? (
          <div role="status" aria-busy="true" aria-label="Loading calendar" className="flex flex-col gap-2 px-3 py-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex flex-col gap-2.5 rounded-[10px] border border-line bg-surface px-3 py-3">
                <Skeleton className="w-16" />
                <Skeleton className="w-4/5" />
                <Skeleton className="w-1/3" />
              </div>
            ))}
          </div>
        ) : (
          groups.map((day) => {
            const list = tasksOn(day);
            const isToday = day === today;
            return (
              <section key={day} aria-label={fmtDowComma(day)}>
                <h2 className={cn("sticky top-0 z-[2] m-0 flex h-[38px] items-center gap-2 border-b border-line bg-bg px-4 text-[13.5px] font-semibold", isToday && "text-accent-t")}>
                  {isToday ? `Today · ${fmtDowComma(day)}` : fmtDowComma(day)}
                  {list.length > 0 && <span className="ml-auto font-mono text-[11px] font-medium text-fg-3">{list.length}</span>}
                </h2>
                {list.length === 0 ? (
                  <p className="m-0 px-4 pb-3.5 pt-3 text-[13px] text-fg-3">Nothing due</p>
                ) : (
                  <ul role="list" className="m-0 flex list-none flex-col gap-2 px-3 pb-3.5 pt-2.5">
                    {list.map((t) => {
                      const s = statusOf(t.statusId);
                      const e = epicOf(t.epicId);
                      const u = userOf(t.assigneeId);
                      return (
                        <li key={t.id}>
                          <button
                            type="button"
                            aria-label={`${t.key} ${t.title}`}
                            onClick={(ev) => onOpen(t, ev.currentTarget)}
                            className="flex w-full flex-col gap-[7px] rounded-[10px] border border-line bg-surface px-3 py-[11px] text-left text-fg transition-transform duration-[var(--dur-fast)] active:scale-[.99]"
                          >
                            <span className="flex min-w-0 items-center gap-2">
                              <StatusGlyph kind={s?.glyph ?? "todo"} />
                              <span className="font-mono text-[12px] text-fg-3">{t.key}</span>
                              <span className="flex-1" />
                              {t.priority > 0 && <PriorityIcon level={t.priority} bars />}
                            </span>
                            <span className={cn("line-clamp-2 text-[14px] font-medium leading-5", s?.glyph === "done" && "text-fg-3")}>{t.title}</span>
                            <span className="flex min-w-0 items-center gap-2">
                              {e ? (
                                <>
                                  <span aria-hidden className="tl-sq size-2 flex-none rounded-[2px]" style={{ "--h": e.hue } as CSSProperties} />
                                  <span className="min-w-0 flex-1 truncate text-[12px] text-fg-3">{e.name}</span>
                                </>
                              ) : (
                                <span className="flex-1 text-[12px] text-fg-3">No epic</span>
                              )}
                              {u && <Avatar name={u.name} hue={u.hue} size={20} ring={false} decorative />}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            );
          })
        )}
      </div>
      {canCreate && (
        <button
          type="button"
          aria-label="New task"
          onClick={onCreate}
          className="absolute bottom-6 right-4 z-[5] inline-flex size-[54px] items-center justify-center rounded-[16px] bg-accent text-white shadow-pop transition-transform duration-[var(--dur-fast)] active:scale-95"
        >
          <Plus size={20} aria-hidden />
        </button>
      )}
    </div>
  );
}
