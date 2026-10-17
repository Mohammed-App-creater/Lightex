import { beforeEach, describe, expect, it } from "vitest";
import type { AuditEntry } from "@/api/types";
import { auditActionKind, auditEntity } from "@/lib/audit";
import { mockControls } from "@/api/mock/controls";
import { mockSession, resetDB } from "@/api/mock/db";
import { MockTransport } from "@/api/mock/transport";
import { auditTime, isWordDiff, toCsv, wordDiff } from "./lib";

const row = (p: Partial<AuditEntry>): AuditEntry => ({ id: "a", actorId: "u", action: "tracking.task.updated", target: "T", createdAt: "2026-10-07T14:32:05.000Z", actorName: null, actorKind: "user", entityType: "", module: null, targetType: "", targetId: null, entityKey: null, source: "web", requestId: null, changes: [], ...p });

describe("audit vocabulary", () => {
  it("maps wire actions to the eight action kinds and entity types", () => {
    expect(auditActionKind(row({ action: "tracking.task.status_changed" }))).toBe("status");
    expect(auditActionKind(row({ action: "core.comment.created" }))).toBe("commented");
    expect(auditActionKind(row({ action: "tracking.task.created" }))).toBe("created");
    expect(auditActionKind(row({ action: "core.member.removed" }))).toBe("deleted");
    expect(auditActionKind(row({ action: "core.member.role_changed" }))).toBe("role");
    expect(auditActionKind(row({ action: "core.role.updated" }))).toBe("updated");
    expect(auditEntity(row({ action: "core.member.invited" }))).toBe("member");
    expect(auditEntity(row({ action: "weird.thing" }))).toBe("workspace");
  });

  it("accepts namespaced entity / target types and any module prefix (platform Stage 2)", () => {
    expect(auditEntity(row({ action: "tracking.task.updated", entityType: "tracking.task" }))).toBe("task");
    expect(auditEntity(row({ action: "x.y.z", targetType: "core.comment", entityType: "comment" }))).toBe("comment");
    expect(auditEntity(row({ action: "sales.deal.created" }))).toBe("workspace");
    expect(auditActionKind(row({ action: "core.comment.created", entityType: "core.comment" }))).toBe("commented");
  });

  it("groups target types like the server's filter[entity] buckets", () => {
    expect(auditEntity(row({ action: "core.attachment.created", entityType: "core.attachment" }))).toBe("task");
    expect(auditEntity(row({ action: "tracking.epic.updated", entityType: "tracking.epic" }))).toBe("project");
    expect(auditEntity(row({ action: "tracking.project_member.added", entityType: "tracking.project_member" }))).toBe("member");
    expect(auditEntity(row({ action: "tracking.dashboard.created", entityType: "tracking.dashboard" }))).toBe("workspace");
    expect(auditActionKind(row({ action: "core.attachment.deleted", entityType: "core.attachment" }))).toBe("deleted");
    expect(auditActionKind(row({ action: "core.comment.purged", entityType: "core.comment" }))).toBe("deleted");
    expect(auditActionKind(row({ action: "core.comment.restored", entityType: "core.comment" }))).toBe("updated");
    expect(auditActionKind(row({ action: "core.comment.updated", entityType: "core.comment" }))).toBe("updated");
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

describe("mock GET /workspaces/:slug/audit", () => {
  const t = new MockTransport();
  type Page = { data: AuditEntry[]; nextCursor: string | null; total?: number };
  const list = (query?: Parameters<MockTransport["request"]>[0]["query"]) => t.request<Page>({ method: "GET", path: "/workspaces/platform/audit", query });

  beforeEach(() => {
    resetDB();
    mockControls.set((c) => ({ ...c, errorRate: 0, latencyMin: 0, latencyMax: 0, offline: false, teammates: false }));
  });

  it("is admin-only (core.audit.view), mirroring the hidden nav entry", async () => {
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
