import { beforeEach, describe, expect, it } from "vitest";
import type { ApiError } from "@/lib/api/errors";
import type { CustomField, Project, RunningTimer, SavedView, Task, TaskDependencies, TaskDetail, TimeEntry, Timesheet } from "@/lib/api/types";
import { addDaysISO, todayISO } from "@/lib/utils/dates";
import { mockControls } from "./controls";
import { getDB, mockSession, resetDB, setDB } from "./db";
import { ensureExt39, findCycle, weekStartOf } from "./handlers/extensions";
import { createSeed } from "./seed";
import { MockTransport } from "./transport";

/* Board 39 (v2) mock endpoints: custom fields, dependencies, time tracking, timesheet. */

const t = new MockTransport();
const as = (userId: string) => mockSession.set(userId);
type M = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
const req = <T,>(method: M, path: string, body?: unknown, query?: Parameters<MockTransport["request"]>[0]["query"]) => t.request<T>({ method, path, body, query });
async function rejects(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e as ApiError;
  }
  throw new Error("expected rejection");
}
const task = (n: number) => getDB().tasks.find((x) => x.id === `p_prj-t${n}`)!;
const detail = (key: string) => req<TaskDetail>("GET", `/workspaces/platform/tasks/${key}`);

beforeEach(() => {
  resetDB();
  mockControls.set((c) => ({ ...c, errorRate: 0, latencyMin: 0, latencyMax: 0, offline: false, teammates: false }));
});

describe("seed and upgrade", () => {
  it("derives the new task fields from the seed", async () => {
    as("u_alex");
    const d = await detail("PRJ-42");
    expect(d.isBlocked).toBe(true);
    expect(d.openBlockers.map((b) => b.key)).toEqual(["PRJ-48"]);
    expect(d.timeEstimateMinutes).toBe(360);
    expect(d.loggedMinutes).toBe(255);
    expect(d.customFields["p_prj-cf-accounts"]).toBe(1240);
    expect(d.dependencies.blockedBy.map((x) => x.task.key)).toEqual(["PRJ-48", "PRJ-40"]);
    expect(d.dependencies.blocks.map((x) => x.task.key)).toEqual(["PRJ-47", "PRJ-68"]);
    const project = await req<Project>("GET", "/workspaces/platform/projects/PRJ");
    expect(project.my_permissions).toEqual(expect.arrayContaining(["field.manage", "time.log", "time.delete_any"]));
  });

  it("upgrades a v1-cached database exactly once (roles, seed, Blocked view)", () => {
    const db = createSeed();
    // Rewind to a v1 shape.
    delete db.customFields;
    delete db.dependencies;
    delete db.timeEntries;
    delete db.timers;
    delete db.ext39;
    db.views = undefined;
    db.viewPins = undefined;
    db.tasks.forEach((x) => {
      delete x.customFields;
      delete x.timeEstimateMinutes;
    });
    const member = db.roles.find((r) => r.key === "project_member" && r.workspaceId === "ws_platform")!;
    member.permissions = member.permissions.filter((p) => p !== "time.log");
    const custom = db.roles.find((r) => r.id === "ws_platform-role-release")!;
    const customBefore = [...custom.permissions];

    ensureExt39(db);
    expect(member.permissions).toContain("time.log");
    expect(custom.permissions).toEqual(customBefore);
    expect(db.customFields).toHaveLength(5);
    expect(db.dependencies).toHaveLength(5);
    const blocked = db.views!.filter((v) => v.name === "Blocked");
    expect(blocked.map((v) => v.ownerId).sort()).toEqual(["u_alex", "u_jordan", "u_morgan", "u_riley", "u_sam", "u_taylor"]);
    const alexPins = db.viewPins!.filter((p) => p.userId === "u_alex").sort((a, b) => a.position - b.position);
    expect(alexPins.at(-1)!.viewId).toBe("vw_blocked_u_alex");

    const counts = [db.customFields!.length, db.timeEntries!.length, db.views!.length];
    ensureExt39(db);
    expect([db.customFields!.length, db.timeEntries!.length, db.views!.length]).toEqual(counts);
  });
});

