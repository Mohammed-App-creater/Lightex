import type { ChecklistItem } from "@/api/types";
import { keyBetween, keysBetween } from "@/lib/utils/fractional-index";
import { nowISO, uid } from "../db";
import type { MockDB, TaskRec } from "../db-types";
import { checklistOf } from "../derive";
import { publishChecklist } from "../realtime";
import { fail, invalid, requireProject, requireUser, route, type Ctx } from "../router";
import { auditTask } from "./extensions";
import { canEditTask } from "./tasks";

/*
 * Task checklists and multiple assignees (docs/tracking/checklist-assignees.md). Checklist items live in the
 * optional `checklist` collection (no SCHEMA bump); `ensureExtChecklist` also moves cached task records from the
 * single `assigneeId` to `assigneeIds`.
 */

export const CHECKLIST_LIMIT = 100;
export const CHECKLIST_TEXT_MAX = 500;

const DELETED = "This task was deleted. Restore it to make changes.";
const CANT_EDIT = "You can only edit tasks you reported or are assigned.";

/** A task record cached before multiple assignees (`assigneeId`) → `assigneeIds`. */
export function migrateAssignees(t: TaskRec) {
  const legacy = t as TaskRec & { assigneeId?: string | null };
  if (!Array.isArray(legacy.assigneeIds)) legacy.assigneeIds = legacy.assigneeId ? [legacy.assigneeId] : [];
  if ("assigneeId" in legacy) delete legacy.assigneeId;
}

/** Seeded co-assignees (the first id is the seed's own assignee) and checklists, keyed by task id. */
const SEED_CO_ASSIGNEES: Record<string, string[]> = {
  "p_prj-t42": ["u_alex", "u_jordan"],
  "p_prj-t33": ["u_jordan", "u_alex", "u_taylor"],
  "p_prj-t57": ["u_taylor", "u_sam"],
};
const SEED_CHECKLISTS: Record<string, [string, boolean][]> = {
  "p_prj-t42": [
    ["Reproduce with the sidebar collapsing mid-drag", true],
    ["Add a ResizeObserver to the board", true],
    ["Debounce reflow on sidebar toggle", false],
    ["Regression test: drag while resizing", false],
    ["Check Safari and Firefox", false],
  ],
  "p_prj-t33": [
    ["Register the Okta app", true],
    ["SAML callback route", false],
    ["Map Okta groups to roles", false],
  ],
};

/**
 * Upgrades a database (seed or cache) once: `assigneeIds` on every task record (trashed projects too), the
 * `checklist` collection, and the seeded co-assignees and checklists.
 */
export function ensureExtChecklist(db: MockDB) {
  db.tasks.forEach(migrateAssignees);
  db.trash?.projects.forEach((p) => p.tasks.forEach(migrateAssignees));
  db.checklist ??= [];
  if (db.extChecklist) return;
  db.extChecklist = true;
  for (const [taskId, ids] of Object.entries(SEED_CO_ASSIGNEES)) {
    const t = db.tasks.find((x) => x.id === taskId);
    // Only a task still assigned as seeded (a cached database may have been edited since).
    if (!t || t.assigneeIds.length !== 1 || t.assigneeIds[0] !== ids[0]) continue;
    t.assigneeIds = ids.filter((u) => db.projectMembers.some((m) => m.projectId === t.projectId && m.userId === u));
  }
  for (const [taskId, items] of Object.entries(SEED_CHECKLISTS)) {
    const t = db.tasks.find((x) => x.id === taskId);
    if (!t || db.checklist.some((c) => c.taskId === taskId)) continue;
    const keys = keysBetween(null, null, items.length);
    items.forEach(([text, done], i) => {
      const at = new Date(new Date(t.createdAt).getTime() + (i + 1) * 3_600_000).toISOString();
      db.checklist!.push({
        id: `cl_${taskId}_${i + 1}`,
        taskId,
        text,
        done,
        position: keys[i]!,
        doneAt: done ? at : null,
        doneById: done ? (t.assigneeIds[0] ?? null) : null,
        createdAt: at,
        createdById: t.reporterId,
      });
    });
  }
}

/* ───────── validation (same order and messages as the backend's services) ───────── */

function checklistTask(ctx: Ctx): TaskRec {
  const userId = requireUser(ctx);
  const t = ctx.db.tasks.find((x) => x.id === ctx.params.taskId);
  if (!t) fail(404, "not_found", "Task not found.");
  requireProject(ctx, t.projectId, "tracking.project.view");
  if (t.deletedAt) fail(409, "task_deleted", DELETED);
  if (!canEditTask(ctx.db, userId, t)) fail(403, "forbidden", CANT_EDIT, { permission: "tracking.task.edit_any" });
  return t;
}

