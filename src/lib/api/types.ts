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

export type ProjectTemplate = "kanban" | "scrum" | "bugs";

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
  activeSprintId: ID | null;
  myRoleId: ID | null;
  my_permissions: ProjectPermission[];
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
}

export interface Label {
  id: ID;
  projectId: ID;
  name: string;
  /** CSS colour token, e.g. "var(--low)". */
  color: string;
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
  progress: Progress;
}

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
}

/** Full task as returned by GET /workspaces/:slug/tasks/:key. */
export interface TaskDetail extends Task {
  description: RichDoc | null;
  subtasks: Task[];
  project: Pick<Project, "id" | "key" | "name" | "hue" | "my_permissions">;
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
    | "dueDate"
    | "epicId"
    | "milestoneId"
    | "sprintId"
    | "objectiveIds"
    | "labelIds"
  >
> & { description?: RichDoc | null };

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
  parentId?: ID | null;
  labelIds?: ID[];
  description?: RichDoc | null;
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
  | "member_added";

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
}

export type NotificationType = "assigned" | "mention" | "status" | "comment" | "due" | "sprint";

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
  payload: { quote?: string; fromStatus?: string; toStatus?: string; dueDate?: ISODate; sprintName?: string };
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
  action: string;
  target: string;
  createdAt: ISODateTime;
}

/* ───────────────────────── Search, reports, misc ───────────────────────── */

export type SearchResult =
  | { type: "task"; task: Task; projectKey: string; projectName: string }
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
}

export interface Paginated<T> {
  data: T[];
  nextCursor: string | null;
}

export interface Session {
  accessToken: string | null;
  user: User;
}
