"use client";

import { ArrowLeft, Check, Plus, Target } from "lucide-react";
import { motion } from "motion/react";
import { Avatar, UnassignedAvatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ErrorState, Skeleton } from "@/components/ui/feedback";
import { PriorityIcon, StatusGlyph, priorityMeta, type PriorityLevel } from "@/components/ui/glyphs";
import { useOpenTask } from "@/features/goals/parts";
import { useProjectMembers } from "@/features/projects/queries";
import { errorMessage } from "@/lib/api/errors";
import type { Sprint, Task } from "@/lib/api/types";
import { useCan } from "@/lib/permissions/can";
import { cn } from "@/lib/utils/cn";
import { dateRange, shortDate } from "@/lib/utils/dates";
import { SPRINT_COLUMNS, addedMidSprint, glyphLookup, sumPts, sprintWhen } from "./sprint-model";
import { useSprintTasks } from "./sprint-review";

/** Sprint board (board 26 "Sprint board"): read-only columns for one sprint; cards open the task panel. */
export function SprintBoard({ sprint, onBack, onComplete }: { sprint: Sprint; onBack: () => void; onComplete: () => void }) {
  const canSprint = useCan("sprint.manage");
  const q = useSprintTasks(sprint.projectId, sprint.id);
  const members = useProjectMembers(sprint.projectId);
  const people = new Map((members.data ?? []).map((m) => [m.userId, m.user]));
  const openTask = useOpenTask();
  const glyphOf = glyphLookup(q.data?.statuses ?? []);
  const w = sprintWhen(sprint);
  const total = sprint.progress.points;
  const pct = total ? Math.round((sprint.progress.donePoints / total) * 100) : sprint.progress.percent;
  const tag = sprint.state === "active" ? "Active" : sprint.state === "planned" ? "Planned" : "Completed";
  const whenCls = w.tone === "warn" ? "text-warn" : w.tone === "danger" ? "text-danger" : "text-fg-3";
  const tasks = q.data?.tasks ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-[52px] flex-none items-center gap-2 border-b border-line px-6 max-[760px]:px-2">
        <Button variant="secondary" size="sm" onClick={onBack} aria-label="Back to sprints" className="max-[760px]:h-11">
          <ArrowLeft size={13} aria-hidden /> <span className="max-[760px]:hidden">Sprints</span>
        </Button>
        <h1 className="m-0 ml-1 truncate text-[14px] font-semibold">{sprint.name}</h1>
        <span
          className={cn(
            "inline-flex h-5 flex-none items-center gap-[5px] whitespace-nowrap rounded-[5px] border border-line-2 px-[7px] font-mono text-[11px] font-medium text-fg-2",
            sprint.state === "active" && "border-transparent bg-ok-s text-ok",
          )}
        >
          {sprint.state === "active" && <span aria-hidden className="size-1.5 rounded-full bg-current" />}
          {tag}
        </span>
        <span className="font-mono text-[11.5px] text-fg-3 max-[760px]:hidden">{dateRange(sprint.startDate, sprint.endDate)}</span>
        <span className="flex-1" />
        {canSprint && sprint.state === "active" && (
          <Button variant="primary" size="sm" onClick={onComplete} className="max-[760px]:h-11">
            <Check size={13} aria-hidden />
            <span>
              Complete<span className="max-[760px]:hidden"> sprint</span>
            </span>
          </Button>
        )}
      </header>
      <div className="flex flex-none flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-6 py-2.5 max-[760px]:px-3">
        <span className="inline-flex min-w-0 items-center gap-1.5 text-[13px] font-medium">
          <Target size={13} className="flex-none text-fg-3" aria-hidden />
          <span className="truncate">{sprint.goal || "No goal"}</span>
        </span>
        <span className="flex-1 max-[760px]:hidden" />
        <span className={cn("font-mono text-[11.5px]", whenCls)}>{w.text}</span>
        <span className="flex w-[160px] items-center gap-2">
          <span
            role="progressbar"
            aria-label={`${sprint.name} points done`}
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            className="h-1.5 flex-1 overflow-hidden rounded-[3px] border border-line bg-raised"
          >
            <span className="block h-full origin-left bg-ok transition-transform duration-700 ease-out" style={{ transform: `scaleX(${pct / 100})` }} />
          </span>
          <span className="font-mono text-[11.5px] text-fg-2">{pct}%</span>
        </span>
        <span className="font-mono text-[11.5px] text-fg-3">
          <b className="font-semibold text-fg">{sprint.progress.donePoints}</b>/{total} pts
        </span>
      </div>
      {q.isPending ? (
        <div aria-busy="true" aria-label={`Loading ${sprint.name}`} className="grid min-h-0 flex-1 grid-cols-4 gap-3 px-6 pb-6 pt-3.5 max-[760px]:flex max-[760px]:overflow-hidden max-[760px]:px-3.5">
          {SPRINT_COLUMNS.map((c) => (
            <div key={c.kind} className="flex flex-col gap-2 rounded-[11px] border border-line bg-surface p-2 max-[760px]:w-[86%] max-[760px]:flex-none">
              <Skeleton className="m-1 h-2.5 w-24" />
              {[0, 1].map((i) => (
                <Skeleton key={i} className="h-[78px] w-full rounded-lg" />
              ))}
            </div>
          ))}
        </div>
      ) : q.isError ? (
        <div className="p-6">
          <ErrorState title="Couldn’t load this sprint" body={errorMessage(q.error)} onRetry={() => void q.refetch()} retrying={q.isFetching} />
        </div>
      ) : (
        <motion.div
          role="list"
          aria-label={`${sprint.name} board`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.18 }}
          className="grid min-h-0 flex-1 grid-cols-[repeat(4,minmax(220px,1fr))] gap-3 overflow-auto px-6 pb-6 pt-3.5 max-[760px]:flex max-[760px]:snap-x max-[760px]:snap-mandatory max-[760px]:px-3.5 max-[760px]:pb-10"
        >
          {SPRINT_COLUMNS.map((col) => {
            const ts = tasks.filter((t) => col.glyphs.includes(glyphOf(t.statusId))).sort((a, b) => b.priority - a.priority || a.number - b.number);
            return (
              <section
                key={col.kind}
                role="listitem"
                aria-label={col.name}
                className="flex min-h-0 min-w-0 flex-col gap-2 self-start rounded-[11px] border border-line bg-surface p-2 max-[760px]:w-[86%] max-[760px]:flex-none max-[760px]:snap-center"
              >
                <div className="flex h-7 items-center gap-2 px-1.5 text-[12.5px] font-semibold">
                  <StatusGlyph kind={col.kind} />
                  {col.name}
                  <span className="font-mono text-[11px] font-medium text-fg-3">{ts.length}</span>
                  <span className="flex-1" />
                  <span className="font-mono text-[11px] font-medium text-fg-3">{sumPts(ts)} pts</span>
                </div>
                <div className="flex flex-col gap-1.5">
                  {ts.map((t) => (
                    <Card key={t.id} task={t} sprint={sprint} assignee={t.assigneeId ? people.get(t.assigneeId) : undefined} done={col.kind === "done"} onOpen={() => openTask(t.key)} />
                  ))}
                  {ts.length === 0 && <div className="flex h-14 items-center justify-center rounded-lg border border-dashed border-line-2 text-[12px] text-fg-3">No tasks</div>}
                </div>
              </section>
            );
          })}
        </motion.div>
      )}
    </div>
  );
}

