/*
 * API types. Every request and response type is derived from the generated OpenAPI schema
 * (`schema.d.ts`, `npm run gen:api` from `../docs/openapi.yaml`; the backend serializes camelCase, plus the verbatim
 * `my_permissions`). Nothing here restates a wire shape by hand. Three helpers adjust a schema type:
 *
 * - `Wire<T>`: the schema type without `readonly` (the client builds and patches these objects).
 * - `Refine<T, N>`: narrows fields the schema types loosely (a known union the schema sends as `string`, JSON the
 *   schema leaves as `unknown`, a field the serializer always sends but marks optional because it has a default).
 *   Each override must be assignable to the schema's own field type, so a schema change that breaks it fails here.
 * - `SchemaGap<T, N>`: an override the schema contradicts. Each use is a known `docs/openapi.yaml` gap listed in
 *   docs/final-report.md ("Remaining known gaps"); remove it when the backend fixes the schema.
 *
 * Client-only types (the permission catalogue, filters, timeline modes, the import parser's types) and the few
 * extension types for client-computed fields are marked as such.
 */

import type { components } from "./schema";

type S = components["schemas"];
/** The raw schema components, for wire shapes the client normalizes (the mock answers with these). */
export type ApiSchemas = S;

/** A schema type without `readonly`. */
export type Wire<T> = { -readonly [K in keyof T]: T[K] };
type Flat<T> = { [K in keyof T]: T[K] };
/** Narrow some fields of a schema type; each override must be assignable to the schema's field (see above). */
export type Refine<T, N extends { [K in keyof N]: K extends keyof T ? T[K] : never }> = Flat<Wire<Omit<T, keyof N>> & N>;
/** Override fields the schema gets wrong (known gaps only, see above). Keys must exist on the schema type. */
type SchemaGap<T, N extends { [K in keyof N]: K extends keyof T ? unknown : never }> = Flat<Wire<Omit<T, keyof N>> & N>;

export type ID = string;
/** YYYY-MM-DD */
export type ISODate = string;
/** ISO-8601 UTC timestamp */
export type ISODateTime = string;

/* ───────────────────────── Permissions (client catalogue) ───────────────────────── */

export const WORKSPACE_PERMISSIONS = [
  "core.workspace.view",
  "core.workspace.update",
  "core.workspace.delete",
  "core.workspace.manage_members",
  "core.roles.manage",
  "tracking.project.create",
  "tracking.project.assign_admin",
  /* Board 37 (v2): connect GitHub / GitLab, choose repositories, disconnect. */
  "tracking.integration.manage",
  "core.audit.view",
  "core.modules.manage",
  "core.teams.manage",
  /* Stage 3 (platform): the sales module's placeholder page. Hidden while sales is off. */
  "sales.health.view",
] as const;

export const PROJECT_PERMISSIONS = [
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
  /* Board 37 (v2): create branches, link and unlink PRs, commits and branches. */
  "tracking.development.link",
  "tracking.time.log",
  "tracking.time.delete_any",
  "tracking.comment.create",
  "tracking.comment.edit_own",
  "tracking.comment.delete_any",
  "tracking.attachment.upload",
  "tracking.attachment.delete_any",
  /* Board 33 (v2): dashboards. */
  "tracking.dashboard.create",
  "tracking.dashboard.manage",
  "tracking.report.view",
] as const;

export type WorkspacePermission = (typeof WORKSPACE_PERMISSIONS)[number];
export type ProjectPermission = (typeof PROJECT_PERMISSIONS)[number];
export type Permission = WorkspacePermission | ProjectPermission;
export type RoleScope = S["RoleScopeEnum"];

export type PermissionGroup = "Tasks" | "Planning" | "Collaboration" | "Reports" | "Administration";

/** Who owns a permission (Stage 1 contract §1). Independent of `scope`. */
export type PermissionModule = "core" | "tracking" | "sales";

/** `GET /permissions` item. `scopable` (Stage 4): the grant carries an own / team / all data scope. */
export type PermissionInfo = Refine<
  S["PermissionInfo"],
  { key: Permission; module: PermissionModule; scope: RoleScope; group: PermissionGroup }
>;

/** Platform Stage 4: how much of the workspace's data a scopable grant reaches. */
export type DataScope = NonNullable<S["RoleInRequest"]["dataScopes"]>[string];
export const DATA_SCOPES: readonly DataScope[] = ["own", "team", "all"];
/** `{code: scope}` for scopable codes. */
export type DataScopeMap = Record<string, DataScope>;

