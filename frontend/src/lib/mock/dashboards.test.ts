import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/errors";
import type { Dashboard, DashboardSummary, PresenceHeartbeat, PresenceRoster, Project, Task, WorkloadReport } from "@/lib/api/types";
import { presenceClaims } from "@/lib/realtime/presence";
import type { RealtimeEnvelope } from "@/lib/realtime/events";
import { mockControls } from "./controls";
import { getDB, mockSession, resetDB, setDB } from "./db";
import { createSeed } from "./seed";
import { presenceSessions, sweepPresence } from "./handlers/presence";
import { MockRealtimeSource, mockBus, type BusEvent } from "./realtime";
import { presenceTick, resetPresenceSim } from "./teammates";
import { MockTransport } from "./transport";

/* Board 33 mock backend: DB1–DB6, W1, progress quarter, P1–P3, the bus and the simulated stream. */

const t = new MockTransport();
const as = (u: string | null) => mockSession.set(u);
const req = <T>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown, query?: Parameters<MockTransport["request"]>[0]["query"]) =>
  t.request<T>({ method, path, body, query });
async function rejects(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e as ApiError;
  }
  throw new Error("expected rejection");
}

let events: BusEvent[] = [];
let unsub: () => void = () => undefined;

beforeEach(() => {
  resetDB();
  mockBus.resetForTests();
  presenceSessions.clear();
  presenceClaims.reset();
  mockControls.set((c) => ({ ...c, errorRate: 0, latencyMin: 0, latencyMax: 0, offline: false, teammates: false, realtime: "live" }));
  events = [];
  unsub = mockBus.subscribe((e) => events.push(e));
  as("u_alex");
});
afterEach(() => unsub());

const health = "db_prj_health";
const focus = "db_sam_focus";

