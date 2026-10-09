import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ApiError } from "@/lib/api/errors";
import type { ActivityEntry, ImportJob, ImportJobSummary, ImportRowPreview, Notification, Paginated, Project, UploadTicket } from "@/lib/api/types";
import { mockControls } from "./controls";
import { getDB, mockSession, resetDB } from "./db";
import { dropImportMemory, ensureExt40, reportBody, runImportNow } from "./handlers/imports";
import { mockUploads } from "./handlers/tasks";
import { sampleText } from "./import/fixtures/sample";
import { createSeed } from "./seed";
import { MockTransport } from "./transport";

/* Board 40 (v2) mock endpoints I1–I9, the runner and the upgrade. */

const t = new MockTransport();
const as = (userId: string) => mockSession.set(userId);
type M = "GET" | "POST" | "PUT";
const req = <T,>(method: M, path: string, body?: unknown, query?: Parameters<MockTransport["request"]>[0]["query"]) => t.request<T>({ method, path, body, query });
async function rejects(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e as ApiError;
  }
  throw new Error("expected rejection");
}
const JIRA = readFileSync(join(__dirname, "import", "fixtures", "jira-export.csv"), "utf8");

/** I1 + the signed PUT (the mock's upload map) + I2. */
async function upload(content: string | Uint8Array, name = "tasks-export.csv", source: "csv" | "jira" = "csv", projectId = "p_prj") {
  const blob = new Blob([content as BlobPart], { type: "text/csv" });
  const { job, upload: ticket } = await req<{ job: ImportJob; upload: UploadTicket }>("POST", `/projects/${projectId}/imports`, { source, fileName: name, size: blob.size });
  expect(ticket.url).toBe(`mock-upload://${job.id}`);
  mockUploads.get(job.id)!.blob = blob;
  return job;
}
const analyze = (id: string) => req<ImportJob>("POST", `/imports/${id}/analyze`);
const get = (id: string) => req<ImportJob>("GET", `/imports/${id}`);
function mapping(job: ImportJob, patch: Partial<NonNullable<ImportJob["mapping"]>> = {}) {
  const m = job.mapping!;
  return { revision: m.revision + 1, columns: m.columns, statuses: {}, types: {}, people: {}, ...patch };
}

beforeEach(() => {
  resetDB();
  dropImportMemory();
  mockControls.set((c) => ({ ...c, errorRate: 0, latencyMin: 0, latencyMax: 0, offline: false, teammates: false }));
});

describe("permissions and the upgrade", () => {
  it("adds project.import to the system roles of a cached database once, leaving custom roles", () => {
    const db = createSeed();
    delete db.ext40;
    const member = db.roles.find((r) => r.key === "project_member" && r.workspaceId === "ws_platform")!;
    member.permissions = member.permissions.filter((p) => p !== "project.import");
    const viewer = db.roles.find((r) => r.key === "viewer" && r.workspaceId === "ws_platform")!;
    const custom = db.roles.find((r) => r.id === "ws_platform-role-release")!;
    const customBefore = [...custom.permissions];
    ensureExt40(db);
    expect(member.permissions.indexOf("project.import")).toBe(member.permissions.indexOf("task.move") + 1);
    expect(viewer.permissions).not.toContain("project.import");
    expect(custom.permissions).toEqual(customBefore);
    ensureExt40(db);
    expect(member.permissions.filter((p) => p === "project.import")).toHaveLength(1);
  });

  it("exposes project.import and nextTaskNumber on the project", async () => {
    as("u_sam");
    const p = await req<Project>("GET", "/workspaces/platform/projects/PRJ");
    expect(p.my_permissions).toContain("project.import");
    expect(p.nextTaskNumber).toBe(getDB().projects.find((x) => x.id === "p_prj")!.taskSeq + 1);
    as("u_taylor");
    expect((await req<Project>("GET", "/workspaces/platform/projects/PRJ")).my_permissions).not.toContain("project.import");
  });

  it("refuses viewers (403 with the missing code), non-members and archived projects", async () => {
    as("u_taylor");
    const e = await rejects(req("POST", "/projects/p_prj/imports", { source: "csv", fileName: "a.csv", size: 10 }));
    expect([e.status, e.code, e.details?.permission]).toEqual([403, "forbidden", "project.import"]);
    as("u_casey");
    expect((await rejects(req("POST", "/projects/p_prj/imports", { source: "csv", fileName: "a.csv", size: 10 }))).status).toBe(403);
    as("u_alex");
    getDB().projects.find((p) => p.id === "p_prj")!.status = "archived";
    expect((await rejects(req("POST", "/projects/p_prj/imports", { source: "csv", fileName: "a.csv", size: 10 }))).status).toBe(403);
  });
});

