"use client";

import { useQuery } from "@tanstack/react-query";
import { FolderPlus, Plus } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { Avatar, ProjectBadge } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/card";
import { EmptyState, ErrorState, ProgressBar, Skeleton } from "@/components/ui/feedback";
import { shell } from "@/components/shell/shell-state";
import { useMe } from "@/features/auth/session";
import { activityText } from "@/features/tasks/task-comments";
import { api } from "@/lib/api/endpoints";
import { qk } from "@/lib/api/query-keys";
import type { Project, Task } from "@/lib/api/types";
import { daysUntil } from "@/lib/domain/progress";
import { can, useCan, useCurrentWorkspace } from "@/lib/permissions/can";
import { routes } from "@/lib/routes";
import { addDaysISO, agoOrDate, todayISO } from "@/lib/utils/dates";
import { NewProjectDialog } from "./new-project-dialog";
import { useMyTasks, useProjects, useWsMembers } from "./queries";
import { TaskLine, useStatusMap } from "./task-line";

export type Bucket = { id: string; title: string; tasks: Task[] };

/** Groups open tasks by due date: Overdue, Today, This week, Later, No date. */
export function bucketTasks(tasks: Task[], today = todayISO()): Bucket[] {
  const week = addDaysISO(today, 7);
  const b: Bucket[] = [
    { id: "overdue", title: "Overdue", tasks: [] },
    { id: "today", title: "Today", tasks: [] },
    { id: "week", title: "This week", tasks: [] },
    { id: "later", title: "Later", tasks: [] },
    { id: "none", title: "No due date", tasks: [] },
  ];
  for (const t of tasks) {
    const d = t.dueDate;
    const target = !d ? b[4]! : d < today ? b[0]! : d === today ? b[1]! : d <= week ? b[2]! : b[3]!;
    target.tasks.push(t);
  }
  return b.filter((x) => x.tasks.length);
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export function HomeScreen() {
  const ws = useCurrentWorkspace()!;
  const me = useMe();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const canCreateProject = useCan("project.create");
  const projects = useProjects(ws.slug);
  const mine = useMyTasks(ws.slug);
  const { statuses, projects: projectMap } = useStatusMap();
  const newProject = search.get("new-project") === "1" && canCreateProject;
  const open = useMemo(() => (mine.data ?? []).filter((t) => statuses.get(t.statusId)?.category !== "done"), [mine.data, statuses]);
  const buckets = bucketTasks(open);
  const anyCreate = (projects.data ?? []).some((p) => can("task.create", p.my_permissions));

  return (
    <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-6 px-8 pb-16 pt-7 max-[760px]:px-4">
      <header className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-[260px] flex-1 flex-col gap-1">
          <h1 className="m-0 text-h2">
            {greeting()}, {me.name.split(" ")[0]}
          </h1>
          <p className="m-0 text-[13px] text-fg-2">
            {open.length ? `${open.length} open ${open.length === 1 ? "task is" : "tasks are"} yours across ${ws.name}.` : `Nothing assigned to you in ${ws.name} right now.`}
          </p>
        </div>
        {canCreateProject && (
          <Button size="sm" onClick={() => router.push(`${pathname}?new-project=1`)}>
            <FolderPlus size={14} aria-hidden /> New project
          </Button>
        )}
        {anyCreate && (
          <Button size="sm" variant="primary" kbd="C" onClick={() => shell.openCreateTask()}>
            New task
          </Button>
        )}
      </header>

      <div className="flex flex-wrap items-start gap-6">
        <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-6">
          <Panel title="My work" actions={<Button size="sm" variant="ghost" asChild><Link href={routes.myTasks(ws.slug)}>View all</Link></Button>}>
            {mine.isPending ? (
              <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading your tasks">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-9" />
                ))}
              </div>
            ) : mine.isError ? (
              <ErrorState title="Couldn’t load your tasks" onRetry={() => void mine.refetch()} />
            ) : buckets.length === 0 ? (
              <EmptyState icon={<Plus size={20} aria-hidden />} title="You’re all clear" body="Nothing assigned to you. Pick something up from a board, or create a task." />
            ) : (
              <div className="flex flex-col gap-4">
                {buckets.slice(0, 3).map((b) => (
                  <section key={b.id} aria-label={b.title}>
                    <h3 className={`eyebrow m-0 mb-1 ${b.id === "overdue" ? "text-danger" : ""}`}>
                      {b.title} · {b.tasks.length}
                    </h3>
                    <ul className="m-0 list-none p-0">
                      {b.tasks.slice(0, 6).map((t) => (
                        <TaskLine key={t.id} task={t} status={statuses.get(t.statusId)} project={projectMap.get(t.projectId)} />
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </Panel>
        </div>
        <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-6">
          <ActivityPanel />
        </div>
      </div>

      <section aria-labelledby="projects-h" className="flex flex-col gap-3">
        <h2 id="projects-h" className="m-0 text-title">
          Projects
        </h2>
        {projects.isPending ? (
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-32 rounded-lg" />
            ))}
          </div>
        ) : projects.isError ? (
          <ErrorState title="Couldn’t load projects" onRetry={() => void projects.refetch()} />
        ) : (projects.data ?? []).length === 0 ? (
          <EmptyState
            icon={<FolderPlus size={20} aria-hidden />}
            title="No projects yet"
            body={canCreateProject ? "Create a project to start planning work." : "You haven’t been added to a project yet. Ask a workspace admin to add you."}
            actions={canCreateProject ? <Button variant="primary" onClick={() => router.push(`${pathname}?new-project=1`)}>New project</Button> : undefined}
          />
        ) : (
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]">
            {projects.data!.map((p) => (
              <ProjectCard key={p.id} project={p} />
            ))}
          </div>
        )}
      </section>
      <NewProjectDialog open={newProject} onOpenChange={(o) => !o && router.replace(pathname)} />
    </div>
  );
}

function ProjectCard({ project }: { project: Project }) {
  const ws = useCurrentWorkspace()!;
  const sprint = useQuery({ queryKey: [...qk.sprints(project.id), "active"], queryFn: () => api.planning.activeSprint(project.id) });
  const s = sprint.data;
  return (
    <Link
      href={routes.project(ws.slug, project.key)}
      className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4 transition-[border-color,transform,box-shadow] duration-150 [transition-timing-function:var(--spring)] hover:-translate-y-0.5 hover:border-line-2 hover:shadow-pop motion-reduce:hover:translate-y-0"
    >
      <div className="flex items-center gap-2.5">
        <ProjectBadge code={project.key.slice(0, 2)} hue={project.hue} size={24} />
        <span className="min-w-0 flex-1 truncate font-semibold">{project.name}</span>
        <span className="font-mono text-meta text-fg-3">{project.key}</span>
      </div>
      <p className="m-0 line-clamp-2 min-h-10 text-[12.5px] leading-5 text-fg-2">{project.description}</p>
      {s ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex justify-between text-meta text-fg-3">
            <span>{s.name}</span>
            <span className="font-mono">
              {s.progress.percent}% · {Math.max(0, daysUntil(s.endDate))}d left
            </span>
          </div>
          <ProgressBar value={s.progress.percent} label={`${s.name} progress`} color="var(--accent-t)" />
        </div>
      ) : (
        <span className="text-meta text-fg-3">{project.openTaskCount} open tasks · no active sprint</span>
      )}
    </Link>
  );
}

function ActivityPanel() {
  const ws = useCurrentWorkspace()!;
  const { data, isPending, isError, refetch } = useQuery({ queryKey: qk.wsActivity(ws.slug), queryFn: () => api.workspaces.activity(ws.slug, { limit: 10 }) });
  const { data: members = [] } = useWsMembers(ws.slug);
  return (
    <Panel title="Recent activity">
      {isPending ? (
        <Skeleton className="h-48" />
      ) : isError ? (
        <ErrorState title="Couldn’t load activity" onRetry={() => void refetch()} />
      ) : !data?.data.length ? (
        <span className="text-[13px] text-fg-2">No activity yet.</span>
      ) : (
        <div role="feed" aria-label="Recent activity" className="flex flex-col">
          {data.data.map((a) => {
            const actor = members.find((m) => m.userId === a.actorId)?.user;
            return (
              <article key={a.id} className="flex gap-2.5 py-2 text-[13px] leading-5 text-fg-2">
                <Avatar name={actor?.name ?? "Lightex"} hue={actor?.hue} size={20} className="mt-px" decorative />
                <span className="min-w-0 flex-1">
                  <b className="font-medium text-fg">{actor?.name ?? "Lightex"}</b> {activityText(a, a.taskKey ?? undefined)}
                </span>
                <span className="whitespace-nowrap text-meta text-fg-3">{agoOrDate(a.createdAt)}</span>
              </article>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