describe("dashboards DB1–DB6 (§5.2)", () => {
  it("DB1 lists shared (A–Z) then the caller's personal ones", async () => {
    as("u_sam");
    const sam = await req<DashboardSummary[]>("GET", "/projects/p_prj/dashboards");
    expect(sam.map((d) => [d.name, d.visibility, d.widgetCount])).toEqual([
      ["Sprint 14 health", "shared", 6],
      ["My focus", "personal", 2],
    ]);
    as("u_alex");
    expect((await req<DashboardSummary[]>("GET", "/projects/p_prj/dashboards")).map((d) => d.name)).toEqual(["Sprint 14 health"]);
    expect(await req<DashboardSummary[]>("GET", "/projects/p_mob/dashboards")).toEqual([]);
  });

  it("DB3 returns every widget (the client hides unreadable ones); someone else's personal one is 404", async () => {
    const d = await req<Dashboard>("GET", `/dashboards/${health}`);
    expect(d.widgets.map((w) => `${w.type}:${w.w}x${w.h}`)).toEqual(["burndown:6x2", "my_tasks:3x2", "objectives:3x2", "workload:6x2", "velocity:3x2", "activity:3x2"]);
    expect(d.owner).toMatchObject({ id: "u_alex", name: "Alex Kim" });
    expect((await rejects(req("GET", `/dashboards/${focus}`))).status).toBe(404);
    as("u_casey");
    expect((await rejects(req("GET", `/dashboards/${health}`))).status).toBe(403);
    expect((await rejects(req("GET", `/dashboards/${focus}`))).status).toBe(404);
  });

  it("DB2 creates from a template, skipping report widgets the creator can't read", async () => {
    const d = await req<Dashboard>("POST", "/projects/p_prj/dashboards", { name: "  Release  ", visibility: "personal", template: "sprint_health" });
    expect(d).toMatchObject({ name: "Release", visibility: "personal", version: 1, ownerId: "u_alex" });
    expect(d.widgets).toHaveLength(6);
    // A role with dashboard.create but no report.view gets only My tasks and Recent activity.
    const db = getDB();
    const role = db.roles.find((r) => r.key === "project_member" && r.workspaceId === "ws_platform")!;
    role.permissions = role.permissions.filter((p) => p !== "report.view");
    as("u_sam");
    const s = await req<Dashboard>("POST", "/projects/p_prj/dashboards", { name: "Mine", visibility: "shared", template: "sprint_health" });
    expect(s.widgets.map((w) => w.type)).toEqual(["my_tasks", "activity"]);
    expect(events.filter((e) => e.type === "dashboard.changed").map((e) => (e.data as { op: string }).op)).toEqual(["created", "created"]);
  });

  it("DB2 validates name, visibility, template, permission and limits", async () => {
    const field = async (body: unknown) => (await rejects(req("POST", "/projects/p_prj/dashboards", body))).fieldErrors;
    expect(await field({ name: " ", visibility: "shared" })).toEqual({ name: "Name is required" });
    expect(await field({ name: "x".repeat(61), visibility: "shared" })).toEqual({ name: "Up to 60 characters" });
    expect(await field({ name: "sprint 14 HEALTH", visibility: "shared" })).toEqual({ name: "You already have a dashboard with this name" });
    expect(await field({ name: "A", visibility: "team" })).toEqual({ visibility: "Pick shared or personal" });
    expect(await field({ name: "A", visibility: "shared", template: "fancy" })).toEqual({ template: "Pick blank or sprint_health" });
    as("u_taylor");
    const e = await rejects(req("POST", "/projects/p_prj/dashboards", { name: "A", visibility: "shared" }));
    expect([e.status, e.code, e.details?.permission]).toEqual([403, "forbidden", "dashboard.create"]);
    as("u_alex");
    for (let i = 0; i < 10; i++) await req("POST", "/projects/p_prj/dashboards", { name: `P${i}`, visibility: "personal" });
    const lim = await rejects(req("POST", "/projects/p_prj/dashboards", { name: "P10", visibility: "personal" }));
    expect([lim.status, lim.code, lim.message]).toEqual([409, "dashboard_limit", "You can have up to 10 personal dashboards in a project."]);
    for (let i = 0; i < 19; i++) await req("POST", "/projects/p_prj/dashboards", { name: `S${i}`, visibility: "shared" });
    const sl = await rejects(req("POST", "/projects/p_prj/dashboards", { name: "S19", visibility: "shared" }));
    expect(sl.message).toBe("A project can have up to 20 shared dashboards.");
  });

  it("DB4 renames with version, 409 with details.current; only the owner changes visibility", async () => {
    const d = await req<Dashboard>("PATCH", `/dashboards/${health}`, { name: "Release health", version: 1 });
    expect([d.name, d.version]).toEqual(["Release health", 2]);
    const c = await rejects(req("PATCH", `/dashboards/${health}`, { name: "Again", version: 1 }));
    expect([c.status, c.code, (c.details?.current as Dashboard).version]).toEqual([409, "version_conflict", 2]);
    as("u_jordan"); // Manager: dashboard.manage, not the owner
    const v = await rejects(req("PATCH", `/dashboards/${health}`, { visibility: "personal", version: 2 }));
    expect([v.status, v.details?.permission, v.message]).toEqual([403, "dashboard.create", "Only the owner can change who sees this dashboard."]);
    const r = await req<Dashboard>("PATCH", `/dashboards/${health}`, { name: "Jordan’s rename", version: 2 });
    expect(r.version).toBe(3);
    as("u_sam"); // Member: no dashboard.manage on a shared one they don't own
    const m = await rejects(req("PATCH", `/dashboards/${health}`, { name: "Nope", version: 3 }));
    expect([m.status, m.details?.permission]).toEqual([403, "dashboard.manage"]);
    const own = await req<Dashboard>("PATCH", `/dashboards/${focus}`, { visibility: "shared", version: 1 });
    expect(own.visibility).toBe("shared");
  });

  it("DB5 creates, updates and deletes in one PUT, bumps the version once, audits once", async () => {
    const before = await req<Dashboard>("GET", `/dashboards/${health}`);
    const audits = getDB().audit.length;
    const [burn, , obj] = before.widgets;
    const d = await req<Dashboard>("PUT", `/dashboards/${health}/layout`, {
      version: 1,
      widgets: [
        { ...burn, w: 12 },
        { ...obj, h: 1 },
        { type: "velocity", w: 3, h: 2, config: { range: "last2", extra: true } },
      ],
    });
    expect(d.version).toBe(2);
    expect(d.widgets.map((w) => `${w.type}:${w.w}x${w.h}`)).toEqual(["burndown:12x2", "objectives:3x1", "velocity:3x2"]);
    expect(d.widgets[0]!.id).toBe(burn!.id);
    expect(d.widgets[2]!.config).toEqual({ range: "last2" }); // unknown keys dropped
    expect(getDB().audit.length).toBe(audits + 1);
    expect(getDB().audit[0]).toMatchObject({ action: "dashboard.layout_updated", target: "Sprint 14 health" });
    expect(events.filter((e) => e.type === "dashboard.changed").at(-1)).toMatchObject({ projectId: "p_prj", data: { dashboardId: health, op: "layout", version: 2 } });
  });

  it("DB5 checks the version first, then every rule", async () => {
    const c = await rejects(req("PUT", `/dashboards/${health}/layout`, { version: 9, widgets: "nope" }));
    expect(c.code).toBe("version_conflict");
    const err = async (widgets: unknown) => (await rejects(req("PUT", `/dashboards/${health}/layout`, { version: 1, widgets }))).fieldErrors;
    expect(await err("nope")).toEqual({ widgets: "Send a list of widgets" });
    expect(await err(Array.from({ length: 7 }, () => ({ type: "activity", w: 3, h: 1 })))).toEqual({ widgets: "Up to 6 widgets" });
    expect(await err([{ type: "activity", w: 3, h: 1 }, { type: "activity", w: 3, h: 1 }])).toMatchObject({ widgets: "Each widget type can appear once" });
    expect(await err([{ id: "nope", type: "activity", w: 3, h: 1 }])).toEqual({ "widgets.0.id": "Unknown widget" });
    expect(await err([{ id: "wg_prj_burn", type: "velocity", w: 3, h: 2 }])).toEqual({ "widgets.0.type": "A widget’s type can’t be changed" });
    expect(await err([{ type: "chart", w: 3, h: 2 }])).toEqual({ "widgets.0.type": "Pick a widget type" });
    expect(await err([{ type: "activity", w: 2, h: 1 }])).toEqual({ "widgets.0.w": "Width is 3 to 12 columns" });
    expect(await err([{ type: "activity", w: 3, h: 5 }])).toEqual({ "widgets.0.h": "Height is 1 to 4 rows" });
    expect(await err([{ type: "burndown", w: 6, h: 1 }])).toEqual({ "widgets.0.h": "Burndown needs at least 2 rows" });
    expect(await err([{ type: "burndown", w: 6, h: 2, config: { sprintId: "sp_mob_7" } }])).toEqual({ "widgets.0.config.sprintId": "Pick a sprint from this project" });
    expect(await err([{ type: "my_tasks", w: 3, h: 2, config: { showDone: "yes" } }])).toEqual({ "widgets.0.config.showDone": "Use true or false" });
    expect(await err([{ type: "objectives", w: 3, h: 2, config: { quarter: "x".repeat(17) } }])).toEqual({ "widgets.0.config.quarter": "Up to 16 characters" });
    expect(await err([{ type: "workload", w: 6, h: 2, config: { unit: "days", personField: "p_prj-cf-found" } }])).toEqual({
      "widgets.0.config.unit": "Pick points or hours",
      "widgets.0.config.personField": "Pick a person field from this project",
    });
    expect(await err([{ type: "velocity", w: 3, h: 2, config: { range: "last9" } }])).toEqual({ "widgets.0.config.range": "Pick last2 or last6" });
    // A person custom field is accepted.
    await req("PUT", `/dashboards/${health}/layout`, { version: 1, widgets: [{ type: "workload", w: 6, h: 2, config: { unit: "hours", sprintId: "sp_14", personField: "p_prj-cf-qaowner" } }] });
  });

  it("DB5: adding a report widget needs report.view; keeping one doesn't", async () => {
    const db = getDB();
    const custom = db.roles.find((r) => r.name === "Release captain")!;
    custom.permissions = [...custom.permissions.filter((p) => p !== "report.view"), "dashboard.manage"];
    as("u_riley");
    const add = await rejects(req("PUT", `/dashboards/${focus}/layout`, { version: 1, widgets: [] }));
    expect(add.status).toBe(404); // Sam's personal dashboard
    const d = await req<Dashboard>("GET", `/dashboards/${health}`);
    const kept = await req<Dashboard>("PUT", `/dashboards/${health}/layout`, { version: 1, widgets: [...d.widgets].reverse() });
    expect(kept.widgets[0]!.type).toBe("activity");
    const e = await rejects(req("PUT", `/dashboards/${health}/layout`, { version: 2, widgets: [{ type: "activity", w: 3, h: 2 }, { type: "burndown", w: 6, h: 2 }] }));
    expect(e.fieldErrors).toEqual({ "widgets.1.type": "You can’t view this report" });
  });

  it("DB6 deletes (hard) and archived projects are view only", async () => {
    as("u_sam");
    await req("DELETE", `/dashboards/${focus}`);
    expect(getDB().dashboards!.some((d) => d.id === focus)).toBe(false);
    expect(events.filter((e) => e.type === "dashboard.changed").at(-1)).toMatchObject({ userId: "u_sam", projectId: null, data: { op: "deleted", version: null } });
    as("u_alex");
    getDB().projects.find((p) => p.id === "p_prj")!.status = "archived";
    expect((await rejects(req("DELETE", `/dashboards/${health}`))).status).toBe(403);
    expect((await req<Dashboard>("GET", `/dashboards/${health}`)).id).toBe(health);
  });

  it("grants the dashboard keys per §4.2 and ensureExt33 upgrades a cached v1 DB exactly once", async () => {
    const p = await req<Project>("GET", "/workspaces/platform/projects/PRJ");
    expect(p.my_permissions.slice(-3)).toEqual(["dashboard.create", "dashboard.manage", "report.view"]);
    as("u_sam");
    const sam = await req<Project>("GET", "/workspaces/platform/projects/PRJ");
    expect(sam.my_permissions).toEqual(["project.view", "task.create", "task.edit_own", "task.assign", "task.move", "project.import", "time.log", "comment.create", "comment.edit_own", "attachment.upload", "dashboard.create", "report.view"]);
    // A database cached before board 33: no keys, no dashboards, no marker.
    const old = createSeed();
    delete old.ext33;
    delete old.dashboards;
    for (const r of old.roles) r.permissions = r.permissions.filter((x) => !x.startsWith("dashboard."));
    const custom = old.roles.find((r) => r.name === "Release captain")!;
    const customBefore = [...custom.permissions];
    setDB(old);
    const { ensureExt33 } = await import("./handlers/dashboards");
    ensureExt33(old);
    ensureExt33(old);
    expect(old.dashboards!.filter((d) => d.id === health)).toHaveLength(1);
    const mgr = old.roles.find((r) => r.key === "manager" && r.workspaceId === "ws_platform")!;
    expect(mgr.permissions.slice(-3)).toEqual(["dashboard.create", "dashboard.manage", "report.view"]);
    expect(custom.permissions).toEqual(customBefore);
  });
});

