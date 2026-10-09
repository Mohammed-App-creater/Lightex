import type {
  AccessRequest,
  ActivityEntry,
  AuditEntry,
  Epic,
  Label,
  Milestone,
  Notification,
  NotificationPreferences,
  PushDevice,
  SmsConnection,
  SmsVerification,
  TelegramConnection,
  TelegramLink,
  Objective,
  Permission,
  Project,
  RichDoc,
  RoleScope,
  Sprint,
  Status,
  Task,
  User,
  Comment,
  Attachment,
  CustomField,
  CustomFieldValue,
  ImportIssue,
  ImportJob,
  ImportOutcome,
  ImportTaskType,
  TimeEntry,
  Dashboard,
  DevItem,
  DevTrigger,
  Integration,
  Provider,
  Repository,
} from "@/lib/api/types";

/* Stored shapes. Derived fields (progress, counts, my_permissions) are computed per request. */

export type UserRec = User & { password: string };
export type WorkspaceRec = {
  id: string;
  slug: string;
  name: string;
  hue: number;
  createdAt: string;
  deletedAt: string | null;
  /** Board 38: `notificationPolicy.sms` (missing = true). */
  smsEnabled?: boolean;
};
export type WsMemberRec = {
  workspaceId: string;
  userId: string;
  roleId: string;
  status: "active" | "deactivated";
  joinedAt: string;
  lastActiveAt: string | null;
};
export type RoleRec = {
  id: string;
  workspaceId: string;
  key: string | null;
  name: string;
  description: string;
  scope: RoleScope;
  isSystem: boolean;
  permissions: Permission[];
};
export type InviteRec = {
  id: string;
  token: string;
  workspaceId: string;
  email: string;
  roleId: string;
  invitedById: string;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "accepted" | "revoked" | "expired";
};
export type ProjectRec = Omit<
  Project,
  "my_permissions" | "myRoleId" | "memberCount" | "openTaskCount" | "activeSprintId" | "nextTaskNumber" | "devEnabled"
> & { taskSeq: number };
export type ProjectMemberRec = { projectId: string; userId: string; roleId: string; addedAt: string };
export type ObjectiveRec = Omit<Objective, "progress" | "taskIds">;
export type MilestoneRec = Omit<Milestone, "progress">;
// Board 27 fields are optional on the record (older seeds lack them); toEpic normalizes to null.
// Board 32 dates are optional too (cached databases predate them); toEpic normalizes to null.
export type EpicRec = Omit<Epic, "progress" | "ownerId" | "milestoneId" | "archivedAt" | "startDate" | "dueDate"> &
  Partial<Pick<Epic, "ownerId" | "milestoneId" | "archivedAt" | "startDate" | "dueDate">>;
export type SprintRec = Omit<Sprint, "progress">;
export type TaskRec = Omit<
  Task,
  "subtaskCount" | "subtaskDoneCount" | "commentCount" | "attachmentCount" | "customFields" | "isBlocked" | "openBlockers" | "timeEstimateMinutes" | "loggedMinutes" | "startDate" | "dev"
> & {
  /** Board 32 (optional so v1-cached records still load; toTask normalizes to null). */
  startDate?: string | null;
  description: RichDoc | null;
  startedAt: string | null;
  /** Board 39: set custom-field values (optional so v1-cached records still load). */
  customFields?: Record<string, CustomFieldValue>;
  timeEstimateMinutes?: number | null;
};
export type AttachmentRec = Attachment & { content?: string };
export type NotificationRec = Notification & { recipientId: string };

