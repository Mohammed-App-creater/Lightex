import type {
  Epic,
  Milestone,
  Objective,
  Permission,
  Project,
  ProjectPermission,
  Role,
  Sprint,
  Task,
  User,
  Workspace,
  WorkspacePermission,
} from "@/lib/api/types";
import { PROJECT_PERMISSIONS, WORKSPACE_PERMISSIONS } from "@/lib/api/types";
import { expectedPercent, isAtRisk, isDoneStatus, progressOf } from "@/lib/domain/progress";
import type {
  EpicRec,
  MilestoneRec,
  MockDB,
  ObjectiveRec,
  ProjectRec,
  RoleRec,
  SprintRec,
  TaskRec,
  UserRec,
  WorkspaceRec,
} from "./db-types";

/* Server-side derivations: permissions, counts and progress are computed, never stored. */

export const toUser = ({ password: _password, ...u }: UserRec): User => u;

export function wsMembership(db: MockDB, userId: string, workspaceId: string) {
  return db.wsMembers.find((m) => m.userId === userId && m.workspaceId === workspaceId && m.status === "active");
}

export function wsPermissions(db: MockDB, userId: string, workspaceId: string): WorkspacePermission[] {
  const m = wsMembership(db, userId, workspaceId);
  if (!m) return [];
  const role = db.roles.find((r) => r.id === m.roleId);
  return (role?.permissions ?? []).filter((p): p is WorkspacePermission =>
    (WORKSPACE_PERMISSIONS as readonly string[]).includes(p),
  );
}

export function projectMembership(db: MockDB, userId: string, projectId: string) {
  return db.projectMembers.find((m) => m.userId === userId && m.projectId === projectId);
}

/** Project permissions come ONLY from project membership. No workspace override. */
export function projectPermissions(db: MockDB, userId: string, projectId: string): ProjectPermission[] {
  const m = projectMembership(db, userId, projectId);
  if (!m) return [];
  const role = db.roles.find((r) => r.id === m.roleId);
  return (role?.permissions ?? []).filter((p): p is ProjectPermission =>
    (PROJECT_PERMISSIONS as readonly string[]).includes(p),
  );
}

export function toWorkspace(db: MockDB, w: WorkspaceRec, userId: string): Workspace {
  const m = wsMembership(db, userId, w.id)!;
  return {
    id: w.id,
    slug: w.slug,
    name: w.name,
    hue: w.hue,
    createdAt: w.createdAt,
    memberCount: db.wsMembers.filter((x) => x.workspaceId === w.id && x.status === "active").length,
    myRoleId: m.roleId,
    my_permissions: wsPermissions(db, userId, w.id),
  };
}

export function toRole(db: MockDB, r: RoleRec): Role {
  const memberCount =
    r.scope === "workspace"
      ? db.wsMembers.filter((m) => m.roleId === r.id && m.status === "active").length
      : new Set(db.projectMembers.filter((m) => m.roleId === r.id).map((m) => m.userId)).size;
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    name: r.name,
    description: r.description,
    scope: r.scope,
    isSystem: r.isSystem,
    permissions: r.permissions as Permission[],
    memberCount,
  };
}

export function liveTasks(db: MockDB, projectId?: string) {
  return db.tasks.filter((t) => !t.deletedAt && (!projectId || t.projectId === projectId));
}

export function statusesOf(db: MockDB, projectId: string) {
  return db.statuses.filter((s) => s.projectId === projectId).sort((a, b) => a.position - b.position);
}

export function toProject(db: MockDB, p: ProjectRec, userId: string): Project {
  const statuses = statusesOf(db, p.id);
  const open = liveTasks(db, p.id).filter((t) => {
    const s = statuses.find((x) => x.id === t.statusId);
    return s?.category !== "done";
  }).length;
  const m = projectMembership(db, userId, p.id);
  return {
    ...stripSeq(p),
    memberCount: db.projectMembers.filter((x) => x.projectId === p.id).length,
    openTaskCount: open,
    activeSprintId: db.sprints.find((s) => s.projectId === p.id && s.state === "active")?.id ?? null,
    myRoleId: m?.roleId ?? null,
    my_permissions: projectPermissions(db, userId, p.id),
  };
}

function stripSeq({ taskSeq: _taskSeq, ...rest }: ProjectRec) {
  return rest;
}

export function toTask(db: MockDB, t: TaskRec): Task {
  const { description: _d, startedAt: _s, ...rest } = t;
  const statuses = statusesOf(db, t.projectId);
  const subs = db.tasks.filter((x) => x.parentId === t.id && !x.deletedAt);
  return {
    ...rest,
    subtaskCount: subs.length,
    subtaskDoneCount: subs.filter((x) => isDoneStatus(x.statusId, statuses)).length,
    commentCount: db.comments.filter((c) => c.taskId === t.id).length,
    attachmentCount: db.attachments.filter((a) => a.taskId === t.id).length,
  };
}

export function toObjective(db: MockDB, o: ObjectiveRec): Objective {
  const tasks = liveTasks(db, o.projectId).filter((t) => t.objectiveIds.includes(o.id));
  return { ...o, taskIds: tasks.map((t) => t.id), progress: progressOf(tasks, statusesOf(db, o.projectId)) };
}

export function toMilestone(db: MockDB, m: MilestoneRec): Milestone {
  const tasks = liveTasks(db, m.projectId).filter((t) => t.milestoneId === m.id);
  const base = progressOf(tasks, statusesOf(db, m.projectId));
  const done = Boolean(m.completedAt);
  const percent = done ? 100 : base.percent;
  const expected = expectedPercent(m.startDate, m.dueDate);
  return { ...m, progress: { ...base, percent, expected, atRisk: isAtRisk(percent, expected, done) } };
}

export function toEpic(db: MockDB, e: EpicRec): Epic {
  const tasks = liveTasks(db, e.projectId).filter((t) => t.epicId === e.id);
  return { ...e, progress: progressOf(tasks, statusesOf(db, e.projectId)) };
}

export function toSprint(db: MockDB, s: SprintRec): Sprint {
  const statuses = statusesOf(db, s.projectId);
  const tasks = liveTasks(db, s.projectId).filter((t) => t.sprintId === s.id);
  const base = progressOf(tasks, statuses);
  const points = tasks.reduce((a, t) => a + (t.estimate ?? 0), 0);
  const donePoints = tasks.filter((t) => isDoneStatus(t.statusId, statuses)).reduce((a, t) => a + (t.estimate ?? 0), 0);
  return { ...s, progress: { ...base, points, donePoints } };
}