describe("reports: W1 workload and progress quarter (§5.4)", () => {
  it("W1 points: sprint rows sorted by name, capacity from completed sprints, scale", async () => {
    const r = await req<WorkloadReport>("GET", "/projects/p_prj/reports/workload", undefined, { filter: { unit: "points" } });
    expect(r.sprint?.name).toBe("Sprint 14");
    expect(r.unit).toBe("points");
    expect(r.rows.map((x) => x.user.name)).toEqual([...r.rows.map((x) => x.user.name)].sort((a, b) => a.localeCompare(b)));
    expect(r.rows.every((x) => x.capacity !== null)).toBe(true);
    const max = Math.max(...r.rows.map((x) => Math.max(x.inProgress + x.todo, x.capacity ?? 0)));
    expect(r.scale).toBeGreaterThanOrEqual(max);
    expect(r.scale % 2).toBe(0);
  });

  it("W1 hours (minutes), a person field, 404 / 422 / 403", async () => {
    const h = await req<WorkloadReport>("GET", "/projects/p_prj/reports/workload", undefined, { filter: { unit: "hours" } });
    expect(h.unit).toBe("hours");
    expect(h.scale % 120).toBe(0);
    const pf = await req<WorkloadReport>("GET", "/projects/p_prj/reports/workload", undefined, { filter: { person: "p_prj-cf-qaowner" } });
    expect(pf.personField).toEqual({ id: "p_prj-cf-qaowner", name: "QA owner" });
    expect((await rejects(req("GET", "/projects/p_prj/reports/workload", undefined, { filter: { person: "p_prj-cf-found" } }))).fieldErrors).toEqual({
      "filter[person]": "Pick a person field from this project",
    });
    expect((await rejects(req("GET", "/projects/p_prj/reports/workload", undefined, { filter: { sprint: "nope" } }))).status).toBe(404);
    as("u_taylor");
    expect((await rejects(req("GET", "/projects/p_prj/reports/workload"))).status).toBe(403);
  });

  it("W1 without a sprint", async () => {
    getDB().sprints.filter((s) => s.projectId === "p_prj" && s.state === "active").forEach((s) => (s.state = "planned"));
    const r = await req<WorkloadReport>("GET", "/projects/p_prj/reports/workload");
    expect(r).toEqual({ sprint: null, unit: "points", personField: null, scale: 0, rows: [], unassigned: { inProgress: 0, todo: 0, unestimated: 0 } });
  });

  it("progress objective rows carry quarter, milestones null", async () => {
    const rows = await req<{ kind: string; quarter: string | null }[]>("GET", "/projects/p_prj/reports/progress");
    expect(rows.filter((r) => r.kind === "objective").every((r) => r.quarter === "Q4")).toBe(true);
    expect(rows.filter((r) => r.kind === "milestone").every((r) => r.quarter === null)).toBe(true);
  });
});