describe("I1 create + I2 analyze", () => {
  it("validates the create body with the contract's messages", async () => {
    as("u_alex");
    const fields = async (body: unknown) => (await rejects(req("POST", "/projects/p_prj/imports", body))).fieldErrors;
    expect(await fields({ source: "trello", fileName: "a.csv", size: 1 })).toEqual({ source: "Trello import is coming soon" });
    expect(await fields({ source: "xls", fileName: "a.csv", size: 1 })).toEqual({ source: "Pick CSV or Jira" });
    expect(await fields({ source: "csv", fileName: "a.xlsx", size: 1 })).toEqual({ file: "Only .csv files" });
    expect(await fields({ source: "csv", fileName: "a.csv", size: 0 })).toEqual({ file: "File is empty" });
    const big = await rejects(req("POST", "/projects/p_prj/imports", { source: "csv", fileName: "a.csv", size: 13_002_342 }));
    expect([big.fieldErrors.file, big.details?.file]).toEqual(["File is too large", { reason: "too_large", size: 13_002_342 }]);
  });

  it("analyzes the sample: ready, file info, analysis and the suggested mapping", async () => {
    as("u_alex");
    const draft = await upload(sampleText());
    expect(draft.status).toBe("draft");
    const job = await analyze(draft.id);
    expect(job.status).toBe("ready");
    expect(job.preset).toBe("generic");
    expect(job.file).toMatchObject({ name: "tasks-export.csv", encoding: "utf-8", delimiter: ",", rowCount: 48, columnCount: 8 });
    expect(job.analysis!.columns[0]).toMatchObject({ name: "Title", samples: ["Fix login redirect loop", "Add SSO for admin console", "Board loads slowly with 500 cards"], emptyCount: 2 });
    expect(job.analysis!.columns[6]).toMatchObject({ name: "Due", inferredType: "date", dateOrder: "ymd" });
    expect(job.mapping!.columns.map((c) => c.field)).toEqual(["title", "description", "status", "assignee", "priority", "estimate", "dueDate", "labels"]);
    expect(job.validation!.blockers[0]!.message).toBe("Map 1 more status");
    expect(job.validation!.values.statuses.find((v) => v.key === "review")!.target).toBe("p_prj-st-review");
    // Idempotent on a ready job.
    expect((await analyze(job.id)).mapping!.revision).toBe(0);
  });

  it("returns the analysis errors as 422 with details.file", async () => {
    as("u_alex");
    const check = async (content: string | Uint8Array, reason: string, title: string) => {
      const d = await upload(content);
      const e = await rejects(analyze(d.id));
      expect([e.status, e.fieldErrors.file, (e.details?.file as { reason: string }).reason]).toEqual([422, title, reason]);
    };
    await check(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2]), "excel", "Only .csv files");
    await check("Title\nA\u0000B\n", "binary", "Not a text file");
    await check('Title,Notes\nA,"open\n', "unclosed_quote", "Unclosed quote");
    await check("Title,Status\n", "header_only", "Header only, no rows");
    const many = `Title\n${Array.from({ length: 1240 }, (_, i) => `Task ${i}`).join("\n")}\n`;
    const d = await upload(many);
    const e = await rejects(analyze(d.id));
    expect(e.details?.file).toEqual({ reason: "too_many_rows", rows: 1240, max: 1000, mock: true });
    // A missing upload.
    const { job } = await req<{ job: ImportJob }>("POST", "/projects/p_prj/imports", { source: "csv", fileName: "x.csv", size: 4 });
    expect((await rejects(analyze(job.id))).details?.file).toEqual({ reason: "upload_missing" });
  });

  it("only the creator can analyze, map and start", async () => {
    as("u_alex");
    const d = await upload(sampleText());
    as("u_jordan");
    const e = await rejects(analyze(d.id));
    expect([e.status, e.message, e.details?.permission]).toEqual([403, "Only the person who started this import can change it.", undefined]);
  });
});

