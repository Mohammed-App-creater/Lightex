import { apiUrl } from "@/lib/env";
import { enc, http } from "./client";
import type { ListQuery } from "./transport";
import type {
  AcceptInviteResult,
  AccessRequest,
  AccessRequestWithUser,
  ActivityEntry,
  Attachment,
  AuditPage,
  AuthResult,
  AuthorizeUrl,
  AvailableRepository,
  BacklogData,
  BoardData,
  BurndownReport,
  ChannelTestResult,
  Comment,
  ConfirmConnect,
  CustomField,
  CustomFieldInput,
  CustomFieldPatch,
  CycleTimeReport,
  Dashboard,
  DashboardCreate,
  DashboardPatch,
  DashboardSummary,
  DashboardWidgetInput,
  DependencyRelation,
  DevAutomationRule,
  DevBranch,
  DevItem,
  Epic,
  EpicWrite,
  GitLabConnectBody,
  ImportCreate,
  ImportCreated,
  ImportErrorReport,
  ImportJob,
  ImportJobSummary,
  ImportMapping,
  ImportRowPreview,
  Integration,
  IntegrationsOverview,
  Invite,
  Label,
  LabelPatch,
  Me,
  Milestone,
  MilestoneWrite,
  MyWorkspaceAccessRequest,
  Notification,
  NotificationChannels,
  NotificationPage,
  NotificationPreferences,
  NotificationPreferencesInput,
  Objective,
  ObjectiveWrite,
  Paginated,
  PermissionInfo,
  PresenceHeartbeat,
  PresenceRoster,
  PresenceUpdate,
  ProgressRow,
  Project,
  ProjectCreate,
  ProjectDirectoryItem,
  ProjectMember,
  ProjectPatch,
  ProjectSummary,
  PushDevice,
  PushSubscriptionInput,
  ReadAllResult,
  RecentItem,
  ReportKpis,
  Repository,
  RichDoc,
  Role,
  RoleCreate,
  RolePatch,
  SalesHealth,
  SavedView,
  SavedViewInput,
  SavedViewPatch,
  SearchResult,
  SearchType,
  SlugAvailability,
  SmsVerification,
  SmsVerificationInput,
  SmsVerifyResult,
  Sprint,
  SprintWrite,
  Status,
  StatusCreate,
  StatusPatch,
  TargetRef,
  Task,
  TaskBulk,
  TaskCreate,
  TaskDependencies,
  TaskDetail,
  TaskDevelopment,
  TaskMove,
  TaskPatch,
  Team,
  TeamDetail,
  TeamMember,
  TelegramLink,
  TestableChannel,
  ThroughputReport,
  TimeEntry,
  TimeEntryInput,
  TimerStart,
  TimerState,
  TimerStop,
  Timesheet,
  TrackedRepositoryInput,
  TrashKind,
  TrashList,
  TrashRef,
  UnreadCount,
  UploadRequest,
  UploadTicket,
  VapidKey,
  VelocityReport,
  WorkloadReport,
  Workspace,
  WorkspaceAccessRequest,
  WorkspaceCreate,
  WorkspaceMember,
  WorkspaceModule,
  WorkspacePatch,
} from "./types";
import type { components } from "./schema";

type WS = components["schemas"];

/*
 * Every backend endpoint, grouped as in docs/api-contract.md. Screens import `api` only;
 * nothing else in the app knows a URL. Swapping to the real backend = HttpTransport.
 */

export const auth = {
  login: (email: string, password: string) => http.post<AuthResult>("/auth/login", { email, password }, { anonymous: true }),
  register: (body: { name: string; email: string; password: string }) =>
    http.post<AuthResult>("/auth/register", body, { anonymous: true }),
  refresh: () => http.post<{ accessToken: string }>("/auth/refresh", undefined, { anonymous: true }),
  logout: () => http.post<void>("/auth/logout", undefined, { anonymous: true }),
  forgotPassword: (email: string) => http.post<void>("/auth/forgot-password", { email }, { anonymous: true }),
  resetPassword: (token: string, password: string) =>
    http.post<void>("/auth/reset-password", { token, password }, { anonymous: true }),
  me: () => http.get<Me>("/auth/me"),
  updateMe: (body: WS["PatchedProfileInRequest"]) => http.patch<Me>("/auth/me", body),
  changePassword: (currentPassword: string, newPassword: string) =>
    http.put<void>("/auth/me/password", { currentPassword, newPassword }),
  /**
   * Live mode only. A page navigation, not a fetch: the API redirects to Google, then back to `next`
   * with the refresh cookie set (the session restores as on any page load), or to
   * `/login?error=google|google_cancelled|google_unavailable`.
   */
  googleStartUrl: (next: string) => `${apiUrl}/api/v1/auth/google/start?next=${enc(next)}`,
  invite: (token: string) => http.get<Invite>(`/invites/${enc(token)}`, undefined, { anonymous: true }),
  acceptInvite: (token: string, body: { name?: string; password?: string }) =>
    http.post<AcceptInviteResult>(`/invites/${enc(token)}/accept`, body, { anonymous: true }),
};

