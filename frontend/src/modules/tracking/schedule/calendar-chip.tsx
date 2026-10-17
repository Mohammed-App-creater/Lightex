"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { Avatar } from "@/components/ui/avatar";
import { PriorityIcon, StatusGlyph, glyphLabel, priorityMeta } from "@/components/ui/glyphs";
import type { ISODate, Status, Task, User } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";
import { calendarKey, fmtDay } from "./schedule-lib";
import { useBarDrag } from "./use-bar-drag";
import { useReschedulePending } from "./use-reschedule";

/*
 * Calendar chip (design .cl-chip; .cl-chip.lg in week mode): priority bars, glyph, key, title (+ avatar).
 * Drag to another day (the chip follows the pointer with a transform), Alt+← / → ±1 day, Alt+↑ / ↓
 * ±7 days, Enter / Space opens the task. A sync ring shows while its PATCH is in flight.
 */

export type ChipProps = {
  task: Task;
  due: ISODate;
  status: Status | undefined;
  user: User | null | undefined;
  lg?: boolean;
  avatar?: boolean;
  editable: boolean;
  onOpen: (el: HTMLElement) => void;
  resolveDay: (x: number, y: number) => ISODate | null;
  onOver: (day: ISODate | null) => void;
  onDrop: (day: ISODate) => void;
  onNudge: (deltaDays: number) => void;
  onCancel: () => void;
  onFlush: () => void;
};

export function CalendarChip(p: ChipProps) {
  const { task } = p;
  const pending = useReschedulePending(task.id);
  const ref = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState<{ dx: number; dy: number } | null>(null);
  const [prevPending, setPrevPending] = useState(pending);
  const [landed, setLanded] = useState(0);
  if (pending !== prevPending) {
    setPrevPending(pending);
    if (!pending) setLanded((n) => n + 1);
  }
  const glyph = p.status?.glyph ?? "todo";
  const drag = useBarDrag({
    enabled: p.editable,
    onMove: (s) => {
      setOffset({ dx: s.dx, dy: s.dy });
      p.onOver(p.resolveDay(s.clientX, s.clientY));
    },
    onEnd: (commit, s) => {
      setOffset(null);
      p.onOver(null);
      const day = commit ? p.resolveDay(s.clientX, s.clientY) : null;
      if (day && day !== p.due) p.onDrop(day);
    },
    onTap: () => ref.current && p.onOpen(ref.current),
  });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      p.onOpen(e.currentTarget);
      return;
    }
    if (e.key === "Escape") {
      p.onCancel();
      return;
    }
    if (!p.editable || !e.altKey) return;
    const d = calendarKey(e.key);
    if (d === null) return;
    e.preventDefault();
    p.onNudge(d);
  };

  const aria = `${task.key} ${task.title}, ${glyphLabel[glyph]}, ${priorityMeta[task.priority].short} priority, due ${fmtDay(p.due)}${p.editable ? ". Alt plus arrow keys reschedule" : ""}`;
  const done = glyph === "done";
  const bars = <PriorityIcon level={task.priority} bars className="scale-[.8]" />;
  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      data-chip-id={task.id}
      aria-roledescription={p.editable ? "draggable task" : "task"}
      aria-label={aria}
      onKeyDown={onKeyDown}
      onBlur={p.onFlush}
      {...drag}
      className={cn(
        "relative flex min-w-0 flex-none select-none rounded-[5px] border border-line bg-surface text-[12px] font-medium text-fg outline-none transition-[background-color,border-color,opacity] duration-[var(--dur-fast)] hover:border-line-2 hover:bg-raised focus-visible:shadow-[var(--focus-ring)]",
        p.lg ? "flex-col items-stretch gap-[7px] p-2" : "h-[22px] items-center gap-[5px] px-1.5",
        p.editable ? (offset ? "cursor-grabbing" : "cursor-grab") : "cursor-pointer",
        offset && "z-50 border-accent bg-raised opacity-100 shadow-pop",
      )}
      style={{ transform: offset ? `translate(${offset.dx}px, ${offset.dy}px)` : undefined, touchAction: p.editable ? "none" : undefined }}
    >
      {p.lg ? (
        <>
          <span className={cn("flex min-w-0 items-center gap-1.5", landed > 0 && "sch-land")} key={`r${landed}`}>
            {bars}
            <StatusGlyph kind={glyph} className="size-3" />
            <span className="flex-none font-mono text-[10.5px] text-fg-3">{task.key}</span>
            <span className="flex-1" />
            {pending && <span aria-hidden className="sch-sync" />}
            {p.user && <Avatar name={p.user.name} hue={p.user.hue} size={18} ring={false} decorative />}
          </span>
          <span className={cn("line-clamp-2 text-[12.5px] leading-[17px]", done && "text-fg-3")}>{task.title}</span>
        </>
      ) : (
        <span className={cn("flex min-w-0 flex-1 items-center gap-[5px]", landed > 0 && "sch-land")} key={`r${landed}`}>
          {bars}
          <StatusGlyph kind={glyph} className="size-3" />
          <span className="flex-none font-mono text-[10.5px] text-fg-3 max-[760px]:hidden">{task.key}</span>
          <span className={cn("min-w-0 flex-1 truncate", done && "text-fg-3")}>{task.title}</span>
          {pending && <span aria-hidden className="sch-sync" />}
          {p.avatar && p.user && <Avatar name={p.user.name} hue={p.user.hue} size={18} ring={false} decorative />}
        </span>
      )}
    </div>
  );
}