describe("I4 mapping and I5 rows", () => {
  it("saves the whole mapping, recomputes validation and keeps explicit choices", async () => {
    as("u_alex");
    const job = await analyze((await upload(sampleText())).id);
    const next = await req<ImportJob>("PUT", `/imports/${job.id}/mapping`, mapping(job, { statuses: { blocked: "p_prj-st-todo" }, people: { "chris ortiz": null } }));
    expect(next.mapping!.revision).toBe(1);
    expect(next.validation!.ready).toBe(true);
    expect(next.validation!.values.statuses.find((v) => v.key === "blocked")).toMatchObject({ target: "p_prj-st-todo", auto: false });
    expect(next.validation!.values.statuses.find((v) => v.key === "todo")).toMatchObject({ auto: true });
    expect(next.validation!.counts).toMatchObject({ tasks: 44, skipped: 4, statuses: 5, people: 3 });
    // Stale revision → 409 with the current job.
    const stale = await rejects(req("PUT", `/imports/${job.id}/mapping`, mapping(job)));
    expect([stale.status, stale.code, (stale.details?.current as ImportJob).mapping!.revision]).toEqual([409, "mapping_conflict", 1]);
  });

  it("returns the contract's 422 messages", async () => {
    as("u_alex");
    const job = await analyze((await upload(sampleText())).id);
    const errs = async (body: unknown) => (await rejects(req("PUT", `/imports/${job.id}/mapping`, body))).fieldErrors;
    expect(await errs({ ...mapping(job), columns: [{ field: "title" }] })).toEqual({ columns: "Send one entry per column" });
    expect(await errs({ ...mapping(job), statuses: { blocked: "p_mob-st-todo" } })).toEqual({ "statuses.blocked": "Pick a status from this project" });
    expect(await errs({ ...mapping(job), types: { story: "story" } })).toEqual({ "types.story": "Pick feature, bug, chore, spike or epic" });
    expect(await errs({ ...mapping(job), people: { "chris ortiz": "u_casey" } })).toEqual({ "people.chris ortiz": "Pick someone on this project" });
    const cols = job.mapping!.columns.map((c, i) => (i === 1 ? { field: "customField", customFieldId: "nope" } : c));
    expect(await errs({ ...mapping(job), columns: cols })).toEqual({ "columns.1.customFieldId": "This field was deleted" });
  });

  it("a custom role without task.assign limits people to the importer (suggestions and 422)", async () => {
    const db = getDB();
    const release = db.roles.find((r) => r.id === "ws_platform-role-release")!;
    release.permissions.push("project.import");
    expect(release.permissions).not.toContain("task.assign");
    as("u_riley");
    const job = await analyze((await upload(sampleText())).id);
    expect(job.validation!.values.people.map((v) => v.target)).toEqual([null, "u_riley", null, null]);
    const e = await rejects(req("PUT", `/imports/${job.id}/mapping`, mapping(job, { people: { "alex kim": "u_alex" } })));
    expect(e.fieldErrors).toEqual({ "people.alex kim": "You can only assign tasks to yourself" });
  });

  it("I5 previews the first rows (dry run) with predicted keys and skip reasons", async () => {
    as("u_alex");
    const job = await analyze((await upload(sampleText())).id);
    const page = await req<Paginated<ImportRowPreview>>("GET", `/imports/${job.id}/rows`, undefined, { limit: 5 });
    const seq = getDB().projects.find((p) => p.id === "p_prj")!.taskSeq;
    expect(page.data.map((r) => r.row)).toEqual([2, 3, 4, 5, 6]);
    expect(page.data[0]!.key).toBe(`PRJ-${seq + 1}`);
    const skipped = await req<Paginated<ImportRowPreview>>("GET", `/imports/${job.id}/rows`, undefined, { filter: { outcome: "skipped" } });
    expect(skipped.data.map((r) => [r.row, r.issues[0]!.reason])).toEqual([
      [8, "Missing title"],
      [20, "Invalid due date"],
      [27, "Estimate is not a number"],
      [42, "Missing title"],
    ]);
  });
});