export type Role = Refine<S["Role"], { description: string; permissions: Permission[]; dataScopes: DataScopeMap }>;
export type RoleCreate = Refine<S["RoleInRequest"], { name: string; scope: RoleScope; permissions: Permission[] }>;
export type RolePatch = Refine<S["PatchedRoleInRequest"], { permissions?: Permission[] }>;

/* ───────────────────────── People and workspaces ───────────────────────── */

/** `hue`: avatar hue for oklch(var(--av-l) var(--av-c) hue); always sent (the schema marks it optional: it has a default). */
export type User = Refine<S["User"], { hue: number }>;
/** The signed-in user (`/auth/me`). `hasPassword` is false for Google-only accounts. */
export type Me = Refine<S["Me"], { hue: number }>;
export type AuthResult = Refine<S["AuthOut"], { user: User }>;
export type AcceptInviteResult = Wire<S["AcceptInviteOut"]>;

export type Workspace = Refine<
  S["Workspace"],
  {
    hue: number;
    my_permissions: WorkspacePermission[];
    /** Platform Stage 4: the scope of each scopable code the user holds (disabled modules excluded). */
    myDataScopes: DataScopeMap;
    /** Board 38: PATCH needs `core.workspace.update`. */
    notificationPolicy: { sms: boolean };
  }
>;
export type WorkspaceCreate = Refine<S["WorkspaceCreateInRequest"], { name: string; slug: string }>;
/** `notificationPolicy` (board 38) is accepted by PATCH but missing from `PatchedWorkspaceUpdateInRequest` (known gap). */
export type WorkspacePatch = Wire<S["PatchedWorkspaceUpdateInRequest"]> & { notificationPolicy?: { sms: boolean } };
export type SlugAvailability = Wire<S["SlugAvailability"]>;

/* Platform Stage 4: flat teams inside a workspace. */
export type Team = Refine<S["Team"], { description: string }>;
/** A team member (no hue: the UI takes it from the member list). */
export type TeamMember = Wire<S["TeamMember"]>;
export type TeamDetail = Refine<S["TeamDetail"], { description: string }>;

/** A nav item a module contributes (Stage 3 contract §1); `path` is relative to the workspace. */
export type ModuleNavItemInfo = Wire<S["NavItem"]>;
/** `GET workspaces/{slug}/modules`. `core` is listed too (always on, not toggleable). */
export type WorkspaceModule = Wire<S["WorkspaceModule"]>;

export type MemberStatus = S["WorkspaceMemberStatusEnum"];
export type WorkspaceMember = Refine<S["WorkspaceMember"], { status: MemberStatus; user: User }>;

export type InviteStatus = "pending" | "accepted" | "revoked" | "expired";
export type Invite = Refine<S["Invite"], { invitedBy: Pick<User, "id" | "name" | "hue"> | null; status: InviteStatus }>;

/* ───────────────────────── Projects ───────────────────────── */

export type ProjectTemplate = S["ProjectTemplateEnum"];
export type ProjectStatus = S["ProjectStatusEnum"];

export type Project = Refine<
  S["Project"],
  {
    description: string;
    hue: number;
    status: ProjectStatus;
    template: ProjectTemplate;
    my_permissions: ProjectPermission[];
    /** Platform Stage 4: the same workspace-level map as `Workspace.myDataScopes`. */
    myDataScopes: DataScopeMap;
  }
>;
export type ProjectCreate = Refine<S["ProjectInRequest"], { name: string; key: string }>;
export type ProjectPatch = Wire<S["PatchedProjectInRequest"]>;

/** Board 24 "Not on any project": a member asks workspace admins to be added to a project. */
export type WorkspaceAccessRequest = Wire<S["WorkspaceAccessRequest"]>;
export type MyWorkspaceAccessRequest = Wire<S["MyWsAccessRequest"]>;

export type AccessRequestStatus = "pending" | "approved" | "denied" | "withdrawn";
export type AccessRequest = Refine<S["AccessRequest"], { status: AccessRequestStatus }>;
export type AccessRequestWithUser = Refine<S["AccessRequestWithUser"], { status: AccessRequestStatus; user: User }>;

/**
 * Error details, not a response body: `details.project` of the 403 `not_a_project_member` (the schema has no
 * components for error details). Also the shape of a project-directory row (see `ProjectDirectoryItem`).
 */
export interface ProjectAccessInfo {
  id: ID;
  key: string;
  name: string;
  hue: number;
  admins: Pick<User, "id" | "name" | "hue">[];
  myRequest: AccessRequest | null;
}
/** Known gap: the schema's `ProjectDirectoryEntry` has only `id`; the server sends the access info plus these. */
export type ProjectDirectoryItem = Wire<S["ProjectDirectoryEntry"]> & ProjectAccessInfo & { isMember: boolean; status: ProjectStatus };