export const workspaces = {
  list: () => http.get<Workspace[]>("/workspaces"),
  /** Stage 3: `modules` turns on extra modules at creation (tracking is always on). */
  create: (body: WorkspaceCreate) => http.post<Workspace>("/workspaces", body),
  get: (slug: string) => http.get<Workspace>(`/workspaces/${enc(slug)}`),
  /** Board 38: `notificationPolicy` (the SMS switch) also needs `core.workspace.update`. */
  update: (slug: string, body: WorkspacePatch) =>
    http.patch<Workspace>(`/workspaces/${enc(slug)}`, body),
  remove: (slug: string, confirm: string) => http.del(`/workspaces/${enc(slug)}`, { confirm }),
  slugAvailability: (slug: string, q: string) =>
    http.get<SlugAvailability>(`/workspaces/${enc(slug)}/slug-availability`, { q }),
  members: (slug: string, query?: ListQuery) => http.get<Paginated<WorkspaceMember>>(`/workspaces/${enc(slug)}/members`, query),
  updateMember: (slug: string, userId: string, roleId: string) =>
    http.patch<WorkspaceMember>(`/workspaces/${enc(slug)}/members/${enc(userId)}`, { roleId }),
  removeMember: (slug: string, userId: string) => http.del(`/workspaces/${enc(slug)}/members/${enc(userId)}`),
  invites: (slug: string) => http.get<Invite[]>(`/workspaces/${enc(slug)}/invites`),
  invite: (slug: string, emails: string[], roleId: string) =>
    http.post<Invite[]>(`/workspaces/${enc(slug)}/invites`, { emails, roleId }),
  revokeInvite: (slug: string, id: string) => http.del(`/workspaces/${enc(slug)}/invites/${enc(id)}`),
  resendInvite: (slug: string, id: string) => http.post<Invite>(`/workspaces/${enc(slug)}/invites/${enc(id)}/resend`),
  activity: (slug: string, query?: ListQuery) => http.get<Paginated<ActivityEntry>>(`/tracking/workspaces/${enc(slug)}/activity`, query),
  myTasks: (slug: string) => http.get<Paginated<Task>>(`/tracking/workspaces/${enc(slug)}/tasks`, { filter: { assignee: "me" }, limit: 200 }),
  /** Tasks across visible projects assigned to a user ("me" or a user id). */
  assignedTasks: (slug: string, assignee: string) =>
    http.get<Paginated<Task>>(`/tracking/workspaces/${enc(slug)}/tasks`, { filter: { assignee }, limit: 200 }),
  projectDirectory: (slug: string) =>
    http.get<ProjectDirectoryItem[]>(`/tracking/workspaces/${enc(slug)}/project-directory`),
  /** Board 24: my pending "add me to a project" request to the workspace admins (or null). */
  myAccessRequest: (slug: string) =>
    http.get<MyWorkspaceAccessRequest>(`/workspaces/${enc(slug)}/access-requests/mine`),
  requestAccess: (slug: string) => http.post<WorkspaceAccessRequest>(`/workspaces/${enc(slug)}/access-requests`),
  withdrawAccessRequest: (slug: string) => http.del(`/workspaces/${enc(slug)}/access-requests/mine`),
};

export const roles = {
  list: (slug: string, scope?: "workspace" | "project") =>
    http.get<Role[]>(`/workspaces/${enc(slug)}/roles`, scope ? { filter: { scope } } : undefined),
  /**
   * Stage 4: `dataScopes` gives the scope of each granted scopable code. 400 `data_scope_required` (`details.codes`)
   * when one is missing, 400 `data_scope_not_allowed` for a scope on a non-scopable code.
   */
  create: (slug: string, body: RoleCreate) =>
    http.post<Role>(`/workspaces/${enc(slug)}/roles`, body),
  update: (id: string, body: RolePatch) =>
    http.patch<Role>(`/roles/${enc(id)}`, body),
  remove: (id: string, reassignTo?: string) => http.del(`/roles/${enc(id)}`, reassignTo ? { reassignTo } : undefined),
  catalogue: () => http.get<PermissionInfo[]>("/permissions"),
};

