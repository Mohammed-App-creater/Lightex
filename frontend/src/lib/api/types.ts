/*
 * Frontend entity types. They mirror docs/api-contract.md (no backend docs were provided, so the
 * contract there is the assumption). Field names are camelCase except `my_permissions`, which the
 * brief specifies verbatim.
 */

export type ID = string;
/** YYYY-MM-DD */
export type ISODate = string;
/** ISO-8601 UTC timestamp */
export type ISODateTime = string;

/* ───────────────────────── Permissions ───────────────────────── */

export const WORKSPACE_PERMISSIONS = [
  "workspace.view",
  "workspace.update",
  "workspace.delete",
  "workspace.manage_members",
  "workspace.manage_roles",
  "project.create",
  "project.assign_admin",
  /* Board 37 (v2): connect GitHub / GitLab, choose repositories, disconnect. */
  "integration.manage",
  "audit.view",
] as const;

export const PROJECT_PERMISSIONS = [
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
  "field.manage",
  "task.create",
  "task.edit_any",
  "task.edit_own",
  "task.delete",
  "task.assign",
  "task.move",
  "project.import",
  /* Board 37 (v2): create branches, link and unlink PRs, commits and branches. */
  "development.link",
  "time.log",
  "time.delete_any",
  "comment.create",
  "comment.edit_own",
  "comment.delete_any",
  "attachment.upload",
  "attachment.delete_any",
  /* Board 33 (v2): dashboards. */
  "dashboard.create",
  "dashboard.manage",
  "report.view",
] as const;

export type WorkspacePermission = (typeof WORKSPACE_PERMISSIONS)[number];
export type ProjectPermission = (typeof PROJECT_PERMISSIONS)[number];
export type Permission = WorkspacePermission | ProjectPermission;
export type RoleScope = "workspace" | "project";

export type PermissionGroup = "Tasks" | "Planning" | "Collaboration" | "Reports" | "Administration";

export interface PermissionInfo {
  key: Permission;
  scope: RoleScope;
  group: PermissionGroup;
  label: string;
  description: string;
}

export interface Role {
  id: ID;
  workspaceId: ID;
  name: string;
  description: string;
  scope: RoleScope;
  isSystem: boolean;
  permissions: Permission[];
  memberCount: number;
}

/* ───────────────────────── People and workspaces ───────────────────────── */

export interface User {
  id: ID;
  name: string;
  email: string;
  /** Avatar hue for oklch(var(--av-l) var(--av-c) hue). */
  hue: number;
  avatarUrl: string | null;
  createdAt: ISODateTime;
  /** Only on the signed-in user (`/auth/me`, sign-in responses). False for Google-only accounts. */
  hasPassword?: boolean;
}

export interface Workspace {
  id: ID;
  slug: string;
  name: string;
  hue: number;
  createdAt: ISODateTime;
  memberCount: number;
  myRoleId: ID;
  my_permissions: WorkspacePermission[];
}

export type MemberStatus = "active" | "deactivated";

export interface WorkspaceMember {
  userId: ID;
  workspaceId: ID;
  roleId: ID;
  user: User;
  status: MemberStatus;
  joinedAt: ISODateTime;
  lastActiveAt: ISODateTime | null;
}

export interface Invite {
  id: ID;
  workspaceId: ID;
  workspaceName: string;
  email: string;
  roleId: ID;
  roleName: string;
  invitedBy: Pick<User, "id" | "name" | "hue">;
  createdAt: ISODateTime;
  expiresAt: ISODateTime;
  status: "pending" | "accepted" | "revoked" | "expired";
}

/* ───────────────────────── Projects ───────────────────────── */

/** "simple" added by board 24 (4 templates). */
export type ProjectTemplate = "simple" | "kanban" | "scrum" | "bugs";

export interface Project {
  id: ID;
  workspaceId: ID;
  /** Task key prefix, e.g. PRJ. */
  key: string;
  name: string;
  description: string;
  hue: number;
  leadId: ID | null;
  status: "active" | "archived";
  template: ProjectTemplate;
  createdAt: ISODateTime;
  memberCount: number;
  openTaskCount: number;
  /** Board 24 (home project ring): tasks in a done-category status. Optional for older payloads. */
  doneTaskCount?: number;
  activeSprintId: ID | null;
  myRoleId: ID | null;
  my_permissions: ProjectPermission[];
  /** Board 40: `task_seq + 1`, the number the next task gets (import picker "next key" PRJ-61). */
  nextTaskNumber: number;
  /** Board 37: at least one active integration has a tracked repository that applies to this project. */
  devEnabled: boolean;
}

/** Board 24 "Not on any project": a member asks workspace admins to be added to a project. */
export interface WorkspaceAccessRequest {
  id: ID;
  workspaceId: ID;
  userId: ID;
  createdAt: ISODateTime;
}