export type ProjectMember = Refine<S["ProjectMember"], { user: User }>;

export type StatusCategory = S["StatusCategoryEnum"];
export type StatusGlyph = S["GlyphEnum"];

/** `position` is always sent (optional in the schema: it has a default). `color`: CSS token, null = the glyph's default. */
export type Status = Refine<S["Status"], { position: number }>;
export type StatusCreate = Refine<S["StatusInRequest"], { name: string; category: StatusCategory }>;
export type StatusPatch = Wire<S["PatchedStatusInRequest"]>;

/** `color`: CSS colour token, e.g. "var(--low)"; always sent. */
export type Label = Refine<S["Label"], { color: string }>;
export type LabelPatch = Wire<S["PatchedLabelInRequest"]>;

/* ───────────────────────── Planning ───────────────────────── */

/** 0–100 `percent`, computed from tasks; never stored. */
export type Progress = Wire<S["ProgressOut"]>;
export type Objective = Wire<S["ObjectiveOut"]>;
export type ObjectiveWrite = Wire<S["PatchedObjectiveInRequest"]>;
/** `progress.expected`: share of the start→due window elapsed today, 0–100. */
export type Milestone = Wire<S["MilestoneOut"]>;
export type MilestoneWrite = Wire<S["PatchedMilestoneInRequest"]>;
/** Board 32: `startDate` / `dueDate` both or neither (null = the timeline derives the span from the tasks). */
export type Epic = Wire<S["EpicOut"]>;
/** Create / update body. `archived` toggles archivedAt server-side. */
export type EpicWrite = Wire<S["PatchedEpicInRequest"]>;

export type SprintState = S["SprintOutStateEnum"];
export type Sprint = Wire<S["SprintOut"]>;
export type SprintWrite = Wire<S["PatchedSprintInRequest"]>;

/* ───────────────────────── Tasks ───────────────────────── */

export type TaskType = S["TaskTypeEnum"];
/** 0 none … 4 urgent (the schema types it `integer`). */
export type Priority = 0 | 1 | 2 | 3 | 4;

/** Tiptap / ProseMirror JSON (the schema types it `unknown`). Never rendered as raw HTML. */
export type RichDoc = { type: "doc"; content?: RichNode[] };
export type RichNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: RichNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
};

/** select → option id, user → user id, date → ISODate, number → number, text → string. */
export type CustomFieldValue = string | number;

/**
 * `position`: fractional index; `version`: optimistic-concurrency version sent back on every mutation; board 39
 * `customFields` (set values only, keyed by field id), `isBlocked` / `openBlockers`; board 37 `dev`.
 */
export type Task = Refine<S["TaskOut"], { priority: Priority; customFields: Record<ID, CustomFieldValue> }>;

/** Full task as returned by GET /tracking/workspaces/:slug/tasks/:key. */
export type TaskDetail = Refine<
  S["TaskDetailOut"],
  {
    priority: Priority;
    customFields: Record<ID, CustomFieldValue>;
    description: RichDoc | null;
    subtasks: Task[];
    project: Pick<Project, "id" | "key" | "name" | "hue" | "my_permissions">;
    dependencies: TaskDependencies;
  }
>;

/** PATCH body. `customFields` merges (null clears); `timeEstimateMinutes` 1–60 000 or null. */
export type TaskPatch = Refine<
  Omit<S["PatchedTaskWriteInRequest"], "version">,
  { priority?: Priority; description?: RichDoc | null; customFields?: Record<ID, CustomFieldValue | null> }
>;
export type TaskCreate = Refine<
  Omit<S["TaskWriteInRequest"], "version" | "customFields" | "timeEstimateMinutes">,
  { title: string; priority?: Priority; description?: RichDoc | null }
>;
/** `sprintId: null` moves to the backlog. */
export type TaskMove = Wire<S["TaskMoveRequest"]>;
export type TaskBulk = Refine<S["BulkInRequest"], { patch?: TaskPatch }>;
export type BoardData = Refine<S["Board"], { statuses: Status[]; tasks: Task[] }>;
export type BacklogData = Refine<S["Backlog"], { sprints: { sprintId: ID; tasks: Task[] }[]; backlog: Task[] }>;

/**
 * Platform Stage 2: comments and attachments hang off a generic target (`targets/{targetType}/{targetId}/…`).
 * `targetType` is "<module>.<entity>" ("tracking.task"); `targetId` is the record's id (for tasks, `Task.id`).
 */
export type TargetRef = Pick<S["Comment"], "targetType" | "targetId">;

