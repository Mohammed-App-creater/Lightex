import type { Permission, ProjectPermission, RichDoc, TrashItem, TrashKind, TrashList, TrashRef } from "@/lib/api/types";
import { DAY } from "@/lib/domain/progress";
import { nowISO } from "../db";
import type { MockDB, ProjectRec, TaskRec, TrashStore } from "../db-types";
import { projectMembership, projectPermissions, statusesOf, wsPermissions } from "../derive";
import { logActivity } from "./common";
import { audit } from "./workspaces";
import { fail, invalid, route, wsBySlug, type Ctx } from "../router";

/*
 * Workspace Trash (board 29). Tasks are soft-deleted in place (TaskRec.deletedAt); comments and
 * whole projects are moved into db.trash while deleted. Everything is purged 30 days after deletion.
 *
 * Who sees what (mirrors the UI, see features/trash/lib.ts):
 *   task    → task.delete in the task's project (restore uses the same permission)
 *   comment → comment.delete_any in the project, or comment.edit_own for comments the user wrote
 *             and deleted themselves
 *   project → project.delete in the trashed project (role at deletion time), or the workspace
 *             permission project.assign_admin (workspace owners/admins)
 * Users with none of these anywhere get 403 ("No access to Trash").
 */

export const RETENTION_DAYS = 30;

/* ───────── store ───────── */

export function trashOf(db: MockDB): TrashStore {
  if (!db.trash) db.trash = { seeded: false, comments: [], projects: [], taskDeletedBy: {} };
  if (!db.trash.seeded) {
    db.trash.seeded = true;
    seedTrash(db, db.trash);
  }
  return db.trash;
}

export function markTaskDeleted(db: MockDB, taskId: string, userId: string | null) {
  if (userId) trashOf(db).taskDeletedBy[taskId] = userId;
}

/** Moves a comment into the trash (called by DELETE /comments/:id before it is removed). */
export function trashComment(db: MockDB, c: MockDB["comments"][number], userId: string | null) {
  trashOf(db).comments.push({ ...c, deletedAt: nowISO(), deletedBy: userId });
}

/** Moves a project with its tasks and members into the trash (DELETE /projects/:id). */
export function trashProject(db: MockDB, p: ProjectRec, userId: string | null) {
  trashOf(db).projects.push({
    project: { ...p },
    tasks: db.tasks.filter((t) => t.projectId === p.id),
    members: db.projectMembers.filter((m) => m.projectId === p.id),
    deletedAt: nowISO(),
    deletedBy: userId,
  });
}

/** Permanently removes everything older than the retention window. */
function expire(db: MockDB, store: TrashStore, now = Date.now()) {
  const cutoff = now - RETENTION_DAYS * DAY;
  const old = (iso: string | null) => Boolean(iso) && new Date(iso!).getTime() < cutoff;
  store.comments = store.comments.filter((c) => !old(c.deletedAt));
  for (const tp of store.projects.filter((x) => old(x.deletedAt))) purgeProjectData(db, tp.project.id, tp.tasks);
  store.projects = store.projects.filter((x) => !old(x.deletedAt));
  for (const t of db.tasks.filter((x) => old(x.deletedAt) && !x.parentId)) purgeTask(db, t);
}

function purgeTask(db: MockDB, t: TaskRec) {
  const ids = new Set([t.id, ...db.tasks.filter((x) => x.parentId === t.id).map((x) => x.id)]);
  db.tasks = db.tasks.filter((x) => !ids.has(x.id));
  db.comments = db.comments.filter((c) => !ids.has(c.taskId));
  db.attachments = db.attachments.filter((a) => !ids.has(a.taskId));
  if (db.trash) {
    db.trash.comments = db.trash.comments.filter((c) => !ids.has(c.taskId));
    ids.forEach((id) => delete db.trash!.taskDeletedBy[id]);
  }
}

