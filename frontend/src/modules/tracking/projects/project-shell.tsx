"use client";

import { Suspense, type ReactNode } from "react";
import { ErrorScreen, NotFoundScreen, ProjectForbidden } from "@/components/shell/edge-screens";
import { Skeleton } from "@/components/ui/feedback";
import { NavTabs } from "@/components/ui/tabs";
import { canImport } from "@/features/import/import-lib";
import { ImportWizardHost } from "@/features/import/import-wizard-host";
import { TaskPanelHost } from "@/features/tasks/task-panel-host";
import { isForbidden, isNotFound, isApiError } from "@/lib/api/errors";
import type { Project, ProjectAccessInfo } from "@/lib/api/types";
import { can, ProjectScope, useCurrentWorkspace } from "@/lib/permissions/can";
import { routes, useRouteInfo, type ProjectView } from "@/lib/routes";
import { useProject } from "./queries";

/** Project views shown as tabs, gated only by my_permissions. */
export function projectTabs(p: Pick<Project, "my_permissions">): { view: ProjectView; label: string }[] {
  const perms = p.my_permissions;
  const tabs: { view: ProjectView; label: string; show: boolean }[] = [
    { view: "overview", label: "Overview", show: true },
    { view: "board", label: "Board", show: true },
    { view: "list", label: "List", show: true },
    { view: "backlog", label: "Backlog", show: true },
    // Board 32 (v2): everyone on the project sees them; editing is gated per bar / chip.
    { view: "timeline", label: "Timeline", show: true },
    { view: "calendar", label: "Calendar", show: true },
    // Board 27: everyone can view epics (viewer frame is read-only); epic.manage gates the actions.
    { view: "epics", label: "Epics", show: true },
    { view: "sprints", label: "Sprints", show: can("sprint.manage", perms) || can("task.move", perms) },
    { view: "objectives", label: "Objectives", show: true },
    { view: "milestones", label: "Milestones", show: true },
    { view: "reports", label: "Reports", show: can("report.view", perms) },
    // Board 33 (v2): everyone on the project; widgets are gated by report.view / project.view.
    { view: "dashboards", label: "Dashboards", show: true },
    {
      view: "settings",
      label: "Settings",
      // Board 40: the Import tab (history) is reachable by anyone who may import.
      show: can("project.update", perms) || can("project.manage_members", perms) || can("status.manage", perms) || canImport(perms),
    },
  ];
  return tabs.filter((t) => t.show);
}

export function ProjectShell({ projectKey, children }: { projectKey: string; children: ReactNode }) {
  const ws = useCurrentWorkspace()!;
  const route = useRouteInfo();
  const q = useProject(ws.slug, projectKey);

  if (q.isPending) {
    return (
      <div className="flex flex-col gap-4 px-8 py-6" aria-busy="true" aria-label="Loading project">
        <Skeleton className="h-9 w-[520px] max-w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (q.isError) {
    if (isForbidden(q.error)) {
      const info = (isApiError(q.error) ? q.error.details?.project : null) as ProjectAccessInfo | null;
      return <ProjectForbidden info={info} homeHref={routes.home(ws.slug)} />;
    }
    if (isNotFound(q.error)) return <NotFoundScreen bare path={route.pathname} home={routes.home(ws.slug)} title="Project not found" />;
    return <ErrorScreen bare error={q.error} onRetry={() => q.refetch()} />;
  }

  const project = q.data;
  const tabs = projectTabs(project);
  // Board and list are full-bleed work surfaces; the tab strip stays compact above them.
  return (
    <ProjectScope project={project}>
      <div className="flex h-full min-h-0 flex-col">
        <div className="z-[5] flex-none border-b border-line bg-bg px-8 max-[760px]:px-3">
          <NavTabs
            label="Project views"
            className="border-b-0"
            items={tabs.map((t) => ({
              href: routes.project(ws.slug, project.key, t.view),
              label: t.label,
              active: route.view === t.view,
            }))}
          />
        </div>
        {/* Settings shows its own archived banner with Unarchive (board 28). */}
        {project.status === "archived" && route.view !== "settings" && (
          <div role="status" className="flex h-10 items-center gap-2 border-b border-line bg-raised px-8 text-[13px] text-fg-2">
            This project is archived. It’s read-only until a project admin restores it.
          </div>
        )}
        {/* Each view scrolls inside this area; board and list manage their own inner scroll. */}
        <div data-project-scroll className="flex min-h-0 flex-1 flex-col overflow-auto">{children}</div>
      </div>
      <Suspense fallback={null}>
        <TaskPanelHost />
      </Suspense>
      {/* Board 40: ?import=new|<jobId> opens the import wizard on any project view. */}
      <Suspense fallback={null}>
        <ImportWizardHost />
      </Suspense>
    </ProjectScope>
  );
}