export type Comment = Refine<S["Comment"], { body: RichDoc }>;

export type AttachmentKind = S["AttachmentKindEnum"];
/** `downloadUrl`: short-lived, a download for anything but raster images. `previewUrl`: raster images only. */
export type Attachment = Wire<S["Attachment"]>;
export type UploadTicket = Wire<S["UploadTicket"]>;
export type UploadRequest = Wire<S["UploadUrlInRequest"]>;

/* ───────────────────────── Activity, notifications ───────────────────────── */

/** The verbs the feeds render (the schema types `verb` as `string`). */
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
  /** Board 40: `tracking.task.imported` and `tracking.project.import_completed`. */
  | "imported"
  /* Board 37: `tracking.task.dev_linked` (PR/MR), `tracking.task.dev_branch_created`, `tracking.task.dev_pr_state` → merged. */
  | "dev_linked"
  | "dev_branch_created"
  | "dev_pr_merged";

/** Board 37: `actorKind` "integration" rows (actorId null, actorName "GitHub") render the integration avatar. */
export type ActivityEntry = Refine<S["ActivityOut"], { verb: ActivityVerb; data: Record<string, string | number | null> }>;

/**
 * The display kinds the inbox knows. `Notification.type` is a plain string on the wire (Stage 5): the module that
 * notifies picks it, so an unknown kind falls back to a generic row. "access": someone asked to join a project you
 * manage; "import" (board 40): an import you started finished, stopped or failed.
 */
export type NotificationKind = "assigned" | "mention" | "status" | "comment" | "due" | "sprint" | "access" | "import";
export type NotificationType = S["Notification"]["type"];

/** The free-form payload (the schema types it `unknown`). */
export interface NotificationPayload {
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
}

/**
 * `eventType` (Stage 5): the registered event-type key ("tracking.task.assigned"). `projectName`, `taskKey` and
 * `taskTitle` are snapshots taken when the notification was created. `title` / `link` come from the target's
 * describe() (the mock sends an app-relative link).
 */
export type Notification = Refine<S["Notification"], { payload: NotificationPayload }>;
/** Known gap: the schema's `NotificationPage.data` is a single object; the server sends an array. */
export type NotificationPage = SchemaGap<
  S["NotificationPage"],
  { data: Notification[]; counts: { all: number; mentions: number; assigned: number; unread: number } }
>;
export type UnreadCount = Wire<S["UnreadCount"]>;
export type ReadAllResult = Wire<S["ReadAllOut"]>;

/** Notification preference keys (client: the matrix rows). */
export type NotificationEvent =
  | "tracking.task.assigned"
  | "core.comment.mentioned"
  | "tracking.task.status_changed"
  | "core.comment.created"
  | "tracking.task.due_soon"
  | "tracking.sprint.started";
/** Board 38 (v2): the channels that leave the app. */
export type ExternalChannel = "telegram" | "sms" | "push";
export type NotificationChannel = "in_app" | "email" | ExternalChannel;

/** Board 38. Holds Telegram, SMS and Push only. `days` is Mon..Sun; `from > to` is an overnight window. */
export type QuietHours = Refine<S["QuietHours"], { days: [boolean, boolean, boolean, boolean, boolean, boolean, boolean] }>;

/** `labels`: row labels from the event type registry (read-only). */
export type NotificationPreferences = Refine<
  S["NotificationPreferences"],
  {
    events: Record<NotificationEvent, Record<NotificationChannel, boolean>>;
    emailDelivery: "instant" | "hourly" | "daily";
    quietHours: QuietHours;
  }
>;
export type NotificationPreferencesInput = Omit<NotificationPreferences, "labels"> & Partial<Pick<NotificationPreferences, "labels">>;

/* ───────── Board 38 (v2): Telegram, SMS and push channels ───────── */

export type TelegramConnection = Wire<S["TelegramConnection"]>;
export type SmsConnection = Wire<S["SmsConnection"]>;
export type PushDevice = Wire<S["PushDevice"]>;
export type SmsCountry = Wire<S["SmsCountry"]>;

/**
 * C1 `GET /me/notification-channels`. Known gaps: the schema has `telegram.connection` and `sms.connection`
 * non-nullable, and `sms.countries` / `push.devices` as single objects; the server sends null / arrays.
 */
export type NotificationChannels = SchemaGap<
  S["NotificationChannels"],
  {
    email: Wire<S["EmailChannel"]>;
    telegram: SchemaGap<S["TelegramChannel"], { connection: TelegramConnection | null }>;
    sms: SchemaGap<S["SmsChannel"], { connection: SmsConnection | null; countries: SmsCountry[] }>;
    push: SchemaGap<S["PushChannel"], { devices: PushDevice[] }>;
  }
