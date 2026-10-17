"use client";

import { ChevronRight } from "lucide-react";
import type { CSSProperties } from "react";
import { Avatar, UnassignedAvatar } from "@/components/ui/avatar";
import { StatusGlyph } from "@/components/ui/glyphs";
import type { Status, Task } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";
import { datesForSpan, fillPercent, fmtDay, spanDays, spanOf, type DragMode, type Span, type Window } from "./schedule-lib";
import { TimelineBar } from "./timeline-bar";
import { LabelCell } from "./timeline-lanes";
import type { TlGroup } from "./timeline-model";
import { keyTitle, useReschedulePending, type Rescheduler } from "./use-reschedule";

/* Board 32 timeline rows: group header (epic bar / person) and task rows (design .tl-row, .tl-row.tk). */

type Common = { win: Window; laneWidth: () => number; mobile: boolean; rs: Rescheduler };

/** Toast text: the edge that changed, from → to (a move reports the start). */
function changeText(before: Span, after: Span, mode: DragMode) {
  return mode === "end" ? `${fmtDay(before.end)} → ${fmtDay(after.end)}` : `${fmtDay(before.start)} → ${fmtDay(after.start)}`;
}

export function GroupRow({
  group,
  open,
  onToggle,
  canManageEpics,
  win,
  laneWidth,
  mobile,
  rs,
}: Common & { group: TlGroup; open: boolean; onToggle: () => void; canManageEpics: boolean }) {
  const epic = group.epic;
  const archived = Boolean(epic?.archivedAt);
  const editable = Boolean(epic) && canManageEpics && !archived && !mobile;
  const count = <span className="flex-none font-mono text-[11px] text-fg-3">{group.tasks.length}</span>;
  return (
    <>
      <LabelCell className="pl-3">
        {group.collapsible ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={onToggle}
            className="-ml-1.5 flex h-[30px] min-w-0 flex-1 items-center gap-2 rounded-[6px] px-1.5 text-left text-[13px] font-semibold text-fg hover:bg-hover"
          >
            <ChevronRight size={12} strokeWidth={1.8} aria-hidden className={cn("flex-none text-fg-3 transition-transform duration-200", open && "rotate-90")} />
            {group.hue !== null ? (
              <span aria-hidden className="tl-sq size-2.5 flex-none rounded-[3px]" style={{ "--h": group.hue } as CSSProperties} />
            ) : (
              <span aria-hidden className="size-2.5 flex-none rounded-[3px] border border-dashed border-line-2" />
            )}
            <span className="min-w-0 flex-1 truncate">{group.name}</span>
            {archived && !mobile && <span className="flex-none rounded-[4px] border border-line-2 px-1 font-mono text-[10px] font-medium text-fg-3">Archived</span>}
            {!mobile && count}
          </button>
        ) : (
          <span className="flex min-w-0 flex-1 items-center gap-2 text-[13px] font-semibold">
            {group.kind === "unassigned" ? (
              <UnassignedAvatar size={20} />
            ) : (
              <Avatar name={group.user?.name ?? group.name} hue={group.hue ?? undefined} size={20} decorative />
            )}
            <span className={cn("min-w-0 flex-1 truncate", group.former && "text-fg-2")}>{group.name}</span>
            {count}
          </span>
        )}
      </LabelCell>
      <div className="relative min-w-0 overflow-x-clip">
        {epic && group.span && (
          <TimelineBar
            id={`epic:${epic.id}`}
            kind="epic"
            span={group.span}
            toDates={(s) => ({ startDate: s.start, dueDate: s.end })}
            hue={epic.hue}
            derived={group.derived}
            fill={epic.progress.percent}
            showPct={!group.derived}
            label={`${epic.name} epic${group.derived ? " (dates from its tasks)" : ""}${archived ? ", archived" : ""}`}
            editable={editable}
            win={win}
            laneWidth={laneWidth}
            tabbable
            onOpen={onToggle}
            onEnter={onToggle}
            onCommit={(span) =>
              rs.commitEpic(epic, { startDate: span.start, dueDate: span.end }, {
                toast: `${epic.name} · ${fmtDay(span.start)} → ${fmtDay(span.end)}`,
                announce: `${epic.name}: ${fmtDay(span.start)} to ${fmtDay(span.end)}`,
              })
            }
            onNudge={(span, mode) =>
              rs.nudgeEpic(epic, { startDate: span.start, dueDate: span.end }, mode, {
                toast: `${epic.name} · ${fmtDay(span.start)} → ${fmtDay(span.end)}`,
                announce: `${epic.name}: ${fmtDay(span.start)} to ${fmtDay(span.end)}, ${spanDays(span)} days`,
              })
            }
            onFlush={() => rs.flush(`epic:${epic.id}`)}
            onCancel={() => rs.cancel(`epic:${epic.id}`)}
          />
        )}
      </div>
    </>
  );
}

export function TaskRow({
  task,
  status,
  hue,
  editable,
  tabbable,
  onOpen,
  win,
  laneWidth,
  mobile,
  rs,
}: Common & { task: Task; status: Status | undefined; hue: number | null; editable: boolean; tabbable: boolean; onOpen: (t: Task, el: HTMLElement) => void }) {
  const pending = useReschedulePending(task.id);
  const span = spanOf(task);
  const glyph = status?.glyph ?? "todo";
  const name = `${task.key} ${task.title}`;
  const blocked = task.openBlockers.length ? `, blocked by ${task.openBlockers.map((b) => b.key).join(", ")}` : "";
  return (
    <>
      <LabelCell className={cn("gap-[7px]", mobile ? "pl-2.5" : "pl-[34px]")}>
        <StatusGlyph kind={glyph} />
        <span className="flex-none font-mono text-[11.5px] font-medium text-fg-3">{task.key}</span>
        {!mobile && <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-2">{task.title}</span>}
      </LabelCell>
      <div className="relative min-w-0 overflow-x-clip">
        {span && (
          <TimelineBar
            id={task.id}
            kind="task"
            span={span}
            toDates={(s, mode) => datesForSpan(task, s, mode)}
            hue={hue}
            fill={fillPercent(glyph)}
            label={name}
            suffix={blocked}
            editable={editable}
            win={win}
            laneWidth={laneWidth}
            tabbable={tabbable}
            pending={pending}
            dim={glyph === "done"}
            onOpen={(el) => onOpen(task, el)}
            onCommit={(s, mode) =>
              rs.commit(task, datesForSpan(task, s, mode), { toast: keyTitle(task.key, changeText(span, s, mode)), announce: `${name}: ${fmtDay(s.start)} to ${fmtDay(s.end)}` })
            }
            onNudge={(s, mode) =>
              rs.nudge(task, datesForSpan(task, s, mode), mode, {
                toast: keyTitle(task.key, changeText(span, s, mode)),
                announce: `${name}: ${fmtDay(s.start)} to ${fmtDay(s.end)}, ${spanDays(s)} days`,
              })
            }
            onFlush={() => rs.flush(task.id)}
            onCancel={() => rs.cancel(task.id)}
          />
        )}
      </div>
    </>
  );
}
