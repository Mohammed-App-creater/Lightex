"use client";

import { useQueries } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { ProjectBadge } from "@/components/ui/avatar";
import { PriorityIcon, StatusGlyph } from "@/components/ui/glyphs";
import { DueText } from "@/features/tasks/task-bits";
import { api } from "@/lib/api/endpoints";
import { qk } from "@/lib/api/query-keys";
import type { Project, Status, Task } from "@/lib/api/types";
import { useCurrentWorkspace } from "@/lib/permissions/can";
import { routes } from "@/lib/routes";
import { useProjects } from "./queries";

/** Status lookup across every project the user can see (for cross-project task lists). */
export function useStatusMap() {
  const ws = useCurrentWorkspace()!;
  const { data: projects = [] } = useProjects(ws.slug);
  const results = useQueries({
    queries: projects.map((p) => ({ queryKey: qk.statuses(p.id), queryFn: () => api.projects.statuses(p.id), staleTime: 5 * 60_000 })),
  });
  return useMemo(() => {
    const m = new Map<string, Status>();
    results.forEach((r) => r.data?.forEach((s) => m.set(s.id, s)));
    return { statuses: m, projects: new Map<string, Project>(projects.map((p) => [p.id, p])) };
  }, [results, projects]);
}

/** One task in a cross-project list: glyph, key, title, project, priority, due. Opens the panel. */
export function TaskLine({ task, status, project }: { task: Task; status: Status | undefined; project: Project | undefined }) {
  const ws = useCurrentWorkspace()!;
  const router = useRouter();
  const done = status?.category === "done";
  return (
    <li>
      <button
        type="button"
        onClick={() => router.push(project ? `${routes.project(ws.slug, project.key, "board")}?task=${task.key}` : routes.task(ws.slug, task.key))}
        aria-label={`Open ${task.key}: ${task.title}`}
        className="-mx-2 flex h-11 w-[calc(100%+16px)] items-center gap-3 rounded-md px-2 text-left hover:bg-hover"
      >
        <StatusGlyph kind={status?.glyph ?? "todo"} label={status?.name} />
        <span className="w-[56px] flex-none font-mono text-[11.5px] font-medium text-fg-3">{task.key}</span>
        <span className={`min-w-0 flex-1 truncate font-medium ${done ? "text-fg-3 line-through" : ""}`}>{task.title}</span>
        {project && (
          <span className="hidden items-center gap-1.5 text-meta text-fg-3 sm:flex">
            <ProjectBadge code={project.key.slice(0, 2)} hue={project.hue} size={18} />
            {project.name}
          </span>
        )}
        <PriorityIcon level={task.priority} bars />
        <span className="w-14 text-right">
          <DueText due={task.dueDate} done={done} />
        </span>
      </button>
    </li>
  );
}
