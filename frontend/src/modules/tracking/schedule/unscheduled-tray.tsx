"use client";

import { CalendarPlus, X } from "lucide-react";
import { useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ErrorState, Skeleton } from "@/components/ui/feedback";
import { PriorityIcon, StatusGlyph } from "@/components/ui/glyphs";
import type { ISODate, Status, Task, User } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";
import { useBarDrag } from "./use-bar-drag";

/*
 * Unscheduled tray (board 32 §1.7): a 300 px panel inside the view listing open tasks with neither
 * date, highest priority first. Rows drag onto a timeline lane or a calendar day (sets dueDate) when
 * editable; "Add dates" opens the task panel with Start and Due revealed (the keyboard path).
 */

type TrayQuery = { data?: { data: Task[]; more: boolean }; isPending: boolean; isError: boolean; refetch: () => unknown };

export function UnscheduledTray({
  q,
  statuses,
  users,
  canEdit,
  onClose,
  onOpen,
  onAddDates,
  resolveDay,
  onOver,
  onDrop,
}: {
  q: TrayQuery;
  statuses: Status[];
  users: Map<string, User>;
  canEdit: (t: Task) => boolean;
  onClose: () => void;
  onOpen: (t: Task) => void;
  onAddDates: (t: Task) => void;
  /** Day under the pointer on the host view, or null. */
  resolveDay: (x: number, y: number) => ISODate | null;
  onOver?: (day: ISODate | null) => void;
  onDrop: (t: Task, day: ISODate) => void;
}) {
  const list = q.data?.data ?? [];
  return (
    <aside aria-label="Unscheduled tasks" className="flex w-[300px] flex-none flex-col border-l border-line bg-surface max-[760px]:hidden">
      <header className="flex h-11 flex-none items-center gap-2 border-b border-line pl-4 pr-2">
        <h2 className="m-0 flex-1 text-[13px] font-semibold">
          Unscheduled <span className="font-mono text-[11px] font-medium text-fg-3">{q.data ? (q.data.more ? "200+" : list.length) : ""}</span>
        </h2>
        <Button variant="ghost" size="sm" icon aria-label="Close unscheduled" onClick={onClose}>
          <X size={14} aria-hidden />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {q.isPending ? (
          <div role="status" aria-busy="true" aria-label="Loading unscheduled tasks" className="flex flex-col gap-1.5">
            {[70, 52, 64, 46].map((w, i) => (
              <div key={i} className="flex h-[52px] flex-col justify-center gap-2 rounded-[8px] border border-line px-3">
                <Skeleton className="w-14" />
                <Skeleton style={{ width: `${w}%` }} />
              </div>
            ))}
          </div>
        ) : q.isError ? (
          <ErrorState title="Couldn’t load unscheduled tasks" onRetry={() => void q.refetch()} />
        ) : list.length === 0 ? (
          <p className="m-0 px-2 py-6 text-center text-[13px] text-fg-3">Everything open has a date</p>
        ) : (
          <ul role="list" className="m-0 flex list-none flex-col gap-1.5 p-0">
            {list.map((t) => (
              <TrayItem
                key={t.id}
                task={t}
                status={statuses.find((s) => s.id === t.statusId)}
                user={t.assigneeId ? users.get(t.assigneeId) : undefined}
                editable={canEdit(t)}
                onOpen={() => onOpen(t)}
                onAddDates={() => onAddDates(t)}
                resolveDay={resolveDay}
                onOver={onOver}
                onDrop={(day) => onDrop(t, day)}
              />
            ))}
          </ul>
        )}
      </div>
      {q.data?.more && <p className="m-0 flex-none border-t border-line px-4 py-2 text-[12px] text-fg-3">Showing the 200 highest priority</p>}
    </aside>
  );
}

function TrayItem({
  task,
  status,
  user,
  editable,
  onOpen,
  onAddDates,
  resolveDay,
  onOver,
  onDrop,
}: {
  task: Task;
  status: Status | undefined;
  user: User | undefined;
  editable: boolean;
  onOpen: () => void;
  onAddDates: () => void;
  resolveDay: (x: number, y: number) => ISODate | null;
  onOver?: (day: ISODate | null) => void;
  onDrop: (day: ISODate) => void;
}) {
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);
  const drag = useBarDrag({
    enabled: editable,
    onMove: (s) => {
      setGhost({ x: s.clientX, y: s.clientY });
      onOver?.(resolveDay(s.clientX, s.clientY));
    },
    onEnd: (commit, s) => {
      setGhost(null);
      onOver?.(null);
      const day = commit ? resolveDay(s.clientX, s.clientY) : null;
      if (day) onDrop(day);
    },
    onTap: onOpen,
  });
  const row = (
    <>
      <span className="flex min-w-0 items-center gap-2">
        <StatusGlyph kind={status?.glyph ?? "todo"} />
        <span className="flex-none font-mono text-[11.5px] font-medium text-fg-3">{task.key}</span>
        <span className="flex-1" />
        {task.priority > 0 && <PriorityIcon level={task.priority} label={`Priority ${task.priority}`} />}
        {user && <Avatar name={user.name} hue={user.hue} size={18} ring={false} />}
      </span>
      <span className="line-clamp-2 text-[12.5px] leading-[17px] text-fg">{task.title}</span>
    </>
  );
  return (
    <li
      {...drag}
      aria-roledescription={editable ? "draggable task" : undefined}
      aria-label={`${task.key} ${task.title}${editable ? ". Drag onto a day to set its due date, or use Add dates" : ""}`}
      className={cn(
        "group flex select-none flex-col gap-1.5 rounded-[8px] border border-line bg-bg px-3 py-2 transition-[border-color,opacity] duration-[var(--dur-fast)] hover:border-line-2",
        editable && "cursor-grab",
        ghost && "opacity-50",
      )}
      style={{ touchAction: editable ? "pan-y" : undefined }}
    >
      {row}
      <span className="flex">
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={editable ? onAddDates : onOpen}
          aria-label={editable ? `Add dates to ${task.key}` : `Open ${task.key}`}
          className="-ml-1 inline-flex h-6 items-center gap-1 rounded-[5px] px-1.5 text-[12px] font-medium text-fg-3 hover:bg-hover hover:text-fg max-[760px]:h-9"
        >
          {editable ? (
            <>
              <CalendarPlus size={12} aria-hidden /> Add dates
            </>
          ) : (
            "Open"
          )}
        </button>
      </span>
      {ghost &&
        createPortal(
          <div
            aria-hidden
            className="pointer-events-none fixed left-0 top-0 z-[80] flex w-[240px] flex-col gap-1 rounded-[8px] border border-accent bg-raised px-3 py-2 shadow-pop"
            style={{ transform: `translate(${ghost.x + 12}px, ${ghost.y + 10}px)` } as CSSProperties}
          >
            {row}
          </div>,
          document.body,
        )}
    </li>
  );
}
