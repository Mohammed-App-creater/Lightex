import { beforeEach, describe, expect, it } from "vitest";
import type { ApiError } from "@/lib/api/errors";
import type { SavedView } from "@/lib/api/types";
import { mockControls } from "./controls";
import { mockSession, resetDB } from "./db";
import { MockTransport } from "./transport";

const t = new MockTransport();
const as = (userId: string) => mockSession.set(userId);
const req = <T,>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown) => t.request<T>({ method, path, body });
async function rejects(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e as ApiError;
  }
  throw new Error("expected rejection");
}

beforeEach(() => {
  resetDB();
  mockControls.set((c) => ({ ...c, errorRate: 0, latencyMin: 0, latencyMax: 0, offline: false, teammates: false }));
});

describe("saved views (board 30)", () => {
  it("seeds the pinned personal views (board 39 brings back Blocked) with live counts", async () => {
    as("u_alex");
    const list = await req<SavedView[]>("GET", "/workspaces/platform/views");
    expect(list.filter((v) => v.pinned).map((v) => v.name)).toEqual(["My open bugs", "Due this week", "Blocked"]);
    // PRJ-42, PRJ-47, PRJ-58 and PRJ-68 have an open blocker; board 32's seed adds PRJ-52 (blocked by PRJ-50).
    expect(list.find((v) => v.name === "Blocked")?.count).toBe(5);
    expect(list.every((v) => v.count >= 0 && v.ownerId === "u_alex")).toBe(true);
  });

  it("creates, pins, reorders and deletes; others can't edit and viewers can't share", async () => {
    as("u_alex");
    const [first] = await req<SavedView[]>("GET", "/workspaces/platform/views");
    const projectId = first!.projectId;
    const v = await req<SavedView>("POST", "/workspaces/platform/views", {
      projectId,
      name: "Urgent",
      icon: "bolt",
      visibility: "project",
      layout: "board",
      filters: [{ field: "priority", op: "any", values: ["4"] }, { field: "label", op: "is", values: [] }],
      pinned: true,
    });
    expect(v.pinned).toBe(true);
    expect(v.filters).toHaveLength(1);
    const dup = await rejects(req("POST", "/workspaces/platform/views", { projectId, name: "urgent", filters: [{ field: "priority", op: "is", values: ["4"] }] }));
    expect(dup.status).toBe(422);

    const order = await req<SavedView[]>("PUT", "/workspaces/platform/views/order", { ids: [v.id, first!.id] });
    expect(order.find((x) => x.id === v.id)!.position).toBe(0);

    as("u_sam");
    const seen = await req<SavedView[]>("GET", "/workspaces/platform/views");
    expect(seen.some((x) => x.id === v.id && !x.pinned)).toBe(true);
    expect((await rejects(req("PATCH", `/views/${v.id}`, { name: "Mine now" }))).status).toBe(403);
    expect((await req<SavedView>("PATCH", `/views/${v.id}`, { pinned: true })).pinned).toBe(true);
    expect((await rejects(req("DELETE", `/views/${v.id}`))).status).toBe(403);

    as("u_taylor");
    const share = await rejects(req("POST", "/workspaces/platform/views", { projectId, name: "T", visibility: "project", filters: [{ field: "priority", op: "is", values: ["4"] }] }));
    expect(share.status).toBe(403);

    as("u_alex");
    await req("DELETE", `/views/${v.id}`);
    expect((await req<SavedView[]>("GET", "/workspaces/platform/views")).some((x) => x.id === v.id)).toBe(false);
  });
});