export const projects = {
  list: (slug: string, query?: ListQuery) => http.get<Project[]>(`/tracking/workspaces/${enc(slug)}/projects`, query),
  get: (slug: string, key: string) => http.get<Project>(`/tracking/workspaces/${enc(slug)}/projects/${enc(key)}`),
  create: (slug: string, body: ProjectCreate) =>
    http.post<Project>(`/tracking/workspaces/${enc(slug)}/projects`, body),
  update: (id: string, body: ProjectPatch) => http.patch<Project>(`/tracking/projects/${enc(id)}`, body),
  archive: (id: string) => http.post<Project>(`/tracking/projects/${enc(id)}/archive`),
  unarchive: (id: string) => http.post<Project>(`/tracking/projects/${enc(id)}/unarchive`),
  remove: (id: string, confirm: string) => http.del(`/tracking/projects/${enc(id)}`, { confirm }),
  members: (id: string) => http.get<ProjectMember[]>(`/tracking/projects/${enc(id)}/members`),
  addMember: (id: string, userId: string, roleId: string) => http.post<ProjectMember>(`/tracking/projects/${enc(id)}/members`, { userId, roleId }),
  updateMember: (id: string, userId: string, roleId: string) =>
    http.patch<ProjectMember>(`/tracking/projects/${enc(id)}/members/${enc(userId)}`, { roleId }),
  removeMember: (id: string, userId: string) => http.del(`/tracking/projects/${enc(id)}/members/${enc(userId)}`),
  requestAccess: (id: string, message?: string) => http.post<AccessRequest>(`/tracking/projects/${enc(id)}/access-requests`, { message }),
  withdrawAccessRequest: (id: string) => http.del(`/tracking/projects/${enc(id)}/access-requests/mine`),
  accessRequests: (id: string) => http.get<AccessRequestWithUser[]>(`/tracking/projects/${enc(id)}/access-requests`),
  denyAccessRequest: (id: string, requestId: string) =>
    http.post<AccessRequest>(`/tracking/projects/${enc(id)}/access-requests/${enc(requestId)}/deny`),
  statuses: (id: string) => http.get<Status[]>(`/tracking/projects/${enc(id)}/statuses`),
  createStatus: (id: string, body: StatusCreate) => http.post<Status>(`/tracking/projects/${enc(id)}/statuses`, body),
  updateStatus: (id: string, statusId: string, body: StatusPatch) =>
    http.patch<Status>(`/tracking/projects/${enc(id)}/statuses/${enc(statusId)}`, body),
  /** `moveTo`: status that receives the deleted status's tasks (required when it has tasks). */
  removeStatus: (id: string, statusId: string, moveTo?: string) =>
    http.del(`/tracking/projects/${enc(id)}/statuses/${enc(statusId)}`, moveTo ? { moveTo } : undefined),
  labels: (id: string) => http.get<Label[]>(`/tracking/projects/${enc(id)}/labels`),
  createLabel: (id: string, name: string, color?: string) => http.post<Label>(`/tracking/projects/${enc(id)}/labels`, { name, color }),
  updateLabel: (id: string, labelId: string, body: LabelPatch) =>
    http.patch<Label>(`/tracking/projects/${enc(id)}/labels/${enc(labelId)}`, body),
  removeLabel: (id: string, labelId: string) => http.del(`/tracking/projects/${enc(id)}/labels/${enc(labelId)}`),
  activity: (id: string, query?: ListQuery) => http.get<Paginated<ActivityEntry>>(`/tracking/projects/${enc(id)}/activity`, query),
  summary: (id: string) => http.get<ProjectSummary>(`/tracking/projects/${enc(id)}/summary`),
};

export const planning = {
  objectives: (projectId: string) => http.get<Objective[]>(`/tracking/projects/${enc(projectId)}/objectives`),
  createObjective: (projectId: string, body: ObjectiveWrite) => http.post<Objective>(`/tracking/projects/${enc(projectId)}/objectives`, body),
  updateObjective: (id: string, body: ObjectiveWrite) => http.patch<Objective>(`/tracking/objectives/${enc(id)}`, body),
  removeObjective: (id: string) => http.del(`/tracking/objectives/${enc(id)}`),
  linkTasks: (id: string, taskIds: string[]) => http.post<Objective>(`/tracking/objectives/${enc(id)}/tasks`, { taskIds }),
  unlinkTask: (id: string, taskId: string) => http.del<Objective>(`/tracking/objectives/${enc(id)}/tasks/${enc(taskId)}`),
  milestones: (projectId: string) => http.get<Milestone[]>(`/tracking/projects/${enc(projectId)}/milestones`),
  createMilestone: (projectId: string, body: MilestoneWrite) =>
    http.post<Milestone>(`/tracking/projects/${enc(projectId)}/milestones`, body),
  updateMilestone: (id: string, body: MilestoneWrite) =>
    http.patch<Milestone>(`/tracking/milestones/${enc(id)}`, body),
  removeMilestone: (id: string) => http.del(`/tracking/milestones/${enc(id)}`),
  epics: (projectId: string) => http.get<Epic[]>(`/tracking/projects/${enc(projectId)}/epics`),
  createEpic: (projectId: string, body: EpicWrite & { name: string }) => http.post<Epic>(`/tracking/projects/${enc(projectId)}/epics`, body),
  updateEpic: (id: string, body: EpicWrite) => http.patch<Epic>(`/tracking/epics/${enc(id)}`, body),
  removeEpic: (id: string) => http.del(`/tracking/epics/${enc(id)}`),
  sprints: (projectId: string) => http.get<Sprint[]>(`/tracking/projects/${enc(projectId)}/sprints`),
  createSprint: (projectId: string, body: SprintWrite = {}) => http.post<Sprint>(`/tracking/projects/${enc(projectId)}/sprints`, body),
  updateSprint: (id: string, body: SprintWrite) => http.patch<Sprint>(`/tracking/sprints/${enc(id)}`, body),
  removeSprint: (id: string) => http.del(`/tracking/sprints/${enc(id)}`),
  startSprint: (id: string, body: Pick<SprintWrite, "startDate" | "endDate" | "goal"> = {}) =>
    http.post<Sprint>(`/tracking/sprints/${enc(id)}/start`, body),
  completeSprint: (id: string, moveOpenTasksTo: string) => http.post<Sprint>(`/tracking/sprints/${enc(id)}/complete`, { moveOpenTasksTo }),
  activeSprint: (projectId: string) => http.get<Sprint | null>(`/tracking/projects/${enc(projectId)}/active-sprint`),
};