>;

/** C2 / C3. `code` and `deepLink` only while pending. Known gap: `connection` is nullable on the wire. */
export type TelegramLink = SchemaGap<S["TelegramLink"], { connection: TelegramConnection | null }>;
export type SmsVerification = Wire<S["SmsVerification"]>;
export type SmsVerificationInput = Wire<S["SmsVerificationInRequest"]>;
export type SmsVerifyResult = Wire<S["SmsVerifyOut"]>;
export type VapidKey = Wire<S["VapidKey"]>;

/** C11 body: the browser's `PushSubscription.toJSON()` (the schema types it `unknown`) plus a mode. */
export type PushSubscriptionInput = Refine<
  S["PushSubscriptionInputRequest"],
  { subscription: { endpoint: string; expirationTime: number | null; keys: { p256dh: string; auth: string } } }
>;

export type TestableChannel = S["ChannelEnum"];
export type ChannelTestResult = Wire<S["ChannelTestResult"]>;

/* ───────────────────────── Audit ───────────────────────── */

/** Field-level change. status: glyph key; priority: 0–4; person: user id; text/value: plain string; null = none. */
export type AuditChange = Refine<S["AuditChange"], { before: string | number | null; after: string | number | null }>;

/**
 * `action` is "<module>.<entity>.<verb>"; `target` the entity name at the time. `entityType` / `targetType` may be
 * namespaced ("tracking.task"): `auditEntity()` strips the module.
 */
export type AuditEntry = Refine<S["AuditEntry"], { source: "web" | "api" | "import" | "webhook"; changes: AuditChange[] }>;
export type AuditPage = Refine<S["AuditPage"], { data: AuditEntry[] }>;

/* ───────────────────────── Search, reports, misc ───────────────────────── */

/**
 * Workspace search results. Every result names its target; besides it carries the provider's record under the key
 * named by `type` (the schema leaves that part open). The global `GET /search` also returns `comment` results; the
 * client doesn't call it.
 */
export type SearchResult = Wire<Omit<S["SearchResult"], "type">> &
  (
    | { type: "task"; task: Task; projectKey: string; projectName: string; status: Pick<Status, "name" | "glyph"> }
    | { type: "project"; project: Project }
    | { type: "user"; user: User; roleName: string }
  );
export type SearchType = SearchResult["type"];
export type RecentItem = Refine<S["Recent"], { kind: "task" | "project" }>;

export type ProjectSummary = Wire<S["ProjectSummary"]>;
export type BurndownPoint = Wire<S["BurndownPoint"]>;
export type BurndownReport = Wire<S["BurndownReport"]>;
export type VelocityPoint = Wire<S["VelocityPoint"]>;
export type VelocityReport = Wire<S["VelocityReport"]>;
export type CycleBin = Wire<S["CycleTimeBin"]>;
export type CycleTimeReport = Wire<S["CycleTimeReport"]>;
export type ThroughputPoint = Wire<S["ThroughputPoint"]>;
export type ThroughputReport = Wire<S["ThroughputReport"]>;
export type ProgressRow = Wire<S["ProgressRow"]>;
/** Known gap: the schema's `ReportKpis` lists only `completedThisSprint`; the server sends all of these. */
export type ReportKpis = Wire<S["ReportKpis"]> & {
  sprint: { name: string; number: number; startDate: ISODate; endDate: ISODate; dayIndex: number; lengthDays: number } | null;
  plannedThisSprint: number;
  avgCycleTimeDays: number;
  p85CycleTimeDays: number;
  overdueCount: number;
  oldestOverdueKey: string | null;
  scopeChangePts: number;
  completedSprints: number;
};

/** Every cursor page (`TaskPageOut`, `ActivityPage`, `WorkspaceMemberPage`, …) has this shape. */
export type Paginated<T> = Omit<Wire<S["TaskPageOut"]>, "data"> & { data: T[] };

/**
 * Client state: the access token (live mode; null in mock mode) and the signed-in user. Sign-in responses carry a
 * `User`, `/auth/me` a `Me`; `hasPassword` is known only after the latter (missing = has one).
 */
export type SessionUser = User & Partial<Pick<Me, "hasPassword">>;
export interface Session {
  accessToken: string | null;
  user: SessionUser;
}

export type SalesHealth = Wire<S["SalesHealth"]>;
export type DownloadUrl = Wire<S["DownloadUrl"]>;

/* ───────────────────────── Saved views (board 30) ───────────────────────── */