describe("custom fields (F1–F5, T1)", () => {
  it("lists, creates, validates, edits, reorders and deletes", async () => {
    as("u_alex");
    const list = await req<CustomField[]>("GET", "/projects/p_prj/custom-fields");
    expect(list.map((f) => f.name)).toEqual(["Browser", "Found in", "Accounts affected", "QA sign-off", "QA owner"]);
    expect(list[0]!.taskCount).toBe(4);

    const bad = await rejects(req("POST", "/projects/p_prj/custom-fields", { name: "browser", type: "select", options: [{ name: " ", color: "var(--low)" }] }));
    expect(bad.status).toBe(422);
    expect(bad.details?.fields).toEqual({ name: "A field with this name exists", options: "Add at least one option" });
    const badType = await rejects(req("POST", "/projects/p_prj/custom-fields", { name: "X", type: "color" }));
    expect((badType.details?.fields as Record<string, string>).type).toBe("Pick text, number, select, date or person");

    const env = await req<CustomField>("POST", "/projects/p_prj/custom-fields", {
      name: "Environment",
      type: "select",
      options: [
        { name: "Production", color: "var(--danger)" },
        { name: "Staging", color: "var(--warn)" },
        { name: "", color: "var(--low)" },
      ],
    });
    expect(env.position).toBe(5);
    expect(env.options.map((o) => o.name)).toEqual(["Production", "Staging"]);
    expect(env.taskCount).toBe(0);

    const typeChange = await rejects(req("PATCH", `/custom-fields/${env.id}`, { type: "text" }));
    expect((typeChange.details?.fields as Record<string, string>).type).toBe("A field’s type can’t be changed");

    // Value on a task, then removing its option clears it.
    const t48 = await detail("PRJ-48");
    await req<Task>("PATCH", `/tasks/${t48.id}`, { customFields: { [env.id]: env.options[1]!.id }, version: t48.version });
    expect((await req<CustomField[]>("GET", "/projects/p_prj/custom-fields")).find((f) => f.id === env.id)!.taskCount).toBe(1);
    const edited = await req<CustomField>("PATCH", `/custom-fields/${env.id}`, { name: "Env", options: [{ id: env.options[0]!.id, name: "Prod", color: "var(--danger)" }, { name: "Preview", color: "var(--low)" }] });
    expect(edited.name).toBe("Env");
    expect(edited.options.map((o) => o.name)).toEqual(["Prod", "Preview"]);
    expect(edited.taskCount).toBe(0);
    expect(task(48).customFields?.[env.id]).toBeUndefined();

    const ids = (await req<CustomField[]>("GET", "/projects/p_prj/custom-fields")).map((f) => f.id);
    expect((await rejects(req("PUT", "/projects/p_prj/custom-fields/order", { ids: ids.slice(1) }))).details?.fields).toEqual({ ids: "Send every field once" });
    const reordered = await req<CustomField[]>("PUT", "/projects/p_prj/custom-fields/order", { ids: [...ids].reverse() });
    expect(reordered[0]!.id).toBe(env.id);

    await req("DELETE", "/custom-fields/p_prj-cf-browser");
    const after = await req<CustomField[]>("GET", "/projects/p_prj/custom-fields");
    expect(after.map((f) => f.position)).toEqual([0, 1, 2, 3, 4]);
    expect(task(42).customFields?.["p_prj-cf-browser"]).toBeUndefined();
    expect(getDB().audit.some((a) => a.action === "project.custom_field_deleted")).toBe(true);
  });

  it("gates field management on field.manage", async () => {
    for (const u of ["u_sam", "u_taylor"]) {
      as(u);
      expect((await req<CustomField[]>("GET", "/projects/p_prj/custom-fields")).length).toBe(5);
      const e = await rejects(req("POST", "/projects/p_prj/custom-fields", { name: "Nope", type: "text" }));
      expect(e.status).toBe(403);
      expect(e.details?.permission).toBe("field.manage");
    }
  });

  it("merges values on PATCH, validates per type, bumps version once and refuses bulk", async () => {
    as("u_alex");
    const d = await detail("PRJ-42");
    const e = await rejects(
      req("PATCH", `/tasks/${d.id}`, {
        customFields: { "p_prj-cf-found": "", "p_prj-cf-accounts": -1, "p_prj-cf-browser": "nope", "p_prj-cf-qasignoff": "2026-13-40", "p_prj-cf-qaowner": "u_casey", gone: "x" },
        version: d.version,
      }),
    );
    expect(e.details?.fields).toEqual({
      "customFields.p_prj-cf-found": "This field is required",
      "customFields.p_prj-cf-accounts": "Enter a number from 0 to 1,000,000,000",
      "customFields.p_prj-cf-browser": "Pick one of the options",
      "customFields.p_prj-cf-qasignoff": "Pick a date",
      "customFields.p_prj-cf-qaowner": "Pick someone on this project",
      "customFields.gone": "This field was deleted",
    });
    expect((await rejects(req("PATCH", `/tasks/${d.id}`, { customFields: [], version: d.version }))).details?.fields).toEqual({ customFields: "Send an object of field ids" });
    expect((await rejects(req("PATCH", `/tasks/${d.id}`, { timeEstimateMinutes: 70_000, version: d.version }))).details?.fields).toEqual({ timeEstimateMinutes: "Estimate is 1 minute to 1000 hours" });

    const next = await req<Task>("PATCH", `/tasks/${d.id}`, { customFields: { "p_prj-cf-accounts": 12.346, "p_prj-cf-qaowner": null }, timeEstimateMinutes: 0, version: d.version });
    expect(next.version).toBe(d.version + 1);
    expect(next.customFields).toEqual({ "p_prj-cf-browser": "p_prj-cf-browser-safari", "p_prj-cf-found": "v2.3.1", "p_prj-cf-accounts": 12.35 });
    expect(next.timeEstimateMinutes).toBeNull();
    expect((await rejects(req("PATCH", `/tasks/${d.id}`, { customFields: {}, version: d.version }))).status).toBe(409);
    expect((await rejects(req("POST", "/projects/p_prj/tasks/bulk", { ids: [d.id], patch: { customFields: {} } }))).details?.fields).toEqual({ customFields: "This field can’t be bulk-edited" });
  });

  it("does not let task.move alone change values", async () => {
    as("u_sam"); // Member: edit_own only; PRJ-42 is Alex's.
    const d = await detail("PRJ-42");
    expect((await rejects(req("PATCH", `/tasks/${d.id}`, { customFields: { "p_prj-cf-found": "x" }, version: d.version }))).status).toBe(403);
  });
});