export const tasks = {
  list: (projectId: string, query?: ListQuery) => http.get<Paginated<Task>>(`/tracking/projects/${enc(projectId)}/tasks`, query),
  create: (projectId: string, body: TaskCreate) => http.post<Task>(`/tracking/projects/${enc(projectId)}/tasks`, body),
  get: (slug: string, key: string) => http.get<TaskDetail>(`/tracking/workspaces/${enc(slug)}/tasks/${enc(key)}`),
  update: (id: string, patch: TaskPatch, version?: number) => http.patch<Task>(`/tracking/tasks/${enc(id)}`, { ...patch, version }),
  remove: (id: string) => http.del(`/tracking/tasks/${enc(id)}`),
  restore: (id: string) => http.post<Task>(`/tracking/tasks/${enc(id)}/restore`),
  bulk: (projectId: string, body: TaskBulk) =>
    http.post<Task[]>(`/tracking/projects/${enc(projectId)}/tasks/bulk`, body),
  activity: (id: string) => http.get<ActivityEntry[]>(`/tracking/tasks/${enc(id)}/activity`),
  /** Board 32 (requested addition): tasks whose effective span overlaps [from, to] (inclusive), one page. */
  range: (projectId: string, from: string, to: string, cursor?: string | null) =>
    http.get<Paginated<Task>>(`/tracking/projects/${enc(projectId)}/tasks`, { filter: { from, to }, sort: "startDate", limit: 500, cursor }),
  /** Board 32 tray: open tasks with no dates, highest priority first. */
  unscheduled: (projectId: string, openStatusIds: string[]) =>
    http.get<Paginated<Task>>(`/tracking/projects/${enc(projectId)}/tasks`, {
      filter: { scheduled: "false", status: openStatusIds },
      sort: "-priority",
      limit: 200,
    }),
};

export const board = {
  get: (projectId: string, sprint: string = "active") =>
    http.get<BoardData>(`/tracking/projects/${enc(projectId)}/board`, { filter: { sprint } }),
  move: (taskId: string, body: TaskMove) => http.post<Task>(`/tracking/tasks/${enc(taskId)}/move`, body),
};

export const backlog = {
  get: (projectId: string) =>
    http.get<BacklogData>(`/tracking/projects/${enc(projectId)}/backlog`),
};

/** Platform Stage 2: `targets/{targetType}/{targetId}/…` (for tasks: "tracking.task" and `Task.id`). */
const targetPath = (t: TargetRef) => `/targets/${enc(t.targetType)}/${enc(t.targetId)}`;

export const comments = {
  list: (target: TargetRef) => http.get<Comment[]>(`${targetPath(target)}/comments`),
  create: (target: TargetRef, body: RichDoc) => http.post<Comment>(`${targetPath(target)}/comments`, { body }),
  update: (id: string, body: RichDoc) => http.patch<Comment>(`/comments/${enc(id)}`, { body }),
  remove: (id: string) => http.del(`/comments/${enc(id)}`),
};

export const attachments = {
  list: (target: TargetRef) => http.get<Attachment[]>(`${targetPath(target)}/attachments`),
  uploadUrl: (target: TargetRef, file: UploadRequest) =>
    http.post<UploadTicket>(`${targetPath(target)}/attachments/upload-url`, file),
  /** The ticket's `uploadId` is the pending attachment's id. */
  confirm: (uploadId: string) => http.post<Attachment>(`/attachments/${enc(uploadId)}/confirm`),
  remove: (id: string) => http.del(`/attachments/${enc(id)}`),
};

export type ReportRange = "last2" | "last6" | "last90" | "custom";

const rq = (range: ReportRange, from?: string, to?: string): ListQuery => ({ filter: { range, from, to } });

export const reports = {
  kpis: (projectId: string) => http.get<ReportKpis>(`/tracking/projects/${enc(projectId)}/reports/kpis`),
  burndown: (projectId: string, sprintId?: string) =>
    http.get<BurndownReport>(
      `/tracking/projects/${enc(projectId)}/reports/burndown`,
      sprintId ? { filter: { sprint: sprintId } } : undefined,
    ),
  velocity: (projectId: string, range: ReportRange, from?: string, to?: string) =>
    http.get<VelocityReport>(
      `/tracking/projects/${enc(projectId)}/reports/velocity`,
      rq(range, from, to),
    ),
  cycleTime: (projectId: string, range: ReportRange, from?: string, to?: string) =>
    http.get<CycleTimeReport>(
      `/tracking/projects/${enc(projectId)}/reports/cycle-time`,
      rq(range, from, to),
    ),
  throughput: (projectId: string, range: ReportRange, from?: string, to?: string) =>
    http.get<ThroughputReport>(`/tracking/projects/${enc(projectId)}/reports/throughput`, rq(range, from, to)),
  progress: (projectId: string) => http.get<ProgressRow[]>(`/tracking/projects/${enc(projectId)}/reports/progress`),
  /** Board 33 (W1, requested addition): open work per person in a sprint, points or hours (minutes). */
  workload: (projectId: string, q: { sprintId?: string | null; unit: "points" | "hours"; person?: string | null }) =>
    http.get<WorkloadReport>(`/tracking/projects/${enc(projectId)}/reports/workload`, {
      filter: { sprint: q.sprintId ?? undefined, unit: q.unit, person: q.person ?? undefined },
    }),
};

