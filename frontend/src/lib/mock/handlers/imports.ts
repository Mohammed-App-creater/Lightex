import { canImport } from "@/features/import/import-lib";
import type {
  ImportColumnMapping,
  ImportField,
  ImportIssue,
  ImportJob,
  ImportJobSummary,
  ImportLogLine,
  ImportMapping,
  ImportResult,
  ImportRowPreview,
  ImportSource,
  ImportTaskType,
  Permission,
  RichDoc,
  RichNode,
} from "@/lib/api/types";
import { keyBetween } from "@/lib/utils/fractional-index";
import { getDB, nowISO, persist, uid } from "../db";
import type { ImportJobRec, ImportRowRec, MockDB, ProjectRec, TaskRec } from "../db-types";
import { projectMembership, projectPermissions, statusesOf, toTask, wsMembership } from "../derive";
import { decodeBytes } from "../import/decode";
import { parseCsv, sniffDelimiter, type CsvError } from "../import/csv";
import { analyzeColumns, planImport, type ParsedFile, type PlanProject, type PlanResult, type UserMaps } from "../import/plan";
import { detectPreset, suggestColumns } from "../import/presets";
import { buildReport, reportFileName } from "../import/report";
import { fail, filterValues, requireUser, route, str, type Ctx } from "../router";
import { logActivity } from "./common";
import { publishBulk } from "../realtime";
import { DEP_LIMIT, findCycle } from "./extensions";
import { memberProject } from "./projects";
import { applyStatusSideEffects, lastPosition, mockUploads, registerMockUpload } from "./tasks";

/*
 * Board 40 (v2): import wizard. REQUESTED API ADDITIONS, implemented from docs/v2/40-import-wizard.md
 * §4 with the same status codes, error codes, messages and permission checks:
 *   I1 POST /projects/:id/imports · I2 POST /imports/:id/analyze · I3 GET /imports/:id ·
 *   I4 PUT /imports/:id/mapping · I5 GET /imports/:id/rows · I6 POST /imports/:id/start ·
 *   I7 POST /imports/:id/cancel · I8 GET /imports/:id/error-report · I9 GET /projects/:id/imports
 * The parser and planner live in ../import/ (inside the lazily loaded mock chunk). Parsed rows stay
 * in memory, never in localStorage; a reload loses them (→ failed `file_missing`). The runner ticks
 * every 150 ms, 4 rows per tick, like one backend batch each.
 */

export const MOCK_MAX_ROWS = 1000;
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
const TICK_MS = 150;
const ROWS_PER_TICK = 4;
const THROTTLE_PER_HOUR = 20;
const DAY = 86_400_000;
const REPORT_CACHE_LIMIT = 200_000;

const parsedFiles = new Map<string, ParsedFile>();
const plans = new Map<string, PlanResult>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const reports = new Map<string, string>();

/* ───────── upgrade ───────── */

const GRANT_AFTER = "task.move";
const ROLES_WITH_IMPORT = new Set(["project_admin", "manager", "project_member"]);

/**
 * Runs once per database (marker `ext40`): from createSeed(), when a cached database loads, and on
 * the first import route. Adds project.import to cached **system** roles by key (§3.2); custom
 * roles are untouched.
 */
export function ensureExt40(db: MockDB) {
  db.imports ??= [];
  db.importRows ??= [];
  if (db.ext40) return;
  db.ext40 = true;
  for (const r of db.roles) {
    if (!r.isSystem || !r.key || !ROLES_WITH_IMPORT.has(r.key) || r.permissions.includes("project.import")) continue;
    const at = r.permissions.indexOf(GRANT_AFTER as Permission);
    if (at >= 0) r.permissions.splice(at + 1, 0, "project.import");
    else r.permissions.push("project.import");
  }
}

/* ───────── views ───────── */

function toJob(rec: ImportJobRec): ImportJob {
  const { workspaceId: _w, userMaps: _u, phase: _p, numberBase: _n, plannedTasks: _t, cursor: _c, setup: _s, requestId: _r, reportCsv: _rc, ...job } = rec;
  return job;
}

function toSummary(rec: ImportJobRec): ImportJobSummary {
  return {
    id: rec.id,
    projectId: rec.projectId,
    source: rec.source,
    status: rec.status,
    fileName: rec.file.name,
    imported: rec.result?.imported ?? rec.progress?.imported ?? 0,
    skipped: rec.result?.skipped ?? rec.progress?.skipped ?? 0,
    firstKey: rec.result?.firstKey ?? null,
    lastKey: rec.result?.lastKey ?? null,
    hasErrorReport: Boolean(rec.result?.hasErrorReport),
    createdById: rec.createdById,
    createdAt: rec.createdAt,
    startedAt: rec.startedAt,
    finishedAt: rec.finishedAt,
    expiresAt: rec.expiresAt,
    error: rec.error,
  };
}

/* ───────── guards ───────── */

/** can_import: project.import and task.create, on an active project. The first missing code is reported. */
function requireImport(ctx: Ctx, p: ProjectRec) {
  const perms = projectPermissions(ctx.db, ctx.userId!, p.id);
  if (p.status === "archived") fail(403, "forbidden", "This project is archived. Unarchive it to import tasks.", { permission: "project.import" });
  for (const code of ["project.import", "task.create"] as const) {
    if (!perms.includes(code)) fail(403, "forbidden", "You don’t have permission to import tasks into this project.", { permission: code });
  }
  return perms;
}

