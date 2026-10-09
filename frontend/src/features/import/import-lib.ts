import type {
  CustomField,
  ImportField,
  ImportFileInfo,
  ImportJob,
  ImportStatus,
  ImportValidation,
  Project,
} from "@/lib/api/types";

/*
 * Board 40 import wizard: pure helpers (unit-tested in import-lib.test.ts). No React, no parser:
 * the live client never parses CSV (the parser lives only in src/lib/mock/import/).
 */

export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

/** §4.5 select labels, in design order. */
export const IMPORT_FIELD_LABELS: Record<ImportField, string> = {
  title: "Title",
  description: "Description",
  status: "Status",
  assignee: "Assignee",
  priority: "Priority",
  estimate: "Estimate",
  dueDate: "Due date",
  labels: "Labels",
  type: "Type",
  timeEstimate: "Time estimate",
  startDate: "Start date",
  epic: "Epic",
  sprint: "Sprint",
  parent: "Parent",
  sourceId: "ID (for links)",
  blockedBy: "Blocked by",
  blocks: "Blocks",
  customField: "Custom field",
  skip: "Don’t import",
};

/** `project.import` and `task.create` (§3.1); nothing is inferred from role names. */
export function canImport(perms: readonly string[] | null | undefined): boolean {
  return Boolean(perms?.includes("project.import") && perms.includes("task.create"));
}

/** Entry points also need an active project (archived projects are read-only). */
export const canImportInto = (p: Pick<Project, "my_permissions" | "status">) => p.status === "active" && canImport(p.my_permissions);

export type FileProblem = { title: string; meta: string };

const fmtMb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;

/** "4 KB" under 1 MB (at least 1 KB), else "12.4 MB" (design). */
export function sizeLabel(bytes: number) {
  const kb = bytes / 1024;
  return kb < 1024 ? `${Math.max(1, Math.round(kb))} KB` : fmtMb(bytes);
}

/** Instant client checks before the create call (§1.4 step 2), with the design's copy. */
export function precheckImportFile(file: { name: string; size: number }): FileProblem | null {
  const name = String(file.name || "file").slice(0, 120);
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  if (ext !== "csv") return { title: "Only .csv files", meta: `${name} · ${ext ? `.${ext}` : "no extension"} · export as CSV first` };
  if (file.size > MAX_IMPORT_BYTES) return { title: "File is too large", meta: `${name} · ${fmtMb(file.size)} · max 10 MB` };
  if (!file.size) return { title: "File is empty", meta: name };
  return null;
}

/**
 * Meta line for a 422 analysis error (§4.3): the title comes from `details.fields.file`, the meta
 * from `details.file`. `rows`/`columns` counts are grouped ("6,210 rows · max 5,000").
 */
export function analysisErrorMeta(name: string, detail: Record<string, unknown> | null | undefined): string {
  const reason = String(detail?.reason ?? "");
  const n = (v: unknown) => Number(v ?? 0).toLocaleString("en-US");
  switch (reason) {
    case "upload_missing":
      return `${name} · The upload didn’t finish. Try again.`;
    case "too_large":
      return `${name} · ${fmtMb(Number(detail?.size ?? 0))} · max 10 MB`;
    case "excel":
      return `${name} · Excel workbook · export as CSV first`;
    case "unclosed_quote":
      return `${name} · near line ${n(detail?.line)}`;
    case "cell_too_long":
      return `${name} · line ${n(detail?.line)} · max 64 KB per cell`;
    case "too_many_columns":
      return `${n(detail?.columns)} columns · max ${n(detail?.max ?? 40)}`;
    case "too_many_rows":
      return `${n(detail?.rows)} rows · max ${n(detail?.max ?? 5000)}${detail?.mock ? " in the mock API" : ""}`;
    default:
      return name;
  }
}

const DELIM_NAME: Record<string, string> = { ";": " · ; separated", "\t": " · tab separated", "|": " · | separated" };

/** "48 rows · 8 columns · 4 KB" + " · ; separated" + " · Windows-1252" (design order). */
export function fileMeta(f: ImportFileInfo) {
  const enc = f.encoding && f.encoding !== "utf-8" ? ` · ${f.encoding === "windows-1252" ? "Windows-1252" : "UTF-16"}` : "";
  return `${f.rowCount.toLocaleString("en-US")} ${f.rowCount === 1 ? "row" : "rows"} · ${f.columnCount} ${f.columnCount === 1 ? "column" : "columns"} · ${sizeLabel(f.size)}${DELIM_NAME[f.delimiter] ?? ""}${enc}`;
}

export const PRESET_NOTE: Record<string, string> = {
  jira: "Looks like a Jira export",
  linear: "Looks like a Linear export",
  asana: "Looks like an Asana export",
};

/** Preset line under the file card; the Jira tile with a generic file gets the non-blocking note. */
export function presetNote(job: Pick<ImportJob, "source" | "preset">): string | null {
  if (job.preset !== "generic") return PRESET_NOTE[job.preset] ?? null;
  if (job.source === "jira") return "This doesn’t look like a Jira export. Columns are matched by name.";
  return null;
}

export type WizardStep = 1 | 2 | 3 | 4;
export type WizardPhase = "setup" | "running" | "result";