function purgeProjectData(db: MockDB, projectId: string, tasks: TaskRec[]) {
  const ids = new Set(tasks.map((t) => t.id));
  db.statuses = db.statuses.filter((s) => s.projectId !== projectId);
  db.labels = db.labels.filter((l) => l.projectId !== projectId);
  db.sprints = db.sprints.filter((s) => s.projectId !== projectId);
  db.epics = db.epics.filter((e) => e.projectId !== projectId);
  db.objectives = db.objectives.filter((o) => o.projectId !== projectId);
  db.milestones = db.milestones.filter((m) => m.projectId !== projectId);
  db.comments = db.comments.filter((c) => !ids.has(c.taskId));
  db.attachments = db.attachments.filter((a) => !ids.has(a.taskId));
  db.accessRequests = db.accessRequests.filter((r) => r.projectId !== projectId);
}

/* ───────── permissions ───────── */

function rolePerms(db: MockDB, roleId: string | undefined): Permission[] {
  return db.roles.find((r) => r.id === roleId)?.permissions ?? [];
}

type Access = {
  task: (projectId: string) => boolean;
  comment: (projectId: string, authorId: string, deletedBy: string | null) => boolean;
  project: (tp: TrashStore["projects"][number]) => boolean;
  any: boolean;
  scope: "all" | "own";
  kinds: TrashKind[];
};

function accessFor(db: MockDB, userId: string, workspaceId: string): Access {
  const wsPerms = wsPermissions(db, userId, workspaceId);
  const live = db.projects.filter((p) => p.workspaceId === workspaceId && projectMembership(db, userId, p.id));
  const permsOf = new Map<string, ProjectPermission[]>(live.map((p) => [p.id, projectPermissions(db, userId, p.id)]));
  const has = (projectId: string, perm: ProjectPermission) => permsOf.get(projectId)?.includes(perm) ?? false;
  const wsAdmin = wsPerms.includes("project.assign_admin");
  const trashed = (db.trash?.projects ?? []).filter((x) => x.project.workspaceId === workspaceId);
  const projectOk = (tp: TrashStore["projects"][number]) =>
    wsAdmin || rolePerms(db, tp.members.find((m) => m.userId === userId)?.roleId).includes("project.delete");
  const anyPerm = (perm: ProjectPermission) => [...permsOf.values()].some((ps) => ps.includes(perm));
  const canProjects = wsAdmin || anyPerm("project.delete") || trashed.some(projectOk);
  const broad = anyPerm("task.delete") || anyPerm("comment.delete_any") || canProjects;
  const any = broad || anyPerm("comment.edit_own");
  const kinds: TrashKind[] = ["task", "comment"];
  if (canProjects) kinds.push("project");
  return {
    task: (pid) => has(pid, "task.delete"),
    comment: (pid, authorId, deletedBy) =>
      has(pid, "comment.delete_any") || (has(pid, "comment.edit_own") && authorId === userId && deletedBy === userId),
    project: projectOk,
    any,
    scope: broad ? "all" : "own",
    kinds,
  };
}

/* ───────── listing ───────── */

const purgeAt = (iso: string) => new Date(new Date(iso).getTime() + RETENTION_DAYS * DAY).toISOString();

function docText(doc: RichDoc | null | undefined): string {
  const out: string[] = [];
  const walk = (n: { text?: string; content?: unknown[] } | undefined) => {
    if (!n) return;
    if (typeof n.text === "string") out.push(n.text);
    (n.content as { text?: string; content?: unknown[] }[] | undefined)?.forEach(walk);
  };
  walk(doc as never);
  return out.join(" ").replace(/\s+/g, " ").trim();
}

function person(db: MockDB, id: string | null | undefined) {
  const u = id ? db.users.find((x) => x.id === id) : null;
  return u ? { id: u.id, name: u.name, hue: u.hue } : null;
}

