import { BarChart3, CircleCheck, Clock, Columns3, Flag, ListTodo, RefreshCcw, Target, Upload } from "lucide-react";
import { lazyWithPreload } from "@/lib/hooks/lazy-with-preload";
import { can } from "@/platform/roles/can";
import { routes } from "@/platform/routes";
import type { ModuleDefinition } from "@/registry";
import { PinnedViews } from "./filters/pinned-views";
import { TASK_TARGET } from "./tasks/target";
import { TaskNotificationPreview } from "./tasks/notification-preview";
import { canImportInto } from "./import/import-lib";
import { SprintCard } from "./sprints/sidebar-sprint-card";

/* The tracking module's contributions to the shell (see `src/registry/index.ts`). */

// Opens on demand ("c", the New task button): split out of the shell chunk and warmed at idle.
const createTask = lazyWithPreload(() => import("./tasks/create-task-dialog").then((m) => m.CreateTaskDialog));

export const tracking: ModuleDefinition = {
  key: "tracking",
  name: "Tracking",
  icon: Columns3,
  // Not toggleable in Stage 3, but its routes are declared like any module's.
  routes: [{ segment: "projects" }, { segment: "tasks" }, { segment: "my-tasks" }, { segment: "timesheet" }],
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
  // Saved views pinned by me (board 30): Manage / Done, Alt+↑↓ reorder.
  sidebarSections: [{ id: "tracking.pinned-views", Component: PinnedViews }],
  sidebarProjectCards: [{ id: "tracking.sprint", Component: SprintCard }],
  shellOverlays: [{ id: "tracking.create-task", Component: createTask.Component, preload: createTask.preload }],
  paletteActions: ({ currentProject }) => [
    {
      // Board 40 (E4): project context only, with tracking.project.import + tracking.task.create on an active project.
      id: "import",
      label: "Import tasks…",
      keys: [],
      icon: <Upload size={12} aria-hidden />,
      run: () => void import("./import/import-wizard-host").then((m) => m.openImportWizard()),
      allowed: Boolean(currentProject && canImportInto(currentProject)),
    },
  ],
  // Inbox preview chips (status, priority, assignee, due) for task notifications; older rows have only a taskKey.
  targetPreviews: [{ targetType: TASK_TARGET, fallback: (n) => Boolean(n.taskKey), Component: TaskNotificationPreview }],
};
