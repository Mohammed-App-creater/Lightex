import { enc, http } from "./client";
import type { ListQuery } from "./transport";
import type {
  AccessRequest,
  ActivityEntry,
  Attachment,
  AuditEntry,
  BurndownPoint,
  Comment,
  CycleBin,
  Epic,
  Invite,
  Label,
  Milestone,
  Notification,
  NotificationPreferences,
  Objective,
  Paginated,
  PermissionInfo,
  Project,
  ProjectAccessInfo,
  ProjectMember,
  ProjectSummary,
  ProgressRow,
  RichDoc,
  Role,
  SearchResult,
  Sprint,
  Status,
  Task,
  TaskCreate,
  TaskDetail,
  TaskMove,
  TaskPatch,
  ThroughputPoint,
  UploadTicket,
  User,
  VelocityPoint,
  Workspace,
  WorkspaceMember,
} from "./types";

/*
 * Every backend endpoint, grouped as in docs/api-contract.md. Screens import `api` only;
 * nothing else in the app knows a URL. Swapping to the real backend = HttpTransport.
 */

type AuthResult = { accessToken: string; user: User };

export const auth = {
  login: (email: string, password: string) => http.post<AuthResult>("/auth/login", { email, password }, { anonymous: true }),
  register: (body: { name: string; email: string; password: string }) =>
    http.post<AuthResult>("/auth/register", body, { anonymous: true }),
  refresh: () => http.post<{ accessToken: string }>("/auth/refresh", undefined, { anonymous: true }),
  logout: () => http.post<void>("/auth/logout", undefined, { anonymous: true }),
  forgotPassword: (email: string) => http.post<void>("/auth/forgot-password", { email }, { anonymous: true }),
  resetPassword: (token: string, password: string) =>
    http.post<void>("/auth/reset-password", { token, password }, { anonymous: true }),
  me: () => http.get<User>("/auth/me"),
  updateMe: (body: { name?: string; avatarUrl?: string | null }) => http.patch<User>("/auth/me", body),
  changePassword: (currentPassword: string, newPassword: string) =>
    http.put<void>("/auth/me/password", { currentPassword, newPassword }),
  invite: (token: string) => http.get<Invite>(`/invites/${enc(token)}`, undefined, { anonymous: true }),
  acceptInvite: (token: string, body: { name?: string; password?: string }) =>
    http.post<AuthResult & { workspaceSlug: string }>(`/invites/${enc(token)}/accept`, body, { anonymous: true }),
};

export const workspaces = {
  list: () => http.get<Workspace[]>("/workspaces"),
  create: (body: { name: string; slug: string }) => http.post<Workspace>("/workspaces", body),
  get: (slug: string) => http.get<Workspace>(`/workspaces/${enc(slug)}`),
  update: (slug: string, body: { name?: string; slug?: string }) => http.patch<Workspace>(`/workspaces/${enc(slug)}`, body),
  remove: (slug: string, confirm: string) => http.del(`/workspaces/${enc(slug)}`, { confirm }),
  slugAvailability: (slug: string, q: string) =>
    http.get<{ slug: string; available: boolean }>(`/workspaces/${enc(slug)}/slug-availability`, { q }),
  members: (slug: string, query?: ListQuery) => http.get<Paginated<WorkspaceMember>>(`/workspaces/${enc(slug)}/members`, query),
  updateMember: (slug: string, userId: string, roleId: string) =>
    http.patch<WorkspaceMember>(`/workspaces/${enc(slug)}/members/${enc(userId)}`, { roleId }),
  removeMember: (slug: string, userId: string) => http.del(`/workspaces/${enc(slug)}/members/${enc(userId)}`),
  invites: (slug: string) => http.get<Invite[]>(`/workspaces/${enc(slug)}/invites`),
  invite: (slug: string, emails: string[], roleId: string) =>
    http.post<Invite[]>(`/workspaces/${enc(slug)}/invites`, { emails, roleId }),
  revokeInvite: (slug: string, id: string) => http.del(`/workspaces/${enc(slug)}/invites/${enc(id)}`),
  resendInvite: (slug: string, id: string) => http.post<Invite>(`/workspaces/${enc(slug)}/invites/${enc(id)}/resend`),
  activity: (slug: string, query?: ListQuery) => http.get<Paginated<ActivityEntry>>(`/workspaces/${enc(slug)}/activity`, query),
  myTasks: (slug: string) => http.get<Paginated<Task>>(`/workspaces/${enc(slug)}/tasks`, { filter: { assignee: "me" }, limit: 200 }),
  /** Tasks across visible projects assigned to a user ("me" or a user id). */
  assignedTasks: (slug: string, assignee: string) =>
    http.get<Paginated<Task>>(`/workspaces/${enc(slug)}/tasks`, { filter: { assignee }, limit: 200 }),
  projectDirectory: (slug: string) =>
    http.get<(ProjectAccessInfo & { isMember: boolean; status: Project["status"] })[]>(`/workspaces/${enc(slug)}/project-directory`),
};

