import { beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "@/api/errors";
import type { ChecklistItem, Paginated, Task, TaskDetail, WorkloadReport } from "@/api/types";
import { mockControls } from "./controls";
import { getDB, mockSession, resetDB } from "./db";
import type { TaskRec } from "./db-types";
import { ensureExtChecklist, migrateAssignees } from "./handlers/checklist";
import { mockBus } from "./realtime";
import { MockTransport } from "./transport";

/* docs/tracking/checklist-assignees.md: multiple assignees and task checklists, as the mock enforces them. */

const t = new MockTransport();
const as = (userId: string | null) => mockSession.set(userId);
const req = <T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown, query?: Parameters<MockTransport["request"]>[0]["query"]) =>
  t.request<T>({ method, path, body, query });

async function rejects(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e as ApiError;
  }
  throw new Error("expected rejection");
}

const T42 = "p_prj-t42";
const T57 = "p_prj-t57";
const detail = (key = "PRJ-42") => req<TaskDetail>("GET", `/tracking/workspaces/platform/tasks/${key}`);
const rec = (id: string) => getDB().tasks.find((x) => x.id === id)!;
const fieldError = (e: ApiError, field: string) => (e.details?.fields as Record<string, string> | undefined)?.[field];

/** Removes tracking.task.assign from u_sam's PRJ role (Member). */
function samCannotAssign() {
  const db = getDB();
  const roleId = db.projectMembers.find((m) => m.userId === "u_sam" && m.projectId === "p_prj")!.roleId;
  const role = db.roles.find((r) => r.id === roleId)!;
  role.permissions = role.permissions.filter((p) => p !== "tracking.task.assign");
}

beforeEach(() => {
  resetDB();
  mockBus.resetForTests();
  mockControls.set((c) => ({ ...c, errorRate: 0, latencyMin: 0, latencyMax: 0, offline: false, teammates: false }));
  as("u_alex");
});

