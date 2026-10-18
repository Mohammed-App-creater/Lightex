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
  // Sales: the backend's groups, in its catalogue order.
  "Sales",
  "Sales: customers",
  "Sales: leads",
  "Sales: pipeline",
  "Sales: quotations",
  "Sales: activities",
  "Sales: follow-ups",
  "Sales: targets",
  "Sales: daily reports",
  "Sales: performance",
  "Sales: reports",
  "Sales: settings",
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

/** A sales workspace code, as `modules/sales/module.py` declares it (scopable unless it says otherwise). */
const sales = (key: WorkspacePermission, group: PermissionGroup, label: string, description: string, scopable = true): PermissionInfo => ({
  ...ws(key, group, label, description),
  scopable,
});

/** The sales catalogue (backend `modules/sales/module.py`, docs/sales/api.md §2), in the backend's order. */
export const SALES_PERMISSIONS: PermissionInfo[] = [
  sales("sales.dashboard.view", "Sales", "Use sales", "Open Sales and see dashboards over the people in scope"),
  sales("sales.company.view", "Sales: customers", "View companies", "See companies in scope"),
  sales("sales.company.create", "Sales: customers", "Create companies", "Add companies", false),
  sales("sales.company.edit", "Sales: customers", "Edit companies", "Edit companies in scope and change their owner"),
  sales("sales.company.delete", "Sales: customers", "Delete companies", "Delete and restore companies in scope"),
  sales("sales.contact.view", "Sales: customers", "View contacts", "See contacts in scope"),
  sales("sales.contact.create", "Sales: customers", "Create contacts", "Add contacts", false),
  sales("sales.contact.edit", "Sales: customers", "Edit contacts", "Edit contacts in scope and change their owner"),
  sales("sales.contact.delete", "Sales: customers", "Delete contacts", "Delete and restore contacts in scope"),
  sales("sales.lead.view", "Sales: leads", "View leads", "See leads in scope"),
  sales("sales.lead.create", "Sales: leads", "Create leads", "Add leads", false),
  sales("sales.lead.edit", "Sales: leads", "Edit leads", "Edit leads in scope"),
  sales("sales.lead.delete", "Sales: leads", "Delete leads", "Delete leads in scope"),
  sales("sales.lead.assign", "Sales: leads", "Assign leads", "Change the owner of leads in scope"),
  sales("sales.lead.convert", "Sales: leads", "Convert leads", "Qualify, disqualify and convert leads in scope"),
  sales("sales.opportunity.view", "Sales: pipeline", "View opportunities", "See opportunities in scope"),
  sales("sales.opportunity.create", "Sales: pipeline", "Create opportunities", "Add opportunities", false),
  sales("sales.opportunity.edit", "Sales: pipeline", "Edit opportunities", "Edit opportunities in scope"),
  sales("sales.opportunity.move", "Sales: pipeline", "Move opportunities", "Move opportunities in scope between open stages"),
  sales("sales.opportunity.close", "Sales: pipeline", "Close opportunities", "Mark opportunities in scope won or lost"),
  sales("sales.opportunity.delete", "Sales: pipeline", "Delete opportunities", "Delete opportunities in scope"),
  sales("sales.opportunity.assign", "Sales: pipeline", "Assign opportunities", "Change the owner of opportunities in scope"),
  sales("sales.opportunity.reopen", "Sales: pipeline", "Reopen opportunities", "Reopen won or lost opportunities in scope"),
  sales("sales.quotation.view", "Sales: quotations", "View quotations", "See quotations in scope"),
  sales("sales.quotation.create", "Sales: quotations", "Create quotations", "Add quotations", false),
  sales("sales.quotation.edit", "Sales: quotations", "Edit quotations", "Edit, send and record answers to quotations in scope"),
  sales("sales.quotation.delete", "Sales: quotations", "Delete quotations", "Delete quotations in scope"),
  sales("sales.activity.view", "Sales: activities", "View activities", "See calls, visits, meetings and notes in scope"),
  sales("sales.activity.create", "Sales: activities", "Log activities", "Log calls, visits, meetings and notes", false),
  sales("sales.activity.edit", "Sales: activities", "Edit activities", "Edit activities in scope"),
  sales("sales.activity.delete", "Sales: activities", "Delete activities", "Delete activities in scope"),
  sales("sales.followup.view", "Sales: follow-ups", "View follow-ups", "See follow-ups in scope"),
  sales("sales.followup.create", "Sales: follow-ups", "Create follow-ups", "Add follow-ups", false),
  sales("sales.followup.edit", "Sales: follow-ups", "Edit follow-ups", "Edit and reschedule follow-ups in scope"),
  sales("sales.followup.complete", "Sales: follow-ups", "Complete follow-ups", "Complete follow-ups in scope"),
  sales("sales.followup.reassign", "Sales: follow-ups", "Reassign follow-ups", "Change the owner of follow-ups in scope"),
  sales("sales.followup.delete", "Sales: follow-ups", "Delete follow-ups", "Delete follow-ups in scope"),
  sales("sales.target.view", "Sales: targets", "View targets", "See targets of the people in scope"),
  sales("sales.target.manage", "Sales: targets", "Manage targets", "Set and allocate targets for people in scope"),
  sales("sales.dailyreport.submit", "Sales: daily reports", "Submit daily report", "Submit your own daily report", false),
  sales("sales.dailyreport.view", "Sales: daily reports", "View daily reports", "See daily reports in scope"),
  sales("sales.dailyreport.review", "Sales: daily reports", "Review daily reports", "Review and reopen daily reports in scope"),
  sales("sales.performance.view", "Sales: performance", "View performance", "See performance pages and ranking in scope"),
  sales("sales.report.view", "Sales: reports", "View reports", "Run sales reports over the people in scope"),
  sales("sales.report.export", "Sales: reports", "Export reports", "Download sales reports as CSV"),
  sales("sales.settings.manage", "Sales: settings", "Manage sales settings", "Edit stages, products, lost reasons, the working calendar and thresholds", false),
];

/**
 * Sales S7 (backend `self_service`): codes that only act on the holder's own things. No-escalation lets anyone who
 * may assign roles grant them without holding them.
 */
export const SELF_SERVICE_CODES: ReadonlySet<string> = new Set(["sales.dailyreport.submit"]);

/** Owner and Admin get every sales code (scope `all`) except submitting a daily report; Member gets none. */
export const OWNER_ADMIN_SALES_CODES = SALES_PERMISSIONS.map((p) => p.key as WorkspacePermission).filter((k) => k !== "sales.dailyreport.submit");
const OWNER_ADMIN_SALES_SCOPES: Record<string, DataScope> = Object.fromEntries(
  SALES_PERMISSIONS.filter((p) => p.scopable && p.key !== "sales.dailyreport.submit").map((p) => [p.key, "all" as DataScope]),
);

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
  // Sales: listed with module "sales"; hidden while sales is off.
  ...SALES_PERMISSIONS,
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

/** Platform Stage 4: whether a grant of `code` carries a data scope (the sales codes). */
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
  /** The data scope of each scopable grant (the sales codes). */
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
      ...OWNER_ADMIN_SALES_CODES,
    ],
    dataScopes: OWNER_ADMIN_SALES_SCOPES,
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
      ...OWNER_ADMIN_SALES_CODES,
    ],
    dataScopes: OWNER_ADMIN_SALES_SCOPES,
  },
  {
    key: "member",
    name: "Member",
    scope: "workspace",
    description: "Sees the workspace and joins projects they’re added to.",
    permissions: ["core.workspace.view"],
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
