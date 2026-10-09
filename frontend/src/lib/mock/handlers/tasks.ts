import type { Attachment, Comment, RichDoc, TaskDetail, TaskPatch } from "@/lib/api/types";
import { validateUpload } from "@/lib/files";
import { comparePosition, keyBetween } from "@/lib/utils/fractional-index";
import { nowISO, uid } from "../db";
import type { AttachmentRec, MockDB, TaskRec } from "../db-types";
import { projectPermissions, statusesOf, toProject, toTask } from "../derive";
import { logActivity, notify } from "./common";
import { dependenciesOf, ensureExt39, prepareTaskExtPatch } from "./extensions";
import { memberProject } from "./projects";
import { markTaskDeleted, trashComment } from "./trash";
import {
  fail,
  filterValues,
  invalid,
  paginate,
  requireProject,
  requireUser,
  route,
  str,
  wsBySlug,
  type Ctx,
} from "../router";

/* ───────── helpers ───────── */

function taskById(ctx: Ctx, id: string) {
  const t = ctx.db.tasks.find((x) => x.id === id);
  if (!t) fail(404, "not_found", "Task not found.");
  requireProject(ctx, t.projectId, "project.view");
  return t;
}

/** edit_any, or edit_own when the user reported or is assigned the task. */
export function canEditTask(db: MockDB, userId: string, t: TaskRec) {
  const perms = projectPermissions(db, userId, t.projectId);
  return perms.includes("task.edit_any") || (perms.includes("task.edit_own") && (t.assigneeId === userId || t.reporterId === userId));
}

function checkVersion(t: TaskRec, version: unknown, db: MockDB) {
  if (typeof version === "number" && version !== t.version) {
    fail(409, "version_conflict", "Someone else changed this card.", { current: toTask(db, t) });
  }
}

function statusName(db: MockDB, id: string) {
  return db.statuses.find((s) => s.id === id)?.name ?? "";
}

function applyStatusSideEffects(db: MockDB, t: TaskRec, nextStatusId: string) {
  const s = db.statuses.find((x) => x.id === nextStatusId);
  if (!s) invalid({ statusId: "Unknown status" });
  if (s.projectId !== t.projectId) invalid({ statusId: "Unknown status" });
  if (s.category === "done" && s.glyph !== "canceled") t.completedAt ??= nowISO();
  else t.completedAt = null;
  if (s.category === "in_progress") t.startedAt ??= nowISO();
}

function lastPosition(db: MockDB, projectId: string, statusId: string) {
  const sorted = db.tasks.filter((x) => x.projectId === projectId && x.statusId === statusId && !x.deletedAt).sort(comparePosition);
  return keyBetween(sorted.at(-1)?.position ?? null, null);
}

export function toDetail(db: MockDB, t: TaskRec, userId: string): TaskDetail {
  const p = db.projects.find((x) => x.id === t.projectId)!;
  const proj = toProject(db, p, userId);
  return {
    ...toTask(db, t),
    description: t.description,
    subtasks: db.tasks
      .filter((x) => x.parentId === t.id && !x.deletedAt)
      .sort((a, b) => a.number - b.number)
      .map((x) => toTask(db, x)),
    project: { id: p.id, key: p.key, name: p.name, hue: p.hue, my_permissions: proj.my_permissions },
    dependencies: dependenciesOf(db, t.id),
  };
}

function mentionIds(doc: RichDoc | null | undefined): string[] {
  const out = new Set<string>();
  const walk = (nodes: RichDoc["content"]) =>
    nodes?.forEach((n) => {
      if (n.type === "mention" && typeof n.attrs?.id === "string") out.add(n.attrs.id);
      walk(n.content);
    });
  walk(doc?.content);
  return [...out];
}

function richText(doc: RichDoc | null | undefined): string {
  const parts: string[] = [];
  const walk = (nodes: RichDoc["content"]) =>
    nodes?.forEach((n) => {
      if (n.text) parts.push(n.text);
      if (n.type === "mention") parts.push(`@${String(n.attrs?.label ?? "")}`);
      walk(n.content);
    });
  walk(doc?.content);
  return parts.join("").trim();
}

/* Uploaded bodies live only in memory (never in localStorage). */
const uploads = new Map<string, { taskId: string; fileName: string; size: number; mimeType: string; blob?: Blob }>();
export const mockUploads = uploads;