export type NotificationTab = "all" | "mentions" | "assigned";

export const notifications = {
  list: (tab: NotificationTab, workspaceId?: string, query?: ListQuery) =>
    http.get<NotificationPage>("/notifications", { ...query, filter: { tab, workspace: workspaceId } }),
  unreadCount: (workspaceId?: string) => http.get<UnreadCount>("/notifications/unread-count", { filter: { workspace: workspaceId } }),
  setRead: (id: string, read: boolean) => http.post<Notification>(`/notifications/${enc(id)}/read`, { read }),
  readAll: (ids?: string[]) => http.post<ReadAllResult>("/notifications/read-all", { ids }),
  unreadAgain: (ids: string[]) => http.post<ReadAllResult>("/notifications/read-all", { ids, unread: true }),
  preferences: () => http.get<NotificationPreferences>("/notification-preferences"),
  savePreferences: (prefs: NotificationPreferencesInput) => http.put<NotificationPreferences>("/notification-preferences", prefs),
};

export const search = {
  query: (slug: string, q: string, types?: SearchType[], limit?: number, signal?: AbortSignal) =>
    http.get<SearchResult[]>(`/workspaces/${enc(slug)}/search`, { q, limit, filter: { type: types } }, { signal }),
  recents: () => http.get<RecentItem[]>("/tracking/me/recents"),
};

export const audit = {
  /** filter[actor] (repeatable user ids), filter[action] (kind), filter[entity], filter[since] (ISO). */
  list: (slug: string, query?: ListQuery) => http.get<AuditPage>(`/workspaces/${enc(slug)}/audit`, query),
};

/** Saved filter views + per-user sidebar pins (board 30). Requested API addition. */
export const views = {
  list: (slug: string) => http.get<SavedView[]>(`/tracking/workspaces/${enc(slug)}/views`),
  create: (slug: string, body: SavedViewInput) => http.post<SavedView>(`/tracking/workspaces/${enc(slug)}/views`, body),
  update: (id: string, body: SavedViewPatch) =>
    http.patch<SavedView>(`/tracking/views/${enc(id)}`, body),
  remove: (id: string) => http.del(`/tracking/views/${enc(id)}`),
  /** Sets the current user's pin order (ids of pinned views, top to bottom). */
  reorder: (slug: string, ids: string[]) => http.put<SavedView[]>(`/tracking/workspaces/${enc(slug)}/views/order`, { ids }),
};

/**
 * Platform Stage 2: the server returns trash kinds namespaced ("tracking.task", "core.comment"), in lists and in the
 * restore / purge echo. The UI works on the bare kind; requests send it bare, which the server still accepts.
 */
export const bareTrashKind = (kind: string): TrashKind => (kind.includes(".") ? kind.slice(kind.lastIndexOf(".") + 1) : kind) as TrashKind;

const bareTrashRef = (r: WS["TrashRef"]): TrashRef => ({ ...r, kind: bareTrashKind(r.kind) });

/** The wire list (namespaced kinds) → the client's `TrashList` (bare kinds: the `TrashKind` extension). */
export function normalizeTrashList(list: WS["TrashList"]): TrashList {
  return {
    ...list,
    kinds: list.kinds.map(bareTrashKind),
    data: list.data.map((it) => ({
      ...it,
      kind: bareTrashKind(it.kind),
      module: it.module || (it.kind.includes(".") ? it.kind.split(".")[0]! : ""),
      project: (it.project ?? null) as TrashList["data"][number]["project"],
    })),
  };
}

/** Workspace trash (board 29): soft-deleted tasks, comments and projects, kept 30 days. */
export const trash = {
  list: (slug: string) => http.get<WS["TrashList"]>(`/workspaces/${enc(slug)}/trash`).then(normalizeTrashList),
  restore: (slug: string, items: TrashRef[]) =>
    http.post<WS["TrashRestored"]>(`/workspaces/${enc(slug)}/trash/restore`, { items }).then((r) => ({ restored: r.restored.map(bareTrashRef) })),
  purge: (slug: string, items: TrashRef[]) =>
    http.post<WS["TrashPurged"]>(`/workspaces/${enc(slug)}/trash/purge`, { items }).then((r) => ({ purged: r.purged.map(bareTrashRef) })),
};

/* ───────── Board 39 (v2): custom fields, dependencies, time tracking. Requested API additions. ───────── */

export const customFields = {
  list: (projectId: string) => http.get<CustomField[]>(`/tracking/projects/${enc(projectId)}/custom-fields`),
  create: (projectId: string, body: CustomFieldInput) => http.post<CustomField>(`/tracking/projects/${enc(projectId)}/custom-fields`, body),
  update: (id: string, body: CustomFieldPatch) => http.patch<CustomField>(`/tracking/custom-fields/${enc(id)}`, body),
  remove: (id: string) => http.del(`/tracking/custom-fields/${enc(id)}`),
  reorder: (projectId: string, ids: string[]) => http.put<CustomField[]>(`/tracking/projects/${enc(projectId)}/custom-fields/order`, { ids }),
};

