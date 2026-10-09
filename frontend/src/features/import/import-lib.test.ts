import { describe, expect, it } from "vitest";
import type { ActivityEntry, AuditEntry, ImportJob, Notification, ProjectPermission } from "@/lib/api/types";
import { PROJECT_PERMISSIONS } from "@/lib/api/types";
import { auditActionKind } from "@/lib/audit";
import { DEFAULT_ROLES, PERMISSION_CATALOGUE } from "@/lib/permissions/catalogue";
import { lineParts, verbText } from "@/features/notifications/events";
import { activityText } from "@/features/tasks/activity-text";
import {
  analysisErrorMeta,
  canImport,
  canImportInto,
  createsLine,
  fieldOptions,
  fileMeta,
  footerReason,
  formatKeyRange,
  importNotificationText,
  precheckImportFile,
  presetNote,
  sizeLabel,
  skipSummary,
  stepOf,
  typeOptions,
} from "./import-lib";

/* Board 40 client helpers (§8.2 "Unit"). */

describe("precheckImportFile (design copy)", () => {
  it("refuses other extensions, oversized and empty files", () => {
    expect(precheckImportFile({ name: "roadmap.xlsx", size: 2000 })).toEqual({ title: "Only .csv files", meta: "roadmap.xlsx · .xlsx · export as CSV first" });
    expect(precheckImportFile({ name: "notes", size: 2000 })).toEqual({ title: "Only .csv files", meta: "notes · no extension · export as CSV first" });
    expect(precheckImportFile({ name: "roadmap-2026.csv", size: 13_002_342 })).toEqual({ title: "File is too large", meta: "roadmap-2026.csv · 12.4 MB · max 10 MB" });
    expect(precheckImportFile({ name: "empty.csv", size: 0 })).toEqual({ title: "File is empty", meta: "empty.csv" });
    expect(precheckImportFile({ name: "TASKS.CSV", size: 10 })).toBeNull();
  });
});

describe("analysisErrorMeta (§4.3)", () => {
  it("builds the meta line per reason", () => {
    expect(analysisErrorMeta("a.csv", { reason: "upload_missing" })).toBe("a.csv · The upload didn’t finish. Try again.");
    expect(analysisErrorMeta("a.csv", { reason: "too_large", size: 13_002_342 })).toBe("a.csv · 12.4 MB · max 10 MB");
    expect(analysisErrorMeta("a.csv", { reason: "excel" })).toBe("a.csv · Excel workbook · export as CSV first");
    expect(analysisErrorMeta("a.csv", { reason: "unclosed_quote", line: 12 })).toBe("a.csv · near line 12");
    expect(analysisErrorMeta("a.csv", { reason: "cell_too_long", line: 40 })).toBe("a.csv · line 40 · max 64 KB per cell");
    expect(analysisErrorMeta("a.csv", { reason: "too_many_columns", columns: 45 })).toBe("45 columns · max 40");
    expect(analysisErrorMeta("a.csv", { reason: "too_many_rows", rows: 6210, max: 5000 })).toBe("6,210 rows · max 5,000");
    expect(analysisErrorMeta("a.csv", { reason: "too_many_rows", rows: 1240, max: 1000, mock: true })).toBe("1,240 rows · max 1,000 in the mock API");
    expect(analysisErrorMeta("a.csv", { reason: "binary" })).toBe("a.csv");
    expect(analysisErrorMeta("a.csv", undefined)).toBe("a.csv");
  });
});

describe("fileMeta and sizes", () => {
  const f = { name: "t.csv", size: 4210, encoding: "utf-8" as const, delimiter: "," as const, rowCount: 48, columnCount: 8 };
  it("matches the design order with delimiter and encoding suffixes", () => {
    expect(fileMeta(f)).toBe("48 rows · 8 columns · 4 KB");
    expect(fileMeta({ ...f, delimiter: ";" })).toBe("48 rows · 8 columns · 4 KB · ; separated");
    expect(fileMeta({ ...f, delimiter: "\t", encoding: "utf-16" })).toBe("48 rows · 8 columns · 4 KB · tab separated · UTF-16");
    expect(fileMeta({ ...f, encoding: "windows-1252" })).toBe("48 rows · 8 columns · 4 KB · Windows-1252");
    expect(fileMeta({ ...f, rowCount: 1, columnCount: 1, size: 10 })).toBe("1 row · 1 column · 1 KB");
    expect(sizeLabel(2.5 * 1048576)).toBe("2.5 MB");
  });
});

