"use client";

import { memo, type CSSProperties, type KeyboardEvent, type MouseEvent, type Ref } from "react";
import { LabelChip } from "@/components/ui/badge";
import { PriorityIcon, StatusGlyph } from "@/components/ui/glyphs";
import { Tooltip } from "@/components/ui/tooltip";
import type { Label, Status, Task, User } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";
import { AssigneeAvatar, DueText, SubtaskRing, useSparking } from "@/features/tasks/task-bits";
import { BlockedBadge, blockedTitle } from "@/features/dependencies/blocked-badge";
import { cardChip } from "@/features/fields/field-lib";
import { useCustomFields } from "@/features/fields/queries";
import { formatClock } from "@/features/time/duration";
import { elapsed, useMyTimer, useNow, useStopTimer } from "@/features/time/use-timer";

export type CardProps = {
  task: Task;
  status: Status | undefined;
  assignee: User | null;
  labels: Label[];
  selected?: boolean;
  dragging?: boolean;
  overlay?: boolean;
  /** Show the done toggle on the status glyph (user can change status). */
  canToggle?: boolean;
  onOpen?: (task: Task, el: HTMLElement) => void;
  onToggleDone?: (task: Task) => void;
  cardRef?: Ref<HTMLDivElement>;
  style?: CSSProperties;
  dragHandleProps?: Record<string, unknown>;
};

/**
 * Board card (board 04/09): key + avatar, title, glyph + priority + estimate + labels + sub-task ring.
 * Memoized: board re-renders on every drag frame, cards only when their own data changes.
 */
export const TaskCard = memo(function TaskCard({
  task,
  status,
  assignee,
  labels,
  selected,
  dragging,
  overlay,
  canToggle,
  onOpen,
  onToggleDone,
  cardRef,
  style,
  dragHandleProps,
}: CardProps) {
  const spark = useSparking(task.id);
  const done = status?.category === "done";
  // Board 39: blocked badge, running-timer chip, first select field with a value.
  const { data: fields } = useCustomFields(task.projectId);
  const chip = fields ? cardChip(task, fields) : null;
  const { data: timer } = useMyTimer();
  const timing = timer?.taskId === task.id;
  const extras = task.isBlocked || timing || chip;
  const open = (e: MouseEvent<HTMLDivElement> | KeyboardEvent<HTMLDivElement>) => onOpen?.(task, e.currentTarget);
  return (
    <div
      ref={cardRef}
      style={style}
      {...dragHandleProps}
      role="button"
      tabIndex={0}
      aria-label={`Open ${task.key}: ${task.title}${task.isBlocked ? ", blocked" : ""}`}
      title={task.isBlocked ? blockedTitle(task, true) : undefined}
      aria-pressed={selected || undefined}
      data-task-key={task.key}
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest("[data-card-action]")) open(e);
      }}
      onKeyDown={(e) => {
        // Space/Enter pick up for keyboard drag (dnd-kit); "o" or Enter-with-modifier opens.
        if (e.key === "o" || ((e.metaKey || e.ctrlKey) && e.key === "Enter")) {
          e.preventDefault();
          open(e);
        }
        (dragHandleProps?.onKeyDown as ((ev: KeyboardEvent) => void) | undefined)?.(e);
      }}
      className={cn(
        "group/card relative flex select-none flex-col gap-2.5 rounded-md border border-line bg-surface p-3 text-left outline-none",
        "transition-[transform,box-shadow,border-color,background-color] duration-150 [transition-timing-function:var(--spring)]",
        "hover:-translate-y-0.5 hover:border-line-2 hover:shadow-pop focus-visible:shadow-[var(--focus-ring)] motion-reduce:hover:translate-y-0",
        "cursor-grab active:cursor-grabbing",
        selected && "border-accent bg-accent-s",
        task.isBlocked && !selected && "border-[color-mix(in_srgb,var(--danger)_30%,transparent)]",
        dragging && !overlay && "opacity-0",
        overlay &&
          "-translate-y-1 -rotate-[1.5deg] scale-[1.03] cursor-grabbing border-line-2 shadow-modal motion-reduce:translate-y-0 motion-reduce:rotate-0 motion-reduce:scale-100",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] font-medium text-fg-3">{task.key}</span>
        <AssigneeAvatar user={assignee} />
      </div>
      <p className={cn("m-0 line-clamp-3 text-[13px] font-medium leading-5 text-fg", done && status?.glyph === "done" && "text-fg-3 line-through")}>
        {task.title}
      </p>
      {extras && (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {task.isBlocked && <BlockedBadge />}
          {timing && timer && <CardTimer timer={timer} />}
          {chip && (
            <span className="inline-flex h-[22px] min-w-0 items-center gap-[5px] rounded-[6px] border border-line bg-raised px-[7px] text-[11.5px] text-fg-2">
              <span aria-hidden className="size-[7px] flex-none rounded-full" style={{ background: chip.color }} />
              <span className="truncate">
                {chip.field}: {chip.option}
              </span>
            </span>
          )}
        </div>
      )}
      <div className="flex min-w-0 items-center gap-2.5">
        {canToggle ? (
          <Tooltip content={done ? "Reopen" : "Mark done"}>
            <button
              type="button"
              data-card-action
              aria-label={done ? `Reopen ${task.key}` : `Mark ${task.key} done`}
              aria-pressed={done}
              onPointerDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              onClick={() => onToggleDone?.(task)}
              className="-m-1 inline-flex size-[22px] flex-none items-center justify-center rounded-sm hover:bg-hover"
            >
              <StatusGlyph kind={status?.glyph ?? "todo"} color={status?.color ?? undefined} spark={spark} />
            </button>
          </Tooltip>
        ) : (
          <StatusGlyph kind={status?.glyph ?? "todo"} color={status?.color ?? undefined} label={status?.name} />
        )}
        <PriorityIcon level={task.priority} label={task.priority ? undefined : undefined} bars />
        {task.estimate !== null && <span className="whitespace-nowrap font-mono text-[11px] text-fg-3">{task.estimate} pts</span>}
        {labels.slice(0, 1).map((l) => (
          <LabelChip key={l.id} name={l.name} color={l.color} size="sm" className="min-w-0 truncate" />
        ))}
        {labels.length > 1 && <span className="font-mono text-[11px] text-fg-3">+{labels.length - 1}</span>}
        <span className="ml-auto flex flex-none items-center gap-2 whitespace-nowrap">
          <DueText due={task.dueDate} done={done} />
          <SubtaskRing done={task.subtaskDoneCount} total={task.subtaskCount} />
        </span>
      </div>
    </div>
  );
});

/** Running-timer chip on a card (pulse + clock); clicking stops the timer and logs the entry. */
function CardTimer({ timer }: { timer: NonNullable<ReturnType<typeof useMyTimer>["data"]> }) {
  const now = useNow(true);
  const stop = useStopTimer();
  const clock = formatClock(elapsed(timer, now));
  return (
    <button
      type="button"
      data-card-action
      aria-label={`Stop timer, ${clock}`}
      aria-pressed
      disabled={stop.isPending}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onClick={() => stop.mutate(timer)}
      className="inline-flex h-[22px] flex-none items-center gap-1.5 rounded-[6px] bg-accent-s px-[7px] font-mono text-[11.5px] font-medium tabular-nums text-accent-t transition-opacity hover:opacity-85 max-[1023px]:h-8"
    >
      <span className="tx-pulse" aria-hidden />
      {clock}
    </button>
  );
}