/** Returned with a 403 for a project the user is not a member of. */
export interface ProjectAccessInfo {
  id: ID;
  key: string;
  name: string;
  hue: number;
  admins: Pick<User, "id" | "name" | "hue">[];
  myRequest: AccessRequest | null;
}

export interface ProjectMember {
  projectId: ID;
  userId: ID;
  roleId: ID;
  user: User;
  addedAt: ISODateTime;
}

export interface AccessRequest {
  id: ID;
  projectId: ID;
  userId: ID;
  message: string;
  createdAt: ISODateTime;
  status: "pending" | "approved" | "denied" | "withdrawn";
}

export type StatusCategory = "todo" | "in_progress" | "done";
export type StatusGlyph = "backlog" | "todo" | "progress" | "review" | "done" | "canceled";

export interface Status {
  id: ID;
  projectId: ID;
  name: string;
  category: StatusCategory;
  /** Display glyph. Optional on the wire; derived from category when absent. */
  glyph: StatusGlyph;
  position: number;
  /** CSS colour token for the glyph (board 28). Null/absent = the glyph's default colour. */
  color?: string | null;
  /** Live tasks in this status (returned by GET /projects/:id/statuses). */
  taskCount?: number;
}

export interface Label {
  id: ID;
  projectId: ID;
  name: string;
  /** CSS colour token, e.g. "var(--low)". */
  color: string;
  /** Live tasks carrying this label (returned by GET /projects/:id/labels). */
  taskCount?: number;
}

/* ───────────────────────── Planning ───────────────────────── */

export interface Progress {
  done: number;
  total: number;
  /** 0–100, computed from tasks; never stored. */
  percent: number;
}

export interface Objective {
  id: ID;
  projectId: ID;
  title: string;
  description: string;
  ownerId: ID | null;
  quarter: string;
  dueDate: ISODate | null;
  status: "active" | "achieved" | "dropped";
  taskIds: ID[];
  progress: Progress;
  createdAt: ISODateTime;
}

export interface Milestone {
  id: ID;
  projectId: ID;
  name: string;
  description: string;
  ownerId: ID | null;
  startDate: ISODate;
  dueDate: ISODate;
  completedAt: ISODateTime | null;
  progress: Progress & {
    /** Share of the start→due window elapsed today, 0–100. */
    expected: number;
    atRisk: boolean;
  };
}

export interface Epic {
  id: ID;
  projectId: ID;
  name: string;
  description: string;
  hue: number;
  /** Board 27: epic owner, target milestone, archive state. */
  ownerId: ID | null;
  milestoneId: ID | null;
  archivedAt: ISODateTime | null;
  /** Board 32: both or neither. Null = the timeline derives the span from the epic's tasks. */
  startDate: ISODate | null;
  /** Board 32: target date ("Target" in the UI). */
  dueDate: ISODate | null;
  progress: Progress;
}

/** Board 27: body for create / update epic. `archived` toggles archivedAt server-side. Board 32 adds the dates (both or neither). */
export type EpicWrite = Partial<Pick<Epic, "name" | "description" | "hue" | "ownerId" | "milestoneId">> & {
  archived?: boolean;
  startDate?: ISODate | null;
  dueDate?: ISODate | null;
};

export type SprintState = "planned" | "active" | "completed";

export interface Sprint {
  id: ID;
  projectId: ID;
  name: string;
  number: number;
  goal: string;
  startDate: ISODate;
  endDate: ISODate;
  state: SprintState;
  completedAt: ISODateTime | null;
  progress: Progress & { points: number; donePoints: number };
}

/* ───────────────────────── Tasks ───────────────────────── */

export type TaskType = "feature" | "bug" | "chore" | "spike";
export type Priority = 0 | 1 | 2 | 3 | 4;

/** Tiptap / ProseMirror JSON. Never rendered as raw HTML. */
export type RichDoc = { type: "doc"; content?: RichNode[] };
export type RichNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: RichNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
};

export interface Task {
  id: ID;
  projectId: ID;
  /** PRJ-42 */
  key: string;
  number: number;
  title: string;
  type: TaskType;
  priority: Priority;
  statusId: ID;
  assigneeId: ID | null;
  reporterId: ID;
  estimate: number | null;
  /** Board 32. Effective span = [startDate ?? dueDate, dueDate ?? startDate]. */
  startDate: ISODate | null;
  dueDate: ISODate | null;
  epicId: ID | null;
  milestoneId: ID | null;
  sprintId: ID | null;
  parentId: ID | null;
  objectiveIds: ID[];
  labelIds: ID[];
  /** Fractional index (string) for ordering within a column / backlog. */
  position: string;
  /** Optimistic-concurrency version; sent back on every mutation. */
  version: number;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  completedAt: ISODateTime | null;
  deletedAt: ISODateTime | null;
  subtaskCount: number;
  subtaskDoneCount: number;
  commentCount: number;
  attachmentCount: number;
  /* Board 39 (v2): requested API fields. */
  /** Set custom-field values only, keyed by field id (select → option id, user → user id, date → ISO). */
  customFields: Record<ID, CustomFieldValue>;
  /** At least one open blocker (a live blocker not in a done-category status). Derived. */
  isBlocked: boolean;
  /** The open blockers, ordered by task number. */
  openBlockers: TaskRef[];
  /** Time estimate in minutes (separate from story points). */
  timeEstimateMinutes: number | null;
  /** Sum of the task's time entries, all users. */
  loggedMinutes: number;
  /* Board 37 (v2). */
  /** Linked development work (headline PR + counts); null when the task has no visible links. */
  dev: TaskDevSummary | null;
}