const job = (p: Partial<ImportJob>): ImportJob =>
  ({ status: "draft", startedAt: null, source: "csv", preset: "generic", validation: null, ...p }) as ImportJob;

describe("stepOf (every status)", () => {
  it("derives the step from the job", () => {
    expect(stepOf(null)).toEqual({ step: 2, phase: "setup" });
    expect(stepOf(job({ status: "draft" }))).toEqual({ step: 2, phase: "setup" });
    expect(stepOf(job({ status: "ready" }))).toEqual({ step: 3, phase: "setup" });
    expect(stepOf(job({ status: "queued", startedAt: null }))).toEqual({ step: 4, phase: "running" });
    expect(stepOf(job({ status: "running", startedAt: "x" }))).toEqual({ step: 4, phase: "running" });
    for (const status of ["completed", "canceled", "failed"] as const) expect(stepOf(job({ status, startedAt: "x" }))).toEqual({ step: 4, phase: "result" });
    expect(stepOf(job({ status: "canceled" }))).toEqual({ step: 2, phase: "setup" });
    expect(stepOf(job({ status: "failed" }))).toEqual({ step: 2, phase: "setup" });
  });
});

describe("footerReason (order and copy)", () => {
  const s = { source: null, uploading: false, fileError: false, job: null };
  it("step 1 and 2", () => {
    expect(footerReason(1, s)).toBe("Pick a source");
    expect(footerReason(1, { ...s, source: "csv" })).toBeNull();
    expect(footerReason(2, { ...s, source: "csv" })).toBe("Upload a CSV file");
    expect(footerReason(2, { ...s, source: "csv", uploading: true })).toBe("Reading file");
    expect(footerReason(2, { ...s, source: "csv", fileError: true })).toBe("Fix the file to continue");
    expect(footerReason(2, { ...s, source: "csv", job: job({ status: "ready" }) })).toBeNull();
  });
  it("step 3 shows the server's first blocker", () => {
    const validation = { blockers: [{ code: "title_unmapped", message: "Map a column to Title" }, { code: "status_unmapped", message: "Map 2 more statuses" }] } as ImportJob["validation"];
    expect(footerReason(3, { ...s, job: job({ status: "ready", validation }) })).toBe("Map a column to Title");
    expect(footerReason(3, { ...s, job: job({ status: "ready", validation: { blockers: [] } as never }) })).toBeNull();
  });
});

describe("summary helpers", () => {
  it("skipSummary, formatKeyRange, createsLine", () => {
    expect(skipSummary([{ reason: "Missing title", count: 2 }, { reason: "Invalid due date", count: 1 }])).toBe("2 × missing title · 1 × invalid due date");
    expect(formatKeyRange({ first: "PRJ-61", last: "PRJ-104" })).toBe("PRJ-61 → PRJ-104");
    expect(formatKeyRange({ first: "PRJ-61", last: "PRJ-61" })).toBe("PRJ-61");
    expect(formatKeyRange(null)).toBe("");
    const creates = { labels: ["api", "ux"], epics: ["Checkout"], options: [{ customFieldId: "f", names: ["Arc"] }] };
    expect(createsLine(creates, ["task.create"])).toBe("Creates 2 labels, 1 epic");
    expect(createsLine(creates, ["field.manage"])).toBe("Creates 2 labels, 1 epic, 1 option");
    expect(createsLine({ labels: [], epics: [], options: [] }, [])).toBeNull();
  });
  it("presetNote", () => {
    expect(presetNote({ source: "csv", preset: "linear" })).toBe("Looks like a Linear export");
    expect(presetNote({ source: "jira", preset: "jira" })).toBe("Looks like a Jira export");
    expect(presetNote({ source: "jira", preset: "generic" })).toBe("This doesn’t look like a Jira export. Columns are matched by name.");
    expect(presetNote({ source: "csv", preset: "generic" })).toBeNull();
  });
});