/** Job → project → membership (404 / 403 like v1) → project.import. */
function loadJob(ctx: Ctx, id: string): { rec: ImportJobRec; project: ProjectRec } {
  const userId = requireUser(ctx);
  ensureExt40(ctx.db);
  const rec = ctx.db.imports!.find((j) => j.id === id);
  const project = rec && ctx.db.projects.find((p) => p.id === rec.projectId);
  if (!rec || !project || !wsMembership(ctx.db, userId, project.workspaceId)) fail(404, "not_found", "Import not found.");
  if (!projectMembership(ctx.db, userId, project.id)) fail(403, "project_membership_required", "You’re not a member of this project.");
  if (!projectPermissions(ctx.db, userId, project.id).includes("project.import")) {
    fail(403, "forbidden", "You don’t have permission to see this project’s imports.", { permission: "project.import" });
  }
  checkFile(rec, project);
  return { rec, project };
}

/** The creator, and can_import still holds (§3.4). */
function requireCreator(ctx: Ctx, rec: ImportJobRec, project: ProjectRec) {
  if (rec.createdById !== ctx.userId || !canImport(projectPermissions(ctx.db, ctx.userId!, project.id)) || project.status === "archived") {
    fail(403, "forbidden", "Only the person who started this import can change it.");
  }
}

function stateError(rec: ImportJobRec): never {
  const finished = rec.status === "completed" || rec.status === "canceled" || rec.status === "failed";
  fail(409, "import_state", finished ? "This import has finished." : "This import has already started.", { status: rec.status });
}

/** A page reload loses the parsed rows (memory only): ready / queued / running jobs fail (§6.7). */
function checkFile(rec: ImportJobRec, project: ProjectRec) {
  if ((rec.status === "ready" || rec.status === "queued" || rec.status === "running") && !parsedFiles.has(rec.id)) {
    failJob(getDB(), rec, project, "file_missing", "The mock API lost the file when the page reloaded. Start a new import.");
  }
}

/* ───────── planning context ───────── */

function planProject(db: MockDB, p: ProjectRec, userId: string): PlanProject {
  const statuses = statusesOf(db, p.id);
  return {
    key: p.key,
    taskSeq: p.taskSeq,
    statuses,
    defaultStatusId: (statuses.find((s) => s.glyph === "todo") ?? statuses[0]!).id,
    members: db.projectMembers
      .filter((m) => m.projectId === p.id)
      .map((m) => db.users.find((u) => u.id === m.userId)!)
      .filter(Boolean)
      .map((u) => ({ id: u.id, name: u.name, email: u.email })),
    importerId: userId,
    perms: projectPermissions(db, userId, p.id),
    labels: db.labels.filter((l) => l.projectId === p.id),
    epics: db.epics.filter((e) => e.projectId === p.id),
    sprints: db.sprints.filter((s) => s.projectId === p.id && s.state !== "completed"),
    customFields: (db.customFields ?? []).filter((f) => f.projectId === p.id).sort((a, b) => a.position - b.position),
    tasks: db.tasks.filter((t) => t.projectId === p.id && !t.deletedAt).map((t) => ({ id: t.id, key: t.key, parentId: t.parentId, sprintId: t.sprintId, epicId: t.epicId })),
  };
}

function replan(db: MockDB, rec: ImportJobRec, project: ProjectRec, columns: ImportColumnMapping[], revision: number) {
  const file = parsedFiles.get(rec.id)!;
  const plan = planImport(file, columns, rec.userMaps, planProject(db, project, rec.createdById ?? ""), revision);
  // Keys that no longer occur (another column was mapped) are dropped from the stored choices.
  const keep = <T,>(m: Record<string, T>, values: { key: string }[]) => Object.fromEntries(Object.entries(m).filter(([k]) => values.some((v) => v.key === k)));
  rec.userMaps = {
    statuses: keep(rec.userMaps.statuses, plan.validation.values.statuses),
    types: keep(rec.userMaps.types, plan.validation.values.types),
    people: keep(rec.userMaps.people, plan.validation.values.people),
  };
  rec.mapping = plan.mapping;
  rec.validation = plan.validation;
  return plan;
}

/* ───────── analysis errors (§4.3) ───────── */

const ANALYSIS_TITLES: Record<string, string> = {
  upload_missing: "Couldn’t read file",
  too_large: "File is too large",
  empty: "File is empty",
  excel: "Only .csv files",
  binary: "Not a text file",
  unclosed_quote: "Unclosed quote",
  cell_too_long: "A cell is too long",
  no_rows: "No rows found",
  header_only: "Header only, no rows",
  too_many_columns: "Too many columns",
  too_many_rows: "Too many rows",
};

function analysisFail(detail: CsvError | { reason: string; [k: string]: unknown }): never {
  const title = ANALYSIS_TITLES[detail.reason] ?? "Couldn’t read file";
  const extra = detail.reason === "too_many_rows" ? { mock: true } : detail.reason === "too_many_columns" ? { max: 40 } : {};
  fail(422, "validation_failed", title, { fields: { file: title }, file: { ...detail, ...extra } });
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") return new Uint8Array(await blob.arrayBuffer());
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer));
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(blob);
  });
}

/* ───────── mapping validation (I4) ───────── */

const FIELDS: ImportField[] = [
  "title",
  "description",
  "status",
  "assignee",
  "priority",
  "estimate",
  "dueDate",
  "labels",
  "type",
  "timeEstimate",
  "startDate",
  "epic",
  "sprint",
  "parent",
  "sourceId",
  "blockedBy",
  "blocks",
  "customField",
  "skip",
];
const TYPES: ImportTaskType[] = ["feature", "bug", "chore", "spike", "epic"];

