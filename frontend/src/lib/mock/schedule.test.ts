import { beforeEach, describe, expect, it } from "vitest";
import vectors from "@/features/schedule/span-vectors.json";
import type { ApiError } from "@/lib/api/errors";
import type { Epic, Paginated, Task } from "@/lib/api/types";
import { mockControls } from "./controls";
import { getDB, mockSession, resetDB } from "./db";
import { checkTaskDates, ensureExt32, scheduleFilter } from "./handlers/schedule";
import { D, createSeed } from "./seed";
import { MockTransport } from "./transport";

/* Board 32 (v2) mock: range filters, startDate / epic date validation, ensureExt32. */

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
const rec = (n: number) => getDB().tasks.find((x) => x.id === `p_prj-t${n}`)!;
const list = (filter: Record<string, string | string[]>, extra: Record<string, string | number> = {}) =>
  req<Paginated<Task>>("GET", "/projects/p_prj/tasks", undefined, { filter, limit: 500, ...extra });

beforeEach(() => {
  resetDB();
  mockControls.set((c) => ({ ...c, errorRate: 0, latencyMin: 0, latencyMax: 0, offline: false, teammates: false }));
  as("u_alex");
});

describe("range filter (L1)", () => {
  it("agrees with every shared span vector", () => {
    for (const c of vectors.cases) {
      const filter: Record<string, string> = {};
      if (c.from) filter.from = c.from;
      if (c.to) filter.to = c.to;
      const pred = scheduleFilter({ filter })!;
      expect(pred({ startDate: c.startDate, dueDate: c.dueDate }), c.name).toBe(c.expected);
    }
  });

  it("returns the seeded tasks whose span overlaps the window, including canceled ones", async () => {
    const from = D("2026-10-10");
    const to = D("2026-10-12");
    const r = await list({ from, to });
    const keys = r.data.map((x) => x.key);
    // PRJ-34 (Oct 6–10) touches `from`; PRJ-54 (Oct 12–14) touches `to`; PRJ-42 (Oct 1–21) encloses it.
    expect(keys).toEqual(expect.arrayContaining(["PRJ-34", "PRJ-54", "PRJ-42", "PRJ-46"]));
    expect(keys).not.toContain("PRJ-50"); // Sep 29 – Oct 6
    expect(keys).not.toContain("PRJ-36"); // unscheduled
    for (const task of r.data) {
      const s = task.startDate ?? task.dueDate!;
      const e = task.dueDate ?? task.startDate!;
      expect(e >= from && s <= to).toBe(true);
    }
    const r34 = r.data.find((x) => x.key === "PRJ-34")!;
    expect(r34.startDate).toBe(D("2026-10-06"));
  });

  it("filter[scheduled] and sort=startDate (nulls last, first when descending)", async () => {
    const tray = await list({ scheduled: "false" }, { sort: "-priority" });
    expect(tray.data.every((x) => !x.startDate && !x.dueDate)).toBe(true);
    expect(tray.data.map((x) => x.key)).toEqual(expect.arrayContaining(["PRJ-36", "PRJ-45", "PRJ-47", "PRJ-55", "PRJ-68", "PRJ-70", "PRJ-63", "PRJ-43"]));
    const withDates = await list({ scheduled: "true" });
    expect(withDates.data.every((x) => x.startDate || x.dueDate)).toBe(true);
    const asc = await list({}, { sort: "startDate" });
    const firstNull = asc.data.findIndex((x) => !x.startDate);
    expect(asc.data.slice(firstNull).every((x) => !x.startDate)).toBe(true);
    expect(asc.data[0]!.startDate).toBe(D("2026-09-01"));
    const desc = await list({}, { sort: "-startDate" });
    expect(desc.data[0]!.startDate).toBeNull();
    const none = await list({ from: D("2026-10-01"), to: D("2026-10-31"), scheduled: "false" });
    expect(none.data).toEqual([]);
  });

  it("combines with v1 filters and pages up to 500", async () => {
    const r = await list({ from: D("2026-09-01"), to: D("2026-11-30"), assignee: "u_sam" });
    expect(r.data.length).toBeGreaterThan(0);
    expect(r.data.every((x) => x.assigneeId === "u_sam")).toBe(true);
    const paged = await req<Paginated<Task>>("GET", "/projects/p_prj/tasks", undefined, { filter: { from: D("2026-09-01"), to: D("2026-11-30") }, sort: "startDate", limit: 3 });
    expect(paged.data).toHaveLength(3);
    expect(paged.nextCursor).toBe("3");
  });

  it("422s for bad parameters with the §4.1 messages", async () => {
    const fields = async (filter: Record<string, string>) => (await rejects(list(filter))).details?.fields;
    expect(await fields({ from: "2026-13-01" })).toEqual({ "filter[from]": "Pick a date" });
    expect(await fields({ from: "2026-10-01", to: "Oct 9" })).toEqual({ "filter[to]": "Pick a date" });
    expect(await fields({ from: "2026-10-09", to: "2026-10-01" })).toEqual({ "filter[to]": "End must be on or after the start" });
    expect(await fields({ from: "2026-01-01", to: "2027-02-05" })).toEqual({ "filter[to]": "Pick a range of 400 days or less" });
    expect(await fields({ scheduled: "maybe" })).toEqual({ "filter[scheduled]": "Use true or false" });
    // exactly 400 days is fine
    await expect(list({ from: "2026-01-01", to: "2027-02-04" })).resolves.toBeTruthy();
  });

  it("excludes deleted tasks", async () => {
    await req("DELETE", `/tasks/${rec(34).id}`);
    const r = await list({ from: D("2026-10-01"), to: D("2026-10-31") });
    expect(r.data.map((x) => x.key)).not.toContain("PRJ-34");
  });
});