function checkText(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) invalid({ text: "Write what needs doing" });
  if (text.length > CHECKLIST_TEXT_MAX) invalid({ text: `Up to ${CHECKLIST_TEXT_MAX} characters` });
  return text;
}

function checkPosition(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9A-Za-z]+$/.test(value) || value.endsWith("0")) invalid({ position: "Invalid position" });
  return value;
}

function itemOf(ctx: Ctx, t: TaskRec): ChecklistItem {
  const item = (ctx.db.checklist ?? []).find((c) => c.id === ctx.params.itemId && c.taskId === t.id);
  if (!item) fail(404, "not_found", "Checklist item not found.");
  return item;
}

function audit(ctx: Ctx, t: TaskRec, op: "added" | "checked" | "unchecked" | "renamed" | "moved" | "removed", text: string) {
  auditTask(ctx.db, t.projectId, ctx.userId!, "tracking.task.checklist_updated", t.title, { key: t.key, targetId: t.id, data: { op, text: text.slice(0, 200) } });
}

/* ───────── routes ───────── */

export function registerChecklist() {
  route("POST", "/tracking/tasks/:taskId/checklist", (ctx) => {
    ensureExtChecklist(ctx.db);
    const t = checklistTask(ctx);
    const b = (ctx.body ?? {}) as Record<string, unknown>;
    const text = checkText(b.text);
    const unknown = Object.keys(b).filter((k) => k !== "text" && k !== "position").sort();
    if (unknown.length) invalid({ [unknown[0]!]: "This field can’t be set here" });
    const items = checklistOf(ctx.db, t.id);
    if (items.length >= CHECKLIST_LIMIT) fail(409, "checklist_limit", `A checklist can have up to ${CHECKLIST_LIMIT} items.`);
    const position = b.position === undefined || b.position === null ? keyBetween(items.at(-1)?.position ?? null, null) : checkPosition(b.position);
    const item: ChecklistItem = {
      id: uid("cl"),
      taskId: t.id,
      text,
      done: false,
      position,
      doneAt: null,
      doneById: null,
      createdAt: nowISO(),
      createdById: ctx.userId!,
    };
    ctx.db.checklist!.push(item);
    audit(ctx, t, "added", text);
    publishChecklist(ctx.db, ctx.userId, t);
    return item;
  });

  route("PATCH", "/tracking/tasks/:taskId/checklist/:itemId", (ctx) => {
    ensureExtChecklist(ctx.db);
    const t = checklistTask(ctx);
    const item = itemOf(ctx, t);
    const b = (ctx.body ?? {}) as Record<string, unknown>;
    const unknown = Object.keys(b).filter((k) => k !== "text" && k !== "done" && k !== "position").sort();
    if (unknown.length) invalid({ [unknown[0]!]: "This field can’t be changed here" });
    // Validate everything before writing anything.
    if ("done" in b && typeof b.done !== "boolean") invalid({ done: "Send true or false" });
    const text = "text" in b ? checkText(b.text) : undefined;
    const position = "position" in b ? checkPosition(b.position) : undefined;
    const ops: ("checked" | "unchecked" | "renamed" | "moved")[] = [];
    if (typeof b.done === "boolean" && b.done !== item.done) {
      item.done = b.done;
      item.doneAt = b.done ? nowISO() : null;
      item.doneById = b.done ? ctx.userId! : null;
      ops.push(b.done ? "checked" : "unchecked");
    }
    if (text !== undefined && text !== item.text) {
      item.text = text;
      ops.push("renamed");
    }
    if (position !== undefined && position !== item.position) {
      item.position = position;
      ops.push("moved");
    }
    if (ops.length) {
      audit(ctx, t, ops[0]!, item.text);
      publishChecklist(ctx.db, ctx.userId, t);
    }
    return { ...item };
  });

  route("DELETE", "/tracking/tasks/:taskId/checklist/:itemId", (ctx) => {
    ensureExtChecklist(ctx.db);
    const t = checklistTask(ctx);
    const item = itemOf(ctx, t);
    ctx.db.checklist = ctx.db.checklist!.filter((c) => c.id !== item.id);
    audit(ctx, t, "removed", item.text);
    publishChecklist(ctx.db, ctx.userId, t);
    return undefined;
  });
}