/** Full task as returned by GET /workspaces/:slug/tasks/:key. */
export interface TaskDetail extends Task {
  description: RichDoc | null;
  subtasks: Task[];
  project: Pick<Project, "id" | "key" | "name" | "hue" | "my_permissions">;
  /** Board 39: both sides of the task's dependencies. */
  dependencies: TaskDependencies;
}

export type TaskPatch = Partial<
  Pick<
    Task,
    | "title"
    | "type"
    | "priority"
    | "statusId"
    | "assigneeId"
    | "estimate"
    | "startDate"
    | "dueDate"
    | "epicId"
    | "milestoneId"
    | "sprintId"
    | "objectiveIds"
    | "labelIds"
  >
> & {
  description?: RichDoc | null;
  /** Board 39. Merge: listed keys are set, null clears, unlisted keys are untouched. */
  customFields?: Record<ID, CustomFieldValue | null>;
  /** Board 39. 1–60 000 minutes, or null to clear. */
  timeEstimateMinutes?: number | null;
};

export interface TaskCreate {
  title: string;
  statusId?: ID;
  type?: TaskType;
  priority?: Priority;
  assigneeId?: ID | null;
  sprintId?: ID | null;
  epicId?: ID | null;
  milestoneId?: ID | null;
  dueDate?: ISODate | null;
  /** Board 32 (API symmetry and seed; the create dialog doesn't show it). */
  startDate?: ISODate | null;
  parentId?: ID | null;
  labelIds?: ID[];
  description?: RichDoc | null;
  /** Story points (board 30 create dialog). */
  estimate?: number | null;
}

export interface TaskMove {
  statusId?: ID;
  /** null moves to the backlog. */
  sprintId?: ID | null;
  position: string;
  version: number;
}

export interface Comment {
  id: ID;
  taskId: ID;
  authorId: ID;
  body: RichDoc;
  mentions: ID[];
  createdAt: ISODateTime;
  editedAt: ISODateTime | null;
}

export type AttachmentKind = "image" | "code" | "text";

export interface Attachment {
  id: ID;
  taskId: ID;
  uploaderId: ID;
  fileName: string;
  size: number;
  mimeType: string;
  kind: AttachmentKind;
  /** Short-lived signed URL; served as a download for anything but raster images. */
  downloadUrl: string;
  /** Raster images only (png/jpg/gif/webp). Never set for SVG or HTML. */
  previewUrl: string | null;
  createdAt: ISODateTime;
}

export interface UploadTicket {
  uploadId: ID;
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: ISODateTime;
}

/* ───────────────────────── Activity, notifications ───────────────────────── */

export type ActivityVerb =
  | "created"
  | "status_changed"
  | "assigned"
  | "commented"
  | "linked_objective"
  | "updated"
  | "deleted"
  | "restored"
  | "sprint_started"
  | "sprint_completed"
  | "attached"
  | "member_added"
  | "dependency_added"
  | "dependency_removed"
  /** Board 40: `task.imported` (task feed) and `project.import_completed` (project / workspace feeds). */
  | "imported"
  /* Board 37: `task.dev_linked` (PR/MR), `task.dev_branch_created`, `task.dev_pr_state` → merged. */
  | "dev_linked"
  | "dev_branch_created"
  | "dev_pr_merged";

export interface ActivityEntry {
  id: ID;
  actorId: ID | null;
  verb: ActivityVerb;
  projectId: ID;
  taskId: ID | null;
  taskKey: string | null;
  taskTitle: string | null;
  data: Record<string, string | number | null>;
  createdAt: ISODateTime;
  /** Board 37: the actor's display name for integration rows ("GitHub"); actorId is null then. */
  actorName?: string | null;
  /** Board 37: "integration" rows render the square integration avatar. */
  actorKind?: "user" | "integration";
}

/** "access": someone asked to join a project you manage (no task; payload.projectKey, optional quote). */
/** "import" (board 40): an import you started finished, stopped or failed (system row, no task). */
export type NotificationType = "assigned" | "mention" | "status" | "comment" | "due" | "sprint" | "access" | "import";