describe("multiple assignees", () => {
  it("seeds co-assignees and answers assigneeIds in order", async () => {
    const d = await detail();
    expect(d.assigneeIds).toEqual(["u_alex", "u_jordan"]);
    expect((await detail("PRJ-57")).assigneeIds).toEqual(["u_taylor", "u_sam"]);
    expect("assigneeId" in d).toBe(false);
    expect((await detail("PRJ-33")).assigneeIds).toEqual(["u_jordan", "u_alex", "u_taylor"]);
  });

  it("migrates a cached record with the single assigneeId", () => {
    const legacy = { id: "x", assigneeId: "u_sam" } as unknown as TaskRec;
    migrateAssignees(legacy);
    expect(legacy.assigneeIds).toEqual(["u_sam"]);
    expect("assigneeId" in legacy).toBe(false);
    const none = { id: "y", assigneeId: null } as unknown as TaskRec;
    migrateAssignees(none);
    expect(none.assigneeIds).toEqual([]);
    // A whole cached database: every task record, then the seeded extras once.
    const db = getDB();
    db.tasks.forEach((x) => {
      const r = x as TaskRec & { assigneeId?: string | null };
      r.assigneeId = x.assigneeIds[0] ?? null;
      delete (r as Partial<TaskRec>).assigneeIds;
    });
    ensureExtChecklist(db);
    expect(rec(T42).assigneeIds).toEqual(["u_alex"]);
  });

  it("replaces the set on PATCH (order kept, duplicates dropped) and notifies each newly added person once", async () => {
    const before = getDB().notifications.length;
    const out = await req<Task>("PATCH", `/tracking/tasks/${T42}`, { assigneeIds: ["u_jordan", "u_sam", "u_jordan", "u_taylor"] });
    expect(out.assigneeIds).toEqual(["u_jordan", "u_sam", "u_taylor"]);
    const fresh = getDB().notifications.slice(0, getDB().notifications.length - before);
    expect(fresh.filter((n) => n.type === "assigned").map((n) => n.recipientId).sort()).toEqual(["u_sam", "u_taylor"]);
    const audit = getDB().audit.find((a) => a.action === "tracking.task.assigned" && a.entityKey === "PRJ-42")!;
    expect(audit.changes).toEqual([
      { field: "Assignee", kind: "person", before: "u_alex", after: null },
      { field: "Assignee", kind: "person", before: null, after: "u_sam" },
      { field: "Assignee", kind: "person", before: null, after: "u_taylor" },
    ]);
    const act = getDB().activity.find((a) => a.verb === "assigned" && a.taskId === T42)!;
    expect(act.data).toEqual({ assignee: "Jordan Lee, Sam Patel, Taylor Ng", assigneeCount: 3 });
    // [] and null unassign everyone.
    expect((await req<Task>("PATCH", `/tracking/tasks/${T42}`, { assigneeIds: null })).assigneeIds).toEqual([]);
    expect(getDB().activity.find((a) => a.verb === "assigned" && a.taskId === T42)!.data).toEqual({ assignee: "nobody", assigneeCount: 0 });
  });

  it("validates assigneeIds with the contract's messages", async () => {
    expect(fieldError(await rejects(req("PATCH", `/tracking/tasks/${T42}`, { assigneeIds: "u_sam" })), "assigneeIds")).toBe("Send a list of ids");
    const eleven = Array.from({ length: 11 }, (_, i) => `u_${i}`);
    expect(fieldError(await rejects(req("PATCH", `/tracking/tasks/${T42}`, { assigneeIds: eleven })), "assigneeIds")).toBe("Assign up to 10 people");
    expect(fieldError(await rejects(req("PATCH", `/tracking/tasks/${T42}`, { assigneeIds: ["u_casey"] })), "assigneeIds")).toBe("Assign people on this project");
    const old = await rejects(req("PATCH", `/tracking/tasks/${T42}`, { assigneeId: "u_sam" }));
    expect(old.status).toBe(422);
    expect(fieldError(old, "assigneeId")).toBe("This field can’t be changed here");
    expect(rec(T42).assigneeIds).toEqual(["u_alex", "u_jordan"]);
  });

  it("needs tracking.task.assign to change the set, but not to reorder it", async () => {
    samCannotAssign();
    as("u_sam");
    // edit_own covers a task where u_sam is one of the assignees.
    const reordered = await req<Task>("PATCH", `/tracking/tasks/${T57}`, { assigneeIds: ["u_sam", "u_taylor"] });
    expect(reordered.assigneeIds).toEqual(["u_sam", "u_taylor"]);
    const e = await rejects(req("PATCH", `/tracking/tasks/${T57}`, { assigneeIds: ["u_sam"] }));
    expect(e.status).toBe(403);
    expect(e.message).toBe("You can’t reassign tasks.");
    expect(e.details?.permission).toBe("tracking.task.assign");
    // Create: yourself is fine, anyone else needs the permission.
    const mine = await req<Task>("POST", "/tracking/projects/p_prj/tasks", { title: "Mine", assigneeIds: ["u_sam"] });
    expect(mine.assigneeIds).toEqual(["u_sam"]);
    const other = await rejects(req("POST", "/tracking/projects/p_prj/tasks", { title: "Ours", assigneeIds: ["u_sam", "u_alex"] }));
    expect(other.status).toBe(403);
    expect(other.message).toBe("You can’t assign tasks to others.");
  });

  it("bulk patch replaces the set and refuses the old field", async () => {
    const ids = [T42, "p_prj-t54"];
    const out = await req<Task[]>("POST", "/tracking/projects/p_prj/tasks/bulk", { ids, patch: { assigneeIds: ["u_jordan"] } });
    expect(out.map((x) => x.assigneeIds)).toEqual([["u_jordan"], ["u_jordan"]]);
    const e = await rejects(req("POST", "/tracking/projects/p_prj/tasks/bulk", { ids, patch: { assigneeId: "u_sam" } }));
    expect(e.status).toBe(422);
  });

  it("filters by any assignee, `none` = nobody assigned, on project and workspace lists", async () => {
    const sam = await req<Paginated<Task>>("GET", "/tracking/projects/p_prj/tasks", undefined, { filter: { assignee: "u_sam" }, limit: 500 });
    expect(sam.data.map((x) => x.key)).toContain("PRJ-57");
    expect(sam.data.every((x) => x.assigneeIds.includes("u_sam"))).toBe(true);
    const none = await req<Paginated<Task>>("GET", "/tracking/projects/p_prj/tasks", undefined, { filter: { assignee: "none" }, limit: 500 });
    expect(none.data.length).toBeGreaterThan(0);
    expect(none.data.every((x) => x.assigneeIds.length === 0)).toBe(true);
    as("u_taylor");
    const mine = await req<Paginated<Task>>("GET", "/tracking/workspaces/platform/tasks", undefined, { filter: { assignee: "me" }, limit: 200 });
    expect(mine.data.map((x) => x.key)).toEqual(expect.arrayContaining(["PRJ-33", "PRJ-57"]));
  });

  it("edit_own covers any assignee", async () => {
    as("u_sam");
    const ok = await req<Task>("PATCH", `/tracking/tasks/${T57}`, { priority: 2 });
    expect(ok.priority).toBe(2);
  });

  it("counts a multi-assignee task in full for each assignee in the workload report", async () => {
    const load = () => req<WorkloadReport>("GET", "/tracking/projects/p_prj/reports/workload", undefined, { filter: { sprint: "sp_14" } });
    const row = (r: WorkloadReport, id: string) => r.rows.find((x) => x.user.id === id)!;
    const both = await load();
    rec(T42).assigneeIds = ["u_alex"];
    const alexOnly = await load();
    expect(row(both, "u_alex").inProgress).toBe(row(alexOnly, "u_alex").inProgress);
    expect(row(both, "u_jordan").inProgress - row(alexOnly, "u_jordan").inProgress).toBe(3);
  });
});