describe("I6 start, the runner, I8 report, I9 history", () => {
  it("refuses to start with blockers, then imports the sample: 44 tasks, 4 skipped, report, notification, activity", async () => {
    as("u_alex");
    const db = getDB();
    const prj = db.projects.find((p) => p.id === "p_prj")!;
    const seq = prj.taskSeq;
    const ready = await analyze((await upload(sampleText())).id);
    const blocked = await rejects(req("POST", `/imports/${ready.id}/start`));
    expect([blocked.status, blocked.fieldErrors.mapping]).toEqual([422, "Map 1 more status"]);
    await req("PUT", `/imports/${ready.id}/mapping`, mapping(ready, { statuses: { blocked: "p_prj-st-todo" } }));
    const queued = await req<ImportJob>("POST", `/imports/${ready.id}/start`);
    expect(queued.status).toBe("queued");
    expect(queued.progress).toMatchObject({ total: 48, processed: 0 });
    // Idempotent.
    expect((await req<ImportJob>("POST", `/imports/${ready.id}/start`)).status).toBe("queued");
    runImportNow(ready.id);
    const done = await get(ready.id);
    expect(done.status).toBe("completed");
    expect(done.result).toMatchObject({ imported: 44, skipped: 4, epics: 0, firstKey: `PRJ-${seq + 1}`, lastKey: `PRJ-${seq + 44}`, hasErrorReport: true, issueCount: 4 });
    expect(done.result!.issues.map((i) => [i.row, i.reason, i.value])).toEqual([
      [8, "Missing title", ""],
      [20, "Invalid due date", "next week"],
      [27, "Estimate is not a number", "XL"],
      [42, "Missing title", ""],
    ]);
    const tasks = db.tasks.filter((x) => x.projectId === "p_prj" && x.number > seq);
    expect(tasks).toHaveLength(44);
    expect(tasks.every((x) => x.sprintId === null && x.reporterId === "u_alex")).toBe(true);
    const first = tasks.find((x) => x.number === seq + 1)!;
    expect(first).toMatchObject({ title: "Fix login redirect loop", assigneeId: "u_alex", priority: 3, estimate: 3, dueDate: "2026-10-08" });
    expect(db.labels.filter((l) => l.projectId === "p_prj" && l.name === "api")).toHaveLength(1);
    expect(prj.taskSeq).toBe(seq + 44);

    const n = db.notifications.find((x) => x.type === "import")!;
    expect(n).toMatchObject({ recipientId: "u_alex", actorId: null, payload: { importId: ready.id, projectKey: "PRJ", imported: 44, skipped: 4, importStatus: "completed" } });
    const act = await req<Paginated<ActivityEntry>>("GET", "/projects/p_prj/activity");
    expect(act.data[0]).toMatchObject({ verb: "imported", taskId: null, data: { imported: 44, fileName: "tasks-export.csv" } });
    const taskFeed = await req<ActivityEntry[]>("GET", `/tasks/${first.id}/activity`);
    expect(taskFeed.at(-1)).toMatchObject({ verb: "imported", data: { fileName: "tasks-export.csv" } });
    expect(db.audit.filter((a) => a.action === "task.imported" && a.source === "import")).toHaveLength(44);

    const report = await req<{ url: string; fileName: string }>("GET", `/imports/${ready.id}/error-report`);
    expect(report.fileName).toMatch(/^import-errors-prj-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(report.url).toMatch(/^(blob:|data:text\/csv)/);
    const csv = reportBody(ready.id)!;
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[0]).toBe(`"Row","Outcome","Reason","Value","Title","Description","Status","Assignee","Priority","Estimate","Due","Tags"`);
    expect(lines[1]).toBe(`"8","Skipped","Missing title","","","See incident 112","blocked","Riley Chen","High","3","2026-10-14","backend"`);
    expect(lines).toHaveLength(6);

    const history = await req<ImportJobSummary[]>("GET", "/projects/p_prj/imports");
    expect(history[0]).toMatchObject({ id: ready.id, status: "completed", imported: 44, skipped: 4, hasErrorReport: true, fileName: "tasks-export.csv" });
    // Finished → 409 on writes.
    expect((await rejects(req("POST", `/imports/${ready.id}/cancel`))).code).toBe("import_state");
  });

  it("imports the Jira fixture: epic with dates, links, sub-task, dependency, warnings", async () => {
    as("u_alex");
    const db = getDB();
    const seq = db.projects.find((p) => p.id === "p_prj")!.taskSeq;
    const job = await analyze((await upload(JIRA, "jira-export.csv", "jira")).id);
    expect(job.preset).toBe("jira");
    expect(job.validation!.blockers).toEqual([]);
    await req("POST", `/imports/${job.id}/start`);
    runImportNow(job.id);
    const done = await get(job.id);
    expect(done.result).toMatchObject({ imported: 4, epics: 1, skipped: 1, warnings: 1 });
    const epic = db.epics.find((e) => e.projectId === "p_prj" && e.name === "Checkout redesign")!;
    expect(epic).toMatchObject({ startDate: "2026-10-01", dueDate: "2026-10-30" });
    const byTitle = (title: string) => db.tasks.find((x) => x.projectId === "p_prj" && x.title === title && x.number > seq)!;
    const drawer = byTitle("Cart drawer");
    expect(drawer).toMatchObject({ epicId: epic.id, estimate: 3, timeEstimateMinutes: 480, startDate: "2026-10-05", dueDate: "2026-10-14", sprintId: "sp_14", assigneeId: "u_jordan" });
    expect(drawer.labelIds.map((id) => db.labels.find((l) => l.id === id)!.name).sort()).toEqual(["frontend", "ux"]);
    expect(byTitle("Cart drawer animation")).toMatchObject({ parentId: drawer.id, assigneeId: "u_jordan", sprintId: "sp_14", epicId: epic.id });
    const bug = byTitle("Price rounding bug");
    expect(bug).toMatchObject({ priority: 4, assigneeId: "u_sam", epicId: epic.id, statusId: "p_prj-st-done" });
    const retry = byTitle("Payment retry");
    expect(retry).toMatchObject({ assigneeId: null, sprintId: null, statusId: "p_prj-st-review" });
    expect(db.dependencies!.some((d) => d.blockerId === bug.id && d.blockedId === retry.id)).toBe(true);
    expect(done.result!.issues.map((i) => i.reason)).toEqual(["Missing title", "No sprint named “Sprint 99” · added to the backlog"]);
  });

  it("stop mid-run keeps what was imported; one active import per project", async () => {
    as("u_alex");
    const a = await analyze((await upload(sampleText())).id);
    await req("PUT", `/imports/${a.id}/mapping`, mapping(a, { statuses: { blocked: "p_prj-st-todo" } }));
    await req("POST", `/imports/${a.id}/start`);
    const b = await analyze((await upload(sampleText(), "again.csv")).id);
    await req("PUT", `/imports/${b.id}/mapping`, mapping(b, { statuses: { blocked: "p_prj-st-todo" } }));
    const busy = await rejects(req("POST", `/imports/${b.id}/start`));
    expect([busy.status, busy.code, busy.details?.jobId]).toEqual([409, "import_in_progress", a.id]);
    runImportNow(a.id, 3); // queued → running, preparing, 1 batch of 4 rows
    const stopping = await req<ImportJob>("POST", `/imports/${a.id}/cancel`);
    expect([stopping.status, stopping.cancelRequested]).toEqual(["running", true]);
    runImportNow(a.id);
    const stopped = await get(a.id);
    expect(stopped.status).toBe("canceled");
    expect(stopped.result!.imported).toBe(4);
    expect(getDB().notifications.find((n) => n.type === "import")!.payload.importStatus).toBe("canceled");
  });

  it("a reload loses the parsed file: ready / running jobs fail with file_missing", async () => {
    as("u_alex");
    const job = await analyze((await upload(sampleText())).id);
    dropImportMemory();
    const after = await get(job.id);
    expect([after.status, after.error?.code]).toEqual(["failed", "file_missing"]);
    expect((await rejects(req("POST", `/imports/${job.id}/start`))).code).toBe("import_state");
  });

  it("cancels drafts and enforces job-level read permission", async () => {
    as("u_alex");
    const d = await upload(sampleText());
    expect((await req<ImportJob>("POST", `/imports/${d.id}/cancel`)).status).toBe("canceled");
    as("u_taylor");
    const e = await rejects(get(d.id));
    expect([e.status, e.details?.permission]).toEqual([403, "project.import"]);
    as("u_drew");
    expect((await rejects(get(d.id))).status).toBe(404);
    as("u_alex");
    expect((await rejects(req("GET", `/imports/${d.id}/error-report`))).status).toBe(404);
  });
});

describe("notifications", () => {
  it("carries the import payload", async () => {
    as("u_alex");
    const job = await analyze((await upload(JIRA, "jira.csv", "jira")).id);
    await req("POST", `/imports/${job.id}/start`);
    runImportNow(job.id);
    const list = await req<Paginated<Notification>>("GET", "/notifications", undefined, { filter: { tab: "all" } });
    expect(list.data[0]).toMatchObject({ type: "import", taskId: null, payload: { importStatus: "completed", imported: 4, skipped: 1 } });
  });
});