export const dependencies = {
  list: (taskId: string) => http.get<TaskDependencies>(`/tracking/tasks/${enc(taskId)}/dependencies`),
  add: (taskId: string, relation: DependencyRelation, otherTaskId: string) =>
    http.post<TaskDependencies>(`/tracking/tasks/${enc(taskId)}/dependencies`, { relation, taskId: otherTaskId }),
  remove: (taskId: string, dependencyId: string) => http.del(`/tracking/tasks/${enc(taskId)}/dependencies/${enc(dependencyId)}`),
};

export const time = {
  entries: (taskId: string) => http.get<TimeEntry[]>(`/tracking/tasks/${enc(taskId)}/time-entries`),
  log: (taskId: string, body: TimeEntryInput) => http.post<TimeEntry>(`/tracking/tasks/${enc(taskId)}/time-entries`, body),
  remove: (entryId: string) => http.del(`/tracking/time-entries/${enc(entryId)}`),
  timer: () => http.get<TimerState>("/tracking/me/timer"),
  startTimer: (taskId: string, date: string) => http.post<TimerStart>(`/tracking/tasks/${enc(taskId)}/timer`, { date }),
  stopTimer: (date: string, note?: string) => http.post<TimerStop>("/tracking/me/timer/stop", { date, note }),
  timesheet: (slug: string, week: string, projectId?: string) =>
    http.get<Timesheet>(`/tracking/workspaces/${enc(slug)}/timesheet`, { filter: { week, project: projectId } }),
};

/* ───────── Board 40 (v2): import wizard. Requested API additions (docs/v2/40-import-wizard.md §4). ───────── */

export const imports = {
  /** I9: newest first, max 20, drafts excluded. */
  list: (projectId: string) => http.get<ImportJobSummary[]>(`/tracking/projects/${enc(projectId)}/imports`),
  /** I1: creates a draft job and returns a signed upload ticket for the CSV. */
  create: (projectId: string, body: ImportCreate) =>
    http.post<ImportCreated>(`/tracking/projects/${enc(projectId)}/imports`, body),
  /** I3: the job (polled every 1 s while queued / running). */
  get: (id: string) => http.get<ImportJob>(`/tracking/imports/${enc(id)}`),
  /** I2: parses the uploaded file and suggests a mapping (draft → ready). */
  analyze: (id: string) => http.post<ImportJob>(`/tracking/imports/${enc(id)}/analyze`),
  /** I4: the whole mapping, with `revision` incremented per PUT. */
  saveMapping: (id: string, mapping: ImportMapping) => http.put<ImportJob>(`/tracking/imports/${enc(id)}/mapping`, mapping),
  /** I5: dry run before start, actual outcomes after. filter[outcome], limit, cursor. */
  rows: (id: string, query?: ListQuery) => http.get<Paginated<ImportRowPreview>>(`/tracking/imports/${enc(id)}/rows`, query),
  /** I6: 202, queued (also the retry of a failed job). */
  start: (id: string) => http.post<ImportJob>(`/tracking/imports/${enc(id)}/start`),
  /** I7: cancels a draft / ready / queued / failed job; a running job stops after its batch. */
  cancel: (id: string) => http.post<ImportJob>(`/tracking/imports/${enc(id)}/cancel`),
  /** I8: a short-lived download URL for the CSV error report. */
  errorReport: (id: string) => http.get<ImportErrorReport>(`/tracking/imports/${enc(id)}/error-report`),
};

/* ───────── Board 33 (v2): dashboards, presence, realtime. Requested API additions (docs/v2/33-dashboards-presence.md §5). ───────── */

export const dashboards = {
  /** DB1: shared (A–Z), then the caller's personal ones (A–Z). */
  list: (projectId: string) => http.get<DashboardSummary[]>(`/tracking/projects/${enc(projectId)}/dashboards`),
  /** DB2: 201 Dashboard (version 1). */
  create: (projectId: string, body: DashboardCreate) =>
    http.post<Dashboard>(`/tracking/projects/${enc(projectId)}/dashboards`, body),
  /** DB3 */
  get: (id: string) => http.get<Dashboard>(`/tracking/dashboards/${enc(id)}`),
  /** DB4: rename / visibility; `version` required (409 version_conflict with details.current). */
  update: (id: string, body: DashboardPatch) =>
    http.patch<Dashboard>(`/tracking/dashboards/${enc(id)}`, body),
  /** DB5: the complete ordered widget list (items without id are created, missing ones deleted). */
  saveLayout: (id: string, version: number, widgets: DashboardWidgetInput[]) =>
    http.put<Dashboard>(`/tracking/dashboards/${enc(id)}/layout`, { version, widgets }),
  /** DB6 */
  remove: (id: string) => http.del(`/tracking/dashboards/${enc(id)}`),
};

export const presence = {
  /** P1: heartbeat (every 20 s while visible) and location / field / typing changes; returns the project roster. */
  put: (slug: string, sessionId: string, body: PresenceUpdate) =>
    http.put<PresenceHeartbeat>(`/workspaces/${enc(slug)}/presence/${enc(sessionId)}`, body),
  /** P2: idempotent; `keepalive` on pagehide. */
  leave: (slug: string, sessionId: string, opts?: { keepalive?: boolean }) =>
    http.del(`/workspaces/${enc(slug)}/presence/${enc(sessionId)}`, undefined, opts),
  /** P3 */
  roster: (slug: string, projectId: string) =>
    http.get<PresenceRoster>(`/workspaces/${enc(slug)}/presence`, { filter: { project: projectId } }),
};