describe("dependencies (D1–D3)", () => {
  it("adds both relations, refuses self, sub-task, duplicates and cycles with the loop path", async () => {
    as("u_alex");
    const d = await detail("PRJ-42");
    const add = (taskId: string, relation: string, other: string) => req<TaskDependencies>("POST", `/tasks/${taskId}/dependencies`, { relation, taskId: other });
    expect((await rejects(add(d.id, "blocked_by", d.id))).details?.fields).toEqual({ taskId: "A task can’t depend on itself" });
    expect((await rejects(add(d.id, "blocks", "p_prj-t43"))).details?.fields).toEqual({ taskId: "A task and its sub-task can’t depend on each other" });
    expect((await rejects(add(d.id, "blocks", "p_mob-t12"))).details?.fields).toEqual({ taskId: "Pick a task from this project" });
    expect((await rejects(add(d.id, "sideways", "p_prj-t50"))).details?.fields).toEqual({ relation: "Pick blocked by or blocks" });
    expect((await rejects(add(d.id, "blocked_by", "p_prj-t48"))).code).toBe("dependency_exists");

    // 2-cycle: 42 blocks 47, so 47 can't block 42.
    const two = await rejects(add(d.id, "blocked_by", "p_prj-t47"));
    expect(two.status).toBe(409);
    expect(two.code).toBe("dependency_cycle");
    expect(two.details?.path).toEqual(["PRJ-42", "PRJ-47", "PRJ-42"]);
    expect(two.message).toBe("That would create a loop: PRJ-42 → PRJ-47 → PRJ-42.");

    // 3-cycle: 48 → 42 → 68; adding 68 blocks 48 closes it.
    const three = await rejects(add("p_prj-t68", "blocks", "p_prj-t48"));
    expect(three.details?.path).toEqual(["PRJ-48", "PRJ-42", "PRJ-68", "PRJ-48"]);
    expect(findCycle(getDB(), "p_prj-t50", "p_prj-t51")).toBeNull();

    const res = await add(d.id, "blocks", "p_prj-t50");
    expect(res.blocks.map((x) => x.task.key)).toEqual(["PRJ-47", "PRJ-68", "PRJ-50"]);
    expect((await detail("PRJ-50")).isBlocked).toBe(true);
    expect(getDB().audit.filter((a) => a.action === "task.dependency_added")).toHaveLength(2);
    const v = (await detail("PRJ-50")).version;

    const row = res.blocks.find((x) => x.task.key === "PRJ-50")!;
    await req("DELETE", `/tasks/p_prj-t50/dependencies/${row.id}`);
    const after = await detail("PRJ-50");
    expect(after.isBlocked).toBe(false);
    expect(after.version).toBe(v); // no version bump
    expect((await rejects(req("DELETE", `/tasks/p_prj-t50/dependencies/${row.id}`))).status).toBe(404);
  });

  it("closes a blocker when it is done and ignores deleted tasks", async () => {
    as("u_alex");
    const b = await detail("PRJ-48");
    await req("PATCH", `/tasks/${b.id}`, { statusId: "p_prj-st-done", version: b.version });
    expect((await detail("PRJ-42")).isBlocked).toBe(false);
    await req("DELETE", "/tasks/p_prj-t57");
    expect((await detail("PRJ-58")).isBlocked).toBe(false);
    expect((await req<TaskDependencies>("GET", "/tasks/p_prj-t58/dependencies")).blockedBy).toHaveLength(0);
    const list = await req<{ data: Task[] }>("GET", "/projects/p_prj/tasks", undefined, { filter: { blocked: "true" } });
    expect(list.data.map((x) => x.key).sort()).toEqual(["PRJ-47", "PRJ-68"]);
    expect((await rejects(req("GET", "/projects/p_prj/tasks", undefined, { filter: { blocked: "maybe" } }))).details?.fields).toEqual({ "filter[blocked]": "Use true or false" });
  });

  it("needs edit rights on the task (viewer and edit_own are refused)", async () => {
    as("u_taylor");
    expect((await rejects(req("POST", "/tasks/p_prj-t50/dependencies", { relation: "blocks", taskId: "p_prj-t51" }))).status).toBe(403);
    as("u_sam"); // reporter/assignee of PRJ-51 only
    expect((await rejects(req("POST", "/tasks/p_prj-t50/dependencies", { relation: "blocks", taskId: "p_prj-t51" }))).status).toBe(403);
    const ok = await req<TaskDependencies>("POST", "/tasks/p_prj-t51/dependencies", { relation: "blocked_by", taskId: "p_prj-t50" });
    expect(ok.isBlocked).toBe(true);
  });
});