function listItems(db: MockDB, userId: string, workspaceId: string, acc: Access): TrashItem[] {
  const store = trashOf(db);
  const items: TrashItem[] = [];
  const projectIds = new Set(db.projects.filter((p) => p.workspaceId === workspaceId).map((p) => p.id));
  const proj = (id: string) => {
    const p = db.projects.find((x) => x.id === id)!;
    return { id: p.id, key: p.key, name: p.name, hue: p.hue };
  };
  // Tasks: top-level deleted rows (subtasks deleted with their parent come back with it).
  for (const t of db.tasks) {
    if (!t.deletedAt || !projectIds.has(t.projectId) || !acc.task(t.projectId)) continue;
    const parent = t.parentId ? db.tasks.find((x) => x.id === t.parentId) : null;
    if (parent?.deletedAt) continue;
    items.push({
      kind: "task",
      id: t.id,
      title: t.title,
      key: t.key,
      hue: null,
      parentKey: null,
      taskCount: null,
      project: proj(t.projectId),
      deletedBy: person(db, store.taskDeletedBy[t.id]),
      deletedAt: t.deletedAt,
      purgeAt: purgeAt(t.deletedAt),
    });
  }
  // Comments on live tasks (comments on a deleted task return with the task).
  for (const c of store.comments) {
    const t = db.tasks.find((x) => x.id === c.taskId);
    if (!t || t.deletedAt || !projectIds.has(t.projectId) || !acc.comment(t.projectId, c.authorId, c.deletedBy)) continue;
    items.push({
      kind: "comment",
      id: c.id,
      title: docText(c.body).slice(0, 160) || "Comment",
      key: null,
      hue: null,
      parentKey: t.key,
      taskCount: null,
      project: proj(t.projectId),
      deletedBy: person(db, c.deletedBy),
      deletedAt: c.deletedAt,
      purgeAt: purgeAt(c.deletedAt),
    });
  }
  for (const tp of store.projects) {
    if (tp.project.workspaceId !== workspaceId || !acc.project(tp)) continue;
    items.push({
      kind: "project",
      id: tp.project.id,
      title: tp.project.name,
      key: tp.project.key,
      hue: tp.project.hue,
      parentKey: null,
      taskCount: tp.tasks.filter((t) => !t.deletedAt && !t.parentId).length,
      project: null,
      deletedBy: person(db, tp.deletedBy),
      deletedAt: tp.deletedAt,
      purgeAt: purgeAt(tp.deletedAt),
    });
  }
  void userId;
  return items.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

/* ───────── restore / purge ───────── */

function refsOf(ctx: Ctx): TrashRef[] {
  const raw = (ctx.body as { items?: unknown })?.items;
  if (!Array.isArray(raw) || !raw.length) invalid({ items: "Pick at least one item" });
  return raw
    .slice(0, 200)
    .filter((r): r is TrashRef => Boolean(r) && typeof r.id === "string" && ["task", "comment", "project"].includes(r.kind));
}

function findVisible(db: MockDB, userId: string, workspaceId: string, acc: Access, ref: TrashRef) {
  const ok = listItems(db, userId, workspaceId, acc).some((i) => i.kind === ref.kind && i.id === ref.id);
  if (!ok) fail(404, "not_found", "That item isn’t in the Trash any more.", { item: ref });
}

function restoreOne(ctx: Ctx, wsId: string, ref: TrashRef) {
  const db = ctx.db;
  const store = trashOf(db);
  if (ref.kind === "task") {
    const t = db.tasks.find((x) => x.id === ref.id)!;
    const when = t.deletedAt;
    t.deletedAt = null;
    t.version += 1;
    db.tasks.filter((x) => x.parentId === t.id && x.deletedAt === when).forEach((x) => (x.deletedAt = null));
    delete store.taskDeletedBy[t.id];
    logActivity(db, ctx.userId, "restored", t.projectId, t);
  } else if (ref.kind === "comment") {
    const i = store.comments.findIndex((c) => c.id === ref.id);
    const { deletedAt: _d, deletedBy: _b, ...c } = store.comments[i]!;
    store.comments.splice(i, 1);
    db.comments.push(c);
  } else {
    const i = store.projects.findIndex((x) => x.project.id === ref.id);
    const tp = store.projects[i]!;
    if (db.projects.some((p) => p.workspaceId === wsId && p.key === tp.project.key)) {
      fail(409, "key_taken", `Another project already uses the key ${tp.project.key}. Rename it, then restore.`, { item: ref });
    }
    store.projects.splice(i, 1);
    db.projects.push(tp.project);
    db.tasks.push(...tp.tasks.filter((t) => !db.tasks.some((x) => x.id === t.id)));
    db.projectMembers.push(...tp.members);
    audit(db, wsId, ctx.userId!, "project.restored", tp.project.name);
  }
}

function purgeOne(ctx: Ctx, wsId: string, ref: TrashRef) {
  const db = ctx.db;
  const store = trashOf(db);
  if (ref.kind === "task") purgeTask(db, db.tasks.find((x) => x.id === ref.id)!);
  else if (ref.kind === "comment") store.comments = store.comments.filter((c) => c.id !== ref.id);
  else {
    const tp = store.projects.find((x) => x.project.id === ref.id)!;
    purgeProjectData(db, tp.project.id, tp.tasks);
    store.projects = store.projects.filter((x) => x !== tp);
    audit(db, wsId, ctx.userId!, "project.purged", tp.project.name);
  }
}

export function registerTrash() {
  const setup = (ctx: Ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    const userId = ctx.userId!;
    const store = trashOf(ctx.db);
    expire(ctx.db, store);
    const acc = accessFor(ctx.db, userId, ws.id);
    if (!acc.any) fail(403, "forbidden", "Trash is for members and admins.", { permission: "task.delete" });
    return { ws, userId, acc };
  };

  route("GET", "/workspaces/:slug/trash", (ctx): TrashList => {
    const { ws, userId, acc } = setup(ctx);
    return { data: listItems(ctx.db, userId, ws.id, acc), scope: acc.scope, kinds: acc.kinds, retentionDays: RETENTION_DAYS };
  });

  route("POST", "/workspaces/:slug/trash/restore", (ctx) => {
    const { ws, userId, acc } = setup(ctx);
    const refs = refsOf(ctx);
    refs.forEach((r) => findVisible(ctx.db, userId, ws.id, acc, r));
    refs.forEach((r) => restoreOne(ctx, ws.id, r));
    return { restored: refs };
  });

  route("POST", "/workspaces/:slug/trash/purge", (ctx) => {
    const { ws, userId, acc } = setup(ctx);
    const refs = refsOf(ctx);
    refs.forEach((r) => findVisible(ctx.db, userId, ws.id, acc, r));
    refs.forEach((r) => purgeOne(ctx, ws.id, r));
    return { purged: refs };
  });
}

/* ───────── demo data (created once, lazily: no seed SCHEMA bump) ───────── */

function seedTrash(db: MockDB, store: TrashStore) {
  const now = Date.now();
  const ago = (days: number, hours = 0) => new Date(now - days * DAY - hours * 3_600_000).toISOString();
  const prj = db.projects.find((p) => p.id === "p_prj");
  if (!prj) return;

  const deletedTask = (p: ProjectRec, title: string, when: string, by: string, type: TaskRec["type"] = "feature") => {
    const st = statusesOf(db, p.id);
    p.taskSeq += 1;
    const t: TaskRec = {
      id: `${p.id}-t${p.taskSeq}`,
      projectId: p.id,
      key: `${p.key}-${p.taskSeq}`,
      number: p.taskSeq,
      title,
      type,
      priority: 2,
      statusId: (st[1] ?? st[0])?.id ?? "",
      assigneeId: by,
      reporterId: by,
      estimate: null,
      dueDate: null,
      epicId: null,
      milestoneId: null,
      sprintId: null,
      parentId: null,
      objectiveIds: [],
      labelIds: [],
      position: `zz${p.taskSeq}`,
      version: 2,
      createdAt: ago(40),
      updatedAt: when,
      completedAt: null,
      deletedAt: when,
      description: null,
      startedAt: null,
    };
    db.tasks.push(t);
    store.taskDeletedBy[t.id] = by;
    return t;
  };

  deletedTask(prj, "Remove legacy session cookies", ago(0, 2), "u_alex", "chore");
  deletedTask(prj, "Spike: WebSocket fallback", ago(3), "u_jordan", "spike");
  deletedTask(prj, "Old board virtualization prototype", ago(27), "u_alex");
  const mob = db.projects.find((p) => p.id === "p_mob");
  if (mob) deletedTask(mob, "Dark mode toggle in onboarding", ago(6), "u_morgan");
  const inf = db.projects.find((p) => p.id === "p_inf");
  if (inf) deletedTask(inf, "Rotate staging certificates", ago(28), "u_riley", "chore");

  const liveTask = (projectId: string, n: number) =>
    db.tasks.find((t) => t.projectId === projectId && !t.deletedAt && !t.parentId && t.number === n) ??
    db.tasks.find((t) => t.projectId === projectId && !t.deletedAt && !t.parentId);
  const comment = (taskId: string | undefined, authorId: string, text: string, when: string, by: string) => {
    if (!taskId) return;
    store.comments.push({
      id: `c_trash_${store.comments.length + 1}`,
      taskId,
      authorId,
      body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
      mentions: [],
      createdAt: new Date(new Date(when).getTime() - 3 * DAY).toISOString(),
      editedAt: null,
      deletedAt: when,
      deletedBy: by,
    });
  };
  comment(liveTask("p_prj", 112)?.id, "u_jordan", "Can we pin this to 2.4 until the fix lands?", ago(1), "u_jordan");
  comment(liveTask("p_prj", 93)?.id, "u_alex", "Duplicate of PRJ-90, closing.", ago(12), "u_alex");
  comment(liveTask("p_prj", 42)?.id, "u_sam", "Benchmarks attached in the thread.", ago(2), "u_sam");
  comment(liveTask("p_inf", 9)?.id, "u_morgan", "Benchmarks look good on the new nodes.", ago(29), "u_morgan");

  const trashedProject = (id: string, key: string, name: string, hue: number, when: string, by: string, titles: string[]) => {
    if (db.projects.some((p) => p.key === key && p.workspaceId === prj.workspaceId)) return;
    const p: ProjectRec = {
      id,
      workspaceId: prj.workspaceId,
      key,
      name,
      description: "",
      hue,
      leadId: by,
      status: "archived",
      template: "kanban",
      createdAt: ago(120),
      taskSeq: 0,
    };
    const defs: [string, string, "todo" | "in_progress" | "done", "todo" | "progress" | "done"][] = [
      ["todo", "Todo", "todo", "todo"],
      ["progress", "In progress", "in_progress", "progress"],
      ["done", "Done", "done", "done"],
    ];
    defs.forEach(([k, n, category, glyph], i) => db.statuses.push({ id: `${id}-st-${k}`, projectId: id, name: n, category, glyph, position: i }));
    const tasks: TaskRec[] = titles.map((title, i) => ({
      id: `${id}-t${i + 1}`,
      projectId: id,
      key: `${key}-${i + 1}`,
      number: i + 1,
      title,
      type: "feature",
      priority: 2,
      statusId: `${id}-st-done`,
      assigneeId: by,
      reporterId: by,
      estimate: null,
      dueDate: null,
      epicId: null,
      milestoneId: null,
      sprintId: null,
      parentId: null,
      objectiveIds: [],
      labelIds: [],
      position: `a${i}`,
      version: 1,
      createdAt: ago(100),
      updatedAt: ago(60),
      completedAt: ago(60),
      deletedAt: null,
      description: null,
      startedAt: null,
    }));
    p.taskSeq = tasks.length;
    const role = (k: string) => `${prj.workspaceId}-role-${k}`;
    store.projects.push({
      project: p,
      tasks,
      members: [
        { projectId: id, userId: "u_alex", roleId: role("project_admin"), addedAt: ago(120) },
        { projectId: id, userId: by, roleId: role(by === "u_alex" ? "project_admin" : "manager"), addedAt: ago(120) },
        { projectId: id, userId: "u_sam", roleId: role("project_member"), addedAt: ago(120) },
      ].filter((m, i, all) => all.findIndex((x) => x.userId === m.userId) === i),
      deletedAt: when,
      deletedBy: by,
    });
  };
  trashedProject("p_trash_la", "LA", "Legacy API", 25, ago(9), "u_alex", [
    "Deprecate v1 auth endpoints",
    "Sunset XML responses",
    "Migrate webhooks to v2",
    "Remove rate-limit shim",
  ]);
  trashedProject("p_trash_hw", "HW", "Hack week", 335, ago(15), "u_taylor", ["Slack-style reactions", "Board confetti"]);
}
