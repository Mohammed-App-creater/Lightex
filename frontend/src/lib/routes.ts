"use client";

import { useParams, usePathname } from "next/navigation";

export type ProjectView =
  | "overview"
  | "board"
  | "list"
  | "backlog"
  | "sprints"
  | "epics"
  | "objectives"
  | "milestones"
  | "reports"
  | "settings";

export type SettingsSection = "general" | "members" | "roles" | "notifications" | "profile" | "audit";

export const routes = {
  login: (next?: string) => (next ? `/login?next=${encodeURIComponent(next)}` : "/login"),
  onboarding: () => "/onboarding",
  home: (ws: string) => `/${ws}`,
  inbox: (ws: string) => `/${ws}/inbox`,
  myTasks: (ws: string, view?: string) => `/${ws}/my-tasks${view ? `?view=${view}` : ""}`,
  search: (ws: string, q?: string) => `/${ws}/search${q ? `?q=${encodeURIComponent(q)}` : ""}`,
  project: (ws: string, key: string, view: ProjectView = "overview") =>
    `/${ws}/projects/${key}${view === "overview" ? "" : `/${view}`}`,
  task: (ws: string, key: string) => `/${ws}/tasks/${key}`,
  settings: (ws: string, section: SettingsSection = "general") => `/${ws}/settings/${section}`,
  trash: (ws: string) => `/${ws}/trash`,
};

/** Adds or removes ?task=KEY on the current URL (task side panel). */
export function withTaskParam(pathname: string, search: string, key: string | null) {
  const sp = new URLSearchParams(search);
  if (key) sp.set("task", key);
  else sp.delete("task");
  const qs = sp.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

/** Where we are: workspace slug, project key and view, from the URL. */
export function useRouteInfo() {
  const params = useParams<{ workspace?: string; key?: string; taskKey?: string }>();
  const pathname = usePathname();
  const parts = pathname.split("/").filter(Boolean);
  const ws = params.workspace ?? "";
  let view: ProjectView | null = null;
  if (parts[1] === "projects" && parts[2]) view = ((parts[3] as ProjectView | undefined) ?? "overview") as ProjectView;
  const section = parts[1] === "settings" ? ((parts[2] as SettingsSection | undefined) ?? "general") : null;
  return {
    workspace: ws,
    projectKey: params.key ? params.key.toUpperCase() : null,
    taskKey: params.taskKey ?? null,
    view,
    section,
    page: (parts[1] ?? "home") as "home" | "inbox" | "my-tasks" | "search" | "projects" | "tasks" | "settings" | "trash",
    pathname,
  };
}