describe("time (E1–E3, R1–R3)", () => {
  const today = todayISO();

  it("logs, validates, lists and deletes entries by permission", async () => {
    as("u_sam");
    const log = (body: unknown) => req<TimeEntry>("POST", "/tasks/p_prj-t51/time-entries", body);
    expect((await rejects(log({ minutes: 1.5, date: today }))).details?.fields).toEqual({ minutes: "Enter a duration" });
    expect((await rejects(log({ minutes: 0, date: today }))).details?.fields).toEqual({ minutes: "Duration must be over 0" });
    expect((await rejects(log({ minutes: 1441, date: today }))).details?.fields).toEqual({ minutes: "Max 24h per entry" });
    expect((await rejects(log({ minutes: 30, date: "nope" }))).details?.fields).toEqual({ date: "Pick a date" });
    expect((await rejects(log({ minutes: 30, date: addDaysISO(today, 5) }))).details?.fields).toEqual({ date: "Can’t log future time" });
    expect((await rejects(log({ minutes: 30, date: addDaysISO(today, -400) }))).details?.fields).toEqual({ date: "Date is too far back" });
    const e = await log({ minutes: 90, date: today, note: `  ${"x".repeat(200)}` });
    expect(e.note).toHaveLength(140);
    expect(e.source).toBe("manual");
    expect((await detail("PRJ-51")).loggedMinutes).toBeGreaterThanOrEqual(90);

    // Sam can't delete Alex's entry; Jordan (Manager) can.
    expect((await rejects(req("DELETE", "/time-entries/te_seed_1"))).details?.permission).toBe("time.delete_any");
    await req("DELETE", `/time-entries/${e.id}`);
    as("u_taylor");
    expect((await rejects(log({ minutes: 30, date: today }))).status).toBe(403);
    as("u_jordan");
    await req("DELETE", "/time-entries/te_seed_1");
    const list = await req<TimeEntry[]>("GET", "/tasks/p_prj-t42/time-entries");
    expect(list.map((x) => x.id)).toEqual(["te_seed_3", "te_seed_2"]);
  });

  it("starts, switches (logging the previous one) and stops the single per-user timer", async () => {
    as("u_alex");
    expect((await req<{ timer: RunningTimer | null }>("GET", "/me/timer")).timer).toBeNull();
    expect((await rejects(req("POST", "/me/timer/stop", { date: today }))).status).toBe(404);
    const a = await req<{ timer: RunningTimer; stopped: TimeEntry | null }>("POST", "/tasks/p_prj-t48/timer", { date: today });
    expect(a.timer.taskKey).toBe("PRJ-48");
    expect(a.stopped).toBeNull();
    const again = await req<{ timer: RunningTimer; stopped: TimeEntry | null }>("POST", "/tasks/p_prj-t48/timer", { date: today });
    expect(again.timer.startedAt).toBe(a.timer.startedAt);

    getDB().timers![0]!.startedAt = new Date(Date.now() - 12 * 60_000).toISOString();
    const sw = await req<{ timer: RunningTimer; stopped: TimeEntry | null }>("POST", "/tasks/p_prj-t54/timer", { date: today });
    expect(sw.timer.taskKey).toBe("PRJ-54");
    expect(sw.stopped).toMatchObject({ taskId: "p_prj-t48", minutes: 12, source: "timer" });

    getDB().timers![0]!.startedAt = new Date(Date.now() - 20_000).toISOString();
    const stop = await req<{ entry: TimeEntry }>("POST", "/me/timer/stop", { date: today });
    expect(stop.entry.minutes).toBe(1);
    expect((await req<{ timer: RunningTimer | null }>("GET", "/me/timer")).timer).toBeNull();
  });

  it("discards a timer when the task is deleted or time.log is lost", async () => {
    as("u_alex");
    await req("POST", "/tasks/p_prj-t54/timer", { date: today });
    await req("DELETE", "/tasks/p_prj-t54");
    const e = await rejects(req("POST", "/me/timer/stop", { date: today }));
    expect(e.code).toBe("task_deleted");
    expect(getDB().timers).toHaveLength(0);

    as("u_sam");
    await req("POST", "/tasks/p_prj-t51/timer", { date: today });
    const role = getDB().roles.find((r) => r.key === "project_member" && r.workspaceId === "ws_platform")!;
    role.permissions = role.permissions.filter((p) => p !== "time.log");
    const f = await rejects(req("POST", "/me/timer/stop", { date: today }));
    expect(f.status).toBe(403);
    expect(f.details?.permission).toBe("time.log");
    expect(getDB().timers).toHaveLength(0);
  });
});