describe("reschedule validation (T1–T3)", () => {
  it("moves both dates, resizes each edge and bumps the version once", async () => {
    const t34 = rec(34);
    const v = t34.version;
    const moved = await req<Task>("PATCH", `/tasks/${t34.id}`, { startDate: D("2026-10-08"), dueDate: D("2026-10-12"), version: v });
    expect([moved.startDate, moved.dueDate, moved.version]).toEqual([D("2026-10-08"), D("2026-10-12"), v + 1]);
    const left = await req<Task>("PATCH", `/tasks/${t34.id}`, { startDate: D("2026-10-03"), version: v + 1 });
    expect([left.startDate, left.dueDate]).toEqual([D("2026-10-03"), D("2026-10-12")]);
    const cleared = await req<Task>("PATCH", `/tasks/${t34.id}`, { startDate: null, version: v + 2 });
    expect(cleared.startDate).toBeNull();
  });

  it("checks format, then order on the resulting pair, keyed by the field that was sent", async () => {
    const t34 = rec(34);
    const fields = async (body: Record<string, unknown>) => (await rejects(req("PATCH", `/tasks/${t34.id}`, { ...body, version: t34.version }))).details?.fields;
    expect(await fields({ startDate: "10/08/2026" })).toEqual({ startDate: "Pick a date" });
    expect(await fields({ dueDate: "2026-02-30" })).toEqual({ dueDate: "Pick a date" });
    expect(await fields({ startDate: D("2026-10-11") })).toEqual({ startDate: "Start date must be on or before the due date" });
    expect(await fields({ dueDate: D("2026-10-05") })).toEqual({ dueDate: "Due date must be on or after the start date" });
    expect(await fields({ startDate: D("2026-10-20"), dueDate: D("2026-10-19") })).toEqual({ startDate: "Start date must be on or before the due date" });
    expect(rec(34).version).toBe(t34.version); // nothing written
    expect(() => checkTaskDates({ dueDate: null }, { startDate: "2026-10-06", dueDate: "2026-10-10" })).not.toThrow();
  });

  it("checks the version first and enforces the edit rule", async () => {
    const t34 = rec(34);
    const stale = await rejects(req("PATCH", `/tasks/${t34.id}`, { startDate: D("2026-10-07"), version: t34.version - 1 }));
    expect([stale.status, stale.code]).toEqual([409, "version_conflict"]);
    expect((stale.details?.current as Task).startDate).toBe(D("2026-10-06"));
    as("u_sam"); // Member: edits own tasks only
    await expect(req("PATCH", `/tasks/${t34.id}`, { startDate: D("2026-10-07"), version: t34.version })).resolves.toBeTruthy();
    const other = rec(42);
    const denied = await rejects(req("PATCH", `/tasks/${other.id}`, { startDate: D("2026-10-02"), version: other.version }));
    expect([denied.status, denied.details?.permission]).toEqual([403, "task.edit_any"]);
    as("u_taylor"); // Viewer
    const viewer = await rejects(req("PATCH", `/tasks/${rec(58).id}`, { dueDate: D("2026-10-18"), version: rec(58).version }));
    expect(viewer.status).toBe(403);
  });

  it("create accepts and validates startDate", async () => {
    const ok = await req<Task>("POST", "/projects/p_prj/tasks", { title: "Spike", startDate: "2026-10-12", dueDate: "2026-10-14" });
    expect([ok.startDate, ok.dueDate]).toEqual(["2026-10-12", "2026-10-14"]);
    const bad = await rejects(req("POST", "/projects/p_prj/tasks", { title: "Spike", startDate: "2026-10-15", dueDate: "2026-10-14" }));
    expect(bad.details?.fields).toEqual({ startDate: "Start date must be on or before the due date" });
  });

  it("bulk refuses startDate and a due date before a selected start (all or nothing)", async () => {
    const ids = [rec(42).id, rec(34).id];
    const start = await rejects(req("POST", "/projects/p_prj/tasks/bulk", { ids, patch: { startDate: "2026-10-01" } }));
    expect(start.details?.fields).toEqual({ "patch.startDate": "This field can’t be bulk-edited" });
    const early = await rejects(req("POST", "/projects/p_prj/tasks/bulk", { ids, patch: { dueDate: D("2026-10-04") } }));
    expect(early.details?.fields).toEqual({ "patch.dueDate": "PRJ-34 starts after this date" });
    expect(rec(42).dueDate).toBe(D("2026-10-21"));
    const cleared = await req<Task[]>("POST", "/projects/p_prj/tasks/bulk", { ids, patch: { dueDate: null } });
    expect(cleared.every((x) => x.dueDate === null && x.startDate)).toBe(true);
  });
});