function checkMapping(db: MockDB, rec: ImportJobRec, project: ProjectRec, body: Partial<ImportMapping>, userId: string): ImportColumnMapping[] {
  const errors: Record<string, string> = {};
  const columns = Array.isArray(body.columns) ? body.columns : null;
  if (!columns || columns.length !== rec.file.columnCount) errors.columns = "Send one entry per column";
  const fields = (db.customFields ?? []).filter((f) => f.projectId === project.id);
  const out: ImportColumnMapping[] = (columns ?? []).map((c, i) => {
    const field = (c as ImportColumnMapping | null)?.field;
    if (!field || !FIELDS.includes(field)) {
      errors[`columns.${i}.field`] = "Pick a field";
      return { field: "skip" };
    }
    if (field === "customField") {
      if (!fields.some((f) => f.id === c.customFieldId)) errors[`columns.${i}.customFieldId`] = "This field was deleted";
      return { field, customFieldId: c.customFieldId };
    }
    if (field === "timeEstimate") return { field, unit: c.unit === "minutes" || c.unit === "seconds" ? c.unit : "hours" };
    return { field };
  });
  const perms = projectPermissions(db, userId, project.id);
  const statusIds = new Set(statusesOf(db, project.id).map((s) => s.id));
  for (const [k, v] of Object.entries(body.statuses ?? {})) if (v !== null && !statusIds.has(v)) errors[`statuses.${k}`] = "Pick a status from this project";
  for (const [k, v] of Object.entries(body.types ?? {})) {
    if (v === null) continue;
    if (!TYPES.includes(v)) errors[`types.${k}`] = "Pick feature, bug, chore, spike or epic";
    else if (v === "epic" && !perms.includes("epic.manage")) errors[`types.${k}`] = "You can’t create epics in this project";
  }
  const memberIds = new Set(db.projectMembers.filter((m) => m.projectId === project.id).map((m) => m.userId));
  for (const [k, v] of Object.entries(body.people ?? {})) {
    if (v === null) continue;
    if (!memberIds.has(v)) errors[`people.${k}`] = "Pick someone on this project";
    else if (v !== userId && !perms.includes("task.assign")) errors[`people.${k}`] = "You can only assign tasks to yourself";
  }
  if (Object.keys(errors).length) fail(422, "validation_failed", "Some fields need fixing.", { fields: errors });
  return out;
}

/* ───────── routes ───────── */

