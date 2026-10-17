import type {
  DataScope,
  PermissionGroup,
  PermissionInfo,
  PermissionModule,
  ProjectPermission,
  RoleScope,
  WorkspacePermission,
} from "@/api/types";

/*
 * Permission keys come from the brief (the behavioural spec), namespaced by module since platform Stage 1
 * (docs/platform/stage1-contract.md §1): `core.*` for the platform, `tracking.*` for the tracking module. Labels, descriptions and the
 * group order (Tasks, Planning, Collaboration, Reports, Administration) follow board 18.
 * The design's own keys (t.create, p.sprints, …) are a conflict noted in the final report.
 */

export const PERMISSION_GROUP_ORDER: PermissionGroup[] = [
  "Tasks",
  "Planning",
  "Collaboration",
  "Reports",
  "Administration",
];

/** The module is the code's first segment: `core.*`, `tracking.*` or `sales.*`. */
export const moduleOf = (key: string): PermissionModule => {
  const head = key.slice(0, key.indexOf("."));
  return head === "core" || head === "sales" ? head : "tracking";
};

const ws = (
  key: WorkspacePermission,
  group: PermissionGroup,
  label: string,
  description: string,
): PermissionInfo => ({ key, module: moduleOf(key), scope: "workspace", group, label, description, scopable: false });

const prj = (
  key: ProjectPermission,
  group: PermissionGroup,
  label: string,
  description: string,
): PermissionInfo => ({ key, module: moduleOf(key), scope: "project", group, label, description, scopable: false });

export const PERMISSION_CATALOGUE: PermissionInfo[] = [
  // Workspace scope
  ws("tracking.project.create", "Planning", "Create projects", "Start new projects in this workspace"),
  ws("core.workspace.manage_members", "Collaboration", "Manage members", "Invite, remove and change member roles"),
  ws("core.audit.view", "Reports", "View audit log", "See who changed what across the workspace"),
  ws("core.workspace.view", "Administration", "View workspace", "See the workspace and its project list"),
  ws("core.workspace.update", "Administration", "Workspace settings", "Rename the workspace and change its URL"),
  ws("core.roles.manage", "Administration", "Manage roles", "Create and edit roles"),
  // Board 37 (v2): after core.roles.manage, as in the backend catalogue.
  ws("tracking.integration.manage", "Administration", "Manage integrations", "Connect GitHub and GitLab, choose repositories and disconnect"),
  ws("tracking.project.assign_admin", "Administration", "Assign project admins", "Make members admins of any project"),
  ws("core.workspace.delete", "Administration", "Delete workspace", "Delete the workspace and all its projects"),
  // Platform Stage 1: catalogue and default roles only; their screens arrive in Stages 3 and 4.
  ws("core.modules.manage", "Administration", "Manage modules", "Turn modules on and off for the workspace"),
  ws("core.teams.manage", "Administration", "Manage teams", "Create teams and choose their members and leads"),
  // Sales S0: the Sales area (placeholder until S1), scopable. Listed with module "sales"; hidden while sales is off.
  { ...ws("sales.dashboard.view", "Reports", "View sales dashboard", "Open Sales and see dashboards over the visible people"), scopable: true },
  // Project scope
  prj("tracking.task.create", "Tasks", "Create tasks", "Add tasks to the board and backlog"),
  prj("tracking.task.edit_any", "Tasks", "Edit any task", "Change fields on others’ tasks"),
  prj("tracking.task.edit_own", "Tasks", "Edit own tasks", "Change tasks you reported or are assigned"),
  prj("tracking.task.assign", "Tasks", "Assign tasks", "Change who a task is assigned to"),
  prj("tracking.task.move", "Tasks", "Move tasks", "Drag tasks between columns and sprints"),
  prj("tracking.task.delete", "Tasks", "Delete tasks", "Remove tasks (restorable for 30 days)"),
  prj("tracking.time.log", "Tasks", "Log time", "Track time on tasks with the timer or by hand"),
  prj("tracking.time.delete_any", "Tasks", "Delete anyone’s time", "Remove time entries logged by others"),
  prj("tracking.project.import", "Tasks", "Import tasks", "Bring in tasks from a CSV or another tool’s export"),
  // Board 37 (v2): after tracking.project.import.
  prj("tracking.development.link", "Tasks", "Link code", "Create branches and link or unlink pull requests, commits and branches"),
  prj("tracking.sprint.manage", "Planning", "Manage sprints", "Start, close and plan sprints"),
  prj("tracking.milestone.manage", "Planning", "Edit milestones", "Create milestones and move dates"),
  prj("tracking.objective.manage", "Planning", "Set objectives", "Create objectives and link tasks"),
  prj("tracking.epic.manage", "Planning", "Manage epics", "Create and rename epics"),
  prj("tracking.status.manage", "Planning", "Edit workflow", "Add, rename and reorder statuses"),
  prj("tracking.field.manage", "Planning", "Manage custom fields", "Create, edit, reorder and delete custom fields"),
  prj("tracking.comment.create", "Collaboration", "Comment", "Reply and mention teammates"),
  prj("tracking.comment.edit_own", "Collaboration", "Edit own comments", "Fix typos in your comments"),
  prj("tracking.comment.delete_any", "Collaboration", "Delete any comment", "Remove anyone’s comment"),
  prj("tracking.attachment.upload", "Collaboration", "Upload files", "Attach images and code files"),
  prj("tracking.attachment.delete_any", "Collaboration", "Delete any file", "Remove anyone’s attachment"),
  prj("tracking.project.manage_members", "Collaboration", "Manage members", "Add people and set their project role"),
  // Board 33 (v2): right before tracking.report.view, as in the backend catalogue.
  prj("tracking.dashboard.create", "Reports", "Create dashboards", "Build dashboards and edit the ones you created"),
  prj("tracking.dashboard.manage", "Reports", "Manage shared dashboards", "Edit, rearrange and delete any shared dashboard"),
  prj("tracking.report.view", "Reports", "View reports", "Velocity, burndown, cycle time"),
  prj("tracking.project.view", "Administration", "View project", "See the project, its board and tasks"),
  prj("tracking.project.update", "Administration", "Project settings", "Rename, change key and description"),
  prj("tracking.project.archive", "Administration", "Archive project", "Close out finished projects"),
  prj("tracking.project.delete", "Administration", "Delete project", "Delete the project and its tasks"),
];