/* ───────── Board 37 (v2): integrations & development. Requested API additions (docs/v2/37-integrations-github-gitlab.md §5). ───────── */

export type { GitLabConnectBody };

export const integrations = {
  /** G1: providers (both, GitHub first) and the workspace's connections. Every member. */
  overview: (slug: string) => http.get<IntegrationsOverview>(`/tracking/workspaces/${enc(slug)}/integrations`),
  /** G2: 200 `{ authorizeUrl }` (GitHub App install page; the client navigates there). */
  connectGitHub: (slug: string) => http.post<AuthorizeUrl>(`/tracking/workspaces/${enc(slug)}/integrations/github/connect`, {}),
  /** G3: OAuth → 200 `{ authorizeUrl }`; token → 201 `Integration` (synchronous checks, 422 per field, 409 integration_exists). */
  connectGitLab: (slug: string, body: GitLabConnectBody) =>
    http.post<AuthorizeUrl | Integration>(`/tracking/workspaces/${enc(slug)}/integrations/gitlab/connect`, body),
  /** G6: the `#connect=<attempt>.<token>` fragment, sent back by the signed-in admin. Any mismatch → 404. */
  confirm: (slug: string, body: ConfirmConnect) => http.post<Integration>(`/tracking/workspaces/${enc(slug)}/integrations/confirm`, body),
  /** G7 */
  get: (id: string) => http.get<Integration>(`/tracking/integrations/${enc(id)}`),
  /** G8: live from the provider (cached 60 s), `q` filters by full path. 409 integration_error, 502 provider_failed. */
  availableRepositories: (id: string, q?: string) =>
    http.get<AvailableRepository[]>(`/tracking/integrations/${enc(id)}/available-repositories`, q ? { q } : undefined),
  /** G9: the complete tracked set (1–200). `projectIds` omitted or [] = all projects. */
  setRepositories: (id: string, repositories: TrackedRepositoryInput[]) =>
    http.put<Integration>(`/tracking/integrations/${enc(id)}/repositories`, { repositories }),
  /** G10: [] = all projects. */
  scopeRepository: (repoId: string, projectIds: string[]) => http.patch<Repository>(`/tracking/repositories/${enc(repoId)}`, { projectIds }),
  /** G11: 202 with `syncing: true`; 429 sync_throttled (details.nextSyncAt) within 2 minutes; 409 integration_error. */
  sync: (id: string) => http.post<Integration>(`/tracking/integrations/${enc(id)}/sync`, {}),
  /** G12: `{ authorizeUrl }` (GitHub / GitLab OAuth) or `Integration` (GitLab token, body `{ token }`). */
  reconnect: (id: string, body: WS["ReconnectInRequest"] = {}) => http.post<AuthorizeUrl | Integration>(`/tracking/integrations/${enc(id)}/reconnect`, body),
  /** G13: 204; linked PRs stay on tasks. */
  disconnect: (id: string) => http.del(`/tracking/integrations/${enc(id)}`),
};

export const development = {
  /** D1: a task's linked branches, commits and PRs/MRs (`:id` = task id or key). Never calls the provider. */
  get: (taskId: string) => http.get<TaskDevelopment>(`/tracking/tasks/${enc(taskId)}/development`),
  /** D2: link by URL (PR/MR, commit or branch). 201 (200 when already linked). */
  link: (taskId: string, url: string) => http.post<DevItem>(`/tracking/tasks/${enc(taskId)}/development/links`, { url }),
  /** D3: manual → deleted; auto / created → suppressed. 204. */
  unlink: (taskId: string, linkId: string) => http.del(`/tracking/tasks/${enc(taskId)}/development/links/${enc(linkId)}`),
  /** D4: from the repository's default branch. 409 branch_exists. */
  createBranch: (taskId: string, body: WS["DevBranchInRequest"]) => http.post<DevBranch>(`/tracking/tasks/${enc(taskId)}/development/branches`, body),
  /** A1: always all three triggers, in order. */
  rules: (projectId: string) => http.get<DevAutomationRule[]>(`/tracking/projects/${enc(projectId)}/dev-automation`),
  /** A2: `tracking.status.manage`; an enabled rule needs a status of this project, pr_merged a done-category one. */
  setRules: (projectId: string, rules: DevAutomationRule[]) => http.put<DevAutomationRule[]>(`/tracking/projects/${enc(projectId)}/dev-automation`, rules),
};