export interface Notification {
  id: ID;
  type: NotificationType;
  /** null for system notifications (e.g. "Due tomorrow"). */
  actorId: ID | null;
  projectId: ID;
  projectName: string;
  taskId: ID | null;
  taskKey: string | null;
  taskTitle: string | null;
  payload: {
    quote?: string;
    fromStatus?: string;
    toStatus?: string;
    dueDate?: ISODate;
    sprintName?: string;
    projectKey?: string;
    /* Board 40 ("import"). */
    importId?: ID;
    imported?: number;
    skipped?: number;
    importStatus?: "completed" | "canceled" | "failed";
    /** Board 37: the change was made by an automation of this provider ("GitHub moved PRJ-42 to Done"). */
    via?: Provider;
  };
  createdAt: ISODateTime;
  readAt: ISODateTime | null;
}

export type NotificationEvent = "assigned" | "mentioned" | "status_change" | "comment" | "due_soon" | "sprint_started";
export type NotificationChannel = "in_app" | "email";

export interface NotificationPreferences {
  events: Record<NotificationEvent, Record<NotificationChannel, boolean>>;
  emailDelivery: "instant" | "hourly" | "daily";
}

export interface AuditEntry {
  id: ID;
  actorId: ID;
  /** "<entity>.<verb>", e.g. "task.status_changed", "member.invited". */
  action: string;
  /** Human-readable entity name at the time of the event (task title, email, role name…). */
  target: string;
  createdAt: ISODateTime;
  /* Board 31 additions (requested API fields; optional so older rows still parse). */
  /** Actor display name snapshot; used for integrations ("ci-bot") and removed members. */
  actorName?: string | null;
  /** "user" (a workspace member) or "integration" (API token / automation). */
  actorKind?: "user" | "integration";
  entityType?: string;
  /** Task key ("PRJ-42") or project key ("PRJ") when the entity has one. */
  entityKey?: string | null;
  /** Board 40 adds "import" (rows written by an import job); board 37 adds "webhook" (integration rows). */
  source?: "web" | "api" | "import" | "webhook";
  requestId?: string | null;
  changes?: AuditChange[];
}

/** Field-level change. `kind` tells the UI how to render values (status glyph, priority bars…). */
export interface AuditChange {
  field: string;
  kind: "text" | "status" | "priority" | "person" | "value";
  /** status: glyph key; priority: 0–4; person: user id; text/value: plain string. null = none. */
  before: string | number | null;
  after: string | number | null;
}

/** Audit list response: Paginated plus an optional total for the "312 events" counter. */
export interface AuditPage {
  data: AuditEntry[];
  nextCursor: string | null;
  total?: number;
}

/* ───────────────────────── Search, reports, misc ───────────────────────── */

export type SearchResult =
  | { type: "task"; task: Task; projectKey: string; projectName: string; status: Pick<Status, "name" | "glyph"> }
  | { type: "project"; project: Project }
  | { type: "user"; user: User; roleName: string };

export interface ProjectSummary {
  openTasks: number;
  doneThisSprint: number;
  cycleTimeDays: number;
  dueThisWeek: number;
}

export interface BurndownPoint {
  date: ISODate;
  remaining: number | null;
  ideal: number;
}
export interface VelocityPoint {
  sprint: string;
  committed: number;
  completed: number;
}
export interface CycleBin {
  label: string;
  count: number;
}
export interface ThroughputPoint {
  week: string;
  done: number;
}
export interface ProgressRow {
  id: ID;
  kind: "objective" | "milestone";
  name: string;
  percent: number;
  expected: number | null;
  dueDate?: ISODate | null;
  /** Board 33 (additive): the objective's quarter; null on milestone rows. Optional so older payloads parse. */
  quarter?: string | null;
}

export interface Paginated<T> {
  data: T[];
  nextCursor: string | null;
}

export interface Session {
  accessToken: string | null;
  user: User;
}

/* ───────────────────────── Saved views (board 30) ───────────────────────── */

export type BaseFilterField = "status" | "priority" | "assignee" | "label" | "sprint" | "due" | "epic";
/** Board 39 adds `blocked` (is true/false) and `cf.<fieldId>` (custom fields). */
export type FilterField = BaseFilterField | "blocked" | `cf.${string}`;
/** Board 39 adds set ("is not empty"), gt and lt. */
export type FilterOp = "is" | "not" | "any" | "empty" | "before" | "after" | "set" | "gt" | "lt";

/**
 * One filter row; rows combine with AND. Values are ids (status, label, sprint, epic, user;
 * "me" = the viewer), priority numbers as strings, or for `due` an ISO date or a relative
 * token: "today", "tomorrow", "week" (today + 7) or "sprint" (active sprint end).
 */
export interface FilterRule {
  field: FilterField;
  op: FilterOp;
  values: string[];
}

export type ViewIcon = "filter" | "star" | "user" | "calendar" | "bolt" | "flag";

export interface SavedView {
  id: ID;
  workspaceId: ID;
  projectId: ID;
  ownerId: ID;
  name: string;
  icon: ViewIcon;
  /** "me" = only the owner sees it; "project" = every project member sees it. */
  visibility: "me" | "project";
  layout: "board" | "list";
  filters: FilterRule[];
  /** Pinned to the current user's sidebar, and the user's pin order. */
  pinned: boolean;
  position: number;
  /** Tasks in the project that match, for the current user ("me"). */
  count: number;
  createdAt: ISODateTime;
}

