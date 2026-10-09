import { QueryClient, type QueryKey } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import { qk } from "@/lib/api/query-keys";
import type { Task } from "@/lib/api/types";
import { createEventApplier, fieldLabel } from "./apply-event";
import type { RealtimeEnvelope } from "./events";
import { remoteMarks } from "./remote";
import type { CachedRoster } from "./roster";

/* Each row of the §7.8 table against a seeded QueryClient. */

const P = "p1";
const SLUG = "platform";
const task = (over: Partial<Task> = {}) => ({ id: "t1", key: "PRJ-1", projectId: P, statusId: "s1", version: 3, title: "A", ...over }) as Task;

let qc: QueryClient;
let flushes: (() => void)[];
let opened: string | null;
let deleted: string[];

function applier() {
  return createEventApplier(
    qc,
    { slug: SLUG, workspaceId: "w1", meId: "u_me", openTaskId: () => "t1", openDashboardId: () => opened, onOpenDashboardDeleted: (id) => deleted.push(id) },
    (fn) => flushes.push(fn),
  );
}
const flush = () => flushes.splice(0).forEach((f) => f());
const invalid = (key: QueryKey) => qc.getQueryState(key)?.isInvalidated ?? false;
const set = (key: QueryKey, data: unknown) => qc.setQueryData(key, data);
const ev = (type: string, data: unknown, extra: Partial<RealtimeEnvelope> = {}): RealtimeEnvelope => ({ v: 1, type, projectId: P, actorId: "u_riley", data, ...extra });

beforeEach(() => {
  qc = new QueryClient();
  flushes = [];
  opened = null;
  deleted = [];
  remoteMarks.clear();
  set(qk.board(P, "active"), { statuses: [], tasks: [task()], sprintId: null });
  set(qk.task(SLUG, "PRJ-1"), { ...task(), subtasks: [] });
  set(qk.taskList(P), { data: [task()], nextCursor: null });
  set(qk.myProjectTasks(P), { data: [task()], nextCursor: null });
  set(qk.reports(P, "burndown"), { sprint: null, points: [] });
  set(qk.activity(P), { data: [], nextCursor: null });
  set(qk.comments("t1"), []);
  set(qk.attachments("t1"), []);
  set(qk.statuses(P), []);
  set(qk.labels(P), []);
  set(qk.sprints(P), []);
  set(qk.customFields(P), []);
  set(qk.dashboards(P), []);
  set(qk.dashboard("d1"), { id: "d1", version: 4 });
  set(qk.unread("w1"), { count: 1 });
  set(qk.views(SLUG), []);
});

