import { BarChart3, CircleCheck, Clock, Columns3, Flag, ListTodo, RefreshCcw, Target, type LucideIcon } from "lucide-react";
import { can } from "@/platform/roles/can";
import { routes, type ProjectView, type RouteInfo } from "@/lib/routes";

/*
 * Module registry (docs/platform-architecture.md §5 and §11). Platform Stage 1 keeps it minimal: each
 * module declares its key, its name and the navigation it adds to the shell. The sidebar renders these
 * items instead of hard-coding them. `enabled_modules`, route groups and required permissions per module
 * arrive in Stage 3; until then every registered module is on.
 */

export type ModuleKey = "tracking";

/** A workspace-level sidebar link (expanded sidebar and collapsed rail). */
export interface ModuleNavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  href: (ws: string) => string;
  /** The `useRouteInfo().page` that marks the item active. */
  page: RouteInfo["page"];
  /** Shortcut shown in the rail tooltip. */
  keys?: string[];
}

/** A link under each project in the sidebar's project accordion. */
export interface ModuleProjectNavItem {
  view: ProjectView;
  label: string;
  icon: LucideIcon;
  /** Hidden unless this returns true for the project's `my_permissions`. */
  gate?: (perms: string[]) => boolean;
}

export interface ModuleDefinition {
  key: ModuleKey;
  name: string;
  nav: ModuleNavItem[];
  projectNav: ModuleProjectNavItem[];
}

export const tracking: ModuleDefinition = {
  key: "tracking",
  name: "Tracking",
  nav: [
    { id: "my-tasks", label: "My tasks", icon: CircleCheck, href: (ws) => routes.myTasks(ws), page: "my-tasks", keys: ["G", "T"] },
    // Board 39 (v2): every workspace member; data is limited to projects they can see.
    { id: "timesheet", label: "Timesheet", icon: Clock, href: (ws) => routes.timesheet(ws), page: "timesheet" },
  ],
  projectNav: [
    { view: "board", label: "Board", icon: Columns3 },
    { view: "backlog", label: "Backlog", icon: ListTodo },
    {
      view: "sprints",
      label: "Sprints",
      icon: RefreshCcw,
      // People who plan or move work see sprints; read-only viewers don't (board 13).
      gate: (p) => can("tracking.sprint.manage", p) || can("tracking.task.move", p),
    },
    { view: "objectives", label: "Objectives", icon: Target },
    { view: "milestones", label: "Milestones", icon: Flag },
    { view: "reports", label: "Reports", icon: BarChart3, gate: (p) => can("tracking.report.view", p) },
  ],
};

/** Every module, in sidebar order. */
export const MODULES: readonly ModuleDefinition[] = [tracking];

export const moduleNavItems = () => MODULES.flatMap((m) => m.nav);
export const projectNavItems = () => MODULES.flatMap((m) => m.projectNav);