/** Board 38 (v2): personal notification channels (docs/v2/38-telegram-sms-push.md §5). Any signed-in user. */
export const channels = {
  /** C1: every channel's availability and connection state. */
  get: () => http.get<NotificationChannels>("/me/notification-channels"),
  /** C2: a 6-character code + deep link (10 min). 409 already_connected while an active connection exists. */
  startTelegram: (timezone?: string) => http.post<TelegramLink>("/me/notification-channels/telegram/link", { timezone }),
  /** C3: polled every 2 s while the dialog is open. */
  telegramLink: (id: string) => http.get<TelegramLink>(`/me/notification-channels/telegram/link/${enc(id)}`),
  /** C4: the dialog closed before linking. */
  cancelTelegram: (id: string) => http.del(`/me/notification-channels/telegram/link/${enc(id)}`),
  /** C5 */
  disconnectTelegram: () => http.del("/me/notification-channels/telegram"),
  /** C6: sends a code. 422 field errors, 429 throttled (`details.reason`, `retryAt`), 502 channel_send_failed. */
  startSms: (body: SmsVerificationInput) =>
    http.post<SmsVerification>("/me/notification-channels/sms/verifications", body),
  /** C7: a new code; tries reset. 429 resend_cooldown before `resendAt`. */
  resendSms: (id: string) => http.post<SmsVerification>(`/me/notification-channels/sms/verifications/${enc(id)}/resend`),
  /** C8: 422 invalid_code / too_many_attempts, 410 code_expired. */
  verifySms: (id: string, code: string) =>
    http.post<SmsVerifyResult>(`/me/notification-channels/sms/verifications/${enc(id)}/verify`, { code }),
  /** C9 */
  removeSms: () => http.del("/me/notification-channels/sms"),
  /** C10: public, for clients that need the key before C1 (logout clean-up). */
  vapidKey: () => http.get<VapidKey>("/push/vapid-public-key", undefined, { anonymous: true }),
  /** C11: subscribe (upsert, moves the endpoint to the caller) or refresh (404 when not the caller's). */
  savePush: (body: PushSubscriptionInput) => http.put<PushDevice>("/me/push-subscriptions", body),
  /** C12: this browser (Turn off, logout). Idempotent. */
  removePushByEndpoint: (endpoint: string) => http.post<void>("/me/push-subscriptions/remove", { endpoint }),
  /** C13: a device from the list. */
  removePushDevice: (id: string) => http.del(`/me/push-subscriptions/${enc(id)}`),
  /** C14: synchronous test; ignores quiet hours. `workspace` (a slug) is a query parameter, as in the schema. */
  test: (channel: TestableChannel, body: WS["ChannelTestInRequest"] = {}, workspace?: string) =>
    http.post<ChannelTestResult>(`/me/notification-channels/${channel}/test`, body, workspace ? { query: { workspace } } : undefined),
};

/** Platform Stage 3 (docs/platform/stage3-contract.md §3): the workspace's modules. */
export const modules = {
  /** Every module, core included. Any member may read it; not paginated. */
  list: (slug: string) => http.get<WorkspaceModule[]>(`/workspaces/${enc(slug)}/modules`),
  /** Needs `core.modules.manage`. 400 `module_not_toggleable` / `module_dependency` (`details.modules`), 404 unknown key. */
  set: (slug: string, key: string, enabled: boolean) => http.put<WorkspaceModule>(`/workspaces/${enc(slug)}/modules/${enc(key)}`, { enabled }),
};

/**
 * Platform Stage 4 (docs/platform/stage4-contract.md §1): teams. Reads are open to workspace members; writes need
 * `core.teams.manage`. A team from another workspace is a 404. Not paginated.
 */
export const teams = {
  list: (slug: string) => http.get<Team[]>(`/workspaces/${enc(slug)}/teams`),
  /** 409 `team_name_taken` (case-insensitive, per workspace). */
  create: (slug: string, body: WS["TeamInRequest"]) => http.post<TeamDetail>(`/workspaces/${enc(slug)}/teams`, body),
  get: (id: string) => http.get<TeamDetail>(`/teams/${enc(id)}`),
  /** 409 `team_name_taken`. */
  update: (id: string, body: WS["PatchedTeamUpdateInRequest"]) => http.patch<TeamDetail>(`/teams/${enc(id)}`, body),
  remove: (id: string) => http.del(`/teams/${enc(id)}`),
  members: (id: string) => http.get<TeamMember[]>(`/teams/${enc(id)}/members`),
  /** 400 `not_a_workspace_member`, 409 `already_a_member`. */
  addMember: (id: string, body: WS["TeamMemberInRequest"]) => http.post<TeamMember>(`/teams/${enc(id)}/members`, body),
  updateMember: (id: string, userId: string, body: { isLead: boolean }) =>
    http.patch<TeamMember>(`/teams/${enc(id)}/members/${enc(userId)}`, body),
  removeMember: (id: string, userId: string) => http.del(`/teams/${enc(id)}/members/${enc(userId)}`),
};

/** Platform Stage 3: the sales module's placeholder endpoint (behind the module guard). */
export const sales = {
  health: (slug: string) => http.get<SalesHealth>(`/sales/workspaces/${enc(slug)}/health`),
};

/** S1. The stream is not a JSON request: src/platform/realtime opens it. The path is kept here for the paper trail. */
export const realtime = { streamPath: (slug: string) => `/workspaces/${enc(slug)}/stream` };

export const api = {
  modules,
  teams,
  sales,
  channels,
  integrations,
  development,
  dashboards,
  presence,
  realtime,
  imports,
  customFields,
  dependencies,
  time,
  trash,
  auth,
  workspaces,
  roles,
  projects,
  planning,
  tasks,
  board,
  backlog,
  comments,
  attachments,
  reports,
  notifications,
  search,
  audit,
  views,
};