describe("presence P1–P3 (§5.3)", () => {
  const put = (sid: string, body: unknown) => req<PresenceHeartbeat>("PUT", `/workspaces/platform/presence/${sid}`, body);

  it("upserts, returns the project roster, aggregates per user, publishes only on change", async () => {
    const r1 = await put("s1", { location: { kind: "board", id: "p_prj" }, state: "viewing", field: null, typing: false });
    expect(r1.heartbeatSec).toBe(20);
    expect(r1.roster.locations).toEqual([{ location: { kind: "board", id: "p_prj" }, people: [expect.objectContaining({ state: "viewing", field: null })] }]);
    expect(events.filter((e) => e.type === "presence.updated")).toHaveLength(1);
    await put("s1", { location: { kind: "board", id: "p_prj" }, state: "viewing", field: null, typing: false });
    expect(events.filter((e) => e.type === "presence.updated")).toHaveLength(1); // pure refresh
    // A second tab of the same user editing a task; then the board tab moves to the task too.
    await put("s2", { location: { kind: "task", id: getDB().tasks.find((x) => x.key === "PRJ-42")!.id }, state: "editing", field: "dueDate", typing: false });
    const moved = await put("s1", { location: { kind: "task", id: getDB().tasks.find((x) => x.key === "PRJ-42")!.id }, state: "viewing", field: null, typing: false });
    const loc = moved.roster.locations.find((l) => l.location.kind === "task")!;
    expect(loc.people).toHaveLength(1);
    expect(loc.people[0]).toMatchObject({ state: "editing", field: "dueDate" });
    const kinds = events.filter((e) => e.type === "presence.updated").map((e) => (e.data as { location: { kind: string } }).location.kind);
    expect(kinds).toEqual(["board", "task", "board", "task"]); // a move publishes the old and the new location
    expect(events.every((e) => e.type !== "presence.updated" || !e.id)).toBe(true); // volatile
  });

  it("validates the body", async () => {
    const err = async (body: unknown) => (await rejects(put("s", body))).fieldErrors;
    expect(await err({ location: { kind: "page", id: "" }, state: "dancing" })).toEqual({ "location.kind": "Pick board, dashboard or task", "location.id": "Pick a location", state: "Pick viewing or editing" });
    expect(await err({ location: { kind: "board", id: "p_prj" }, state: "editing", field: null })).toEqual({ field: "Name the field being edited" });
    expect(await err({ location: { kind: "board", id: "p_prj" }, state: "editing", field: "9bad" })).toEqual({ field: "Unknown field" });
    expect(await err({ location: { kind: "board", id: "p_prj" }, state: "editing", field: "dueDate", typing: true })).toEqual({ typing: "Typing needs the comment or description field" });
  });

  it("checks the location: another project's task is 403 for a non-member, someone's personal dashboard is 404 (and private for the owner)", async () => {
    as("u_casey");
    expect((await rejects(put("c", { location: { kind: "board", id: "p_prj" }, state: "viewing", field: null, typing: false }))).status).toBe(403);
    as("u_alex");
    expect((await rejects(put("a", { location: { kind: "dashboard", id: focus }, state: "viewing", field: null, typing: false }))).status).toBe(404);
    as("u_sam");
    const r = await put("s", { location: { kind: "dashboard", id: focus }, state: "viewing", field: null, typing: false });
    expect(r.roster.locations).toEqual([]);
    expect(events.filter((e) => e.type === "presence.updated")).toHaveLength(0);
  });

  it("P2 is idempotent; P3 needs filter[project]; expired rows are swept and published", async () => {
    await put("s1", { location: { kind: "board", id: "p_prj" }, state: "viewing", field: null, typing: false });
    await req("DELETE", "/workspaces/platform/presence/s1");
    await req("DELETE", "/workspaces/platform/presence/s1");
    expect((await req<PresenceRoster>("GET", "/workspaces/platform/presence", undefined, { filter: { project: "p_prj" } })).locations).toEqual([]);
    expect((await rejects(req("GET", "/workspaces/platform/presence"))).fieldErrors).toEqual({ "filter[project]": "Pick a project" });
    await put("s2", { location: { kind: "board", id: "p_prj" }, state: "viewing", field: null, typing: false });
    const n = events.length;
    expect(sweepPresence(getDB(), Date.now() + 46_000)).toBe(1);
    expect(events.length).toBe(n + 1);
    expect(presenceSessions.all()).toHaveLength(0);
  });

  it("typing lives 8 s", async () => {
    const taskId = getDB().tasks.find((x) => x.key === "PRJ-42")!.id;
    const r = await put("s1", { location: { kind: "task", id: taskId }, state: "editing", field: "comment", typing: true });
    expect(r.roster.locations[0]!.people[0]!.typing).toBe(true);
    as("u_jordan");
    const later = await req<PresenceRoster>("GET", "/workspaces/platform/presence", undefined, { filter: { project: "p_prj" } });
    expect(later.locations[0]!.people[0]!.typing).toBe(true);
  });
});