function Card({
  task: t,
  sprint,
  assignee,
  done,
  onOpen,
}: {
  task: Task;
  sprint: Sprint;
  assignee?: { name: string; hue: number };
  done: boolean;
  onOpen: () => void;
}) {
  const added = sprint.state !== "planned" && addedMidSprint(sprint, t);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${t.key} ${t.title}`}
      className="flex flex-col gap-[9px] rounded-lg border border-line bg-bg px-[11px] py-2.5 text-left transition-[border-color,transform] duration-150 ease-out hover:-translate-y-px hover:border-line-2 motion-reduce:hover:translate-y-0"
    >
      <span className="flex w-full items-center gap-2">
        <span className="font-mono text-[11.5px] font-medium text-fg-3">{t.key}</span>
        {added && (
          <span title="Added mid-sprint" className="inline-flex items-center gap-0.5 font-mono text-[10.5px] text-info">
            <Plus size={10} aria-hidden />
            <span className="sr-only">Added mid-sprint</span>
            {shortDate(t.createdAt.slice(0, 10))}
          </span>
        )}
        <span className="flex-1" />
        {assignee ? <Avatar name={assignee.name} hue={assignee.hue} size={20} ring={false} /> : <UnassignedAvatar size={20} />}
      </span>
      <span className={cn("line-clamp-2 text-[13px] font-medium leading-[18px]", done && "text-fg-2")}>{t.title}</span>
      <span className="flex w-full items-center gap-2">
        <PriorityIcon level={t.priority as PriorityLevel} label={priorityMeta[t.priority as PriorityLevel].label} />
        <span className="flex-1" />
        {t.estimate !== null && (
          <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] bg-raised px-1 font-mono text-[11px] font-medium text-fg-2">{t.estimate}</span>
        )}
      </span>
    </button>
  );
}