export const roles = {
  list: (slug: string, scope?: "workspace" | "project") =>
    http.get<Role[]>(`/workspaces/${enc(slug)}/roles`, scope ? { filter: { scope } } : undefined),
  create: (slug: string, body: Pick<Role, "name" | "description" | "scope" | "permissions">) =>
    http.post<Role>(`/workspaces/${enc(slug)}/roles`, body),
  update: (id: string, body: Partial<Pick<Role, "name" | "description" | "permissions">>) =>
    http.patch<Role>(`/roles/${enc(id)}`, body),
  remove: (id: string, reassignTo?: string) => http.del(`/roles/${enc(id)}`, reassignTo ? { reassignTo } : undefined),
  catalogue: () => http.get<PermissionInfo[]>("/permissions"),
};

export const projects = {
  list: (slug: string, query?: ListQuery) => http.get<Project[]>(`/workspaces/${enc(slug)}/projects`, query),
  get: (slug: string, key: string) => http.get<Project>(`/workspaces/${enc(slug)}/projects/${enc(key)}`),
  create: (slug: string, body: { name: string; key: string; description?: string; template?: Project["template"] }) =>
    http.post<Project>(`/workspaces/${enc(slug)}/projects`, body),
  update: (id: string, body: Partial<Pick<Project, "name" | "description" | "key">>) => http.patch<Project>(`/projects/${enc(id)}`, body),
  archive: (id: string) => http.post<Project>(`/projects/${enc(id)}/archive`),
  unarchive: (id: string) => http.post<Project>(`/projects/${enc(id)}/unarchive`),
  remove: (id: string, confirm: string) => http.del(`/projects/${enc(id)}`, { confirm }),
  members: (id: string) => http.get<ProjectMember[]>(`/projects/${enc(id)}/members`),
  addMember: (id: string, userId: string, roleId: string) => http.post<ProjectMember>(`/projects/${enc(id)}/members`, { userId, roleId }),
  updateMember: (id: string, userId: string, roleId: string) =>
    http.patch<ProjectMember>(`/projects/${enc(id)}/members/${enc(userId)}`, { roleId }),
  removeMember: (id: string, userId: string) => http.del(`/projects/${enc(id)}/members/${enc(userId)}`),
  requestAccess: (id: string, message?: string) => http.post<AccessRequest>(`/projects/${enc(id)}/access-requests`, { message }),
  withdrawAccessRequest: (id: string) => http.del(`/projects/${enc(id)}/access-requests/mine`),
  accessRequests: (id: string) => http.get<(AccessRequest & { user: User })[]>(`/projects/${enc(id)}/access-requests`),
  statuses: (id: string) => http.get<Status[]>(`/projects/${enc(id)}/statuses`),
  createStatus: (id: string, body: { name: string; category: Status["category"] }) => http.post<Status>(`/projects/${enc(id)}/statuses`, body),
  updateStatus: (id: string, statusId: string, body: { name?: string; position?: number }) =>
    http.patch<Status>(`/projects/${enc(id)}/statuses/${enc(statusId)}`, body),
  removeStatus: (id: string, statusId: string) => http.del(`/projects/${enc(id)}/statuses/${enc(statusId)}`),
  labels: (id: string) => http.get<Label[]>(`/projects/${enc(id)}/labels`),
  createLabel: (id: string, name: string, color?: string) => http.post<Label>(`/projects/${enc(id)}/labels`, { name, color }),
  activity: (id: string, query?: ListQuery) => http.get<Paginated<ActivityEntry>>(`/projects/${enc(id)}/activity`, query),
  summary: (id: string) => http.get<ProjectSummary>(`/projects/${enc(id)}/summary`),
};

