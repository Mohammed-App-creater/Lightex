import { beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/errors";
import type { Project, Task, TaskDetail } from "@/lib/api/types";
import { buildQueryString, parseQueryString } from "@/lib/api/transport";
import { mockControls } from "./controls";
import { mockSession, resetDB, getDB } from "./db";
import { MockTransport } from "./transport";

const t = new MockTransport();
const as = (userId: string | null) => mockSession.set(userId);

async function req<T>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown, query?: Parameters<MockTransport["request"]>[0]["query"]) {
  return t.request<T>({ method, path, body, query });
}

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

describe("mock auth", () => {
  it("rejects bad credentials with the shared error shape and signs in good ones", async () => {
    const e = await rejects(req("POST", "/auth/login", { email: "alex@team.dev", password: "nope" }));
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(401);
    expect(e.code).toBe("invalid_credentials");
    const ok = await req<{ user: { id: string } }>("POST", "/auth/login", { email: "ALEX@team.dev", password: "password" });
    expect(ok.user.id).toBe("u_alex");
    expect(mockSession.get()).toBe("u_alex");
  });

  it("returns 401 for protected routes without a session", async () => {
    const e = await rejects(req("GET", "/workspaces"));
    expect(e.status).toBe(401);
  });
});

describe("permissions are scoped (no workspace → project override)", () => {
  it("gives a workspace admin with no project membership a 403 with request-access info", async () => {
    as("u_casey");
    const ws = await req<{ my_permissions: string[] }>("GET", "/workspaces/platform");
    expect(ws.my_permissions).toContain("workspace.manage_members");
    const e = await rejects(req("GET", "/workspaces/platform/projects/PRJ"));
    expect(e.status).toBe(403);
    expect(e.details?.canRequestAccess).toBe(true);
    // and the project list hides it entirely
    const list = await req<Project[]>("GET", "/workspaces/platform/projects");
    expect(list).toHaveLength(0);
  });

  it("returns my_permissions per scope", async () => {
    as("u_taylor");
    const p = await req<Project>("GET", "/workspaces/platform/projects/PRJ");
    expect(p.my_permissions).toEqual(["project.view"]);
    as("u_alex");
    const p2 = await req<Project>("GET", "/workspaces/platform/projects/PRJ");
    expect(p2.my_permissions).toContain("task.delete");
  });

  it("enforces task.delete on the server even if the UI were to show it", async () => {
    as("u_sam"); // project Member: no task.delete
    const e = await rejects(req("DELETE", "/tasks/p_prj-t42"));
    expect(e.status).toBe(403);
    expect(e.details?.permission).toBe("task.delete");
  });

  it("lets edit_own edit only tasks the user reported or is assigned", async () => {
    as("u_sam");
    const mine = getDB().tasks.find((x) => x.key === "PRJ-34")!; // assigned to Sam
    const updated = await req<Task>("PATCH", `/tasks/${mine.id}`, { title: "Session timeout modal v2", version: mine.version });
    expect(updated.title).toBe("Session timeout modal v2");
    const notMine = getDB().tasks.find((x) => x.key === "PRJ-33")!;
    const e = await rejects(req("PATCH", `/tasks/${notMine.id}`, { title: "x", version: notMine.version }));
    expect(e.status).toBe(403);
  });
});

describe("tasks", () => {
  beforeEach(() => as("u_alex"));

  it("rejects stale versions with version_conflict", async () => {
    const task = getDB().tasks.find((x) => x.key === "PRJ-42")!;
    await req("PATCH", `/tasks/${task.id}`, { priority: 4, version: task.version });
    const e = await rejects(req("POST", `/tasks/${task.id}/move`, { position: "a0", version: 1 }));
    expect(e.status).toBe(409);
    expect(e.code).toBe("version_conflict");
  });

  it("moves with a fractional position and bumps the version", async () => {
    const task = getDB().tasks.find((x) => x.key === "PRJ-34")!;
    const done = getDB().statuses.find((s) => s.projectId === "p_prj" && s.glyph === "done")!;
    const before = task.version;
    const moved = await req<Task>("POST", `/tasks/${task.id}/move`, { statusId: done.id, position: "V", version: before });
    expect(moved.statusId).toBe(done.id);
    expect(moved.version).toBe(before + 1);
    expect(moved.completedAt).not.toBeNull();
  });

  it("creates tasks with the next key and returns full detail by key", async () => {
    const created = await req<Task>("POST", "/projects/p_prj/tasks", { title: "Brand new" });
    expect(created.key).toBe("PRJ-72");
    const detail = await req<TaskDetail>("GET", "/workspaces/platform/tasks/prj-42");
    expect(detail.subtasks.map((s) => s.key)).toEqual(["PRJ-43", "PRJ-44", "PRJ-45"]);
    expect(detail.project.my_permissions).toContain("task.edit_any");
  });

  it("filters with filter[...] params", async () => {
    const res = await req<{ data: Task[] }>("GET", "/projects/p_prj/tasks", undefined, {
      filter: { assignee: "me", priority: [3, 4] },
    });
    expect(res.data.length).toBeGreaterThan(0);
    expect(res.data.every((x) => x.assigneeId === "u_alex" && x.priority >= 3)).toBe(true);
  });

  it("validates uploads server-side (10 MB, types)", async () => {
    const big = await rejects(req("POST", "/tasks/p_prj-t42/attachments/upload-url", { fileName: "a.png", size: 11 * 1024 * 1024, mimeType: "image/png" }));
    expect(big.code).toBe("validation_failed");
    const exe = await rejects(req("POST", "/tasks/p_prj-t42/attachments/upload-url", { fileName: "a.exe", size: 10, mimeType: "application/x-msdownload" }));
    expect(exe.fieldErrors.file).toBe("Images or code files only");
  });
});

describe("progress is computed from tasks", () => {
  it("marks Beta launch at risk when behind the time-elapsed share", async () => {
    as("u_alex");
    const ms = await req<{ id: string; progress: { percent: number; expected: number; atRisk: boolean } }[]>("GET", "/projects/p_prj/milestones");
    const beta = ms.find((m) => m.id === "ms_beta")!;
    expect(beta.progress.percent).toBeLessThan(beta.progress.expected);
    expect(beta.progress.atRisk).toBe(true);
    const alpha = ms.find((m) => m.id === "ms_alpha")!;
    expect(alpha.progress.percent).toBe(100);
  });
});

describe("query strings", () => {
  it("round-trips filter[...] arrays, sort, q and cursor", () => {
    const qs = buildQueryString({ q: "reflow", sort: "-priority", cursor: "50", filter: { status: ["a", "b"], sprint: "s1" } });
    expect(qs).toBe("?q=reflow&sort=-priority&cursor=50&filter%5Bstatus%5D=a&filter%5Bstatus%5D=b&filter%5Bsprint%5D=s1");
    expect(parseQueryString(qs.slice(1))).toEqual({ q: "reflow", sort: "-priority", cursor: "50", filter: { status: ["a", "b"], sprint: "s1" } });
  });
});