describe("epic dates (P1, P2)", () => {
  it("returns, sets, clears and validates both-or-neither", async () => {
    const epics = await req<Epic[]>("GET", "/projects/p_prj/epics");
    const sprint = epics.find((e) => e.id === "ep_sprint")!;
    expect([sprint.startDate, sprint.dueDate]).toEqual([D("2026-09-01"), D("2026-10-30")]);
    expect(epics.find((e) => e.id === "ep_legacy")!.startDate).toBeNull();

    const resized = await req<Epic>("PATCH", "/epics/ep_sprint", { startDate: D("2026-09-01"), dueDate: D("2026-11-11") });
    expect(resized.dueDate).toBe(D("2026-11-11"));
    const one = await rejects(req("PATCH", "/epics/ep_legacy", { startDate: "2026-10-01" }));
    expect(one.details?.fields).toEqual({ startDate: "Set both dates or neither" });
    const reversed = await rejects(req("PATCH", "/epics/ep_sprint", { startDate: "2026-11-01", dueDate: "2026-10-01" }));
    expect(reversed.details?.fields).toEqual({ dueDate: "Target date must be on or after the start date" });
    const fmt = await rejects(req("PATCH", "/epics/ep_sprint", { dueDate: "soon" }));
    expect(fmt.details?.fields).toEqual({ dueDate: "Pick a date" });
    const cleared = await req<Epic>("PATCH", "/epics/ep_sprint", { startDate: null, dueDate: null });
    expect([cleared.startDate, cleared.dueDate]).toEqual([null, null]);
    const created = await req<Epic>("POST", "/projects/p_prj/epics", { name: "Timeline", startDate: "2026-10-01", dueDate: "2026-10-31" });
    expect([created.startDate, created.dueDate]).toEqual(["2026-10-01", "2026-10-31"]);
  });

  it("needs epic.manage", async () => {
    as("u_sam");
    const denied = await rejects(req("PATCH", "/epics/ep_sprint", { startDate: "2026-09-01", dueDate: "2026-11-01" }));
    expect([denied.status, denied.details?.permission]).toEqual([403, "epic.manage"]);
  });
});

describe("ensureExt32", () => {
  it("upgrades a v1-cached database once and keeps edited dates", () => {
    const db = createSeed();
    delete db.ext32;
    db.tasks.forEach((x) => delete x.startDate);
    db.epics.forEach((e) => {
      delete e.startDate;
      delete e.dueDate;
    });
    db.dependencies = db.dependencies!.filter((d) => d.id !== "dep_seed_32");
    const find = (n: number) => db.tasks.find((x) => x.id === `p_prj-t${n}`)!;
    find(33).dueDate = "2030-01-01"; // edited by the user after the v1 seed

    ensureExt32(db);
    expect(find(34).startDate).toBe(D("2026-10-06"));
    expect(find(33).startDate).toBeUndefined();
    expect(find(46).startDate).toBeUndefined(); // due-only on purpose
    expect(db.epics.find((e) => e.id === "ep_auth")).toMatchObject({ startDate: D("2026-09-14"), dueDate: D("2026-10-23") });
    expect(db.epics.find((e) => e.id === "ep_mob_off")!.startDate).toBeUndefined();
    expect(db.dependencies!.filter((d) => d.id === "dep_seed_32")).toHaveLength(1);

    find(34).startDate = "2026-10-01";
    delete db.ext32;
    ensureExt32(db);
    expect(find(34).startDate).toBe("2026-10-01");
    expect(db.dependencies!.filter((d) => d.blockerId === "p_prj-t50" && d.blockedId === "p_prj-t52")).toHaveLength(1);
  });

  it("draws both arrow tones: PRJ-48 → PRJ-42 conflicts, PRJ-50 → PRJ-52 doesn't", async () => {
    const r = await list({ from: D("2026-09-01"), to: D("2026-11-30") });
    const by = (k: string) => r.data.find((x) => x.key === k)!;
    expect(by("PRJ-42").openBlockers.map((b) => b.key)).toContain("PRJ-48");
    expect(by("PRJ-52").openBlockers.map((b) => b.key)).toEqual(["PRJ-50"]);
    expect(by("PRJ-42").startDate! <= by("PRJ-48").dueDate!).toBe(true);
    expect(by("PRJ-52").startDate! > by("PRJ-50").dueDate!).toBe(true);
  });
});