export type BaseFilterField = "status" | "priority" | "assignee" | "label" | "sprint" | "due" | "epic";
/** Board 39 adds `blocked` (is true/false) and `cf.<fieldId>` (custom fields). */
export type FilterField = BaseFilterField | "blocked" | `cf.${string}`;
/** Board 39 adds set ("is not empty"), gt and lt. */
export type FilterOp = "is" | "not" | "any" | "empty" | "before" | "after" | "set" | "gt" | "lt";

/**
 * One filter row; rows combine with AND. Values are ids (status, label, sprint, epic, user; "me" = the viewer),
 * priority numbers as strings, or for `due` an ISO date or a relative token: "today", "tomorrow", "week" or "sprint".
 */
export type FilterRule = Refine<S["SavedViewFilter"], { field: FilterField; op: FilterOp }>;

export type ViewIcon = S["SavedViewIconEnum"];
/** `pinned` / `position`: the current user's pins; `count`: matching tasks for the current user. */
export type SavedView = Refine<S["SavedView"], { filters: FilterRule[] }>;
export type SavedViewInput = Refine<
  S["SavedViewCreateInRequest"],
  { icon: ViewIcon; visibility: SavedView["visibility"]; layout: SavedView["layout"]; filters: FilterRule[] }
>;
export type SavedViewPatch = Refine<S["PatchedSavedViewUpdateInRequest"], { filters?: FilterRule[] }>;

/* ───────────────────────── Trash (board 29) ───────────────────────── */

/**
 * Extension (client-computed): the server sends namespaced kinds ("tracking.task", "core.comment");
 * `normalizeTrashList()` / `bareTrashKind()` turn them into these bare kinds, which the UI works on.
 */
export type TrashKind = "task" | "comment" | "project";
export type TrashRef = Refine<S["TrashRef"], { kind: TrashKind }>;
/** The wire item with the bare kind (extension above). `project` is `{id, key, name, hue}` when the item has one. */
export type TrashItem = Refine<S["TrashItem"], { kind: TrashKind; project: Pick<Project, "id" | "key" | "name" | "hue"> | null }>;
export type TrashList = Refine<S["TrashList"], { data: TrashItem[]; kinds: TrashKind[] }>;

/* ───────────────────────── Custom fields, dependencies, time (board 39, v2) ───────────────────────── */

export type CustomFieldType = S["CustomFieldTypeEnum"];
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

export type CustomFieldOption = Refine<S["CustomFieldOptionOut"], { color: FieldColor }>;
export type CustomField = Refine<S["CustomFieldOut"], { options: CustomFieldOption[] }>;
type FieldOptionInput = Refine<S["CustomFieldOptionInRequest"], { color: FieldColor }>;
export type CustomFieldInput = Refine<S["CustomFieldInRequest"], { options?: FieldOptionInput[] }>;
export type CustomFieldPatch = Refine<S["PatchedCustomFieldPatchInRequest"], { options?: FieldOptionInput[] }>;

export type DependencyRelation = S["RelationEnum"];
export type TaskRef = Wire<S["TaskRefOut"]>;
export type DependencyTask = Refine<S["DependencyTaskOut"], { status: Pick<Status, "name" | "glyph" | "category"> }>;
export type DependencyItem = Refine<S["DependencyItemOut"], { task: DependencyTask }>;
export type TaskDependencies = Refine<S["TaskDependenciesOut"], { blockedBy: DependencyItem[]; blocks: DependencyItem[] }>;

export type TimeEntry = Wire<S["TimeEntryOut"]>;
export type TimeEntryInput = Wire<S["TimeEntryInRequest"]>;
export type RunningTimer = Wire<S["RunningTimerOut"]>;
export type TimerState = Wire<S["TimerStateOut"]>;
export type TimerStart = Wire<S["TimerStartOut"]>;
export type TimerStop = Wire<S["TimerStopOut"]>;
export type TimesheetSlice = Wire<S["TimesheetSliceOut"]>;
export type TimesheetCell = Wire<S["TimesheetCellOut"]>;
export type TimesheetRow = Wire<S["TimesheetRowOut"]>;
export type Timesheet = Refine<S["TimesheetOut"], { projects: Refine<S["TimesheetProjectOut"], { my_permissions: ProjectPermission[] }>[] }>;

/* ───────────────────────── Timeline & calendar (board 32, v2), client-only ───────────────────────── */

export type TimelineZoom = "week" | "month" | "quarter";
export type TimelineGroup = "epic" | "assignee";
export type CalendarMode = "month" | "week";

/* ───────────────────────── Import (board 40, v2) ───────────────────────── */

