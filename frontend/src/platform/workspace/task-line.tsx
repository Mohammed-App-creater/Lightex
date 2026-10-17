"use client";

import { useQueries } from "@tanstack/react-query";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import { triggerSpark } from "@/features/tasks/task-origin";
import { useUpdateTask } from "@/features/tasks/mutations";
import { api } from "@/lib/api/endpoints";
import { qk } from "@/lib/api/query-keys";
import type { Project, Status, Task } from "@/lib/api/types";
import { can, canEditTask, useCurrentWorkspace } from "@/lib/permissions/can";
import { withTaskParam } from "@/lib/routes";
import { useProjects } from "./queries";

/** Status lookup across every project the user can see (for cross-project task lists). */
export function useStatusMap() {
  const ws = useCurrentWorkspace()!;
  const projectsQ = useProjects(ws.slug);
  const projects = projectsQ.data;
  const combined = useQueries({
    queries: (projects ?? []).map((p) => ({ queryKey: qk.statuses(p.id), queryFn: () => api.projects.statuses(p.id), staleTime: 5 * 60_000 })),
    combine: combineStatuses,
  });
  const pending = projectsQ.isPending || combined.pending;
  return useMemo(() => build(projects ?? [], combined.data, pending), [projects, combined, pending]);
}

// Module-level so TanStack only re-runs it when a query result changes (stable result otherwise).
function combineStatuses(results: { data?: Status[]; isPending: boolean }[]) {
  return { data: results.map((r) => r.data), pending: results.some((r) => r.isPending) };
}

function build(projects: Project[], data: (Status[] | undefined)[], pending: boolean) {
  const statuses = new Map<string, Status>();
  const byProject = new Map<string, Status[]>();
  data.forEach((list) => {
    if (!list?.length) return;
    list.forEach((s) => statuses.set(s.id, s));
    byProject.set(list[0]!.projectId, [...list].sort((a, b) => a.position - b.position));
  });
  return { statuses, byProject, projects: new Map<string, Project>(projects.map((p) => [p.id, p])), pending };
}

/** Same rule as the board: task.move, or the task-edit rule (edit_any / edit_own). */
export function canChangeStatus(task: Task, project: Project | undefined, meId: string) {
  if (!project) return false;
  return can("task.move", project.my_permissions) || canEditTask(task, project.my_permissions, meId);
}

/** Optimistic status change (rollback + toast live in useUpdateTask). Sparks on Done. */
export function useSetStatus(byProject: Map<string, Status[]>) {
  const update = useUpdateTask();
  return useCallback(
    (task: Task, status: Status) => {
      if (task.statusId === status.id) return;
      if (status.glyph === "done") triggerSpark(task.id);
      update.mutate({ task, patch: { statusId: status.id }, statuses: byProject.get(task.projectId) });
    },
    [update, byProject],
  );
}

/** href that opens the task side panel on the current page (?task=KEY). */
export function useTaskHref() {
  const pathname = usePathname();
  const search = useSearchParams();
  const qs = search.toString();
  return useCallback((key: string) => withTaskParam(pathname, qs, key), [pathname, qs]);
}