export interface MockDB {
  schema: number;
  users: UserRec[];
  workspaces: WorkspaceRec[];
  wsMembers: WsMemberRec[];
  roles: RoleRec[];
  invites: InviteRec[];
  projects: ProjectRec[];
  projectMembers: ProjectMemberRec[];
  accessRequests: AccessRequest[];
  statuses: Status[];
  labels: Label[];
  objectives: ObjectiveRec[];
  milestones: MilestoneRec[];
  epics: EpicRec[];
  sprints: SprintRec[];
  tasks: TaskRec[];
  comments: Comment[];
  attachments: AttachmentRec[];
  notifications: NotificationRec[];
  prefs: { userId: string; prefs: NotificationPreferences }[];
  activity: ActivityEntry[];
  audit: (AuditEntry & { workspaceId: string })[];
  resetTokens: { token: string; userId: string; expiresAt: string }[];
  recents: { userId: string; kind: "task" | "project"; id: string; at: string }[];
  /** Workspace-level "add me to a project" requests (board 24). Optional: created lazily by handlers/home.ts. */
  wsAccessRequests?: { id: string; workspaceId: string; userId: string; createdAt: string }[];
  /** Saved views (board 30). Optional: created lazily by handlers/views.ts, so no SCHEMA bump. */
  views?: SavedViewRec[];
  viewPins?: { userId: string; viewId: string; position: number }[];
  /** Trash (board 29). Optional: created lazily by handlers/trash.ts, so no SCHEMA bump. */
  trash?: TrashStore;
  /* Board 39 (v2). Optional, created by ensureExt39 (handlers/extensions.ts), so no SCHEMA bump. */
  customFields?: CustomFieldRec[];
  dependencies?: DependencyRec[];
  timeEntries?: TimeEntry[];
  timers?: { userId: string; taskId: string; startedAt: string }[];
  /** Board 39 upgrade marker for databases cached before v2. */
  ext39?: boolean;
  /* Board 37 (v2). Optional, created by ensureExt37 (handlers/integrations.ts), so no SCHEMA bump. */
  integrations?: IntegrationRec[];
  repositories?: RepositoryRec[];
  devLinks?: DevLinkRec[];
  devRules?: DevRuleRec[];
  connectAttempts?: ConnectAttemptRec[];
  /** Board 37 upgrade marker (new keys on cached system roles, PRJ-41 / PRJ-29, the GitHub seed). */
  ext37?: boolean;
  /** Board 32 upgrade marker (start dates, epic dates, one extra dependency). */
  ext32?: boolean;
  /* Board 40 (v2). Optional, created lazily by handlers/imports.ts, so no SCHEMA bump. Job records hold no file content. */
  imports?: ImportJobRec[];
  importRows?: ImportRowRec[];
  /** Board 40 upgrade marker (project.import on cached system roles). */
  ext40?: boolean;
  /* Board 33 (v2). Optional, created by ensureExt33 (handlers/dashboards.ts), so no SCHEMA bump. Presence lives in memory only. */
  dashboards?: DashboardRec[];
  /** Board 33 upgrade marker (dashboard keys on cached system roles, PRJ dashboards). */
  ext33?: boolean;
  /* Board 38 (v2). Optional, created by ensureExt38 (handlers/channels.ts), so no SCHEMA bump. No secrets: codes are the fixed mock values. */
  channelConnections?: ChannelConnectionRec[];
  telegramLinks?: TelegramLinkRec[];
  smsVerifications?: SmsVerificationRec[];
  pushDevices?: PushDeviceRec[];
  /** Every OTP send (the §7.5 limits count these). */
  otpSends?: { userId: string; phone: string; at: string }[];
  /** The delivery log (§3.7): events fanned out by the mock, tests, quiet-hours summaries. Capped at 400 rows. */
  channelDeliveries?: ChannelDeliveryRec[];
  /** DRF-style throttle hits per user and scope ("connect", "test"). */
  channelThrottle?: { userId: string; scope: "connect" | "test"; at: string }[];
  /** Board 38 upgrade marker (u_alex's Telegram + push, preference keys, quiet hours). */
  ext38?: boolean;
}

/* Board 38: notification channels. */
export type ChannelConnectionRec =
  | ({ channel: "telegram"; userId: string; chatId: number } & TelegramConnection)
  | ({ channel: "sms"; userId: string } & SmsConnection);
export type TelegramLinkRec = {
  id: string;
  userId: string;
  code: string;
  token: string;
  status: TelegramLink["status"];
  createdAt: string;
  expiresAt: string;
  /** The simulated scan (5 s after creation); null in "Telegram: manual" mode. */
  autoLinkAt: string | null;
  connectionId: string | null;
};
export type SmsVerificationRec = SmsVerification & {
  userId: string;
  country: string;
  status: "pending" | "verified" | "expired" | "canceled";
  sendCount: number;
};
export type PushDeviceRec = PushDevice & { userId: string; endpoint: string; p256dh: string; auth: string; failureCount: number };
export type ChannelDeliveryRec = {
  id: string;
  userId: string;
  workspaceId: string | null;
  channel: "telegram" | "sms" | "push" | "email";
  kind: "event" | "summary" | "test";
  event: string;
  /** The target: the connection or push device id. */
  target: string;
  notificationId: string | null;
  taskKey: string | null;
  urgent: boolean;
  status: "queued" | "deferred" | "sent" | "failed" | "skipped" | "coalesced";
  skipReason: string | null;
  nextAttemptAt: string;
  createdAt: string;
  sentAt: string | null;
  summaryId: string | null;
};

