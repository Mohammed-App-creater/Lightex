"use client";

import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { toast } from "@/components/ui/toast";
import { useProjects } from "@/features/workspace/queries";
import { useHotkeys } from "@/lib/hooks/use-hotkeys";
import { can, useCurrentWorkspace } from "@/lib/permissions/can";
import { routes, useRouteInfo, type ProjectView } from "@/lib/routes";
import { shell } from "./shell-state";

/** Global shortcuts (brief + boards 13/22). Shown in tooltips and the "?" sheet. */
export function GlobalHotkeys() {
  const ws = useCurrentWorkspace()!;
  const router = useRouter();
  const route = useRouteInfo();
  const { theme, setTheme } = useTheme();
  const { data: projects = [] } = useProjects(ws.slug);
  const current = projects.find((p) => p.key === route.projectKey) ?? projects[0];

  const go = (view: ProjectView) => () => {
    if (current) router.push(routes.project(ws.slug, current.key, view));
  };

  useHotkeys({
    "mod+k": () => shell.openPalette(),
    "mod+b": () => shell.toggleCollapsed(),
    "[": () => shell.toggleCollapsed(),
    "?": () => shell.setShortcuts(true),
    "mod+,": () => router.push(routes.settings(ws.slug, can("workspace.update", ws.my_permissions) ? "general" : "profile")),
    c: () => {
      if (!projects.some((p) => can("task.create", p.my_permissions))) {
        toast.info("Your role can’t create tasks in any project");
        return;
      }
      shell.openCreateTask(current && can("task.create", current.my_permissions) ? { projectId: current.id } : {});
    },
    "mod+shift+l": () => {
      const next = theme === "light" ? "dark" : "light";
      setTheme(next);
      toast.info(`Theme: ${next === "light" ? "Light" : "Navy"}`);
    },
    "g b": go("board"),
    "g l": go("list"),
    "g s": go("sprints"),
    "g k": go("backlog"),
    "g o": go("objectives"),
    "g m": go("milestones"),
    "g r": go("reports"),
    "g i": () => router.push(routes.inbox(ws.slug)),
    "g t": () => router.push(routes.myTasks(ws.slug)),
    "g h": () => router.push(routes.home(ws.slug)),
    "g p": () => router.push(routes.settings(ws.slug, "profile")),
  });
  return null;
}