describe("the bus publishes §6.2 events", () => {
  it("task PATCH, move, comment and the inbox", async () => {
    const tk = (await req<{ data: Task[] }>("GET", "/projects/p_prj/tasks", undefined, { filter: { assignee: "u_sam" } })).data[0]!;
    await req("PATCH", `/tasks/${tk.id}`, { dueDate: "2026-10-20", version: tk.version });
    const ch = events.find((e) => e.type === "task.changed")!;
    expect(ch).toMatchObject({ projectId: "p_prj", actorId: "u_alex", data: { taskId: tk.id, key: tk.key, op: "updated", version: tk.version + 1, fields: ["dueDate"] } });
    expect(Number(ch.id)).toBeGreaterThan(0);
    const statuses = await req<{ id: string; glyph: string }[]>("GET", "/projects/p_prj/statuses");
    await req("POST", `/tasks/${tk.id}/move`, { statusId: statuses.find((s) => s.glyph === "review")!.id, position: "a0", version: tk.version + 1 });
    expect(events.filter((e) => e.type === "task.changed").at(-1)).toMatchObject({ data: { op: "moved", fields: ["statusId", "position"] } });
    expect(events.some((e) => e.type === "inbox.changed" && e.userId === "u_sam")).toBe(true);
    await req("POST", `/tasks/${tk.id}/comments`, { body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }] } });
    expect(events.filter((e) => e.type === "comment.changed").at(-1)).toMatchObject({ data: { taskId: tk.id, op: "created" } });
    const ids = events.filter((e) => e.id).map((e) => Number(e.id));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it("publishes nothing when the handler fails (on commit only)", async () => {
    const tk = getDB().tasks.find((x) => x.key === "PRJ-42")!;
    await rejects(req("PATCH", `/tasks/${tk.id}`, { title: "x", version: 999 }));
    expect(events).toEqual([]);
  });

  it("planning routes publish project.changed from the route table", async () => {
    await req("POST", "/projects/p_prj/labels", { name: "realtime", color: "var(--info)" });
    expect(events.at(-1)).toMatchObject({ type: "project.changed", projectId: "p_prj", data: { areas: ["labels"] } });
  });
});