/* Board 37: integrations. Credentials never exist in the mock; the fake provider needs none. */
export type IntegrationRec = Omit<Integration, "repositories" | "syncing" | "nextSyncAt" | "status" | "manageUrl"> & {
  workspaceId: string;
  /** "pending" = called back, waiting for confirm (never listed). */
  status: "pending" | "active" | "error";
  accountExternalId: string;
  manageUrl: string | null;
  syncRequestedAt: string | null;
  /** A sync run is "running" until this time (lazy completion on read). */
  syncUntil: string | null;
};
export type RepositoryRec = Omit<Repository, "provider" | "syncState" | "canCreateBranch"> & {
  workspaceId: string;
  baseUrl: string;
  syncState: "idle" | "queued" | "syncing" | "failed";
  syncUntil: string | null;
  archived: boolean;
};
/** One linked object per task; the wire item is kept as-is with the server-side match fields next to it. */
export type DevLinkRec = {
  id: string;
  taskId: string;
  workspaceId: string;
  baseUrl: string;
  repoExternalId: string;
  /** PR "<repo>#<n>", commit sha, branch "<repo>:<name>". */
  externalId: string;
  repositoryId: string | null;
  suppressed: boolean;
  linkedBy: string | null;
  item: DevItem;
};
export type DevRuleRec = { projectId: string; trigger: DevTrigger; enabled: boolean; statusId: string | null; updatedBy: string | null };
export type ConnectAttemptRec = {
  id: string;
  workspaceId: string;
  userId: string;
  provider: Provider;
  mode: "connect" | "reconnect";
  integrationId: string | null;
  status: "started" | "called_back" | "confirmed" | "failed" | "expired";
  /** The one-time confirm token (the backend stores only its hash). */
  confirmToken: string | null;
  expiresAt: string;
};

/** Board 33: the wire dashboard without the derived `owner`. */
export type DashboardRec = Omit<Dashboard, "owner">;

/** Board 40: the wire job plus server-side state (never sent as-is; handlers/imports.ts strips it). */
export type ImportJobRec = ImportJob & {
  workspaceId: string;
  /** Explicit value choices (keys present = the user's choice); everything else is suggested. */
  userMaps: { statuses: Record<string, string | null>; types: Record<string, ImportTaskType | null>; people: Record<string, string | null> };
  phase: "preparing" | "rows" | "links" | "finishing" | null;
  numberBase: number | null;
  plannedTasks: number;
  /** Next planned-row index (0-based) of the rows phase. */
  cursor: number;
  /** Objects created while preparing: labels by lower-case name, epics by "row:<n>" / "name:<lower>", options by field id → name. */
  setup: { done: boolean; labels: Record<string, string>; epics: Record<string, string>; options: Record<string, Record<string, string>> } | null;
  requestId: string;
  /** Error report body (no BOM), kept when it is small enough for the localStorage cache. */
  reportCsv: string | null;
};
export type ImportRowRec = {
  jobId: string;
  row: number;
  outcome: ImportOutcome;
  taskId: string | null;
  epicId: string | null;
  key: string | null;
  title: string;
  refs: string[];
  issues: ImportIssue[];
};

export type CustomFieldRec = Omit<CustomField, "taskCount"> & { createdById?: string | null };
/** One row means `blockerId` blocks `blockedId`. */
export type DependencyRec = { id: string; projectId: string; blockerId: string; blockedId: string; createdById: string | null; createdAt: string };

/* Trash (board 29): deleted comments and whole projects live here; tasks keep TaskRec.deletedAt. */
export type TrashedCommentRec = Comment & { deletedAt: string; deletedBy: string | null };
export type TrashedProjectRec = {
  project: ProjectRec;
  tasks: TaskRec[];
  members: ProjectMemberRec[];
  deletedAt: string;
  deletedBy: string | null;
};
export type TrashStore = {
  seeded: boolean;
  comments: TrashedCommentRec[];
  projects: TrashedProjectRec[];
  /** taskId → user who deleted it. */
  taskDeletedBy: Record<string, string>;
};

export type SavedViewRec = Omit<import("@/lib/api/types").SavedView, "pinned" | "position" | "count">;