export type SavedViewInput = Pick<SavedView, "projectId" | "name" | "icon" | "visibility" | "layout" | "filters"> & { pinned?: boolean };

/* ───────────────────────── Trash (board 29) ───────────────────────── */

export type TrashKind = "task" | "comment" | "project";

/** Reference to one trashed entity (restore / purge bodies). */
export interface TrashRef {
  kind: TrashKind;
  id: ID;
}

export interface TrashItem extends TrashRef {
  /** Task title, comment excerpt or project name. */
  title: string;
  /** Task key (PRJ-88) or project key (LA). */
  key: string | null;
  /** Project badge hue for project items. */
  hue: number | null;
  /** Comments: key of the task the comment was on. */
  parentKey: string | null;
  /** Projects: live task count inside the trashed project. */
  taskCount: number | null;
  /** Owning project for tasks and comments; null for projects. */
  project: Pick<Project, "id" | "key" | "name" | "hue"> | null;
  deletedBy: Pick<User, "id" | "name" | "hue"> | null;
  deletedAt: ISODateTime;
  /** deletedAt + 30 days; the item is purged automatically after this. */
  purgeAt: ISODateTime;
}

export interface TrashList {
  data: TrashItem[];
  /** "own" = the user only sees items they deleted ("Only yours"). */
  scope: "all" | "own";
  /** Kinds this user may see (Projects is admin-only). */
  kinds: TrashKind[];
  retentionDays: number;
}

/* ───────────────────────── Custom fields, dependencies, time (board 39, v2) ───────────────────────── */

export type CustomFieldType = "text" | "number" | "select" | "date" | "user";
export const FIELD_COLORS = [
  "var(--low)",
  "var(--accent-t)",
  "var(--info)",
  "var(--warn)",
  "var(--orange)",
  "var(--danger)",
  "var(--ok)",
  "var(--text-3)",
] as const;
export type FieldColor = (typeof FIELD_COLORS)[number];

export interface CustomFieldOption {
  id: ID;
  name: string;
  color: FieldColor;
  position: number;
}
export interface CustomField {
  id: ID;
  projectId: ID;
  name: string;
  type: CustomFieldType;
  required: boolean;
  position: number;
  options: CustomFieldOption[];
  /** Live tasks with a value for this field. */
  taskCount: number;
  createdAt: ISODateTime;
}
export interface CustomFieldInput {
  name: string;
  type: CustomFieldType;
  required?: boolean;
  options?: { id?: ID; name: string; color: FieldColor }[];
}
export type CustomFieldPatch = Partial<Pick<CustomFieldInput, "name" | "required" | "options">>;
/** select → option id, user → user id, date → ISODate, number → number, text → string. */
export type CustomFieldValue = string | number;

export type DependencyRelation = "blocked_by" | "blocks";
export interface TaskRef {
  id: ID;
  key: string;
  title: string;
}
export interface DependencyTask extends TaskRef {
  statusId: ID;
  status: Pick<Status, "name" | "glyph" | "category">;
  assigneeId: ID | null;
}
export interface DependencyItem {
  id: ID;
  task: DependencyTask;
  createdAt: ISODateTime;
  createdById: ID | null;
}
export interface TaskDependencies {
  taskId: ID;
  isBlocked: boolean;
  blockedBy: DependencyItem[];
  blocks: DependencyItem[];
}

export interface TimeEntry {
  id: ID;
  taskId: ID;
  projectId: ID;
  userId: ID;
  minutes: number;
  date: ISODate;
  note: string;
  source: "manual" | "timer";
  createdAt: ISODateTime;
}
export interface RunningTimer {
  taskId: ID;
  taskKey: string;
  taskTitle: string;
  projectId: ID;
  startedAt: ISODateTime;
}
export interface TimesheetSlice {
  projectId: ID;
  taskId: ID | null;
  key: string;
  name: string;
  hue: number;
  minutes: number;
}
export interface TimesheetCell {
  date: ISODate;
  minutes: number;
  breakdown: TimesheetSlice[];
}
export interface TimesheetRow {
  user: Pick<User, "id" | "name" | "hue" | "avatarUrl">;
  cells: TimesheetCell[];
  totalMinutes: number;
}
export interface Timesheet {
  weekStart: ISODate;
  days: ISODate[];
  projects: Pick<Project, "id" | "key" | "name" | "hue" | "my_permissions">[];
  rows: TimesheetRow[];
  dayTotals: number[];
  totalMinutes: number;
}

/* ───────────────────────── Timeline & calendar (board 32, v2), client-only ───────────────────────── */

export type TimelineZoom = "week" | "month" | "quarter";
export type TimelineGroup = "epic" | "assignee";
export type CalendarMode = "month" | "week";