export function registerImports() {
  /* I1 */
  route("POST", "/projects/:id/imports", (ctx) => {
    ensureExt40(ctx.db);
    const p = memberProject(ctx, ctx.params.id!);
    requireImport(ctx, p);
    const userId = ctx.userId!;
    const source = str(ctx.body, "source");
    const fileName = (str(ctx.body, "fileName") ?? "").replace(/[\\/]/g, "_").trim().slice(0, 120);
    const size = (ctx.body as { size?: unknown } | null)?.size;
    if (source === "trello") fail(422, "validation_failed", "Trello import is coming soon", { fields: { source: "Trello import is coming soon" } });
    if (source !== "csv" && source !== "jira") fail(422, "validation_failed", "Pick CSV or Jira", { fields: { source: "Pick CSV or Jira" } });
    if (!/\.csv$/i.test(fileName)) fail(422, "validation_failed", "Only .csv files", { fields: { file: "Only .csv files" } });
    if (typeof size !== "number" || !Number.isInteger(size) || size <= 0) fail(422, "validation_failed", "File is empty", { fields: { file: "File is empty" } });
    if (size > MAX_IMPORT_BYTES) fail(422, "validation_failed", "File is too large", { fields: { file: "File is too large" }, file: { reason: "too_large", size } });
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    if (ctx.db.imports!.filter((j) => j.createdById === userId && j.createdAt >= hourAgo).length >= THROTTLE_PER_HOUR) {
      fail(429, "rate_limited", "You’ve started a lot of imports. Try again in a few minutes.");
    }
    const now = nowISO();
    const id = uid("imp");
    const rec: ImportJobRec = {
      id,
      projectId: p.id,
      source: source as ImportSource,
      preset: "generic",
      status: "draft",
      cancelRequested: false,
      file: { name: fileName, size, encoding: "", delimiter: "", rowCount: 0, columnCount: 0 },
      analysis: null,
      mapping: null,
      validation: null,
      progress: null,
      result: null,
      error: null,
      createdById: userId,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      expiresAt: new Date(Date.now() + DAY).toISOString(),
      workspaceId: p.workspaceId,
      userMaps: { statuses: {}, types: {}, people: {} },
      phase: null,
      numberBase: null,
      plannedTasks: 0,
      cursor: 0,
      setup: null,
      requestId: "",
      reportCsv: null,
    };
    ctx.db.imports!.push(rec);
    registerMockUpload(id, fileName, size);
    return {
      job: toJob(rec),
      upload: { uploadId: id, url: `mock-upload://${id}`, method: "PUT", headers: { "Content-Type": "text/csv" }, expiresAt: new Date(Date.now() + 600_000).toISOString() },
    };
  });

  /* I2 */
  route("POST", "/imports/:id/analyze", async (ctx) => {
    const { rec, project } = loadJob(ctx, ctx.params.id!);
    requireCreator(ctx, rec, project);
    if (rec.status === "ready") return toJob(rec);
    if (rec.status !== "draft") stateError(rec);
    const blob = mockUploads.get(rec.id)?.blob;
    if (!blob) analysisFail({ reason: "upload_missing" });
    if (blob.size > MAX_IMPORT_BYTES) analysisFail({ reason: "too_large", size: blob.size });
    if (blob.size === 0) analysisFail({ reason: "empty" });
    const decoded = decodeBytes(await blobBytes(blob));
    if (!decoded.ok) analysisFail({ reason: decoded.reason });
    const delimiter = sniffDelimiter(decoded.text);
    const parsed = parseCsv(decoded.text, delimiter, MOCK_MAX_ROWS);
    if (!parsed.ok) analysisFail(parsed.error);
    const file: ParsedFile = { ...parsed.csv, delimiter };
    // The job may have been canceled while the file was being read.
    if (rec.status !== "draft") stateError(rec);
    parsedFiles.set(rec.id, file);
    const ctxProject = planProject(ctx.db, project, ctx.userId!);
    rec.preset = detectPreset(file.rawHeader);
    rec.file = { ...rec.file, size: blob.size, encoding: decoded.encoding, delimiter, rowCount: file.rows.length, columnCount: file.header.length };
    rec.analysis = { columns: analyzeColumns(file, ctxProject.members) };
    rec.status = "ready";
    replan(ctx.db, rec, project, suggestColumns(file.rawHeader, rec.preset, ctxProject.customFields), 0);
    return toJob(rec);
  });

  /* I3 */
  route("GET", "/imports/:id", (ctx) => toJob(loadJob(ctx, ctx.params.id!).rec));

  /* I4 */
  route("PUT", "/imports/:id/mapping", (ctx) => {
    const { rec, project } = loadJob(ctx, ctx.params.id!);
    requireCreator(ctx, rec, project);
    if (rec.status !== "ready") stateError(rec);
    const body = (ctx.body ?? {}) as Partial<ImportMapping>;
    const revision = Number(body.revision);
    if (!Number.isFinite(revision) || revision <= (rec.mapping?.revision ?? 0)) {
      fail(409, "mapping_conflict", "This mapping was changed in another tab.", { current: toJob(rec) });
    }
    const columns = checkMapping(ctx.db, rec, project, body, ctx.userId!);
    rec.userMaps = { statuses: { ...(body.statuses ?? {}) }, types: { ...(body.types ?? {}) }, people: { ...(body.people ?? {}) } } as UserMaps;
    replan(ctx.db, rec, project, columns, revision);
    return toJob(rec);
  });

  /* I5 */
  route("GET", "/imports/:id/rows", (ctx) => {
    const { rec, project } = loadJob(ctx, ctx.params.id!);
    const outcome = filterValues(ctx.query, "outcome")[0] ?? "all";
    const limit = Math.min(Math.max(Number(ctx.query.limit) || 20, 1), 100);
    const offset = Number(ctx.query.cursor) || 0;
    let rows: ImportRowPreview[];
    if (rec.status === "ready") {
      const plan = planImport(parsedFiles.get(rec.id)!, rec.mapping!.columns, rec.userMaps, planProject(ctx.db, project, rec.createdById ?? ""), rec.mapping!.revision);
      rows = plan.rows.map((r) => ({ row: r.row, outcome: r.outcome, key: r.key, issues: r.issues, values: r.values }));
    } else {
      const plan = plans.get(rec.id);
      rows = ctx.db.importRows!
        .filter((r) => r.jobId === rec.id)
        .sort((a, b) => a.row - b.row)
        .map((r) => ({
          row: r.row,
          outcome: r.outcome,
          key: r.key,
          issues: r.issues,
          values: plan?.rows.find((p) => p.row === r.row)?.values ?? {
            title: r.title,
            type: r.outcome === "epic" ? "epic" : "feature",
            statusId: null,
            assigneeId: null,
            priority: 0,
            estimate: null,
            timeEstimateMinutes: null,
            startDate: null,
            dueDate: null,
            labels: [],
            epic: null,
            sprintId: null,
            parent: null,
            customFields: {},
          },
        }));
    }
    if (outcome === "warning") rows = rows.filter((r) => r.issues.some((i) => i.severity === "warning"));
    else if (outcome !== "all") rows = rows.filter((r) => r.outcome === outcome);
    const data = rows.slice(offset, offset + limit);
    return { data, nextCursor: offset + limit < rows.length ? String(offset + limit) : null };
  });

  /* I6 */
  route("POST", "/imports/:id/start", (ctx) => {
    const { rec, project } = loadJob(ctx, ctx.params.id!);
    requireCreator(ctx, rec, project);
    if (rec.status === "queued" || rec.status === "running") return toJob(rec);
    if (rec.status !== "ready" && rec.status !== "failed") stateError(rec);
    if (rec.status === "failed" && (rec.error?.code === "file_missing" || !parsedFiles.has(rec.id))) {
      fail(409, "import_state", "The uploaded file is gone. Start a new import.", { status: rec.status });
    }
    if (rec.status === "ready") {
      replan(ctx.db, rec, project, rec.mapping!.columns, rec.mapping!.revision);
      const blockers = rec.validation!.blockers;
      if (blockers.length) fail(422, "validation_failed", blockers[0]!.message, { fields: { mapping: blockers[0]!.message }, blockers });
    }
    const busy = ctx.db.imports!.find((j) => j.projectId === project.id && j.id !== rec.id && (j.status === "queued" || j.status === "running"));
    if (busy) fail(409, "import_in_progress", "Another import is running in this project. Try again when it finishes.", { jobId: busy.id });
    const total = rec.file.rowCount;
    rec.status = "queued";
    rec.requestId ||= `req_${uid("").slice(-10)}`;
    rec.error = null;
    rec.result = null;
    rec.finishedAt = null;
    rec.expiresAt = null;
    rec.progress ??= { phase: "preparing", total, processed: 0, imported: 0, epics: 0, skipped: 0, warnings: 0, recent: [] };
    rec.phase ??= "preparing";
    if (!rec.setup?.done) recordAudit(ctx.db, rec, project, "project.import_started", rec.file.name, null);
    schedule(rec.id);
    return toJob(rec);
  });

  /* I7 */
  route("POST", "/imports/:id/cancel", (ctx) => {
    const { rec, project } = loadJob(ctx, ctx.params.id!);
    const perms = projectPermissions(ctx.db, ctx.userId!, project.id);
    if (rec.createdById !== ctx.userId && !perms.includes("project.update")) fail(403, "forbidden", "Only the person who started this import can stop it.", { permission: "project.update" });
    if (rec.status === "completed" || rec.status === "canceled") stateError(rec);
    if (rec.status === "running") {
      rec.cancelRequested = true;
      return toJob(rec);
    }
    const wasStarted = rec.status === "queued" || rec.status === "failed";
    rec.status = "canceled";
    rec.finishedAt = nowISO();
    rec.expiresAt = new Date(Date.now() + (wasStarted ? 30 : 1) * DAY).toISOString();
    if (rec.status === "canceled" && !wasStarted) {
      // Drafts and ready jobs: the file goes now; the record is purged by retention.
      mockUploads.delete(rec.id);
      parsedFiles.delete(rec.id);
    }
    clearTimer(rec.id);
    return toJob(rec);
  });

  /* I8 */
  route("GET", "/imports/:id/error-report", (ctx) => {
    const { rec, project } = loadJob(ctx, ctx.params.id!);
    const terminal = rec.status === "completed" || rec.status === "canceled" || rec.status === "failed";
    const csv = reports.get(rec.id) ?? rec.reportCsv;
    if (!terminal || !rec.result?.hasErrorReport || !csv) fail(404, "not_found", "This import has no error report.");
    const body = `﻿${csv}`;
    let url: string;
    if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
      url = URL.createObjectURL(new Blob([body], { type: "text/csv" }));
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } else {
      url = `data:text/csv;charset=utf-8,${encodeURIComponent(body)}`;
    }
    return { url, fileName: reportFileName(project.key, rec.finishedAt ?? nowISO()), expiresAt: new Date(Date.now() + 60_000).toISOString() };
  });

  /* I9 */
  route("GET", "/projects/:id/imports", (ctx) => {
    ensureExt40(ctx.db);
    const p = memberProject(ctx, ctx.params.id!);
    requireImport(ctx, p);
    const list = ctx.db.imports!.filter((j) => j.projectId === p.id && j.status !== "draft");
    list.forEach((j) => checkFile(j, p));
    return list
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 20)
      .map(toSummary);
  });
}