describe("gating", () => {
  it("canImport needs project.import and task.create; entry points also need an active project", () => {
    expect(canImport(["project.import", "task.create"])).toBe(true);
    expect(canImport(["project.import"])).toBe(false);
    expect(canImport(["task.create"])).toBe(false);
    expect(canImport(undefined)).toBe(false);
    expect(canImportInto({ status: "archived", my_permissions: ["project.import", "task.create"] })).toBe(false);
    expect(canImportInto({ status: "active", my_permissions: ["project.import", "task.create"] })).toBe(true);
  });
  it("fieldOptions: the design's eight, More fields, Custom fields, Don’t import", () => {
    const g = fieldOptions([{ id: "cf1", name: "Browser" }]);
    expect(g.map((x) => x.label)).toEqual([null, "More fields", "Custom fields", null]);
    expect(g[0]!.options.map((o) => o.label)).toEqual(["Title *", "Description", "Status", "Assignee", "Priority", "Estimate", "Due date", "Labels"]);
    expect(g[2]!.options).toEqual([{ value: "cf:cf1", label: "Browser" }]);
    expect(g[3]!.options).toEqual([{ value: "skip", label: "Don’t import" }]);
    expect(fieldOptions([]).map((x) => x.label)).toEqual([null, "More fields", null]);
  });
  it("typeOptions offer Epic only with epic.manage", () => {
    expect(typeOptions(["task.create"]).map((o) => o.value)).toEqual(["feature", "bug", "chore", "spike"]);
    expect(typeOptions(["epic.manage"]).map((o) => o.value)).toContain("epic");
  });
});

describe("permissions catalogue and default roles (§3)", () => {
  it("places project.import after task.move and in the Tasks group", () => {
    const i = PROJECT_PERMISSIONS.indexOf("project.import");
    expect(PROJECT_PERMISSIONS[i - 1]).toBe("task.move");
    expect(PROJECT_PERMISSIONS[i + 1]).toBe("time.log");
    expect(PERMISSION_CATALOGUE.find((p) => p.key === "project.import")).toMatchObject({ group: "Tasks", label: "Import tasks", scope: "project" });
  });
  it("grants it to Project Admin, Manager and Member, not Viewer", () => {
    const holds = (key: string) => (DEFAULT_ROLES.find((r) => r.key === key)!.permissions as ProjectPermission[]).includes("project.import");
    expect(["project_admin", "manager", "project_member", "viewer"].map(holds)).toEqual([true, true, true, false]);
    // Workspace roles never carry project keys.
    expect(["owner", "admin", "member"].map(holds)).toEqual([false, false, false]);
  });
});

describe("activity, audit and inbox vocabulary", () => {
  const act = (data: ActivityEntry["data"], taskId: string | null): ActivityEntry => ({ id: "a", actorId: "u", verb: "imported", projectId: "p", taskId, taskKey: taskId ? "PRJ-61" : null, taskTitle: null, data, createdAt: "" });
  it("activityText for imported", () => {
    expect(activityText(act({ imported: 44, fileName: "tasks-export.csv" }, null))).toBe("imported 44 tasks from tasks-export.csv");
    expect(activityText(act({ imported: 1, fileName: "a.csv" }, null))).toBe("imported 1 task from a.csv");
    expect(activityText(act({ fileName: "tasks-export.csv" }, "t1"))).toBe("imported this task from tasks-export.csv");
  });
  it("auditActionKind", () => {
    const row = (action: string): AuditEntry => ({ id: "a", actorId: "u", action, target: "T", createdAt: "" });
    expect(auditActionKind(row("task.imported"))).toBe("created");
    expect(auditActionKind(row("project.import_started"))).toBe("updated");
    expect(auditActionKind(row("project.import_completed"))).toBe("updated");
  });
  it("inbox row text for import", () => {
    const n = { id: "n", type: "import", actorId: null, projectId: "p", projectName: "Platform Rebuild", taskId: null, taskKey: null, taskTitle: null, createdAt: "", readAt: null } as const;
    const mk = (payload: Notification["payload"]) => ({ ...n, payload }) as Notification;
    expect(verbText(mk({ projectKey: "PRJ", imported: 44, skipped: 4, importStatus: "completed" }), null)).toBe("Import finished · 44 tasks added to PRJ · 4 skipped");
    expect(lineParts(mk({ projectKey: "PRJ", imported: 120, skipped: 0, importStatus: "canceled" }), null).lead).toBe("Import stopped");
    expect(importNotificationText({ projectKey: "PRJ", imported: 120, importStatus: "failed" })).toEqual({ lead: "Import failed", rest: "120 tasks added to PRJ" });
  });
});