describe("task checklist", () => {
  const base = `/tracking/tasks/${T42}/checklist`;

  it("lists the checklist in position order on the detail and counts it on Task", async () => {
    const d = await detail();
    expect(d.checklist.map((i) => i.text)).toEqual([
      "Reproduce with the sidebar collapsing mid-drag",
      "Add a ResizeObserver to the board",
      "Debounce reflow on sidebar toggle",
      "Regression test: drag while resizing",
      "Check Safari and Firefox",
    ]);
    expect(d).toMatchObject({ checklistCount: 5, checklistDoneCount: 2 });
    const board = await req<{ tasks: Task[] }>("GET", "/tracking/projects/p_prj/board");
    expect(board.tasks.find((x) => x.id === T42)).toMatchObject({ checklistCount: 5, checklistDoneCount: 2 });
    expect(board.tasks.find((x) => x.key === "PRJ-54")).toMatchObject({ checklistCount: 0, checklistDoneCount: 0 });
  });

  it("adds last (or at a position), checks, renames, moves and removes without bumping the version", async () => {
    const version = rec(T42).version;
    const feed = getDB().activity.length;
    const events: unknown[] = [];
    const off = mockBus.subscribe((e) => e.type === "tracking.task.changed" && events.push(e.data));
    const added = await req<ChecklistItem>("POST", base, { text: "  Ship it  " });
    expect(added).toMatchObject({ taskId: T42, text: "Ship it", done: false, doneAt: null, doneById: null, createdById: "u_alex" });
    let d = await detail();
    expect(d.checklist.at(-1)!.id).toBe(added.id);
    const first = await req<ChecklistItem>("POST", base, { text: "First", position: "0V" });
    d = await detail();
    expect(d.checklist[0]!.id).toBe(first.id);

    const checked = await req<ChecklistItem>("PATCH", `${base}/${added.id}`, { done: true });
    expect(checked.done).toBe(true);
    expect(checked.doneById).toBe("u_alex");
    expect(checked.doneAt).not.toBeNull();
    const unchecked = await req<ChecklistItem>("PATCH", `${base}/${added.id}`, { done: false });
    expect(unchecked).toMatchObject({ done: false, doneAt: null, doneById: null });
    expect((await req<ChecklistItem>("PATCH", `${base}/${added.id}`, { text: "Ship it today" })).text).toBe("Ship it today");
    await req("DELETE", `${base}/${added.id}`);
    d = await detail();
    expect(d.checklist.some((i) => i.id === added.id)).toBe(false);
    expect(d.checklistCount).toBe(6);
    expect(rec(T42).version).toBe(version);
    off();
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => JSON.stringify(e).includes('"fields":["checklist"]') && (e as { version: unknown }).version === null)).toBe(true);
    const ops = getDB()
      .audit.filter((a) => a.action === "tracking.task.checklist_updated")
      .map((a) => a.changes?.find((c) => c.field === "op")?.after);
    expect(ops).toEqual(["removed", "renamed", "unchecked", "checked", "added", "added"]);
    // Audit only: nothing in the activity feed.
    expect(getDB().activity.length).toBe(feed);
  });

  it("validates with the contract's messages", async () => {
    const item = (await detail()).checklist[0]!;
    expect(fieldError(await rejects(req("POST", base, { text: "   " })), "text")).toBe("Write what needs doing");
    expect(fieldError(await rejects(req("POST", base, { text: "x".repeat(501) })), "text")).toBe("Up to 500 characters");
    expect((await rejects(req("POST", base, { text: "ok", done: true }))).status).toBe(422);
    expect(fieldError(await rejects(req("POST", base, { text: "ok", position: "bad key!" })), "position")).toBe("Invalid position");
    expect(fieldError(await rejects(req("PATCH", `${base}/${item.id}`, { done: "yes" })), "done")).toBe("Send true or false");
    expect(fieldError(await rejects(req("PATCH", `${base}/${item.id}`, { position: "" })), "position")).toBe("Invalid position");
    expect((await rejects(req("PATCH", `${base}/${item.id}`, { colour: "red" }))).status).toBe(422);
    // An item of another task is a 404.
    const other = await req<ChecklistItem>("POST", "/tracking/tasks/p_prj-t54/checklist", { text: "Elsewhere" });
    expect((await rejects(req("PATCH", `${base}/${other.id}`, { done: true }))).status).toBe(404);
    expect((await rejects(req("DELETE", `${base}/nope`))).status).toBe(404);
  });

  it("stops at 100 items with 409 checklist_limit", async () => {
    const db = getDB();
    for (let i = (await detail()).checklistCount; i < 100; i++) {
      db.checklist!.push({ id: `cl_fill_${i}`, taskId: T42, text: `Item ${i}`, done: false, position: `z${String(i).padStart(3, "1")}`, doneAt: null, doneById: null, createdAt: "", createdById: null });
    }
    const e = await rejects(req("POST", base, { text: "One too many" }));
    expect(e.status).toBe(409);
    expect(e.code).toBe("checklist_limit");
  });

  it("uses the task edit rule (403), and refuses deleted tasks (409)", async () => {
    as("u_taylor");
    const e = await rejects(req("POST", base, { text: "Viewer" }));
    expect(e.status).toBe(403);
    expect(e.message).toBe("You can only edit tasks you reported or are assigned.");
    expect(e.details?.permission).toBe("tracking.task.edit_any");
    // edit_own: u_sam is one of PRJ-57's assignees, but not PRJ-54's.
    as("u_sam");
    const db = getDB();
    const roleId = db.projectMembers.find((m) => m.userId === "u_sam" && m.projectId === "p_prj")!.roleId;
    const role = db.roles.find((r) => r.id === roleId)!;
    role.permissions = role.permissions.filter((p) => p !== "tracking.task.edit_any");
    expect((await req<ChecklistItem>("POST", `/tracking/tasks/${T57}/checklist`, { text: "Mine" })).text).toBe("Mine");
    expect((await rejects(req("POST", "/tracking/tasks/p_prj-t54/checklist", { text: "Not mine" }))).status).toBe(403);
    as("u_alex");
    await req("DELETE", `/tracking/tasks/${T42}`);
    const gone = await rejects(req("POST", base, { text: "Late" }));
    expect(gone.status).toBe(409);
    expect(gone.code).toBe("task_deleted");
  });
});