/* ───────────────────────── Import (board 40, v2) ───────────────────────── */

export type ImportSource = "csv" | "jira";
export type ImportPreset = "generic" | "jira" | "linear" | "asana";
export type ImportStatus = "draft" | "ready" | "queued" | "running" | "completed" | "failed" | "canceled";
export type ImportField =
  | "title"
  | "description"
  | "status"
  | "assignee"
  | "priority"
  | "estimate"
  | "dueDate"
  | "labels"
  | "type"
  | "timeEstimate"
  | "startDate"
  | "epic"
  | "sprint"
  | "parent"
  | "sourceId"
  | "blockedBy"
  | "blocks"
  | "customField"
  | "skip";
export type ImportTaskType = TaskType | "epic";
export type ImportColumnType = "empty" | "text" | "number" | "date" | "duration" | "list" | "person";
export type ImportDateOrder = "ymd" | "mdy" | "dmy" | "jira" | "text";
export type ImportTimeUnit = "minutes" | "hours" | "seconds";

export interface ImportFileInfo {
  name: string;
  size: number;
  encoding: "" | "utf-8" | "utf-16" | "windows-1252";
  delimiter: "" | "," | ";" | "	" | "|";
  rowCount: number;
  columnCount: number;
}
export interface ImportColumn {
  index: number;
  name: string;
  samples: string[];
  inferredType: ImportColumnType;
  emptyCount: number;
  distinctCount: number;
  dateOrder: ImportDateOrder | null;
}
export interface ImportColumnMapping {
  field: ImportField;
  customFieldId?: ID;
  unit?: ImportTimeUnit;
}
export interface ImportMapping {
  revision: number;
  columns: ImportColumnMapping[];
  statuses: Record<string, ID | null>;
  types: Record<string, ImportTaskType | null>;
  people: Record<string, ID | null>;
}
export interface ImportValue {
  key: string;
  value: string;
  count: number;
  target: string | null;
  auto: boolean;
  matchedBy?: "email" | "name" | "initial" | null;
}
export type ImportBlockerCode =
  | "title_unmapped"
  | "duplicate_field"
  | "status_unmapped"
  | "type_unmapped"
  | "too_many_values"
  | "too_many_creates"
  | "nothing_to_import";
export interface ImportBlocker {
  code: ImportBlockerCode;
  message: string;
  field?: ImportField;
}
export interface ImportValidation {
  ready: boolean;
  blockers: ImportBlocker[];
  values: { statuses: ImportValue[]; types: ImportValue[]; people: ImportValue[] };
  counts: { rows: number; tasks: number; epics: number; skipped: number; warnings: number; statuses: number; people: number };
  skipReasons: { reason: string; count: number }[];
  creates: { labels: string[]; epics: string[]; options: { customFieldId: ID; names: string[] }[] };
  keyRange: { first: string; last: string } | null;
}
export interface ImportIssue {
  severity: "skip" | "warning";
  field: ImportField | null;
  reason: string;
  value: string;
}
export type ImportOutcome = "task" | "epic" | "skipped";
export interface ImportRowValues {
  title: string;
  type: ImportTaskType;
  statusId: ID | null;
  assigneeId: ID | null;
  priority: Priority;
  estimate: number | null;
  timeEstimateMinutes: number | null;
  startDate: ISODate | null;
  dueDate: ISODate | null;
  labels: string[];
  epic: { id?: ID; name: string; new?: boolean } | null;
  sprintId: ID | null;
  parent: { ref: string; row?: number; taskId?: ID } | null;
  customFields: Record<ID, CustomFieldValue>;
}
export interface ImportRowPreview {
  row: number;
  outcome: ImportOutcome;
  key: string | null;
  issues: ImportIssue[];
  values: ImportRowValues;
}
export interface ImportLogLine {
  row: number;
  outcome: ImportOutcome;
  key: string | null;
  title: string;
  reason: string | null;
}
export interface ImportProgress {
  phase: "preparing" | "rows" | "links" | "finishing";
  total: number;
  processed: number;
  imported: number;
  epics: number;
  skipped: number;
  warnings: number;
  recent: ImportLogLine[];
}
export interface ImportResult {
  imported: number;
  epics: number;
  skipped: number;
  warnings: number;
  firstKey: string | null;
  lastKey: string | null;
  created: { labels: number; epics: number; options: number };
  hasErrorReport: boolean;
  issueCount: number;
  issues: (ImportIssue & { row: number })[];
}
export interface ImportJob {
  id: ID;
  projectId: ID;
  source: ImportSource;
  preset: ImportPreset;
  status: ImportStatus;
  cancelRequested: boolean;
  file: ImportFileInfo;
  analysis: { columns: ImportColumn[] } | null;
  mapping: ImportMapping | null;
  validation: ImportValidation | null;
  progress: ImportProgress | null;
  result: ImportResult | null;
  error: { code: string; message: string } | null;
  createdById: ID | null;
  createdAt: ISODateTime;
  startedAt: ISODateTime | null;
  finishedAt: ISODateTime | null;
  expiresAt: ISODateTime | null;
}
export interface ImportJobSummary {
  id: ID;
  projectId: ID;
  source: ImportSource;
  status: ImportStatus;
  fileName: string;
  imported: number;
  skipped: number;
  firstKey: string | null;
  lastKey: string | null;
  hasErrorReport: boolean;
  createdById: ID | null;
  createdAt: ISODateTime;
  startedAt: ISODateTime | null;
  finishedAt: ISODateTime | null;
  expiresAt: ISODateTime | null;
  error: { code: string; message: string } | null;
}