/* ───────── runner ───────── */

function clearTimer(id: string) {
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.delete(id);
}

function schedule(id: string) {
  if (timers.has(id)) return;
  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id);
      const db = getDB();
      const rec = db.imports?.find((j) => j.id === id);
      if (!rec) return;
      const done = step(db, rec);
      persist();
      if (!done) schedule(id);
    }, TICK_MS),
  );
}

/** Tests: run a queued job to the end synchronously (no timers). */
export function runImportNow(id: string, maxTicks = 10_000) {
  clearTimer(id);
  const db = getDB();
  const rec = db.imports?.find((j) => j.id === id);
  if (!rec) return;
  for (let i = 0; i < maxTicks; i++) if (step(db, rec)) break;
}

/** Tests: forget the in-memory files (what a page reload does). */
export function dropImportMemory() {
  parsedFiles.clear();
  plans.clear();
  reports.clear();
  timers.forEach((t) => clearTimeout(t));
  timers.clear();
}

const pushRecent = (rec: ImportJobRec, line: ImportLogLine) => {
  rec.progress!.recent = [...rec.progress!.recent, line].slice(-10);
};

function richFromText(text: string): RichDoc | null {
  const t = text.replace(/\r\n?/g, "\n").trim();
  if (!t) return null;
  const content: RichNode[] = t.split(/\n{2,}/).map((para) => {
    const lines = para.split("\n");
    const nodes: RichNode[] = [];
    lines.forEach((line, i) => {
      if (i > 0) nodes.push({ type: "hardBreak" });
      if (line) nodes.push({ type: "text", text: line });
    });
    return { type: "paragraph", content: nodes };
  });
  return { type: "doc", content };
}

function issueKey(i: ImportIssue & { row: number }) {
  return `${i.row}|${i.severity}|${i.reason}`;
}

/** One tick = one backend batch. Returns true when the job is terminal. */
function step(db: MockDB, rec: ImportJobRec): boolean {
  if (rec.status !== "queued" && rec.status !== "running") return true;
  const project = db.projects.find((p) => p.id === rec.projectId);
  const file = parsedFiles.get(rec.id);
  const imported = rec.progress?.imported ?? 0;
  if (!file) return failJob(db, rec, project, "file_missing", "The mock API lost the file when the page reloaded. Start a new import.");
  if (!project || project.status === "archived") {
    return failJob(db, rec, project, "project_unavailable", `The project was archived during the import. ${imported} ${imported === 1 ? "task was" : "tasks were"} imported.`);
  }
  const creator = rec.createdById ?? "";
  if (!canImport(projectPermissions(db, creator, project.id))) {
    return failJob(db, rec, project, "permission_lost", `You no longer have permission to import into ${project.key}. ${imported} ${imported === 1 ? "task was" : "tasks were"} imported before it stopped.`);
  }
  if (rec.status === "queued") {
    rec.status = "running";
    rec.startedAt ??= nowISO();
    return false;
  }
  if (rec.cancelRequested) {
    linkPhase(db, rec, project, true);
    return finishJob(db, rec, project, "canceled");
  }
  let plan = plans.get(rec.id);
  if (!plan) {
    plan = planImport(file, rec.mapping!.columns, rec.userMaps, planProject(db, project, creator), rec.mapping!.revision);
    plans.set(rec.id, plan);
  }
  const progress = rec.progress!;
  if (rec.phase === "preparing") {
    if (!rec.setup?.done) prepare(db, rec, project, plan);
    rec.phase = "rows";
    progress.phase = "rows";
    return false;
  }
  if (rec.phase === "rows") {
    const batch = plan.rows.slice(rec.cursor, rec.cursor + ROWS_PER_TICK);
    for (const r of batch) importRow(db, rec, project, r, creator);
    rec.cursor += batch.length;
    progress.processed = rec.cursor;
    if (rec.cursor >= plan.rows.length) {
      rec.phase = "links";
      progress.phase = "links";
    }
    return false;
  }
  if (rec.phase === "links") {
    linkPhase(db, rec, project, false);
    rec.phase = "finishing";
    progress.phase = "finishing";
    return false;
  }
  return finishJob(db, rec, project, "completed");
}