function kindOf(fileName: string, mime: string): AttachmentRec["kind"] {
  if (/^image\/(png|jpe?g|gif|webp)$/.test(mime) || /\.(png|jpe?g|gif|webp)$/i.test(fileName)) return "image";
  if (/\.(txt|md|diff|log)$/i.test(fileName)) return "text";
  return "code";
}

/** Fresh URLs per request (signed URLs are short-lived in the real API). */
function toAttachment(a: AttachmentRec): Attachment {
  const { content, ...rest } = a;
  let downloadUrl = rest.downloadUrl;
  let previewUrl = rest.previewUrl;
  if (!downloadUrl.startsWith("blob:") || typeof window === "undefined") {
    if (content !== undefined) {
      downloadUrl = `data:application/octet-stream;base64,${btoa(unescape(encodeURIComponent(content)))}`;
    } else if (a.kind === "image" && typeof document !== "undefined") {
      downloadUrl = placeholderPng(a.fileName);
      previewUrl = downloadUrl;
    } else {
      downloadUrl = `data:application/octet-stream;base64,${btoa("(mock) file body not kept after reload")}`;
    }
  }
  // Never offer an inline preview for anything that is not a raster image.
  if (a.kind !== "image") previewUrl = null;
  return { ...rest, downloadUrl, previewUrl, content: undefined } as Attachment;
}

