"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, RefreshCcw } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, ProgressBar, ProgressRing, Skeleton } from "@/components/ui/feedback";
import { toast } from "@/components/ui/toast";
import { useSprints } from "@/features/projects/queries";
import { api } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import type { Sprint } from "@/lib/api/types";
import { daysUntil } from "@/lib/domain/progress";
import { useCan, useCurrentProject, useCurrentWorkspace } from "@/lib/permissions/can";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils/cn";
import { dateRange } from "@/lib/utils/dates";
import { CompleteSprintDialog, EditSprintDialog, StartSprintDialog } from "./sprint-dialogs";

/** Sprints: the active sprint, what's planned next, and the completed history. */
export function SprintsScreen() {
  const project = useCurrentProject()!;
  const ws = useCurrentWorkspace()!;
  const qc = useQueryClient();
  const canSprint = useCan("sprint.manage");
  const q = useSprints(project.id);
  const create = useMutation({
    mutationFn: () => api.planning.createSprint(project.id),
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: qk.scope(project.id) });
      toast.success(`${s.name} created`, { body: "Plan it from the backlog." });
    },
    onError: (e) => toast.error("Couldn’t create a sprint", { body: errorMessage(e) }),
  });
  const sprints = q.data ?? [];
  const active = sprints.find((s) => s.state === "active");
  const planned = sprints.filter((s) => s.state === "planned").sort((a, b) => a.number - b.number);
  const done = sprints.filter((s) => s.state === "completed").sort((a, b) => b.number - a.number);

  return (
    <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-6 px-8 pb-16 pt-6 max-[760px]:px-3">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="m-0 text-h3">Sprints</h1>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" asChild>
          <Link href={routes.project(ws.slug, project.key, "backlog")}>Plan in backlog</Link>
        </Button>
        {canSprint && (
          <Button size="sm" variant="primary" loading={create.isPending} onClick={() => create.mutate()}>
            <Plus size={13} aria-hidden /> Create sprint
          </Button>
        )}
      </div>
      {q.isPending ? (
        <div aria-busy="true" aria-label="Loading sprints" className="flex flex-col gap-3">
          <Skeleton className="h-44 rounded-lg" />
          <Skeleton className="h-24 rounded-lg" />
        </div>
      ) : q.isError ? (
        <ErrorState title="Couldn’t load sprints" body={errorMessage(q.error)} onRetry={() => void q.refetch()} />
      ) : sprints.length === 0 ? (
        <EmptyState
          icon={<RefreshCcw size={20} aria-hidden />}
          title="No sprints yet"
          body="Sprints group work into 1–2 week cycles. Create one, then pull tasks in from the backlog."
          actions={canSprint ? <Button variant="primary" onClick={() => create.mutate()}>Create sprint</Button> : undefined}
        />
      ) : (
        <>
          <Group title="Active">
            {active ? <SprintCard sprint={active} canSprint={canSprint} next={planned[0]} hasActive /> : <p className="m-0 text-[13px] text-fg-2">No sprint is running.</p>}
          </Group>
          {planned.length > 0 && (
            <Group title="Planned">
              {planned.map((s) => (
                <SprintCard key={s.id} sprint={s} canSprint={canSprint} hasActive={Boolean(active)} />
              ))}
            </Group>
          )}
          {done.length > 0 && (
            <Group title="Completed">
              <ul className="m-0 flex list-none flex-col divide-y divide-line rounded-lg border border-line bg-surface p-0">
                {done.map((s) => (
                  <li key={s.id} className="grid grid-cols-[minmax(0,1fr)_160px_120px_80px] items-center gap-4 px-4 py-3 max-[760px]:grid-cols-[minmax(0,1fr)_80px]">
                    <span className="flex min-w-0 flex-col">
                      <span className="font-semibold">{s.name}</span>
                      <span className="truncate text-meta text-fg-3">{s.goal || "No goal set"}</span>
                    </span>
                    <span className="font-mono text-meta text-fg-3 max-[760px]:hidden">{dateRange(s.startDate, s.endDate)}</span>
                    <ProgressBar value={s.progress.percent} label={`${s.name} completion`} color="var(--ok)" className="max-[760px]:hidden" />
                    <span className="text-right font-mono text-meta text-fg-2">
                      {s.progress.donePoints}/{s.progress.points} pts
                    </span>
                  </li>
                ))}
              </ul>
            </Group>
          )}
        </>
      )}
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <h2 className="eyebrow m-0">{title}</h2>
      {children}
    </section>
  );
}

function SprintCard({ sprint, canSprint, next, hasActive }: { sprint: Sprint; canSprint: boolean; next?: Sprint; hasActive: boolean }) {
  const ws = useCurrentWorkspace()!;
  const project = useCurrentProject()!;
  const [dialog, setDialog] = useState<"start" | "complete" | "edit" | null>(null);
  const isActive = sprint.state === "active";
  const left = daysUntil(sprint.endDate);
  const startReason = hasActive ? "Complete the active sprint first" : sprint.progress.total === 0 ? "Add tasks to the sprint before starting it" : undefined;
  return (
    <div className={cn("flex flex-wrap items-center gap-5 rounded-lg border bg-surface p-5", isActive ? "border-line-2" : "border-line")}>
      <ProgressRing value={sprint.progress.percent} size={isActive ? 84 : 56} color={isActive ? "var(--accent)" : "var(--text-2)"} label={sprint.name} showValue />
      <div className="flex min-w-0 flex-[1_1_260px] flex-col gap-1">
        <div className="flex items-center gap-2">
          <h3 className="m-0 text-title">{sprint.name}</h3>
          <span className="font-mono text-meta text-fg-3">{dateRange(sprint.startDate, sprint.endDate)}</span>
        </div>
        <p className="m-0 text-[13px] text-fg-2">{sprint.goal || <span className="text-fg-3">No goal set.</span>}</p>
        <p className="m-0 font-mono text-meta text-fg-3">
          {sprint.progress.done}/{sprint.progress.total} tasks · {sprint.progress.donePoints}/{sprint.progress.points} pts
          {isActive && ` · ${left >= 0 ? `${left}d left` : `${-left}d over`}`}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" asChild>
          <Link href={routes.project(ws.slug, project.key, isActive ? "board" : "backlog")}>{isActive ? "Open board" : "Plan"}</Link>
        </Button>
        {canSprint && (
          <Button size="sm" variant="ghost" onClick={() => setDialog("edit")}>
            Edit
          </Button>
        )}
        {canSprint && isActive && <Button size="sm" onClick={() => setDialog("complete")}>Complete sprint</Button>}
        {canSprint && !isActive && (
          <Button size="sm" variant={startReason ? "secondary" : "primary"} disabledReason={startReason} onClick={() => setDialog("start")}>
            Start sprint
          </Button>
        )}
      </div>
      {dialog === "start" && <StartSprintDialog sprint={sprint} open onOpenChange={(o) => !o && setDialog(null)} />}
      {dialog === "complete" && (
        <CompleteSprintDialog sprint={sprint} next={next} openCount={sprint.progress.total - sprint.progress.done} open onOpenChange={(o) => !o && setDialog(null)} />
      )}
      {dialog === "edit" && <EditSprintDialog sprint={sprint} open onOpenChange={(o) => !o && setDialog(null)} />}
    </div>
  );
}
