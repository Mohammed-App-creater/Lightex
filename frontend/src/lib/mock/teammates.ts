import { comparePosition, keyBetween } from "@/lib/utils/fractional-index";
import { getDB, mockSession, nowISO, persist } from "./db";
import { mockControls } from "./controls";
import { logActivity, notify } from "./handlers/common";

/*
 * Simulated teammates: every ~45s (tab visible) someone else nudges a task forward.
 * This is what makes the 30s board/inbox polling observable in mock mode, and it bumps
 * task versions so an in-flight drag can hit a real `version_conflict`.
 */

let started = false;

export function startTeammates() {
  if (started || typeof window === "undefined") return;
  started = true;
  window.setInterval(() => {
    if (document.visibilityState !== "visible" || !mockControls.get().teammates) return;
    simulateTeammateEdit();
  }, 45_000);
}

const FLOW = ["todo", "progress", "review", "done"] as const;

/** Moves one task (or `taskId`) one step along the flow as another project member. Returns its key. */
export function simulateTeammateEdit(taskId?: string): string | null {
  const db = getDB();
  const me = mockSession.get();
  if (!me) return null;
  const myProjects = db.projectMembers.filter((m) => m.userId === me).map((m) => m.projectId);
  const candidates = db.tasks.filter((t) => {
    if (t.deletedAt || !myProjects.includes(t.projectId) || t.parentId) return false;
    if (taskId) return t.id === taskId;
    const s = db.statuses.find((x) => x.id === t.statusId);
    const sprint = db.sprints.find((x) => x.id === t.sprintId);
    return sprint?.state === "active" && s && s.glyph !== "done" && s.glyph !== "canceled" && s.glyph !== "backlog";
  });
  const task = candidates[Math.floor(Math.random() * candidates.length)];
  if (!task) return null;
  const others = db.projectMembers.filter((m) => m.projectId === task.projectId && m.userId !== me).map((m) => m.userId);
  const actor = others[Math.floor(Math.random() * others.length)] ?? null;
  const current = db.statuses.find((s) => s.id === task.statusId)!;
  const idx = FLOW.indexOf(current.glyph as (typeof FLOW)[number]);
  const nextGlyph = FLOW[Math.min(FLOW.length - 1, Math.max(0, idx) + 1)]!;
  const next = db.statuses.find((s) => s.projectId === task.projectId && s.glyph === nextGlyph)!;
  if (next.id !== task.statusId) {
    const col = db.tasks.filter((t) => t.projectId === task.projectId && t.statusId === next.id && !t.deletedAt).sort(comparePosition);
    task.statusId = next.id;
    task.position = keyBetween(null, col[0]?.position ?? null);
    if (next.glyph === "done") task.completedAt = nowISO();
    if (next.category === "in_progress") task.startedAt ??= nowISO();
    logActivity(db, actor, "status_changed", task.projectId, task, { from: current.name, to: next.name });
    if (task.assigneeId === me) {
      notify(db, me, "status", actor, task, task.projectId, { fromStatus: current.name, toStatus: next.name });
    }
  }
  task.version += 1;
  task.updatedAt = nowISO();
  persist();
  return task.key;
}
