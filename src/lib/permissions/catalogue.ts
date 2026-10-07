import type {
  PermissionGroup,
  PermissionInfo,
  ProjectPermission,
  RoleScope,
  WorkspacePermission,
} from "@/lib/api/types";

/*
 * Permission keys come from the brief (the behavioural spec). Labels, descriptions and the
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

const ws = (
  key: WorkspacePermission,
  group: PermissionGroup,
  label: string,
  description: string,
): PermissionInfo => ({ key, scope: "workspace", group, label, description });

const prj = (
  key: ProjectPermission,
  group: PermissionGroup,
  label: string,
  description: string,
): PermissionInfo => ({ key, scope: "project", group, label, description });

export const PERMISSION_CATALOGUE: PermissionInfo[] = [
  // Workspace scope
  ws("project.create", "Planning", "Create projects", "Start new projects in this workspace"),
  ws("workspace.manage_members", "Collaboration", "Manage members", "Invite, remove and change member roles"),
  ws("audit.view", "Reports", "View audit log", "See who changed what across the workspace"),
  ws("workspace.view", "Administration", "View workspace", "See the workspace and its project list"),
  ws("workspace.update", "Administration", "Workspace settings", "Rename the workspace and change its URL"),
  ws("workspace.manage_roles", "Administration", "Manage roles", "Create and edit roles"),
  ws("project.assign_admin", "Administration", "Assign project admins", "Make members admins of any project"),
  ws("workspace.delete", "Administration", "Delete workspace", "Delete the workspace and all its projects"),
  // Project scope
  prj("task.create", "Tasks", "Create tasks", "Add tasks to the board and backlog"),
  prj("task.edit_any", "Tasks", "Edit any task", "Change fields on others’ tasks"),
  prj("task.edit_own", "Tasks", "Edit own tasks", "Change tasks you reported or are assigned"),
  prj("task.assign", "Tasks", "Assign tasks", "Change who a task is assigned to"),
  prj("task.move", "Tasks", "Move tasks", "Drag tasks between columns and sprints"),
  prj("task.delete", "Tasks", "Delete tasks", "Remove tasks (restorable for 30 days)"),
  prj("sprint.manage", "Planning", "Manage sprints", "Start, close and plan sprints"),
  prj("milestone.manage", "Planning", "Edit milestones", "Create milestones and move dates"),
  prj("objective.manage", "Planning", "Set objectives", "Create objectives and link tasks"),
  prj("epic.manage", "Planning", "Manage epics", "Create and rename epics"),
  prj("status.manage", "Planning", "Edit workflow", "Add, rename and reorder statuses"),
  prj("comment.create", "Collaboration", "Comment", "Reply and mention teammates"),
  prj("comment.edit_own", "Collaboration", "Edit own comments", "Fix typos in your comments"),
  prj("comment.delete_any", "Collaboration", "Delete any comment", "Remove anyone’s comment"),
  prj("attachment.upload", "Collaboration", "Upload files", "Attach images and code files"),
  prj("attachment.delete_any", "Collaboration", "Delete any file", "Remove anyone’s attachment"),
  prj("project.manage_members", "Collaboration", "Manage members", "Add people and set their project role"),
  prj("report.view", "Reports", "View reports", "Velocity, burndown, cycle time"),
  prj("project.view", "Administration", "View project", "See the project, its board and tasks"),
  prj("project.update", "Administration", "Project settings", "Rename, change key and description"),
  prj("project.archive", "Administration", "Archive project", "Close out finished projects"),
  prj("project.delete", "Administration", "Delete project", "Delete the project and its tasks"),
];

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
}[] = [
  {
    key: "owner",
    name: "Owner",
    scope: "workspace",
    description: "Full control, including deleting the workspace. Can’t be assigned.",
    permissions: [
      "workspace.view",
      "workspace.update",
      "workspace.delete",
      "workspace.manage_members",
      "workspace.manage_roles",
      "project.create",
      "project.assign_admin",
      "audit.view",
    ],
  },
  {
    key: "admin",
    name: "Admin",
    scope: "workspace",
    description: "Manages members, roles and projects.",
    permissions: [
      "workspace.view",
      "workspace.update",
      "workspace.manage_members",
      "workspace.manage_roles",
      "project.create",
      "project.assign_admin",
      "audit.view",
    ],
  },
  {
    key: "member",
    name: "Member",
    scope: "workspace",
    description: "Sees the workspace and joins projects they’re added to.",
    permissions: ["workspace.view"],
  },
  {
    key: "project_admin",
    name: "Project Admin",
    scope: "project",
    description: "Everything in the project, including members and deletion.",
    permissions: [
      "project.view",
      "project.update",
      "project.archive",
      "project.delete",
      "project.manage_members",
      "objective.manage",
      "milestone.manage",
      "epic.manage",
      "sprint.manage",
      "status.manage",
      "task.create",
      "task.edit_any",
      "task.edit_own",
      "task.delete",
      "task.assign",
      "task.move",
      "comment.create",
      "comment.edit_own",
      "comment.delete_any",
      "attachment.upload",
      "attachment.delete_any",
      "report.view",
    ],
  },
  {
    key: "manager",
    name: "Manager",
    scope: "project",
    description: "Plans sprints and goals and edits any task.",
    permissions: [
      "project.view",
      "project.update",
      "objective.manage",
      "milestone.manage",
      "epic.manage",
      "sprint.manage",
      "status.manage",
      "task.create",
      "task.edit_any",
      "task.edit_own",
      "task.delete",
      "task.assign",
      "task.move",
      "comment.create",
      "comment.edit_own",
      "comment.delete_any",
      "attachment.upload",
      "attachment.delete_any",
      "report.view",
    ],
  },
  {
    key: "project_member",
    name: "Member",
    scope: "project",
    description: "Creates tasks, works their own, comments and uploads.",
    permissions: [
      "project.view",
      "task.create",
      "task.edit_own",
      "task.assign",
      "task.move",
      "comment.create",
      "comment.edit_own",
      "attachment.upload",
      "report.view",
    ],
  },
  {
    key: "viewer",
    name: "Viewer",
    scope: "project",
    description: "Read-only access to the board, backlog and goals.",
    permissions: ["project.view"],
  },
];
