"use client";

import { createContext, useCallback, useContext, type ReactNode } from "react";
import type {
  Permission,
  Project,
  ProjectPermission,
  Task,
  Workspace,
  WorkspacePermission,
} from "@/lib/api/types";
import { PROJECT_PERMISSIONS } from "@/lib/api/types";

/*
 * Permission layer. Driven ONLY by `my_permissions` from the workspace / project payloads,
 * never by role names. Workspace and project scopes are separate: a workspace Owner with no
 * project membership has no project permissions.
 *
 *   useCan("task.create")                    → current project scope (from <ProjectScope>)
 *   useCan("project.create")                 → current workspace scope
 *   useCan("task.delete", { project })       → an explicit project
 *   <Can permission="task.delete">…</Can>    → hidden means not rendered
 */

const WorkspaceCtx = createContext<Workspace | null>(null);
const ProjectCtx = createContext<Project | null>(null);

export function WorkspaceScope({ workspace, children }: { workspace: Workspace; children: ReactNode }) {
  return <WorkspaceCtx.Provider value={workspace}>{children}</WorkspaceCtx.Provider>;
}
export function ProjectScope({ project, children }: { project: Project | null; children: ReactNode }) {
  return <ProjectCtx.Provider value={project}>{children}</ProjectCtx.Provider>;
}

export const useCurrentWorkspace = () => useContext(WorkspaceCtx);
export const useCurrentProject = () => useContext(ProjectCtx);

export type Scope =
  | "workspace"
  | "project"
  | { workspace: Pick<Workspace, "my_permissions"> }
  | { project: Pick<Project, "my_permissions"> | null | undefined };

export const isProjectPermission = (p: Permission): p is ProjectPermission =>
  (PROJECT_PERMISSIONS as readonly string[]).includes(p);

/** Pure check, usable outside React. */
export function can(
  permission: Permission,
  perms: readonly string[] | undefined | null,
): boolean {
  return Boolean(perms?.includes(permission));
}

function resolve(permission: Permission, scope: Scope | undefined, ws: Workspace | null, project: Project | null) {
  let perms: readonly string[] | undefined;
  if (scope && typeof scope === "object") {
    perms = "workspace" in scope ? scope.workspace.my_permissions : scope.project?.my_permissions;
  } else if (scope === "workspace" || (!scope && !isProjectPermission(permission))) {
    perms = ws?.my_permissions;
  } else {
    perms = project?.my_permissions;
  }
  return can(permission, perms);
}

/** Returns a checker bound to the current workspace / project scope. */
export function usePermissions() {
  const ws = useContext(WorkspaceCtx);
  const project = useContext(ProjectCtx);
  return useCallback((permission: Permission, scope?: Scope) => resolve(permission, scope, ws, project), [ws, project]);
}

export function useCan(permission: Permission, scope?: Scope): boolean {
  return usePermissions()(permission, scope);
}

/** Edit rule for a task: edit_any, or edit_own on tasks you reported or are assigned. */
export function canEditTask(
  task: Pick<Task, "assigneeId" | "reporterId">,
  perms: readonly string[] | undefined,
  userId: string | undefined,
) {
  if (can("task.edit_any", perms)) return true;
  return can("task.edit_own", perms) && !!userId && (task.assigneeId === userId || task.reporterId === userId);
}

export function Can({
  permission,
  scope,
  children,
  fallback = null,
}: {
  permission: Permission | Permission[];
  scope?: Scope;
  children: ReactNode;
  /** Rendered when not allowed. Defaults to nothing ("hidden means not rendered"). */
  fallback?: ReactNode;
}) {
  const check = usePermissions();
  const list = Array.isArray(permission) ? permission : [permission];
  return <>{list.every((p) => check(p, scope)) ? children : fallback}</>;
}

export type { WorkspacePermission, ProjectPermission };
