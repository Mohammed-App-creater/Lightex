/** Query key factory. Every cache entry in the app is addressed through here. */
export const qk = {
  me: () => ["me"] as const,
  workspaces: () => ["workspaces"] as const,
  workspace: (slug: string) => ["workspace", slug] as const,
  wsMembers: (slug: string) => ["workspace", slug, "members"] as const,
  invites: (slug: string) => ["workspace", slug, "invites"] as const,
  roles: (slug: string) => ["workspace", slug, "roles"] as const,
  catalogue: () => ["permissions"] as const,
  wsActivity: (slug: string) => ["workspace", slug, "activity"] as const,
  myTasks: (slug: string) => ["workspace", slug, "my-tasks"] as const,
  wsAccessRequest: (slug: string) => ["workspace", slug, "access-request"] as const,
  audit: (slug: string) => ["workspace", slug, "audit"] as const,
  directory: (slug: string) => ["workspace", slug, "directory"] as const,
  /** Saved views + my pins (board 30). */
  views: (slug: string) => ["workspace", slug, "views"] as const,
  trash: (slug: string) => ["workspace", slug, "trash"] as const,
  search: (slug: string, q: string, types?: string) => ["workspace", slug, "search", q, types ?? "all"] as const,
  recents: () => ["recents"] as const,

  projects: (slug: string) => ["workspace", slug, "projects"] as const,
  project: (slug: string, key: string) => ["project", slug, key.toUpperCase()] as const,
  /** Everything scoped to one project id (for blanket invalidation). */
  scope: (projectId: string) => ["p", projectId] as const,
  statuses: (projectId: string) => ["p", projectId, "statuses"] as const,
  labels: (projectId: string) => ["p", projectId, "labels"] as const,
  members: (projectId: string) => ["p", projectId, "members"] as const,
  accessRequests: (projectId: string) => ["p", projectId, "access-requests"] as const,
  summary: (projectId: string) => ["p", projectId, "summary"] as const,
  activity: (projectId: string) => ["p", projectId, "activity"] as const,
  board: (projectId: string, sprint = "active") => ["p", projectId, "board", sprint] as const,
  backlog: (projectId: string) => ["p", projectId, "backlog"] as const,
  taskList: (projectId: string) => ["p", projectId, "tasks"] as const,
  objectives: (projectId: string) => ["p", projectId, "objectives"] as const,
  milestones: (projectId: string) => ["p", projectId, "milestones"] as const,
  epics: (projectId: string) => ["p", projectId, "epics"] as const,
  sprints: (projectId: string) => ["p", projectId, "sprints"] as const,
  reports: (projectId: string, kind: string, ...args: (string | undefined)[]) => ["p", projectId, "reports", kind, ...args] as const,

  task: (slug: string, key: string) => ["task", slug, key.toUpperCase()] as const,
  comments: (taskId: string) => ["t", taskId, "comments"] as const,
  attachments: (taskId: string) => ["t", taskId, "attachments"] as const,
  taskActivity: (taskId: string) => ["t", taskId, "activity"] as const,

  /* Board 39 (v2) */
  customFields: (projectId: string) => ["p", projectId, "custom-fields"] as const,
  dependencies: (taskId: string) => ["t", taskId, "dependencies"] as const,
  timeEntries: (taskId: string) => ["t", taskId, "time"] as const,
  myTimer: () => ["me", "timer"] as const,
  /** Prefix for every week/project of a workspace's timesheet. */
  timesheets: (slug: string) => ["workspace", slug, "timesheet"] as const,
  timesheet: (slug: string, week: string, projectId?: string) => ["workspace", slug, "timesheet", week, projectId ?? "all"] as const,

  /* Board 32 (v2). Under ["p", id] so qk.scope invalidation and patchTasks reach them. */
  /** Tasks overlapping a window (timeline / calendar). */
  schedule: (projectId: string, from: string, to: string) => ["p", projectId, "schedule", from, to] as const,
  /** Prefix of every schedule window of a project. */
  schedules: (projectId: string) => ["p", projectId, "schedule"] as const,
  unscheduled: (projectId: string) => ["p", projectId, "unscheduled"] as const,

  /* Board 40 (v2). The history sits under ["p", id] so qk.scope invalidation reaches it. */
  imports: (projectId: string) => ["p", projectId, "imports"] as const,
  importJob: (id: string) => ["import", id] as const,
  importRows: (id: string, outcome: string, revision: number) => ["import", id, "rows", outcome, revision] as const,

  /* Board 33 (v2). The list sits under ["p", id] so qk.scope invalidation reaches it. */
  dashboards: (projectId: string) => ["p", projectId, "dashboards"] as const,
  dashboard: (id: string) => ["dashboard", id] as const,
  /** Project presence roster; outside ["p", id] so qk.scope invalidation doesn't refetch it. */
  presence: (slug: string, projectId: string) => ["presence", slug, projectId] as const,
  /** My-tasks widget: the viewer's tasks in one project (under ["p", id], so task patches reach it). */
  myProjectTasks: (projectId: string) => ["p", projectId, "tasks", "mine"] as const,

  /* Board 37 (v2). Development sits under ["t", id] (task-scoped), rules under ["p", id] (qk.scope reaches them). */
  integrations: (slug: string) => ["workspace", slug, "integrations"] as const,
  availableRepos: (integrationId: string, q?: string) => ["integration", integrationId, "available", q ?? ""] as const,
  development: (taskId: string) => ["t", taskId, "development"] as const,
  devRules: (projectId: string) => ["p", projectId, "dev-rules"] as const,

  notifications: (tab: string, workspaceId?: string) => ["notifications", workspaceId ?? "all", tab] as const,
  unread: (workspaceId?: string) => ["notifications", workspaceId ?? "all", "unread"] as const,
  prefs: () => ["notification-prefs"] as const,
  /* Board 38 (v2). Personal: not under a workspace (the same for every workspace). */
  channels: () => ["notification-channels"] as const,
  telegramLink: (id: string) => ["notification-channels", "telegram-link", id] as const,
};