export const planning = {
  objectives: (projectId: string) => http.get<Objective[]>(`/projects/${enc(projectId)}/objectives`),
  createObjective: (projectId: string, body: Partial<Objective>) => http.post<Objective>(`/projects/${enc(projectId)}/objectives`, body),
  updateObjective: (id: string, body: Partial<Objective>) => http.patch<Objective>(`/objectives/${enc(id)}`, body),
  removeObjective: (id: string) => http.del(`/objectives/${enc(id)}`),
  linkTasks: (id: string, taskIds: string[]) => http.post<Objective>(`/objectives/${enc(id)}/tasks`, { taskIds }),
  unlinkTask: (id: string, taskId: string) => http.del<Objective>(`/objectives/${enc(id)}/tasks/${enc(taskId)}`),
  milestones: (projectId: string) => http.get<Milestone[]>(`/projects/${enc(projectId)}/milestones`),
  createMilestone: (projectId: string, body: Partial<Milestone> & { taskIds?: string[] }) =>
    http.post<Milestone>(`/projects/${enc(projectId)}/milestones`, body),
  updateMilestone: (id: string, body: Partial<Milestone> & { taskIds?: string[]; completed?: boolean }) =>
    http.patch<Milestone>(`/milestones/${enc(id)}`, body),
  removeMilestone: (id: string) => http.del(`/milestones/${enc(id)}`),
  epics: (projectId: string) => http.get<Epic[]>(`/projects/${enc(projectId)}/epics`),
  createEpic: (projectId: string, body: { name: string; description?: string }) => http.post<Epic>(`/projects/${enc(projectId)}/epics`, body),
  updateEpic: (id: string, body: { name?: string; description?: string }) => http.patch<Epic>(`/epics/${enc(id)}`, body),
  removeEpic: (id: string) => http.del(`/epics/${enc(id)}`),
  sprints: (projectId: string) => http.get<Sprint[]>(`/projects/${enc(projectId)}/sprints`),
  createSprint: (projectId: string, body: Partial<Sprint> = {}) => http.post<Sprint>(`/projects/${enc(projectId)}/sprints`, body),
  updateSprint: (id: string, body: Partial<Sprint>) => http.patch<Sprint>(`/sprints/${enc(id)}`, body),
  removeSprint: (id: string) => http.del(`/sprints/${enc(id)}`),
  startSprint: (id: string, body: Partial<Pick<Sprint, "startDate" | "endDate" | "goal">> = {}) =>
    http.post<Sprint>(`/sprints/${enc(id)}/start`, body),
  completeSprint: (id: string, moveOpenTasksTo: string) => http.post<Sprint>(`/sprints/${enc(id)}/complete`, { moveOpenTasksTo }),
  activeSprint: (projectId: string) => http.get<Sprint | null>(`/projects/${enc(projectId)}/active-sprint`),
};

export const tasks = {
  list: (projectId: string, query?: ListQuery) => http.get<Paginated<Task>>(`/projects/${enc(projectId)}/tasks`, query),
  create: (projectId: string, body: TaskCreate) => http.post<Task>(`/projects/${enc(projectId)}/tasks`, body),
  get: (slug: string, key: string) => http.get<TaskDetail>(`/workspaces/${enc(slug)}/tasks/${enc(key)}`),
  update: (id: string, patch: TaskPatch, version?: number) => http.patch<Task>(`/tasks/${enc(id)}`, { ...patch, version }),
  remove: (id: string) => http.del(`/tasks/${enc(id)}`),
  restore: (id: string) => http.post<Task>(`/tasks/${enc(id)}/restore`),
  bulk: (projectId: string, body: { ids: string[]; patch?: TaskPatch; delete?: boolean; restore?: boolean }) =>
    http.post<Task[]>(`/projects/${enc(projectId)}/tasks/bulk`, body),
  activity: (id: string) => http.get<ActivityEntry[]>(`/tasks/${enc(id)}/activity`),
};

export const board = {
  get: (projectId: string, sprint: string = "active") =>
    http.get<{ statuses: Status[]; tasks: Task[]; sprintId: string | null }>(`/projects/${enc(projectId)}/board`, { filter: { sprint } }),
  move: (taskId: string, body: TaskMove) => http.post<Task>(`/tasks/${enc(taskId)}/move`, body),
};

export const backlog = {
  get: (projectId: string) =>
    http.get<{ sprints: { sprintId: string; tasks: Task[] }[]; backlog: Task[] }>(`/projects/${enc(projectId)}/backlog`),
};

export const comments = {
  list: (taskId: string) => http.get<Comment[]>(`/tasks/${enc(taskId)}/comments`),
  create: (taskId: string, body: RichDoc) => http.post<Comment>(`/tasks/${enc(taskId)}/comments`, { body }),
  update: (id: string, body: RichDoc) => http.patch<Comment>(`/comments/${enc(id)}`, { body }),
  remove: (id: string) => http.del(`/comments/${enc(id)}`),
};