describe("applyEvent", () => {
  it("task.changed: invalidates the task's views, batched until the frame flush", () => {
    const a = applier();
    a.apply(ev("task.changed", { taskId: "t1", key: "PRJ-1", op: "updated", version: 4, fields: ["dueDate"] }));
    expect(invalid(qk.board(P, "active"))).toBe(false);
    expect(flushes).toHaveLength(1);
    a.apply(ev("task.changed", { taskId: "t1", key: "PRJ-1", op: "updated", version: 5, fields: [] }));
    expect(flushes).toHaveLength(1); // one batch per frame
    flush();
    for (const key of [qk.board(P, "active"), qk.task(SLUG, "PRJ-1"), qk.taskList(P), qk.myProjectTasks(P), qk.reports(P, "burndown"), qk.activity(P), qk.views(SLUG)]) {
      expect(invalid(key), JSON.stringify(key)).toBe(true);
    }
    expect(invalid(qk.statuses(P))).toBe(false);
  });

  it("task.changed: skips its own echo / an already fresh version", () => {
    const a = applier();
    a.apply(ev("task.changed", { taskId: "t1", key: "PRJ-1", op: "updated", version: 3, fields: [] }, { actorId: "u_me" }));
    flush();
    expect(invalid(qk.board(P, "active"))).toBe(false);
  });

  it("task.changed by someone else on the open task leaves a mark for the toast (PRJ-1 · Due)", () => {
    const a = applier();
    a.apply(ev("task.changed", { taskId: "t1", key: "PRJ-1", op: "updated", version: 9, fields: ["dueDate"] }));
    expect(remoteMarks.get("t:t1")).toMatchObject({ actorId: "u_riley", fields: ["dueDate"] });
    expect(remoteMarks.get(`p:${P}`)).not.toBeNull();
    expect(fieldLabel("dueDate")).toBe("Due");
  });

  it("task.changed deleted: removes the card at once", () => {
    const a = applier();
    a.apply(ev("task.changed", { taskId: "t1", key: "PRJ-1", op: "deleted", version: null, fields: [] }));
    expect((qc.getQueryData(qk.board(P, "active")) as { tasks: Task[] }).tasks).toHaveLength(0);
  });

  it("tasks.bulk_changed: invalidates the project scope and views", () => {
    const a = applier();
    a.apply(ev("tasks.bulk_changed", { taskIds: null, op: "created" }));
    flush();
    expect(invalid(qk.statuses(P))).toBe(true);
    expect(invalid(qk.views(SLUG))).toBe(true);
  });

  it("comment.changed and attachment.changed: their lists and the task", () => {
    const a = applier();
    a.apply(ev("comment.changed", { taskId: "t1", key: "PRJ-1", commentId: "c1", op: "created" }));
    a.apply(ev("attachment.changed", { taskId: "t1", key: "PRJ-1", op: "deleted" }));
    flush();
    expect(invalid(qk.comments("t1"))).toBe(true);
    expect(invalid(qk.attachments("t1"))).toBe(true);
    expect(invalid(qk.task(SLUG, "PRJ-1"))).toBe(true);
    expect(invalid(qk.activity(P))).toBe(true);
  });

  it("project.changed: per area", () => {
    const a = applier();
    a.apply(ev("project.changed", { areas: ["labels", "custom_fields"] }));
    flush();
    expect(invalid(qk.labels(P))).toBe(true);
    expect(invalid(qk.customFields(P))).toBe(true);
    expect(invalid(qk.statuses(P))).toBe(false);
  });

  it("dashboard.changed: version skip, invalidate otherwise, remove + leave when deleted while open", () => {
    const a = applier();
    a.apply(ev("dashboard.changed", { dashboardId: "d1", op: "layout", version: 4 }));
    flush();
    expect(invalid(qk.dashboard("d1"))).toBe(false);
    expect(invalid(qk.dashboards(P))).toBe(true);
    a.apply(ev("dashboard.changed", { dashboardId: "d1", op: "layout", version: 5 }));
    flush();
    expect(invalid(qk.dashboard("d1"))).toBe(true);
    opened = "d1";
    a.apply(ev("dashboard.changed", { dashboardId: "d1", op: "deleted", version: null }));
    expect(qc.getQueryData(qk.dashboard("d1"))).toBeUndefined();
    expect(deleted).toEqual(["d1"]);
  });

  it("inbox.changed: writes the unread count and refreshes the inbox", () => {
    const a = applier();
    a.apply(ev("inbox.changed", { unread: 7 }, { projectId: null }));
    expect(qc.getQueryData(qk.unread("w1"))).toEqual({ count: 7 });
    expect(qc.getQueryData(qk.unread())).toEqual({ count: 7 });
  });

  it("access.changed: workspace, projects and me", () => {
    set(qk.workspace(SLUG), {});
    set(qk.me(), {});
    const a = applier();
    a.apply(ev("access.changed", { projectId: P }));
    flush();
    expect(invalid(qk.workspace(SLUG))).toBe(true);
    expect(invalid(qk.me())).toBe(true);
  });

  it("presence.updated: replaces one location and ignores an older snapshot", () => {
    const a = applier();
    const person = (id: string) => ({ user: { id, name: id, hue: 1, avatarUrl: null }, state: "viewing" as const, field: null, typing: false, since: "2026-10-09T09:00:00Z" });
    a.apply(ev("presence.updated", { location: { kind: "board", id: P }, people: [person("u_jordan")], at: "2026-10-09T09:00:10Z" }));
    a.apply(ev("presence.updated", { location: { kind: "board", id: P }, people: [], at: "2026-10-09T09:00:05Z" }));
    const r = qc.getQueryData<CachedRoster>(qk.presence(SLUG, P))!;
    expect(r.locations).toHaveLength(1);
    expect(r.locations[0]!.people.map((p) => p.user.id)).toEqual(["u_jordan"]);
  });

  it("pause queues a project's events until resume (board drag)", () => {
    const a = applier();
    a.pause(P);
    a.apply(ev("project.changed", { areas: ["labels"] }));
    flush();
    expect(invalid(qk.labels(P))).toBe(false);
    a.resume(P);
    flush();
    expect(invalid(qk.labels(P))).toBe(true);
  });

  it("invalidateAll (hello after polling, reset) covers every workspace prefix; unknown types are ignored", () => {
    const a = applier();
    a.apply(ev("brand.new.thing", {}));
    a.invalidateAll();
    flush();
    expect(invalid(qk.statuses(P))).toBe(true);
    expect(invalid(qk.task(SLUG, "PRJ-1"))).toBe(true);
    expect(invalid(qk.dashboard("d1"))).toBe(true);
    expect(invalid(qk.unread("w1"))).toBe(true);
  });
});

describe("board 37 events (§8.4)", () => {
  it("task.changed with fields [development] and version null invalidates the Development section", () => {
    set(qk.development("t1"), { pullRequests: [] });
    set(qk.development("t2"), { pullRequests: [] });
    const a = applier();
    a.apply(ev("task.changed", { taskId: "t1", key: "PRJ-1", op: "updated", version: null, fields: ["development"] }));
    flush();
    expect(invalid(qk.development("t1"))).toBe(true);
    expect(invalid(qk.development("t2"))).toBe(false);
    expect(invalid(qk.task(SLUG, "PRJ-1"))).toBe(true);
  });

  it("integration.changed (no project) refreshes the settings page, devEnabled and task-scoped queries", () => {
    set(qk.integrations(SLUG), { providers: [], integrations: [] });
    set(qk.projects(SLUG), []);
    set(qk.development("t1"), { pullRequests: [] });
    const a = applier();
    a.apply(ev("integration.changed", { integrationId: "int_1", op: "disconnected" }, { projectId: null }));
    flush();
    expect(invalid(qk.integrations(SLUG))).toBe(true);
    expect(invalid(qk.projects(SLUG))).toBe(true);
    expect(invalid(qk.development("t1"))).toBe(true);
  });

  it("project.changed [development] refreshes the automation rules and projects", () => {
    set(qk.devRules(P), []);
    set(qk.projects(SLUG), []);
    const a = applier();
    a.apply(ev("project.changed", { areas: ["development"] }));
    flush();
    expect(invalid(qk.devRules(P))).toBe(true);
    expect(invalid(qk.projects(SLUG))).toBe(true);
  });
});