/** §1.4: draft / no job → 1–2, ready → 3 (map), queued / running → 4 running, terminal → 4 result. */
export function stepOf(job: Pick<ImportJob, "status" | "startedAt"> | null): { step: WizardStep; phase: WizardPhase } {
  if (!job || job.status === "draft") return { step: 2, phase: "setup" };
  if (job.status === "ready") return { step: 3, phase: "setup" };
  if (job.status === "queued" || job.status === "running") return { step: 4, phase: "running" };
  // A job that never started (canceled, or failed because the file is gone) has no result: upload again.
  if ((job.status === "canceled" || job.status === "failed") && !job.startedAt) return { step: 2, phase: "setup" };
  return { step: 4, phase: "result" };
}

export const isActiveStatus = (s: ImportStatus) => s === "queued" || s === "running";
export const isTerminalStatus = (s: ImportStatus) => s === "completed" || s === "canceled" || s === "failed";

/**
 * Footer reason (warning tone) for setup steps; null when Next may proceed. Step 3 shows the
 * server's first blocker ("Map a column to Title" → "Two columns map to Status" → …).
 */
export function footerReason(
  step: WizardStep,
  s: { source: string | null; uploading: boolean; fileError: boolean; job: Pick<ImportJob, "status" | "validation"> | null },
): string | null {
  if (step === 1) return s.source ? null : "Pick a source";
  if (step === 2) {
    if (s.uploading) return "Reading file";
    if (s.job?.status === "ready") return null;
    if (s.fileError) return "Fix the file to continue";
    return "Upload a CSV file";
  }
  if (step === 3) return s.job?.validation?.blockers[0]?.message ?? null;
  return null;
}

export type FieldOption = { value: string; label: string };
export type FieldGroup = { label: string | null; options: FieldOption[] };

const CORE: ImportField[] = ["title", "description", "status", "assignee", "priority", "estimate", "dueDate", "labels"];
const MORE: ImportField[] = ["type", "timeEstimate", "startDate", "epic", "sprint", "parent", "sourceId", "blockedBy", "blocks"];

/** Select value for a column mapping ("cf:<id>" for custom fields). */
export const fieldValue = (c: { field: ImportField; customFieldId?: string }) => (c.field === "customField" ? `cf:${c.customFieldId ?? ""}` : c.field);

/**
 * §4.5 options: the design's eight ("Title *" first), "More fields", a "Custom fields" group with
 * this project's fields, then "Don’t import". Every field is offered; value-level gates (Epic type,
 * other assignees, new options) apply in the value tables.
 */
export function fieldOptions(customFields: Pick<CustomField, "id" | "name">[]): FieldGroup[] {
  const groups: FieldGroup[] = [
    { label: null, options: CORE.map((f) => ({ value: f, label: f === "title" ? "Title *" : IMPORT_FIELD_LABELS[f] })) },
    { label: "More fields", options: MORE.map((f) => ({ value: f, label: IMPORT_FIELD_LABELS[f] })) },
  ];
  if (customFields.length) groups.push({ label: "Custom fields", options: customFields.map((f) => ({ value: `cf:${f.id}`, label: f.name })) });
  groups.push({ label: null, options: [{ value: "skip", label: IMPORT_FIELD_LABELS.skip }] });
  return groups;
}

/** Type values a mapping may pick: Feature, Bug, Chore, Spike, and Epic only with `epic.manage`. */
export function typeOptions(perms: readonly string[]): FieldOption[] {
  const base = [
    { value: "feature", label: "Feature" },
    { value: "bug", label: "Bug" },
    { value: "chore", label: "Chore" },
    { value: "spike", label: "Spike" },
  ];
  return perms.includes("epic.manage") ? [...base, { value: "epic", label: "Epic" }] : base;
}

/** "PRJ-61 → PRJ-104" (one key when first = last). */
export function formatKeyRange(range: { first: string | null; last: string | null } | null | undefined): string {
  if (!range?.first) return "";
  return range.last && range.last !== range.first ? `${range.first} → ${range.last}` : range.first;
}

/** "2 × missing title · 1 × invalid due date" (design). */
export function skipSummary(reasons: ImportValidation["skipReasons"]): string {
  return reasons.map((r) => `${r.count} × ${r.reason.charAt(0).toLowerCase()}${r.reason.slice(1)}`).join(" · ");
}

/** "Creates 2 labels, 1 epic" (+ options with field.manage); null when nothing is created. */
export function createsLine(creates: ImportValidation["creates"], perms: readonly string[]): string | null {
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const parts: string[] = [];
  if (creates.labels.length) parts.push(n(creates.labels.length, "label", "labels"));
  if (creates.epics.length) parts.push(n(creates.epics.length, "epic", "epics"));
  const options = creates.options.reduce((a, o) => a + o.names.length, 0);
  if (options && perms.includes("field.manage")) parts.push(n(options, "option", "options"));
  return parts.length ? `Creates ${parts.join(", ")}` : null;
}

/** Inbox / toast line for a finished import (§5.8). */
export function importNotificationText(p: { importStatus?: string; imported?: number; skipped?: number; projectKey?: string }) {
  const n = p.imported ?? 0;
  const added = `${n} ${n === 1 ? "task" : "tasks"} added to ${p.projectKey ?? "the project"}`;
  if (p.importStatus === "failed") return { lead: "Import failed", rest: added };
  if (p.importStatus === "canceled") return { lead: "Import stopped", rest: added };
  return { lead: "Import finished", rest: p.skipped ? `${added} · ${p.skipped} skipped` : added };
}

export const STATUS_LABEL: Record<ImportStatus, string> = {
  draft: "Draft",
  ready: "Not started",
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  canceled: "Stopped",
};