export const attachments = {
  list: (taskId: string) => http.get<Attachment[]>(`/tasks/${enc(taskId)}/attachments`),
  uploadUrl: (taskId: string, file: { fileName: string; size: number; mimeType: string }) =>
    http.post<UploadTicket>(`/tasks/${enc(taskId)}/attachments/upload-url`, file),
  confirm: (taskId: string, uploadId: string) => http.post<Attachment>(`/tasks/${enc(taskId)}/attachments`, { uploadId }),
  remove: (id: string) => http.del(`/attachments/${enc(id)}`),
};

export type ReportRange = "last2" | "last6" | "last90" | "custom";
export type ReportKpis = {
  sprint: { name: string; number: number; startDate: string; endDate: string; dayIndex: number; lengthDays: number } | null;
  completedThisSprint: number;
  plannedThisSprint: number;
  avgCycleTimeDays: number;
  p85CycleTimeDays: number;
  overdueCount: number;
  oldestOverdueKey: string | null;
  scopeChangePts: number;
  completedSprints: number;
};

const rq = (range: ReportRange, from?: string, to?: string): ListQuery => ({ filter: { range, from, to } });

export const reports = {
  kpis: (projectId: string) => http.get<ReportKpis>(`/projects/${enc(projectId)}/reports/kpis`),
  burndown: (projectId: string, sprintId?: string) =>
    http.get<{ sprint: { id: string; name: string; startDate: string; endDate: string } | null; points: BurndownPoint[] }>(
      `/projects/${enc(projectId)}/reports/burndown`,
      sprintId ? { filter: { sprint: sprintId } } : undefined,
    ),
  velocity: (projectId: string, range: ReportRange, from?: string, to?: string) =>
    http.get<{ points: VelocityPoint[]; insufficient: boolean; completedSprints: number }>(
      `/projects/${enc(projectId)}/reports/velocity`,
      rq(range, from, to),
    ),
  cycleTime: (projectId: string, range: ReportRange, from?: string, to?: string) =>
    http.get<{ bins: CycleBin[]; total: number; medianDays: number; insufficient: boolean }>(
      `/projects/${enc(projectId)}/reports/cycle-time`,
      rq(range, from, to),
    ),
  throughput: (projectId: string, range: ReportRange, from?: string, to?: string) =>
    http.get<{ points: ThroughputPoint[]; insufficient: boolean }>(`/projects/${enc(projectId)}/reports/throughput`, rq(range, from, to)),
  progress: (projectId: string) => http.get<ProgressRow[]>(`/projects/${enc(projectId)}/reports/progress`),
};

export type NotificationTab = "all" | "mentions" | "assigned";

export const notifications = {
  list: (tab: NotificationTab, workspaceId?: string, query?: ListQuery) =>
    http.get<Paginated<Notification> & { counts: { all: number; mentions: number; assigned: number; unread: number } }>(
      "/notifications",
      { ...query, filter: { tab, workspace: workspaceId } },
    ),
  unreadCount: (workspaceId?: string) => http.get<{ count: number }>("/notifications/unread-count", { filter: { workspace: workspaceId } }),
  setRead: (id: string, read: boolean) => http.post<Notification>(`/notifications/${enc(id)}/read`, { read }),
  readAll: (ids?: string[]) => http.post<{ ids: string[] }>("/notifications/read-all", { ids }),
  unreadAgain: (ids: string[]) => http.post<{ ids: string[] }>("/notifications/read-all", { ids, unread: true }),
  preferences: () => http.get<NotificationPreferences>("/notification-preferences"),
  savePreferences: (prefs: NotificationPreferences) => http.put<NotificationPreferences>("/notification-preferences", prefs),
};

export const search = {
  query: (slug: string, q: string, types?: ("task" | "project" | "user")[], limit?: number, signal?: AbortSignal) =>
    http.get<SearchResult[]>(`/workspaces/${enc(slug)}/search`, { q, limit, filter: { type: types } }, { signal }),
  recents: () => http.get<{ kind: "task" | "project"; id: string; at: string }[]>("/me/recents"),
};

export const audit = {
  list: (slug: string, query?: ListQuery) => http.get<Paginated<AuditEntry>>(`/workspaces/${enc(slug)}/audit`, query),
};

export const api = {
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
};