/* ───────────────────────── Dashboards (v2, board 33) ───────────────────────── */

export type WidgetType = "burndown" | "my_tasks" | "objectives" | "workload" | "velocity" | "activity";
export interface WidgetConfigMap {
  burndown: { sprintId: ID | null };
  my_tasks: { showDone: boolean };
  objectives: { quarter: string | null };
  workload: { unit: "points" | "hours"; sprintId: ID | null; personField: ID | null };
  velocity: { range: "last2" | "last6" };
  activity: Record<string, never>;
}
/** One widget; the array order of `Dashboard.widgets` is the layout order (positions are computed by `pack`). */
export type DashboardWidget = {
  [T in WidgetType]: { id: ID; type: T; w: number; h: number; config: WidgetConfigMap[T] };
}[WidgetType];
/** A layout item for `PUT /dashboards/:id/layout`: no `id` means "create". */
type WithOptionalId<W> = W extends { id: ID } ? Omit<W, "id"> & { id?: ID } : never;
export type DashboardWidgetInput = WithOptionalId<DashboardWidget>;
export type DashboardVisibility = "shared" | "personal";
export type DashboardTemplate = "blank" | "sprint_health";
export interface Dashboard {
  id: ID;
  projectId: ID;
  name: string;
  visibility: DashboardVisibility;
  ownerId: ID;
  owner: Pick<User, "id" | "name" | "hue" | "avatarUrl">;
  version: number;
  widgets: DashboardWidget[];
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}
export interface DashboardSummary {
  id: ID;
  projectId: ID;
  name: string;
  visibility: DashboardVisibility;
  ownerId: ID;
  widgetCount: number;
  updatedAt: ISODateTime;
}

/* Workload report (W1). Hours are minutes on the wire. */
export interface WorkloadRow {
  user: Pick<User, "id" | "name" | "hue" | "avatarUrl">;
  inProgress: number;
  todo: number;
  capacity: number | null;
  unestimated: number;
}
export interface WorkloadReport {
  sprint: { id: ID; name: string; number: number; startDate: ISODate; endDate: ISODate } | null;
  unit: "points" | "hours";
  personField: { id: ID; name: string } | null;
  scale: number;
  rows: WorkloadRow[];
  unassigned: { inProgress: number; todo: number; unestimated: number };
}

/* ───────────────────────── Presence (v2, board 33) ───────────────────────── */

export type PresenceLocationKind = "board" | "dashboard" | "task";
export interface PresenceLocation {
  kind: PresenceLocationKind;
  id: ID;
}
export interface PresencePerson {
  user: Pick<User, "id" | "name" | "hue" | "avatarUrl">;
  state: "viewing" | "editing";
  field: string | null;
  typing: boolean;
  since: ISODateTime;
}
export interface PresenceRoster {
  projectId: ID;
  /** Server time of the snapshot; clients drop older snapshots. */
  at: ISODateTime;
  /** Only non-empty locations. */
  locations: { location: PresenceLocation; people: PresencePerson[] }[];
}
export interface PresenceUpdate {
  location: PresenceLocation;
  state: "viewing" | "editing";
  field: string | null;
  typing: boolean;
}
export interface PresenceHeartbeat {
  expiresAt: ISODateTime;
  heartbeatSec: number;
  roster: PresenceRoster;
}

/* ───────────────────────── Board 37 (v2): integrations & development ───────────────────────── */

export type Provider = "github" | "gitlab";
export type IntegrationErrorCode =
  | "token_expired"
  | "token_revoked"
  | "installation_suspended"
  | "installation_removed"
  | "insufficient_scope"
  | "unreachable"
  | "webhook_failing";

export interface ProviderInfo {
  provider: Provider;
  name: "GitHub" | "GitLab";
  /** The server has this provider configured (§2.3). */
  available: boolean;
  /** github: ["app"]; gitlab: ["oauth", "token"] or ["token"]. */
  methods: ("app" | "oauth" | "token")[];
  /** GitLab OAuth: "https://gitlab.com". */
  oauthBaseUrl: string | null;
  canCreateBranch: boolean;
}

export type RepoVisibility = "public" | "private" | "internal";