export type ImportSource = S["ImportSourceEnum"];
export type ImportPreset = S["PresetEnum"];
export type ImportStatus = S["ImportStatusEnum"];
export type ImportField = S["FieldEnum"];
export type ImportTimeUnit = S["ImportColumnMappingUnitEnum"];
export type ImportTaskType = TaskType | "epic";
export type ImportFileInfo = Wire<S["ImportFileInfo"]>;
export type ImportColumnMapping = Wire<S["ImportColumnMappingRequest"]>;
export type ImportMapping = Refine<S["ImportMappingInRequest"], { types: Record<string, ImportTaskType | null> }>;
export type ImportCreate = Wire<S["ImportCreateInRequest"]>;
export type ImportCreated = Refine<S["ImportCreated"], { job: ImportJob }>;
export type ImportErrorReport = Wire<S["ImportErrorReport"]>;
export type ImportFailure = Wire<S["ImportFailure"]>;

/*
 * The job's analysis / validation / progress / result and a row preview's issues / values are free-form JSON in the
 * schema (`unknown`, described in docs/v2/40-import-wizard.md §4). These client types give them their §4 shape.
 */
export type ImportColumnType = "empty" | "text" | "number" | "date" | "duration" | "list" | "person";
export type ImportDateOrder = "ymd" | "mdy" | "dmy" | "jira" | "text";
export interface ImportColumn {
  index: number;
  name: string;
  samples: string[];
  inferredType: ImportColumnType;
  emptyCount: number;
  distinctCount: number;
  dateOrder: ImportDateOrder | null;
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
export type ImportOutcome = S["OutcomeEnum"];
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
export type ImportRowPreview = Refine<S["ImportRowPreview"], { issues: ImportIssue[]; values: ImportRowValues }>;
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
export type ImportJob = Refine<
  S["ImportJob"],
  {
    analysis: { columns: ImportColumn[] } | null;
    mapping: ImportMapping | null;
    validation: ImportValidation | null;
    progress: ImportProgress | null;
    result: ImportResult | null;
  }
>;
export type ImportJobSummary = Wire<S["ImportJobSummary"]>;

/* ───────────────────────── Dashboards (v2, board 33) ───────────────────────── */

export type WidgetType = S["DashboardWidgetTypeEnum"];
/** Widget configs per type (the schema types `config` as `unknown` and describes these). */
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
  [T in WidgetType]: Refine<S["DashboardWidget"], { type: T; config: WidgetConfigMap[T] }>;
}[WidgetType];
/** A layout item for `PUT /dashboards/:id/layout`: no `id` means "create". */
export type DashboardWidgetInput = {
  [T in WidgetType]: Refine<S["DashboardWidgetInputRequest"], { type: T; config: WidgetConfigMap[T] }>;
}[WidgetType];
export type DashboardVisibility = S["DashboardVisibilityEnum"];
export type DashboardTemplate = S["DashboardCreateTemplateEnum"];
export type Dashboard = Refine<S["Dashboard"], { widgets: DashboardWidget[] }>;
export type DashboardSummary = Wire<S["DashboardSummary"]>;
export type DashboardCreate = Wire<S["DashboardCreateRequest"]>;
export type DashboardPatch = Refine<S["PatchedDashboardPatchRequest"], { version: number }>;

/* Workload report (W1). Hours are minutes on the wire. The schema leaves the nested objects `unknown`. */
export interface WorkloadRow {
  user: Pick<User, "id" | "name" | "hue" | "avatarUrl">;
  inProgress: number;
  todo: number;
  capacity: number | null;
  unestimated: number;
}
export type WorkloadReport = Refine<
  S["WorkloadReport"],
  {
    sprint: { id: ID; name: string; number: number; startDate: ISODate; endDate: ISODate } | null;
    personField: { id: ID; name: string } | null;
    rows: WorkloadRow[];
    unassigned: { inProgress: number; todo: number; unestimated: number };
  }
>;

/* ───────────────────────── Presence (v2, board 33) ───────────────────────── */

export type PresenceLocationKind = "board" | "dashboard" | "task";
/** `{kind, id}` (the schema types the location as `unknown`). */
export interface PresenceLocation {
  kind: PresenceLocationKind;
  id: ID;
}
export interface PresencePerson {
  user: Pick<User, "id" | "name" | "hue" | "avatarUrl">;
  state: S["PresenceUpdateStateEnum"];
  field: string | null;
  typing: boolean;
  since: ISODateTime;
}
/** `at`: server time of the snapshot (clients drop older ones); only non-empty locations. */
export type PresenceRoster = Refine<S["PresenceRoster"], { locations: { location: PresenceLocation; people: PresencePerson[] }[] }>;
export type PresenceUpdate = Refine<S["PresenceUpdateRequest"], { location: PresenceLocation; field: string | null; typing: boolean }>;
export type PresenceHeartbeat = Refine<S["PresenceHeartbeat"], { roster: PresenceRoster }>;