/** Preparing (§5.2): labels, epics and select options (get-or-create by name), then reserve numbers. */
function prepare(db: MockDB, rec: ImportJobRec, project: ProjectRec, plan: PlanResult) {
  const setup = { done: false, labels: {} as Record<string, string>, epics: {} as Record<string, string>, options: {} as Record<string, Record<string, string>> };
  const creator = rec.createdById ?? "";
  for (const name of plan.validation.creates.labels) {
    const existing = db.labels.find((l) => l.projectId === project.id && l.name.toLowerCase() === name);
    if (existing) setup.labels[name] = existing.id;
    else {
      const id = uid("lb");
      db.labels.push({ id, projectId: project.id, name, color: "var(--text-3)" });
      setup.labels[name] = id;
      recordAudit(db, rec, project, "label.created", name, null);
    }
  }
  const epicFor = (name: string, dates: { startDate: string | null; dueDate: string | null } | null) => {
    const existing = db.epics.find((e) => e.projectId === project.id && e.name.toLowerCase() === name.toLowerCase());
    if (existing) return existing.id;
    const id = uid("ep");
    db.epics.push({
      id,
      projectId: project.id,
      name: name.slice(0, 80),
      description: "",
      hue: [255, 200, 150, 60, 20, 300][db.epics.length % 6]!,
      ownerId: null,
      milestoneId: null,
      archivedAt: null,
      startDate: dates?.startDate ?? null,
      dueDate: dates?.dueDate ?? null,
    });
    recordAudit(db, rec, project, "epic.created", name, null);
    return id;
  };
  for (const r of plan.rows) {
    if (r.outcome === "epic") setup.epics[`row:${r.row}`] = epicFor(r.values.title, { startDate: r.values.startDate, dueDate: r.values.dueDate });
  }
  for (const r of plan.rows) {
    if (r.outcome !== "task" || r.epicRow !== null || r.epicId || !r.epicName) continue;
    if (!project || !projectPermissions(db, creator, project.id).includes("epic.manage")) continue;
    setup.epics[`name:${r.epicName.toLowerCase()}`] ??= epicFor(r.epicName, null);
  }
  for (const { customFieldId, names } of plan.validation.creates.options) {
    const f = db.customFields?.find((x) => x.id === customFieldId);
    if (!f) continue;
    setup.options[customFieldId] = {};
    for (const name of names) {
      let opt = f.options.find((o) => o.name.toLowerCase() === name.toLowerCase());
      if (!opt) {
        opt = { id: uid("opt"), name: name.slice(0, 40), color: "var(--text-3)", position: f.options.length };
        f.options.push(opt);
      }
      setup.options[customFieldId][name.toLowerCase()] = opt.id;
    }
    recordAudit(db, rec, project, "project.custom_field_updated", f.name, null);
  }
  // Reserve a contiguous block of task numbers.
  const tasks = plan.rows.filter((r) => r.outcome === "task").length;
  rec.numberBase = project.taskSeq + 1;
  rec.plannedTasks = tasks;
  project.taskSeq += tasks;
  setup.done = true;
  rec.setup = setup;
}