export interface Repository {
  id: ID;
  integrationId: ID;
  provider: Provider;
  externalId: string;
  /** "platform-team/web" */
  fullPath: string;
  owner: string;
  name: string;
  visibility: RepoVisibility;
  defaultBranch: string;
  url: string;
  allProjects: boolean;
  /** [] when allProjects. */
  projectIds: ID[];
  openPullRequests: number;
  /** "paused" when the integration is in error. */
  syncState: "idle" | "queued" | "syncing" | "paused" | "failed";
  lastSyncedAt: ISODateTime | null;
  /** The provider allows it and the repository isn't archived. */
  canCreateBranch: boolean;
}

export interface Integration {
  id: ID;
  provider: Provider;
  authKind: "github_app" | "gitlab_oauth" | "gitlab_token";
  baseUrl: string;
  account: { login: string; kind: "organization" | "user" | "bot"; url: string };
  status: "active" | "error";
  error: { code: IntegrationErrorCode; message: string; since: ISODateTime } | null;
  connectedBy: ID | null;
  connectedAt: ISODateTime;
  lastSyncedAt: ISODateTime | null;
  /** A sync run is queued / running / deferred. */
  syncing: boolean;
  /** "Sync now" is available again at. */
  nextSyncAt: ISODateTime | null;
  tokenExpiresAt: ISODateTime | null;
  /** GitHub: installation settings (managers only); GitLab token: null. */
  manageUrl: string | null;
  /** Tracked only; ordered by full path. */
  repositories: Repository[];
}

export interface AvailableRepository {
  externalId: string;
  fullPath: string;
  owner: string;
  name: string;
  visibility: RepoVisibility;
  updatedAt: ISODateTime | null;
  /** Tracked by this integration. */
  tracked: boolean;
  /** Tracked by another integration of this workspace (disabled row). */
  trackedElsewhere: boolean;
}

export interface IntegrationsOverview {
  /** Always both, GitHub first. */
  providers: ProviderInfo[];
  /** Active + error; GitHub first, then by connectedAt. */
  integrations: Integration[];
}

export interface RepoRef {
  id: ID;
  fullPath: string;
}
export interface DevAuthor {
  login: string;
  name: string | null;
  userId: ID | null;
}
export type CheckState = "passing" | "failing" | "running";
export interface DevCheck {
  name: string;
  state: CheckState;
  durationSec: number | null;
  url: string | null;
}
export type DevLinkSource = "auto" | "manual" | "created";

export interface DevPullRequest {
  id: ID;
  kind: "pull_request";
  provider: Provider;
  /** null after a disconnect (repoFullPath still names it). */
  repository: RepoRef | null;
  repoFullPath: string;
  number: number;
  /** GitHub "#214", GitLab "!12". */
  ref: string;
  title: string;
  url: string;
  state: "open" | "draft" | "merged" | "closed";
  headBranch: string;
  baseBranch: string;
  author: DevAuthor;
  checks: { state: CheckState; passed: number; total: number; items: DevCheck[] } | null;
  approvals: number;
  linkSource: DevLinkSource;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  mergedAt: ISODateTime | null;
  closedAt: ISODateTime | null;
}
export interface DevBranch {
  id: ID;
  kind: "branch";
  provider: Provider;
  repository: RepoRef | null;
  repoFullPath: string;
  name: string;
  url: string;
  state: "active" | "deleted";
  aheadBy: number | null;
  linkSource: DevLinkSource;
  updatedAt: ISODateTime;
}
export interface DevCommit {
  id: ID;
  kind: "commit";
  provider: Provider;
  repository: RepoRef | null;
  repoFullPath: string;
  sha: string;
  shortSha: string;
  message: string;
  url: string;
  author: DevAuthor;
  committedAt: ISODateTime;
  linkSource: "auto" | "manual";
}
export type DevItem = DevPullRequest | DevBranch | DevCommit;

export interface DevRepositoryOption {
  id: ID;
  provider: Provider;
  fullPath: string;
  name: string;
  defaultBranch: string;
  canCreateBranch: boolean;
}

export interface TaskDevelopment {
  taskId: ID;
  taskKey: string;
  /** Project.devEnabled */
  enabled: boolean;
  suggestedBranch: string;
  repositories: DevRepositoryOption[];
  pullRequests: DevPullRequest[];
  branches: DevBranch[];
  commits: DevCommit[];
  commitTotal: number;
  syncedAt: ISODateTime | null;
}

export interface TaskDevSummary {
  /** The headline PR: most recently updated open/draft, else merged in the last 14 days, else null. */
  pr: {
    provider: Provider;
    number: number;
    ref: string;
    state: DevPullRequest["state"];
    checks: CheckState | null;
    checksPassed: number;
    checksTotal: number;
    approvals: number;
    baseBranch: string;
    mergedAt: ISODateTime | null;
  } | null;
  prCount: number;
  branchCount: number;
  commitCount: number;
}

export type DevTrigger = "branch_created" | "pr_opened" | "pr_merged";
export interface DevAutomationRule {
  trigger: DevTrigger;
  enabled: boolean;
  statusId: ID | null;
}
