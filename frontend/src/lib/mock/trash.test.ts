import { beforeEach, describe, expect, it } from "vitest";
import type { ApiError } from "@/lib/api/errors";
import type { Label, Project, Status, TrashList } from "@/lib/api/types";
import { mockControls } from "./controls";
import { getDB, mockSession, resetDB } from "./db";
import { MockTransport } from "./transport";

const t = new MockTransport();
const as = (userId: string | null) => mockSession.set(userId);
const req = <T,>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown) => t.request<T>({ method, path, body });
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
  as(null);
});

describe("trash (board 29)", () => {
  it("scopes by role: admin sees all kinds, member only their own, viewer is denied", async () => {
    as("u_alex");
    const all = await req<TrashList>("GET", "/workspaces/platform/trash");
    expect(all.scope).toBe("all");
    expect(all.kinds).toContain("project");
    expect(all.data.some((i) => i.kind === "task")).toBe(true);
    expect(all.data.some((i) => i.kind === "project" && i.key === "LA")).toBe(true);

    as("u_sam");
    const own = await req<TrashList>("GET", "/workspaces/platform/trash");
    expect(own.scope).toBe("own");
    expect(own.kinds).not.toContain("project");
    expect(own.data.length).toBeGreaterThan(0);
    expect(own.data.every((i) => i.kind === "comment" && i.deletedBy?.id === "u_sam")).toBe(true);

    as("u_taylor");
    const e = await rejects(req("GET", "/workspaces/platform/trash"));
    expect(e.status).toBe(403);
  });

  it("deleting a project moves it to the trash; restore brings it back", async () => {
    as("u_alex");
    const p = await req<Project>("GET", "/workspaces/platform/projects/PRJ");
    await req("DELETE", `/projects/${p.id}`, { confirm: "PRJ" });
    expect((await rejects(req("GET", "/workspaces/platform/projects/PRJ"))).status).toBe(404);
    const list = await req<TrashList>("GET", "/workspaces/platform/trash");
    expect(list.data.some((i) => i.kind === "project" && i.id === p.id)).toBe(true);
    await req("POST", "/workspaces/platform/trash/restore", { items: [{ kind: "project", id: p.id }] });
    const back = await req<Project>("GET", "/workspaces/platform/projects/PRJ");
    expect(back.openTaskCount).toBe(p.openTaskCount);
    expect(back.memberCount).toBe(p.memberCount);
  });

  it("restores and purges tasks and comments", async () => {
    as("u_alex");
    const p = await req<Project>("GET", "/workspaces/platform/projects/PRJ");
    const task = getDB().tasks.find((x) => x.projectId === p.id && !x.deletedAt && !x.parentId)!;
    await req("DELETE", `/tasks/${task.id}`);
    let list = await req<TrashList>("GET", "/workspaces/platform/trash");
    const row = list.data.find((i) => i.id === task.id)!;
    expect(row.deletedBy?.id).toBe("u_alex");
    await req("POST", "/workspaces/platform/trash/restore", { items: [{ kind: "task", id: task.id }] });
    expect(getDB().tasks.find((x) => x.id === task.id)!.deletedAt).toBeNull();

    const c = getDB().comments[0]!;
    await req("DELETE", `/comments/${c.id}`);
    list = await req<TrashList>("GET", "/workspaces/platform/trash");
    expect(list.data.some((i) => i.kind === "comment" && i.id === c.id)).toBe(true);
    await req("POST", "/workspaces/platform/trash/purge", { items: [{ kind: "comment", id: c.id }] });
    list = await req<TrashList>("GET", "/workspaces/platform/trash");
    expect(list.data.some((i) => i.id === c.id)).toBe(false);
    expect(getDB().comments.some((x) => x.id === c.id)).toBe(false);
  });

  it("purges items older than 30 days automatically", async () => {
    as("u_alex");
    await req<TrashList>("GET", "/workspaces/platform/trash");
    const old = getDB().trash!.comments[0]!;
    old.deletedAt = new Date(Date.now() - 31 * 86_400_000).toISOString();
    const list = await req<TrashList>("GET", "/workspaces/platform/trash");
    expect(list.data.some((i) => i.id === old.id)).toBe(false);
  });
});

describe("project settings endpoints (board 28)", () => {
  it("statuses: counts, colour, delete with move, last-in-group guard", async () => {
    as("u_alex");
    const p = await req<Project>("GET", "/workspaces/platform/projects/PRJ");
    const list = await req<Status[]>("GET", `/projects/${p.id}/statuses`);
    const review = list.find((s) => s.name === "In review")!;
    const progress = list.find((s) => s.name === "In progress")!;
    expect(typeof review.taskCount).toBe("number");
    await req("PATCH", `/projects/${p.id}/statuses/${review.id}`, { color: "var(--danger)" });
    const moved = review.taskCount ?? 0;
    await req("DELETE", `/projects/${p.id}/statuses/${review.id}`, { moveTo: progress.id });
    const after = await req<Status[]>("GET", `/projects/${p.id}/statuses`);
    expect(after.find((s) => s.id === review.id)).toBeUndefined();
    expect(after.find((s) => s.id === progress.id)!.taskCount).toBe((progress.taskCount ?? 0) + moved);
    const e = await rejects(req("DELETE", `/projects/${p.id}/statuses/${progress.id}`, { moveTo: after[0]!.id }));
    expect(e.code).toBe("last_in_category");
    // Viewer can't manage statuses.
    as("u_taylor");
    expect((await rejects(req("PATCH", `/projects/${p.id}/statuses/${progress.id}`, { name: "X" }))).status).toBe(403);
  });

  it("labels: rename, recolor, delete (project.update) and hue on the project", async () => {
    as("u_alex");
    const p = await req<Project>("GET", "/workspaces/platform/projects/PRJ");
    const labels = await req<Label[]>("GET", `/projects/${p.id}/labels`);
    const bug = labels.find((l) => l.name === "bug")!;
    expect(bug.taskCount).toBeGreaterThan(0);
    const renamed = await req<Label>("PATCH", `/projects/${p.id}/labels/${bug.id}`, { name: "Defect", color: "var(--warn)" });
    expect(renamed).toMatchObject({ name: "defect", color: "var(--warn)" });
    await req("DELETE", `/projects/${p.id}/labels/${bug.id}`);
    expect(getDB().tasks.some((x) => x.labelIds.includes(bug.id))).toBe(false);
    const next = await req<Project>("PATCH", `/projects/${p.id}`, { hue: 140 });
    expect(next.hue).toBe(140);
    as("u_sam");
    expect((await rejects(req("DELETE", `/projects/${p.id}/labels/${labels[0]!.id}`))).status).toBe(403);
  });

  it("refuses to demote or remove the only project admin", async () => {
    as("u_alex");
    const p = await req<Project>("GET", "/workspaces/platform/projects/PRJ");
    const e = await rejects(req("DELETE", `/projects/${p.id}/members/u_alex`));
    expect(e.code).toBe("last_admin");
  });
});