describe("MockRealtimeSource", () => {
  async function open(lastEventId: string | null) {
    const got: RealtimeEnvelope[] = [];
    const ac = new AbortController();
    const done = new MockRealtimeSource().run({ slug: "platform", lastEventId, signal: ac.signal, onEvent: (e) => got.push(e), onActivity: () => undefined });
    await new Promise((r) => setTimeout(r, 5));
    return { got, ac, done };
  }

  it("says hello with the visible projects, replays after Last-Event-ID, filters by project", async () => {
    const tk = getDB().tasks.find((x) => x.key === "PRJ-42")!;
    await req("PATCH", `/tasks/${tk.id}`, { priority: 1, version: tk.version });
    const first = Number(events.find((e) => e.type === "task.changed")!.id);
    await req("PATCH", `/tasks/${tk.id}`, { priority: 2, version: tk.version });
    as("u_taylor");
    const s = await open(String(first));
    expect(s.got[0]).toMatchObject({ type: "hello", data: { replayed: 1 } });
    expect((s.got[0]!.data as { projects: string[] }).projects.sort()).toEqual(["p_mob", "p_prj"]);
    expect(s.got[1]).toMatchObject({ type: "task.changed", id: String(first + 1) });
    s.ac.abort();
    await expect(s.done).resolves.toEqual({ kind: "aborted" });
  });

  it("answers reset for an unknown cursor, unavailable in polling mode, failed offline", async () => {
    const s = await open("999999");
    expect(s.got.map((e) => e.type)).toEqual(["hello", "reset"]);
    s.ac.abort();
    mockControls.set((c) => ({ ...c, realtime: "polling" }));
    await expect(new MockRealtimeSource().run({ slug: "platform", lastEventId: null, signal: new AbortController().signal, onEvent: () => undefined, onActivity: () => undefined })).resolves.toMatchObject({ kind: "unavailable" });
    mockControls.set((c) => ({ ...c, realtime: "live", offline: true }));
    await expect(new MockRealtimeSource().run({ slug: "platform", lastEventId: null, signal: new AbortController().signal, onEvent: () => undefined, onActivity: () => undefined })).resolves.toMatchObject({ kind: "failed" });
  });

  it("delivers live events, and ends with reconnect when the user's access changes", async () => {
    as("u_sam");
    const s = await open(null);
    as("u_morgan"); // Project Admin on MOB
    await req("POST", "/projects/p_mob/members", { userId: "u_sam", roleId: "ws_platform-role-viewer" });
    await new Promise((r) => setTimeout(r, 5));
    expect(s.got.map((e) => e.type)).toContain("access.changed");
    expect(s.got.at(-1)).toMatchObject({ type: "reconnect", data: { reason: "access_changed" } });
    await expect(s.done).resolves.toEqual({ kind: "ended" });
  });
});

describe("teammate presence simulator", () => {
  it("does nothing when teammates are off, and shows up to 2 viewers when on", () => {
    resetPresenceSim();
    const id = presenceClaims.newId();
    presenceClaims.set(id, { projectId: "p_prj", location: { kind: "board", id: "p_prj" }, state: "viewing", field: null, typing: false });
    presenceTick(Date.now(), { visible: true });
    expect(presenceSessions.all()).toHaveLength(0);
    mockControls.set((c) => ({ ...c, teammates: true }));
    presenceTick(Date.now(), { visible: true });
    const viewers = presenceSessions.all().filter((s) => s.sessionId.startsWith("sim-"));
    expect(viewers).toHaveLength(2);
    expect(viewers.every((v) => v.userId !== "u_alex")).toBe(true);
    mockControls.set((c) => ({ ...c, teammates: false }));
    presenceTick(Date.now(), { visible: true });
    expect(presenceSessions.all()).toHaveLength(0);
    presenceClaims.remove(id);
  });
});