/** Platform Stage 4: whether a grant of `code` carries a data scope (sales S0: `sales.dashboard.view`). */
export const isScopable = (catalogue: readonly PermissionInfo[], code: string) =>
  catalogue.some((p) => p.key === code && p.scopable === true);

export function permissionsFor(scope: RoleScope) {
  return PERMISSION_CATALOGUE.filter((p) => p.scope === scope);
}

/** Default system roles. Seven in total: three workspace, four project. */
export const DEFAULT_ROLES: {
  key: string;
  name: string;
  scope: RoleScope;
  description: string;
  permissions: (WorkspacePermission | ProjectPermission)[];
  /** The data scope of each scopable grant (sales S0: `sales.dashboard.view`). */
  dataScopes?: Record<string, DataScope>;
}[] = [
  {
    key: "owner",
    name: "Owner",
    scope: "workspace",
    description: "Full control, including deleting the workspace. Can’t be assigned.",
    permissions: [
      "core.workspace.view",
      "core.workspace.update",
      "core.workspace.delete",
      "core.workspace.manage_members",
      "core.roles.manage",
      "tracking.project.create",
      "tracking.project.assign_admin",
      "tracking.integration.manage",
      "core.audit.view",
      "core.modules.manage",
      "core.teams.manage",
      "sales.dashboard.view",
    ],
    dataScopes: { "sales.dashboard.view": "all" },
  },
  {
    key: "admin",
    name: "Admin",
    scope: "workspace",
    description: "Manages members, roles and projects.",
    permissions: [
      "core.workspace.view",
      "core.workspace.update",
      "core.workspace.manage_members",
      "core.roles.manage",
      "tracking.project.create",
      "tracking.project.assign_admin",
      "tracking.integration.manage",
      "core.audit.view",
      "core.modules.manage",
      "core.teams.manage",
      "sales.dashboard.view",
    ],
    dataScopes: { "sales.dashboard.view": "all" },
  },
  {
    key: "member",
    name: "Member",
    scope: "workspace",
    description: "Sees the workspace and joins projects they’re added to.",
    permissions: ["core.workspace.view", "sales.dashboard.view"],
    dataScopes: { "sales.dashboard.view": "own" },
  },
  {
    key: "project_admin",
    name: "Project Admin",
    scope: "project",
    description: "Everything in the project, including members and deletion.",
    permissions: [
      "tracking.project.view",
      "tracking.project.update",
      "tracking.project.archive",
      "tracking.project.delete",
      "tracking.project.manage_members",
      "tracking.objective.manage",
      "tracking.milestone.manage",
      "tracking.epic.manage",
      "tracking.sprint.manage",
      "tracking.status.manage",
      "tracking.field.manage",
      "tracking.task.create",
      "tracking.task.edit_any",
      "tracking.task.edit_own",
      "tracking.task.delete",
      "tracking.task.assign",
      "tracking.task.move",
      "tracking.project.import",
      "tracking.development.link",
      "tracking.time.log",
      "tracking.time.delete_any",
      "tracking.comment.create",
      "tracking.comment.edit_own",
      "tracking.comment.delete_any",
      "tracking.attachment.upload",
      "tracking.attachment.delete_any",
      "tracking.dashboard.create",
      "tracking.dashboard.manage",
      "tracking.report.view",
    ],
  },
  {
    key: "manager",
    name: "Manager",
    scope: "project",
    description: "Plans sprints and goals and edits any task.",
    permissions: [
      "tracking.project.view",
      "tracking.project.update",
      "tracking.objective.manage",
      "tracking.milestone.manage",
      "tracking.epic.manage",
      "tracking.sprint.manage",
      "tracking.status.manage",
      "tracking.field.manage",
      "tracking.task.create",
      "tracking.task.edit_any",
      "tracking.task.edit_own",
      "tracking.task.delete",
      "tracking.task.assign",
      "tracking.task.move",
      "tracking.project.import",
      "tracking.development.link",
      "tracking.time.log",
      "tracking.time.delete_any",
      "tracking.comment.create",
      "tracking.comment.edit_own",
      "tracking.comment.delete_any",
      "tracking.attachment.upload",
      "tracking.attachment.delete_any",
      "tracking.dashboard.create",
      "tracking.dashboard.manage",
      "tracking.report.view",
    ],
  },
  {
    key: "project_member",
    name: "Member",
    scope: "project",
    description: "Creates tasks, works their own, comments and uploads.",
    permissions: [
      "tracking.project.view",
      "tracking.task.create",
      "tracking.task.edit_own",
      "tracking.task.assign",
      "tracking.task.move",
      "tracking.project.import",
      "tracking.development.link",
      "tracking.time.log",
      "tracking.comment.create",
      "tracking.comment.edit_own",
      "tracking.attachment.upload",
      "tracking.dashboard.create",
      "tracking.report.view",
    ],
  },
  {
    key: "viewer",
    name: "Viewer",
    scope: "project",
    description: "Read-only access to the board, backlog and goals.",
    permissions: ["tracking.project.view"],
  },
];
