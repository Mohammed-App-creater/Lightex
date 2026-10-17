import { beforeEach, describe, expect, it } from "vitest";
import type { AuditEntry } from "@/lib/api/types";
import { auditActionKind, auditEntity } from "@/lib/audit";
import { mockControls } from "@/lib/mock/controls";
import { mockSession, resetDB } from "@/lib/mock/db";
import { MockTransport } from "@/lib/mock/transport";
import { dayLabel, groupByDay, activityCategory } from "./activity-feed";
import { auditTime, isWordDiff, toCsv, wordDiff } from "./lib";

const row = (p: Partial<AuditEntry>): AuditEntry => ({ id: "a", actorId: "u", action: "task.updated", target: "T", createdAt: "2026-10-07T14:32:05.000Z", ...p });

describe("audit vocabulary", () => {
  it("maps wire actions to the eight action kinds and entity types", () => {
    expect(auditActionKind(row({ action: "task.status_changed" }))).toBe("status");
    expect(auditActionKind(row({ action: "comment.created" }))).toBe("commented");
    expect(auditActionKind(row({ action: "task.created" }))).toBe("created");
    expect(auditActionKind(row({ action: "member.removed" }))).toBe("deleted");
    expect(auditActionKind(row({ action: "member.role_changed" }))).toBe("role");
    expect(auditActionKind(row({ action: "role.updated" }))).toBe("updated");
    expect(auditEntity(row({ action: "member.invited" }))).toBe("member");
    expect(auditEntity(row({ action: "weird.thing" }))).toBe("workspace");
  });
});

describe("audit helpers", () => {
  it("word-diffs text and marks deletions / insertions", () => {
    expect(wordDiff("Fix flaky board reflow on resize", "Fix flaky board reflow on column resize")).toEqual([
      { op: "eq", text: "Fix flaky board reflow on " },
      { op: "ins", text: "column " },
      { op: "eq", text: "resize" },
    ]);
    const d = wordDiff("move unfinished tasks", "carry over unfinished tasks");
    expect(d.filter((s) => s.op === "del").map((s) => s.text.trim())).toEqual(["move"]);
    expect(d.filter((s) => s.op === "ins").map((s) => s.text.trim())).toEqual(["carry over"]);
  });

  it("only word-diffs text changes with both sides", () => {
    expect(isWordDiff({ field: "Title", kind: "text", before: "a", after: "b" })).toBe(true);
    expect(isWordDiff({ field: "Comment", kind: "text", before: null, after: "b" })).toBe(false);
    expect(isWordDiff({ field: "Status", kind: "status", before: "todo", after: "done" })).toBe(false);
  });

  it("formats UTC cell and full timestamps", () => {
    expect(auditTime("2026-10-07T04:02:09.000Z")).toEqual({ cell: "Oct 7 04:02", full: "2026-10-07 04:02:09 UTC" });
  });

  it("exports CSV with quoted, escaped cells", () => {
    const csv = toCsv([row({ target: 'Say "hi", ok', changes: [{ field: "Priority", kind: "priority", before: 2, after: 3 }] })], () => "Alex Kim");
    const [head, line] = csv.split("\n");
    expect(head).toBe("time,actor,action,entity_type,entity,source,request_id,changes");
    expect(line).toContain('"Say ""hi"", ok"');
    expect(line).toContain('"Priority: 2 → 3"');
  });
});

describe("activity feed grouping", () => {
  const now = new Date(2026, 9, 7, 15, 0);
  it("labels days relative to now", () => {
    expect(dayLabel(new Date(2026, 9, 7, 9).toISOString(), now)).toBe("Today");
    expect(dayLabel(new Date(2026, 9, 6, 23).toISOString(), now)).toBe("Yesterday");
    expect(dayLabel(new Date(2026, 9, 5, 10).toISOString(), now)).toBe("Mon, Oct 5");
  });
  it("groups consecutive entries by day and categorises verbs", () => {
    const items = [new Date(2026, 9, 7, 10), new Date(2026, 9, 7, 9), new Date(2026, 9, 6, 9)].map((d) => ({ createdAt: d.toISOString() }));
    expect(groupByDay(items, now).map((g) => [g.label, g.items.length])).toEqual([["Today", 2], ["Yesterday", 1]]);
    expect(activityCategory({ verb: "status_changed" })).toBe("status");
    expect(activityCategory({ verb: "member_added" })).toBe("member");
    expect(activityCategory({ verb: "created" })).toBe("other");
  });
});

describe("mock GET /workspaces/:slug/audit", () => {
  const t = new MockTransport();
  type Page = { data: AuditEntry[]; nextCursor: string | null; total?: number };
  const list = (query?: Parameters<MockTransport["request"]>[0]["query"]) => t.request<Page>({ method: "GET", path: "/workspaces/platform/audit", query });

  beforeEach(() => {
    resetDB();
    mockControls.set((c) => ({ ...c, errorRate: 0, latencyMin: 0, latencyMax: 0, offline: false, teammates: false }));
  });

  it("is admin-only (audit.view), mirroring the hidden nav entry", async () => {
    mockSession.set("u_sam");
    await expect(list()).rejects.toMatchObject({ status: 403 });
  });

  it("pages with a cursor, returns a total, and filters server-side", async () => {
    mockSession.set("u_alex");
    const first = await list({ limit: 25 });
    expect(first.data).toHaveLength(25);
    expect(first.total).toBeGreaterThan(200);
    expect(first.nextCursor).toBe("25");
    expect(first.data[0]!.changes?.length).toBeGreaterThan(0);
    const sorted = [...first.data].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    expect(first.data.map((e) => e.id)).toEqual(sorted.map((e) => e.id));

    const status = await list({ limit: 200, filter: { action: "status" } });
    expect(status.data.every((e) => auditActionKind(e) === "status")).toBe(true);

    const actors = await list({ limit: 200, filter: { actor: ["u_jordan", "int_ci"] } });
    expect(new Set(actors.data.map((e) => e.actorId))).toEqual(new Set(["u_jordan", "int_ci"]));

    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    const day = await list({ limit: 200, filter: { since, entity: "task" } });
    expect(day.data.every((e) => e.createdAt >= since && auditEntity(e) === "task")).toBe(true);

    const none = await list({ filter: { actor: "u_taylor", action: "invited", entity: "sprint" } });
    expect(none).toMatchObject({ data: [], total: 0, nextCursor: null });
  });
});