describe("timesheet (S1)", () => {
  it("snaps to Monday, aggregates per project or per task and gates by visibility", async () => {
    expect(weekStartOf("2026-10-11")).toBe("2026-10-05"); // Sunday
    expect(weekStartOf("2026-11-01")).toBe("2026-10-26"); // across a month boundary
    as("u_alex");
    const ts = await req<Timesheet>("GET", "/workspaces/platform/timesheet", undefined, { filter: { week: todayISO() } });
    expect(ts.days).toHaveLength(7);
    expect(ts.weekStart).toBe(ts.days[0]);
    expect(ts.rows.length).toBeGreaterThan(0);
    expect(ts.rows.map((r) => r.user.name)).toEqual([...ts.rows.map((r) => r.user.name)].sort((a, b) => a.localeCompare(b)));
    expect(ts.dayTotals.reduce((a, b) => a + b, 0)).toBe(ts.totalMinutes);
    expect(ts.projects.map((p) => p.key)).toEqual(["INF", "MOB", "PRJ"]);
    const slices = ts.rows.flatMap((r) => r.cells.flatMap((c) => c.breakdown));
    expect(slices.every((s) => s.taskId === null)).toBe(true);

    const one = await req<Timesheet>("GET", "/workspaces/platform/timesheet", undefined, { filter: { week: todayISO(), project: "p_prj" } });
    expect(one.rows.flatMap((r) => r.cells.flatMap((c) => c.breakdown)).every((s) => s.taskId !== null && s.projectId === "p_prj")).toBe(true);
    for (const r of one.rows) for (const c of r.cells) expect(c.minutes).toBeGreaterThanOrEqual(c.breakdown.reduce((a, s) => a + s.minutes, 0));

    expect((await rejects(req("GET", "/workspaces/platform/timesheet", undefined, { filter: { week: "x" } }))).details?.fields).toEqual({ "filter[week]": "Pick a date" });
    as("u_taylor");
    expect((await rejects(req("GET", "/workspaces/platform/timesheet", undefined, { filter: { project: "p_inf" } }))).status).toBe(403);
  });
});