function importRow(db: MockDB, rec: ImportJobRec, project: ProjectRec, r: PlanResult["rows"][number], creator: string) {
  const progress = rec.progress!;
  const rows = db.importRows!;
  if (rows.some((x) => x.jobId === rec.id && x.row === r.row)) return; // idempotent (unique job + row)
  const base: ImportRowRec = { jobId: rec.id, row: r.row, outcome: r.outcome, taskId: null, epicId: null, key: null, title: r.values.title, refs: r.refs, issues: [...r.issues] };
  if (r.outcome === "skipped") {
    rows.push(base);
    progress.skipped++;
    pushRecent(rec, { row: r.row, outcome: "skipped", key: null, title: r.values.title, reason: r.issues[0]?.reason ?? null });
    return;
  }
  if (r.outcome === "epic") {
    base.epicId = rec.setup?.epics[`row:${r.row}`] ?? null;
    rows.push(base);
    progress.epics++;
    progress.warnings += r.issues.filter((i) => i.severity === "warning").length;
    pushRecent(rec, { row: r.row, outcome: "epic", key: null, title: r.values.title, reason: null });
    return;
  }
  const statuses = statusesOf(db, project.id);
  const fallback = (statuses.find((s) => s.glyph === "todo") ?? statuses[0]!).id;
  let statusId = r.values.statusId ?? fallback;
  if (!statuses.some((s) => s.id === statusId)) {
    base.issues.push({ severity: "warning", field: "status", reason: `Status was deleted · used ${statuses.find((s) => s.id === fallback)?.name ?? "the default"}`, value: "" });
    statusId = fallback;
  }
  let assigneeId = r.values.assigneeId;
  if (assigneeId && !projectMembership(db, assigneeId, project.id)) {
    base.issues.push({ severity: "warning", field: "assignee", reason: "Assignee left the project · left unassigned", value: "" });
    assigneeId = null;
  }
  const setup = rec.setup!;
  const epicId = r.epicRow !== null ? (setup.epics[`row:${r.epicRow}`] ?? null) : (r.epicId ?? (r.epicName ? (setup.epics[`name:${r.epicName.toLowerCase()}`] ?? null) : null));
  const labelIds = r.values.labels
    .map((n) => setup.labels[n] ?? db.labels.find((l) => l.projectId === project.id && l.name.toLowerCase() === n)?.id)
    .filter((x): x is string => Boolean(x));
  const customFields = { ...r.values.customFields };
  for (const [fieldId, name] of Object.entries(r.newOptions)) {
    const id = setup.options[fieldId]?.[name.toLowerCase()];
    if (id) customFields[fieldId] = id;
  }
  const number = (rec.numberBase ?? project.taskSeq + 1) + progress.imported;
  const now = nowISO();
  const t: TaskRec = {
    id: uid("t"),
    projectId: project.id,
    key: `${project.key}-${number}`,
    number,
    title: r.values.title,
    type: r.values.type === "epic" ? "feature" : r.values.type,
    priority: r.values.priority,
    statusId,
    assigneeId,
    reporterId: creator,
    estimate: r.values.estimate,
    startDate: r.values.startDate,
    dueDate: r.values.dueDate,
    epicId,
    milestoneId: null,
    // Imports go to the backlog unless a Sprint column maps them (§9 #27); sub-tasks get the parent's.
    sprintId: r.values.sprintId,
    parentId: null,
    objectiveIds: [],
    labelIds,
    position: keyBetween(null, null),
    version: 1,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    startedAt: null,
    deletedAt: null,
    description: richFromText(r.description),
    customFields,
    timeEstimateMinutes: r.values.timeEstimateMinutes,
  };
  t.position = lastPosition(db, project.id, statusId);
  applyStatusSideEffects(db, t, statusId);
  db.tasks.push(t);
  base.taskId = t.id;
  base.key = t.key;
  rows.push(base);
  progress.imported++;
  progress.warnings += base.issues.filter((i) => i.severity === "warning").length;
  pushRecent(rec, { row: r.row, outcome: "task", key: t.key, title: t.title, reason: null });
  const glyph = statuses.find((s) => s.id === statusId)?.glyph ?? "todo";
  recordAudit(db, rec, project, "task.imported", t.title, t.key, [
    { field: "Title", kind: "text", before: null, after: t.title },
    { field: "Status", kind: "status", before: null, after: glyph },
  ]);
}

/** Links (§5.5): parents of sub-tasks, then dependencies with board 39's rules. */
function linkPhase(db: MockDB, rec: ImportJobRec, project: ProjectRec, onlyProcessed: boolean) {
  const plan = plans.get(rec.id);
  if (!plan) return;
  const rows = db.importRows!.filter((x) => x.jobId === rec.id);
  const taskOfRow = (row: number) => rows.find((x) => x.row === row)?.taskId ?? null;
  const live = (id: string | null) => {
    const t = id ? db.tasks.find((x) => x.id === id && !x.deletedAt && x.projectId === project.id) : undefined;
    return t ?? null;
  };
  const warnRow = (rowRec: ImportRowRec, field: ImportField, reason: string, value: string) => {
    rowRec.issues.push({ severity: "warning", field, reason, value });
    rec.progress!.warnings++;
  };
  db.dependencies ??= [];
  for (const r of plan.rows) {
    if (r.outcome !== "task") continue;
    const rowRec = rows.find((x) => x.row === r.row);
    const self = live(rowRec?.taskId ?? null);
    if (!rowRec || !self) continue;
    if (onlyProcessed && r.row - 2 >= rec.cursor) continue;
    if (r.parent && !self.parentId) {
      const parent = live(r.parent.row !== undefined ? taskOfRow(r.parent.row) : (r.parent.taskId ?? null));
      if (parent && parent.id !== self.id && !parent.parentId) self.parentId = parent.id;
    }
    for (const field of ["blockedBy", "blocks"] as const) {
      for (const target of r[field]) {
        const other = live(target.row !== undefined ? taskOfRow(target.row) : (target.taskId ?? null));
        if (!other) continue; // not imported (stopped early): nothing to link
        const [blocker, blocked] = field === "blockedBy" ? [other, self] : [self, other];
        if (blocker.id === blocked.id || blocker.parentId === blocked.id || blocked.parentId === blocker.id) {
          warnRow(rowRec, field, "Would create a loop · dependency skipped", target.ref);
          continue;
        }
        if (db.dependencies.some((d) => d.blockerId === blocker.id && d.blockedId === blocked.id)) continue;
        const count = (pred: (d: { blockerId: string; blockedId: string }) => boolean) => db.dependencies!.filter(pred).length;
        if (count((d) => d.blockedId === blocked.id) >= DEP_LIMIT || count((d) => d.blockerId === blocker.id) >= DEP_LIMIT) {
          warnRow(rowRec, field, "Dependency limit reached", target.ref);
          continue;
        }
        if (findCycle(db, blocker.id, blocked.id)) {
          warnRow(rowRec, field, "Would create a loop · dependency skipped", target.ref);
          continue;
        }
        db.dependencies.push({ id: uid("dep"), projectId: project.id, blockerId: blocker.id, blockedId: blocked.id, createdById: rec.createdById, createdAt: nowISO() });
      }
    }
  }
}

function collectIssues(db: MockDB, rec: ImportJobRec) {
  const all: (ImportIssue & { row: number })[] = [];
  const seen = new Set<string>();
  for (const r of db.importRows!.filter((x) => x.jobId === rec.id)) {
    for (const i of r.issues) {
      const item = { ...i, row: r.row };
      if (seen.has(issueKey(item))) continue;
      seen.add(issueKey(item));
      all.push(item);
    }
  }
  return all.sort((a, b) => (a.severity === b.severity ? a.row - b.row : a.severity === "skip" ? -1 : 1));
}