function placeholderPng(seed: string) {
  try {
    const c = document.createElement("canvas");
    c.width = 320;
    c.height = 180;
    const g = c.getContext("2d");
    if (!g) return "";
    let h = 0;
    for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) % 360;
    const grad = g.createLinearGradient(0, 0, 320, 180);
    grad.addColorStop(0, `hsl(${h} 60% 30%)`);
    grad.addColorStop(1, `hsl(${(h + 60) % 360} 60% 18%)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 320, 180);
    g.fillStyle = "rgba(255,255,255,.85)";
    g.font = "600 16px sans-serif";
    g.fillText(seed, 16, 160);
    return c.toDataURL("image/png");
  } catch {
    return "";
  }
}

/* ───────── routes ───────── */

export function registerTasks() {
  route("GET", "/projects/:id/tasks", (ctx) => {
    const p = memberProject(ctx, ctx.params.id!);
    const q = String(ctx.query.q ?? "").toLowerCase();
    const f = (k: string) => filterValues(ctx.query, k);
    const blocked = f("blocked")[0];
    if (blocked !== undefined && blocked !== "true" && blocked !== "false") invalid({ "filter[blocked]": "Use true or false" });
    ensureExt39(ctx.db);
    const [status, assignee, sprint, epic, milestone, priority, label, parent] = [
      f("status"),
      f("assignee").map((a) => (a === "me" ? ctx.userId! : a)),
      f("sprint"),
      f("epic"),
      f("milestone"),
      f("priority").map(Number),
      f("label"),
      f("parent"),
    ];
    let list = ctx.db.tasks
      .filter((t) => t.projectId === p.id && !t.deletedAt)
      .filter((t) => !q || t.title.toLowerCase().includes(q) || t.key.toLowerCase().includes(q))
      .filter((t) => !status.length || status.includes(t.statusId))
      .filter((t) => !assignee.length || assignee.includes(t.assigneeId ?? "none"))
      .filter((t) => !sprint.length || sprint.includes(t.sprintId ?? "none"))
      .filter((t) => !epic.length || epic.includes(t.epicId ?? "none"))
      .filter((t) => !milestone.length || milestone.includes(t.milestoneId ?? "none"))
      .filter((t) => !priority.length || priority.includes(t.priority))
      .filter((t) => !label.length || t.labelIds.some((l) => label.includes(l)))
      .filter((t) => !parent.length || parent.includes(t.parentId ?? "none"));
    const sort = String(ctx.query.sort ?? "number");
    const desc = sort.startsWith("-");
    const key = desc ? sort.slice(1) : sort;
    list = [...list].sort((a, b) => {
      const av = (a as unknown as Record<string, unknown>)[key] ?? "";
      const bv = (b as unknown as Record<string, unknown>)[key] ?? "";
      const r = av < bv ? -1 : av > bv ? 1 : 0;
      return desc ? -r : r;
    });
    let out = list.map((t) => toTask(ctx.db, t));
    if (blocked !== undefined) out = out.filter((t) => t.isBlocked === (blocked === "true"));
    return paginate(out, ctx.query, 500);
  });

  route("POST", "/projects/:id/tasks", (ctx) => {
    const p = memberProject(ctx, ctx.params.id!);
    const perms = requireProject(ctx, p.id, "task.create");
    const b = (ctx.body ?? {}) as Partial<TaskRec>;
    const title = (b.title ?? "").trim();
    if (!title) invalid({ title: "Give the task a title" });
    const statuses = statusesOf(ctx.db, p.id);
    const statusId = b.statusId && statuses.some((s) => s.id === b.statusId) ? b.statusId : statuses.find((s) => s.glyph === "todo")!.id;
    if (b.assigneeId && b.assigneeId !== ctx.userId && !perms.includes("task.assign")) {
      fail(403, "forbidden", "You can’t assign tasks to others.", { permission: "task.assign" });
    }
    p.taskSeq += 1;
    const now = nowISO();
    const t: TaskRec = {
      id: uid("t"),
      projectId: p.id,
      key: `${p.key}-${p.taskSeq}`,
      number: p.taskSeq,
      title: title.slice(0, 200),
      type: b.type ?? "feature",
      priority: (b.priority ?? 0) as TaskRec["priority"],
      statusId,
      assigneeId: b.assigneeId ?? null,
      reporterId: ctx.userId!,
      estimate: b.estimate ?? null,
      dueDate: b.dueDate ?? null,
      epicId: b.epicId ?? null,
      milestoneId: b.milestoneId ?? null,
      sprintId: b.sprintId === undefined ? ctx.db.sprints.find((s) => s.projectId === p.id && s.state === "active")?.id ?? null : b.sprintId,
      parentId: b.parentId ?? null,
      objectiveIds: [],
      labelIds: b.labelIds ?? [],
      position: lastPosition(ctx.db, p.id, statusId),
      version: 1,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      startedAt: null,
      deletedAt: null,
      description: (b.description as RichDoc | undefined) ?? null,
    };
    if (t.parentId) {
      const parent = ctx.db.tasks.find((x) => x.id === t.parentId);
      if (!parent || parent.projectId !== p.id) invalid({ parentId: "Unknown parent task" });
      t.sprintId = parent.sprintId;
      t.epicId ??= parent.epicId;
    }
    applyStatusSideEffects(ctx.db, t, statusId);
    ctx.db.tasks.push(t);
    logActivity(ctx.db, ctx.userId, "created", p.id, t);
    if (t.assigneeId) notify(ctx.db, t.assigneeId, "assigned", ctx.userId, t, p.id);
    return toTask(ctx.db, t);
  });

  route("GET", "/workspaces/:slug/tasks/:key", (ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    const key = ctx.params.key!.toUpperCase();
    const t = ctx.db.tasks.find((x) => x.key.toUpperCase() === key && ctx.db.projects.find((p) => p.id === x.projectId)?.workspaceId === ws.id);
    if (!t) fail(404, "not_found", "Task not found. It may have been deleted, or you may not have access.");
    const perms = projectPermissions(ctx.db, ctx.userId!, t.projectId);
    if (!perms.includes("project.view")) fail(404, "not_found", "Task not found. It may have been deleted, or you may not have access.");
    recordRecent(ctx.db, ctx.userId!, "task", t.id);
    return toDetail(ctx.db, t, ctx.userId!);
  });

  route("PATCH", "/tasks/:id", (ctx) => {
    const t = taskById(ctx, ctx.params.id!);
    const userId = ctx.userId!;
    const perms = projectPermissions(ctx.db, userId, t.projectId);
    const b = (ctx.body ?? {}) as TaskPatch & { version?: number };
    checkVersion(t, b.version, ctx.db);
    if (t.deletedAt) fail(409, "task_deleted", "This task was deleted. Restore it to make changes.");
    const keys = Object.keys(b).filter((k) => k !== "version") as (keyof TaskPatch)[];
    const onlyStatus = keys.length === 1 && keys[0] === "statusId";
    const canEdit = canEditTask(ctx.db, userId, t);
    if (onlyStatus) {
      if (!canEdit && !perms.includes("task.move")) fail(403, "forbidden", "You can’t change this task’s status.", { permission: "task.move" });
    } else if (!canEdit) {
      fail(403, "forbidden", "You can only edit tasks you reported or are assigned.", { permission: "task.edit_any" });
    }
    if ("assigneeId" in b && b.assigneeId !== t.assigneeId && !perms.includes("task.assign")) {
      fail(403, "forbidden", "You can’t reassign tasks.", { permission: "task.assign" });
    }
    // Board 39: customFields / timeEstimateMinutes are validated before anything is written.
    const applyExt = keys.some((k) => k === "customFields" || k === "timeEstimateMinutes") ? prepareTaskExtPatch(ctx.db, t, b as Record<string, unknown>) : null;
    const before = { ...t };
    if (b.title !== undefined) {
      if (!b.title.trim()) invalid({ title: "Give the task a title" });
      t.title = b.title.trim().slice(0, 200);
    }
    if (b.statusId !== undefined && b.statusId !== t.statusId) {
      applyStatusSideEffects(ctx.db, t, b.statusId);
      t.statusId = b.statusId;
      t.position = lastPosition(ctx.db, t.projectId, b.statusId);
    }
    if (b.type !== undefined) t.type = b.type;
    if (b.priority !== undefined) t.priority = b.priority;
    if (b.assigneeId !== undefined) t.assigneeId = b.assigneeId;
    if (b.estimate !== undefined) t.estimate = b.estimate === null ? null : Math.max(0, Math.min(99, Math.round(b.estimate)));
    if (b.dueDate !== undefined) t.dueDate = b.dueDate;
    if (b.epicId !== undefined) t.epicId = b.epicId;
    if (b.milestoneId !== undefined) t.milestoneId = b.milestoneId;
    if (b.sprintId !== undefined) t.sprintId = b.sprintId;
    if (b.objectiveIds !== undefined) t.objectiveIds = [...new Set(b.objectiveIds)];
    if (b.labelIds !== undefined) t.labelIds = [...new Set(b.labelIds)];
    if (b.description !== undefined) t.description = b.description;
    applyExt?.(userId);
    t.version += 1;
    t.updatedAt = nowISO();

    if (before.statusId !== t.statusId) {
      logActivity(ctx.db, userId, "status_changed", t.projectId, t, { from: statusName(ctx.db, before.statusId), to: statusName(ctx.db, t.statusId) });
      if (t.assigneeId) notify(ctx.db, t.assigneeId, "status", userId, t, t.projectId, { fromStatus: statusName(ctx.db, before.statusId), toStatus: statusName(ctx.db, t.statusId) });
    }
    if (before.assigneeId !== t.assigneeId) {
      const name = ctx.db.users.find((u) => u.id === t.assigneeId)?.name ?? "nobody";
      logActivity(ctx.db, userId, "assigned", t.projectId, t, { assignee: name });
      if (t.assigneeId) notify(ctx.db, t.assigneeId, "assigned", userId, t, t.projectId);
    }
    if (b.objectiveIds && b.objectiveIds.some((o) => !before.objectiveIds.includes(o))) {
      const added = ctx.db.objectives.find((o) => b.objectiveIds!.includes(o.id) && !before.objectiveIds.includes(o.id));
      logActivity(ctx.db, userId, "linked_objective", t.projectId, t, { objective: added?.title ?? "" });
    }
    if (b.description !== undefined) {
      for (const m of mentionIds(b.description)) {
        if (!mentionIds(before.description).includes(m)) notify(ctx.db, m, "mention", userId, t, t.projectId, { quote: richText(b.description).slice(0, 140) });
      }
    }
    return toTask(ctx.db, t);
  });

  route("DELETE", "/tasks/:id", (ctx) => {
    const t = taskById(ctx, ctx.params.id!);
    requireProject(ctx, t.projectId, "task.delete");
    const now = nowISO();
    t.deletedAt = now;
    t.version += 1;
    markTaskDeleted(ctx.db, t.id, ctx.userId);
    ctx.db.tasks.filter((x) => x.parentId === t.id).forEach((x) => (x.deletedAt = now));
    logActivity(ctx.db, ctx.userId, "deleted", t.projectId, t);
    return undefined;
  });

  route("POST", "/tasks/:id/restore", (ctx) => {
    const t = ctx.db.tasks.find((x) => x.id === ctx.params.id);
    if (!t) fail(404, "not_found", "Task not found.");
    requireProject(ctx, t.projectId, "task.delete");
    const when = t.deletedAt;
    t.deletedAt = null;
    t.version += 1;
    ctx.db.tasks.filter((x) => x.parentId === t.id && x.deletedAt === when).forEach((x) => (x.deletedAt = null));
    logActivity(ctx.db, ctx.userId, "restored", t.projectId, t);
    return toTask(ctx.db, t);
  });

  route("POST", "/projects/:id/tasks/bulk", (ctx) => {
    const p = memberProject(ctx, ctx.params.id!);
    const b = (ctx.body ?? {}) as { ids?: string[]; patch?: TaskPatch; delete?: boolean; restore?: boolean };
    const ids = (b.ids ?? []).slice(0, 200);
    const tasks = ctx.db.tasks.filter((t) => ids.includes(t.id) && t.projectId === p.id);
    const userId = ctx.userId!;
    if (b.delete || b.restore) {
      requireProject(ctx, p.id, "task.delete");
      const now = nowISO();
      tasks.forEach((t) => {
        t.deletedAt = b.delete ? now : null;
        t.version += 1;
        if (b.delete) markTaskDeleted(ctx.db, t.id, userId);
      });
      return tasks.map((t) => toTask(ctx.db, t));
    }
    const patch = b.patch ?? {};
    if ("customFields" in patch) invalid({ customFields: "This field can’t be bulk-edited" });
    if ("timeEstimateMinutes" in patch) invalid({ timeEstimateMinutes: "This field can’t be bulk-edited" });
    const perms = projectPermissions(ctx.db, userId, p.id);
    if ("assigneeId" in patch && !perms.includes("task.assign")) fail(403, "forbidden", "You can’t reassign tasks.", { permission: "task.assign" });
    const statusOnly = Object.keys(patch).every((k) => k === "statusId");
    for (const t of tasks) {
      if (!(statusOnly ? perms.includes("task.move") || canEditTask(ctx.db, userId, t) : canEditTask(ctx.db, userId, t))) {
        fail(403, "forbidden", `You can’t edit ${t.key}.`, { permission: "task.edit_any", taskId: t.id });
      }
    }
    for (const t of tasks) {
      if (patch.statusId && patch.statusId !== t.statusId) {
        applyStatusSideEffects(ctx.db, t, patch.statusId);
        t.statusId = patch.statusId;
        t.position = lastPosition(ctx.db, p.id, patch.statusId);
      }
      if (patch.assigneeId !== undefined) t.assigneeId = patch.assigneeId;
      if (patch.labelIds) t.labelIds = [...new Set([...t.labelIds, ...patch.labelIds])];
      if (patch.sprintId !== undefined) t.sprintId = patch.sprintId;
      if (patch.priority !== undefined) t.priority = patch.priority;
      // Board 27: "Add tasks to epic" / remove from epic go through bulk { epicId }.
      if (patch.epicId !== undefined) {
        if (patch.epicId && !ctx.db.epics.some((e) => e.id === patch.epicId && e.projectId === p.id)) invalid({ epicId: "Pick an epic in this project" });
        t.epicId = patch.epicId;
      }
      t.version += 1;
      t.updatedAt = nowISO();
    }
    return tasks.map((t) => toTask(ctx.db, t));
  });

  route("GET", "/tasks/:id/activity", (ctx) => {
    const t = taskById(ctx, ctx.params.id!);
    return ctx.db.activity.filter((a) => a.taskId === t.id);
  });

  /* board + backlog */
  route("GET", "/projects/:id/board", (ctx) => {
    const p = memberProject(ctx, ctx.params.id!);
    const statuses = statusesOf(ctx.db, p.id);
    const wanted = String(ctx.query.filter?.sprint ?? "active");
    const active = ctx.db.sprints.find((s) => s.projectId === p.id && s.state === "active");
    const sprintId = wanted === "active" ? active?.id ?? null : wanted === "all" ? null : wanted;
    const backlogStatus = statuses.find((s) => s.glyph === "backlog")?.id;
    const tasks = ctx.db.tasks
      .filter((t) => t.projectId === p.id && !t.deletedAt && !t.parentId)
      .filter((t) => (sprintId ? t.sprintId === sprintId : t.statusId !== backlogStatus))
      .sort(comparePosition)
      .map((t) => toTask(ctx.db, t));
    recordRecent(ctx.db, ctx.userId!, "project", p.id);
    return { statuses, tasks, sprintId };
  });

  route("POST", "/tasks/:id/move", (ctx) => {
    const t = taskById(ctx, ctx.params.id!);
    requireProject(ctx, t.projectId, "task.move");
    const b = (ctx.body ?? {}) as { statusId?: string; sprintId?: string | null; position?: string; version?: number };
    checkVersion(t, b.version, ctx.db);
    if (typeof b.position !== "string" || !/^[0-9A-Za-z]+$/.test(b.position)) invalid({ position: "Invalid position" });
    const from = t.statusId;
    if (b.statusId && b.statusId !== t.statusId) {
      applyStatusSideEffects(ctx.db, t, b.statusId);
      t.statusId = b.statusId;
    }
    if (b.sprintId !== undefined) {
      if (b.sprintId && !ctx.db.sprints.some((s) => s.id === b.sprintId && s.projectId === t.projectId)) invalid({ sprintId: "Unknown sprint" });
      t.sprintId = b.sprintId;
    }
    t.position = b.position;
    t.version += 1;
    t.updatedAt = nowISO();
    if (from !== t.statusId) {
      logActivity(ctx.db, ctx.userId, "status_changed", t.projectId, t, { from: statusName(ctx.db, from), to: statusName(ctx.db, t.statusId) });
      if (t.assigneeId) notify(ctx.db, t.assigneeId, "status", ctx.userId, t, t.projectId, { fromStatus: statusName(ctx.db, from), toStatus: statusName(ctx.db, t.statusId) });
    }
    return toTask(ctx.db, t);
  });

  route("GET", "/projects/:id/backlog", (ctx) => {
    const p = memberProject(ctx, ctx.params.id!);
    const tasks = ctx.db.tasks.filter((t) => t.projectId === p.id && !t.deletedAt && !t.parentId);
    const sprints = ctx.db.sprints
      .filter((s) => s.projectId === p.id && s.state !== "completed")
      .sort((a, b) => (a.state === "active" ? -1 : b.state === "active" ? 1 : a.number - b.number));
    return {
      sprints: sprints.map((s) => ({ sprintId: s.id, tasks: tasks.filter((t) => t.sprintId === s.id).sort(comparePosition).map((t) => toTask(ctx.db, t)) })),
      backlog: tasks.filter((t) => !t.sprintId).sort(comparePosition).map((t) => toTask(ctx.db, t)),
    };
  });

  /* comments */
  route("GET", "/tasks/:id/comments", (ctx) => {
    const t = taskById(ctx, ctx.params.id!);
    return ctx.db.comments.filter((c) => c.taskId === t.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  });
  route("POST", "/tasks/:id/comments", (ctx) => {
    const t = taskById(ctx, ctx.params.id!);
    requireProject(ctx, t.projectId, "comment.create");
    const body = (ctx.body as { body?: RichDoc })?.body;
    const text = richText(body);
    if (!body || !text) invalid({ body: "Write something first" });
    if (text.length > 2000) invalid({ body: "Keep comments under 2,000 characters" });
    const c: Comment = { id: uid("c"), taskId: t.id, authorId: ctx.userId!, body, mentions: mentionIds(body), createdAt: nowISO(), editedAt: null };
    ctx.db.comments.push(c);
    logActivity(ctx.db, ctx.userId, "commented", t.projectId, t);
    const quote = text.slice(0, 140);
    c.mentions.forEach((m) => notify(ctx.db, m, "mention", ctx.userId, t, t.projectId, { quote }));
    new Set([t.assigneeId, t.reporterId].filter((x): x is string => Boolean(x) && !c.mentions.includes(x!))).forEach((r) =>
      notify(ctx.db, r, "comment", ctx.userId, t, t.projectId, { quote }),
    );
    return c;
  });
  route("PATCH", "/comments/:id", (ctx) => {
    const userId = requireUser(ctx);
    const c = ctx.db.comments.find((x) => x.id === ctx.params.id);
    if (!c) fail(404, "not_found", "Comment not found.");
    const t = taskById(ctx, c.taskId);
    requireProject(ctx, t.projectId, "comment.edit_own");
    if (c.authorId !== userId) fail(403, "forbidden", "You can only edit your own comments.", { permission: "comment.edit_own" });
    const body = (ctx.body as { body?: RichDoc })?.body;
    if (!body || !richText(body)) invalid({ body: "Write something first" });
    c.body = body;
    c.mentions = mentionIds(body);
    c.editedAt = nowISO();
    return c;
  });
  route("DELETE", "/comments/:id", (ctx) => {
    const userId = requireUser(ctx);
    const c = ctx.db.comments.find((x) => x.id === ctx.params.id);
    if (!c) fail(404, "not_found", "Comment not found.");
    const t = taskById(ctx, c.taskId);
    const perms = projectPermissions(ctx.db, userId, t.projectId);
    const own = c.authorId === userId && perms.includes("comment.edit_own");
    if (!own && !perms.includes("comment.delete_any")) fail(403, "forbidden", "You can’t delete this comment.", { permission: "comment.delete_any" });
    trashComment(ctx.db, c, userId); // board 29: deleted comments go to the Trash for 30 days
    ctx.db.comments = ctx.db.comments.filter((x) => x.id !== c.id);
    return undefined;
  });

  /* attachments: signed URL → direct upload → confirm */
  route("GET", "/tasks/:id/attachments", (ctx) => {
    const t = taskById(ctx, ctx.params.id!);
    return ctx.db.attachments.filter((a) => a.taskId === t.id).map(toAttachment);
  });
  route("POST", "/tasks/:id/attachments/upload-url", (ctx) => {
    const t = taskById(ctx, ctx.params.id!);
    requireProject(ctx, t.projectId, "attachment.upload");
    const fileName = str(ctx.body, "fileName") ?? "";
    const size = Number((ctx.body as { size?: number })?.size ?? 0);
    const mimeType = str(ctx.body, "mimeType") ?? "";
    const problem = validateUpload({ name: fileName, size, type: mimeType });
    if (problem) invalid({ file: problem });
    const uploadId = uid("up");
    uploads.set(uploadId, { taskId: t.id, fileName: fileName.slice(0, 120), size, mimeType });
    return { uploadId, url: `mock-upload://${uploadId}`, method: "PUT", headers: { "Content-Type": mimeType || "application/octet-stream" }, expiresAt: new Date(Date.now() + 600_000).toISOString() };
  });
  route("POST", "/tasks/:id/attachments", (ctx) => {
    const t = taskById(ctx, ctx.params.id!);
    requireProject(ctx, t.projectId, "attachment.upload");
    const uploadId = str(ctx.body, "uploadId") ?? "";
    const up = uploads.get(uploadId);
    if (!up || up.taskId !== t.id || !up.blob) fail(400, "upload_missing", "Upload not found or incomplete. Try again.");
    const kind = kindOf(up.fileName, up.mimeType);
    const url = URL.createObjectURL(up.blob);
    const a: AttachmentRec = {
      id: uid("at"),
      taskId: t.id,
      uploaderId: ctx.userId!,
      fileName: up.fileName,
      size: up.size,
      mimeType: up.mimeType,
      kind,
      downloadUrl: url,
      previewUrl: kind === "image" ? url : null,
      createdAt: nowISO(),
    };
    ctx.db.attachments.push(a);
    uploads.delete(uploadId);
    logActivity(ctx.db, ctx.userId, "attached", t.projectId, t, { file: a.fileName });
    return toAttachment(a);
  });
  route("DELETE", "/attachments/:id", (ctx) => {
    const userId = requireUser(ctx);
    const a = ctx.db.attachments.find((x) => x.id === ctx.params.id);
    if (!a) fail(404, "not_found", "File not found.");
    const t = taskById(ctx, a.taskId);
    const perms = projectPermissions(ctx.db, userId, t.projectId);
    if (!(a.uploaderId === userId && perms.includes("attachment.upload")) && !perms.includes("attachment.delete_any"))
      fail(403, "forbidden", "You can’t delete this file.", { permission: "attachment.delete_any" });
    ctx.db.attachments = ctx.db.attachments.filter((x) => x.id !== a.id);
    return undefined;
  });
}

export function recordRecent(db: MockDB, userId: string, kind: "task" | "project", id: string) {
  db.recents = [{ userId, kind, id, at: nowISO() }, ...db.recents.filter((r) => !(r.userId === userId && r.id === id))].slice(0, 30);
}