describe("saved views count on derived fields", () => {
  it("counts blocked and custom-field rules, ignoring rules on deleted fields", async () => {
    as("u_alex");
    const v = await req<SavedView>("POST", "/workspaces/platform/views", {
      projectId: "p_prj",
      name: "Safari bugs",
      filters: [
        { field: "cf.p_prj-cf-browser", op: "is", values: ["p_prj-cf-browser-safari"] },
        { field: "cf.p_prj-cf-accounts", op: "gt", values: ["1000"] },
        { field: "cf.p_prj-cf-found", op: "gt", values: ["1"] }, // wrong op for a text field: dropped
      ],
    });
    expect(v.filters).toHaveLength(2);
    expect(v.count).toBe(1);
    await req("DELETE", "/custom-fields/p_prj-cf-accounts");
    const list = await req<SavedView[]>("GET", "/workspaces/platform/views");
    expect(list.find((x) => x.id === v.id)!.count).toBe(2);
  });
});

it("keeps a fresh seed deterministic for the timesheet generator", () => {
  const a = createSeed();
  const b = createSeed();
  expect(a.timeEntries!.map((e) => [e.userId, e.date, e.minutes])).toEqual(b.timeEntries!.map((e) => [e.userId, e.date, e.minutes]));
  setDB(createSeed());
});