/* ───────────────────────── Board 37 (v2): integrations & development ───────────────────────── */

export type Provider = S["ProviderEnum"];
export type IntegrationErrorCode = S["CodeEnum"];
/** `available`: the server has the provider configured; `methods`: github ["app"], gitlab ["oauth", "token"] or ["token"]. */
export type ProviderInfo = Refine<S["ProviderInfoOut"], { name: "GitHub" | "GitLab" }>;
export type RepoVisibility = S["RepositoryVisibilityEnum"];
/** `projectIds` is [] when `allProjects`; `syncState` "paused" while the integration is in error. */
export type Repository = Wire<S["RepositoryOut"]>;
export type Integration = Wire<S["IntegrationOut"]>;
/** `tracked` by this integration; `trackedElsewhere`: by another integration of the workspace (disabled row). */
export type AvailableRepository = Wire<S["AvailableRepositoryOut"]>;
export type IntegrationsOverview = Refine<S["IntegrationsOverviewOut"], { providers: ProviderInfo[] }>;
export type AuthorizeUrl = Wire<S["AuthorizeUrlOut"]>;
export type GitLabConnectBody = { method: "oauth" } | Refine<S["GitLabConnectInRequest"], { method: "token"; baseUrl: string; token: string }>;
export type ConfirmConnect = Wire<S["ConfirmInRequest"]>;
export type TrackedRepositoryInput = Wire<S["TrackedRepositoryInRequest"]>;

export type RepoRef = Wire<S["RepoRefOut"]>;
export type DevAuthor = Wire<S["DevAuthorOut"]>;
export type CheckState = S["ChecksStateEnum"];
export type DevCheck = Wire<S["DevCheckOut"]>;
export type DevLinkSource = S["LinkSourceEnum"];

/*
 * The schema has one flat `DevItemOut` ("DevPullRequest | DevBranch | DevCommit, discriminated by kind") with the
 * kind-specific keys optional. The client narrows it into the union by `kind`.
 */
type DevItemWire = Wire<S["DevItemOut"]>;
type DevCommon = Pick<DevItemWire, "id" | "provider" | "repository" | "repoFullPath" | "url">;
export type DevPullRequest = DevCommon &
  Refine<
    Pick<DevItemWire, "kind" | "number" | "ref" | "title" | "state" | "headBranch" | "baseBranch" | "author" | "checks" | "approvals" | "linkSource" | "createdAt" | "updatedAt" | "mergedAt" | "closedAt">,
    {
      kind: "pull_request";
      number: number;
      /** GitHub "#214", GitLab "!12". */
      ref: string;
      title: string;
      state: "open" | "draft" | "merged" | "closed";
      headBranch: string;
      baseBranch: string;
      author: DevAuthor;
      checks: Wire<S["DevChecksOut"]> | null;
      approvals: number;
      createdAt: ISODateTime;
      updatedAt: ISODateTime;
      mergedAt: ISODateTime | null;
      closedAt: ISODateTime | null;
    }
  >;
export type DevBranch = DevCommon &
  Refine<
    Pick<DevItemWire, "kind" | "name" | "state" | "aheadBy" | "linkSource" | "updatedAt">,
    { kind: "branch"; name: string; state: "active" | "deleted"; aheadBy: number | null; updatedAt: ISODateTime }
  >;
export type DevCommit = DevCommon &
  Refine<
    Pick<DevItemWire, "kind" | "sha" | "shortSha" | "message" | "author" | "committedAt" | "linkSource">,
    { kind: "commit"; sha: string; shortSha: string; message: string; author: DevAuthor; committedAt: ISODateTime; linkSource: "auto" | "manual" }
  >;
export type DevItem = DevPullRequest | DevBranch | DevCommit;

export type DevRepositoryOption = Wire<S["DevRepositoryOut"]>;
/** `enabled` mirrors `Project.devEnabled`. */
export type TaskDevelopment = Refine<
  S["TaskDevelopmentOut"],
  { pullRequests: DevPullRequest[]; branches: DevBranch[]; commits: DevCommit[] }
>;
/** `pr`: the headline PR (most recently updated open/draft, else merged in the last 14 days, else null). */
export type TaskDevSummary = Wire<S["TaskDevSummaryOut"]>;

export type DevTrigger = S["TriggerEnum"];
export type DevAutomationRule = Wire<S["AutomationRuleSchema"]>;