function buildResult(db: MockDB, rec: ImportJobRec): ImportResult {
  const p = rec.progress ?? { imported: 0, epics: 0, skipped: 0, warnings: 0 };
  const tasks = db.importRows!.filter((x) => x.jobId === rec.id && x.outcome === "task" && x.key).sort((a, b) => a.row - b.row);
  const issues = collectIssues(db, rec);
  const setup = rec.setup;
  return {
    imported: p.imported,
    epics: p.epics,
    skipped: p.skipped,
    warnings: p.warnings,
    firstKey: tasks[0]?.key ?? null,
    lastKey: tasks.at(-1)?.key ?? null,
    created: {
      labels: setup ? Object.keys(setup.labels).length : 0,
      epics: setup ? Object.keys(setup.epics).length : 0,
      options: setup ? Object.values(setup.options).reduce((a, o) => a + Object.keys(o).length, 0) : 0,
    },
    hasErrorReport: issues.length > 0,
    issueCount: issues.length,
    issues: issues.slice(0, 50),
  };
}

function storeReport(db: MockDB, rec: ImportJobRec) {
  const issues = collectIssues(db, rec);
  if (!issues.length) return;
  const file = parsedFiles.get(rec.id);
  const csv = buildReport(file?.header ?? [], file?.rows ?? [], issues);
  reports.set(rec.id, csv);
  rec.reportCsv = csv.length <= REPORT_CACHE_LIMIT ? csv : null;
}

/** Finishing (§5.2): report, counters, status, audit summary, notification, activity. */
function finishJob(db: MockDB, rec: ImportJobRec, project: ProjectRec, status: "completed" | "canceled"): true {
  rec.progress!.phase = "finishing";
  rec.phase = "finishing";
  storeReport(db, rec);
  rec.result = buildResult(db, rec);
  rec.status = status;
  rec.finishedAt = nowISO();
  rec.expiresAt = new Date(Date.now() + 30 * DAY).toISOString();
  clearTimer(rec.id);
  recordAudit(db, rec, project, "project.import_completed", rec.file.name, null);
  logActivity(db, rec.createdById, "imported", project.id, null, { imported: rec.result.imported, fileName: rec.file.name, status });
  notifyFinished(db, rec, project);
  // Board 33: one tasks.bulk_changed ("many") at the end of an import (spec §6.2).
  publishBulk(db, rec.createdById, project.id, null, "created");
  return true;
}

function failJob(db: MockDB, rec: ImportJobRec, project: ProjectRec | undefined, code: string, message: string): true {
  if (rec.status === "ready") {
    // A ready job never ran: no result, nothing to notify.
    rec.status = "failed";
    rec.error = { code, message };
    rec.finishedAt = nowISO();
    rec.expiresAt = new Date(Date.now() + 30 * DAY).toISOString();
    return true;
  }
  if (project) storeReport(db, rec);
  rec.result = rec.progress ? buildResult(db, rec) : null;
  rec.status = "failed";
  rec.error = { code, message };
  rec.finishedAt = nowISO();
  rec.expiresAt = new Date(Date.now() + 30 * DAY).toISOString();
  clearTimer(rec.id);
  if (project) {
    recordAudit(db, rec, project, "project.import_completed", rec.file.name, null);
    notifyFinished(db, rec, project);
    if (rec.result?.imported) publishBulk(db, rec.createdById, project.id, null, "created");
  }
  return true;
}

/** §5.8: one in-app notification to the creator (system row), still requiring project membership. */
function notifyFinished(db: MockDB, rec: ImportJobRec, project: ProjectRec) {
  const creator = rec.createdById;
  if (!creator || !projectMembership(db, creator, project.id)) return;
  const importStatus = rec.status === "failed" ? "failed" : rec.status === "canceled" ? "canceled" : "completed";
  db.notifications.unshift({
    id: uid("n"),
    recipientId: creator,
    type: "import",
    actorId: null,
    projectId: project.id,
    projectName: project.name,
    taskId: null,
    taskKey: null,
    taskTitle: null,
    payload: { importId: rec.id, projectKey: project.key, imported: rec.result?.imported ?? 0, skipped: rec.result?.skipped ?? 0, importStatus },
    createdAt: nowISO(),
    readAt: null,
  });
}

/** Audit rows of a job carry the start request's id, the creator as actor and source "import" (§5.9). */
function recordAudit(db: MockDB, rec: ImportJobRec, project: ProjectRec, action: string, target: string, key: string | null, changes?: NonNullable<MockDB["audit"][number]["changes"]>) {
  db.audit.unshift({
    id: uid("au"),
    workspaceId: project.workspaceId,
    actorId: rec.createdById ?? "",
    action,
    target,
    createdAt: nowISO(),
    entityType: action.split(".")[0],
    entityKey: key ?? (action.startsWith("project.") ? project.key : null),
    source: "import",
    requestId: rec.requestId || null,
    changes,
  });
}

/** Tests: the exact report body I8 serves (BOM + CSV); jsdom can't read blob: URLs back. */
export const reportBody = (id: string) => {
  const csv = reports.get(id) ?? getDB().imports?.find((j) => j.id === id)?.reportCsv;
  return csv ? `﻿${csv}` : null;
};

/** For tests and the dev tools: the in-memory parsed file of a job. */
export const hasParsedFile = (id: string) => parsedFiles.has(id);

/** Task records created by an import, newest job first (tests). */
export function importedTasks(db: MockDB, jobId: string) {
  return db.importRows!.filter((r) => r.jobId === jobId && r.taskId).map((r) => toTask(db, db.tasks.find((t) => t.id === r.taskId)!));
}
