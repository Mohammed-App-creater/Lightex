import { IMPORT_FIELD_LABELS } from "@/features/import/import-lib";
import type {
  CustomFieldType,
  CustomFieldValue,
  ImportBlocker,
  ImportColumn,
  ImportColumnMapping,
  ImportDateOrder,
  ImportField,
  ImportIssue,
  ImportMapping,
  ImportOutcome,
  ImportRowValues,
  ImportTaskType,
  ImportValidation,
  ImportValue,
  Priority,
  StatusGlyph,
} from "@/lib/api/types";
import { dateOrderOf, inferType, parseDate, parseDurationCell, parseNumber, roundHalfUp } from "./convert";
import type { Delimiter, ParsedCsv } from "./csv";
import { firstPerson, matchPerson, matchPriority, matchStatus, matchType, valueKey, type Member } from "./match";
import { MULTI_COLUMN } from "./presets";

/*
 * Board 40 mock: analysis, value maps, row planning and validation (§4.3, §4.6, §4.7). Pure: the
 * handler builds a PlanProject snapshot from the mock DB and calls planImport() for I2 / I4 / I5
 * (dry run) and once more when the runner prepares (§5.2). Deterministic for file + mapping + state.
 */

export const LIMITS = { statuses: 50, types: 20, people: 200, labels: 100, epics: 50, labelsPerTask: 20, options: 50 };
export const MAX_TITLE = 200;
export const MAX_EPIC_NAME = 80;
export const MAX_DESCRIPTION = 20_000;
export const MAX_ESTIMATE = 99;
export const MAX_TIME_MINUTES = 60_000;
export const MAX_TEXT_FIELD = 120;
export const MAX_NUMBER_FIELD = 1_000_000_000;

export interface ParsedFile extends ParsedCsv {
  delimiter: Delimiter;
}

export interface PlanProject {
  key: string;
  taskSeq: number;
  statuses: { id: string; name: string; glyph: StatusGlyph; position: number }[];
  defaultStatusId: string;
  members: Member[];
  importerId: string;
  perms: readonly string[];
  labels: { id: string; name: string }[];
  epics: { id: string; name: string }[];
  sprints: { id: string; name: string }[];
  customFields: { id: string; name: string; type: CustomFieldType; options: { id: string; name: string }[] }[];
  tasks: { id: string; key: string; parentId: string | null; sprintId: string | null; epicId: string | null }[];
}

/** User choices stored on the job (keys present = explicit). */
export interface UserMaps {
  statuses: Record<string, string | null>;
  types: Record<string, ImportTaskType | null>;
  people: Record<string, string | null>;
}

export type DepTarget = { ref: string; row?: number; taskId?: string };

export interface PlannedRow {
  row: number;
  outcome: ImportOutcome;
  /** Predicted key (task rows only). */
  key: string | null;
  /** 0-based index among imported task rows (numbering). */
  taskIndex: number | null;
  issues: ImportIssue[];
  values: ImportRowValues;
  description: string;
  refs: string[];
  /** Parent task: a task row of this file or an existing task. */
  parent: { row?: number; taskId?: string } | null;
  /** Epic: an epic row of this file, an existing epic, or a new name. */
  epicRow: number | null;
  epicId: string | null;
  epicName: string | null;
  blockedBy: DepTarget[];
  blocks: DepTarget[];
  /** select fields: option names to create (only with field.manage). */
  newOptions: Record<string, string>;
}

export interface PlanResult {
  validation: ImportValidation;
  rows: PlannedRow[];
  mapping: ImportMapping;
}

const LIST_SPLIT = /[;,]/;
const REF_SPLIT = /[\s,;]+/;

/* ───────── analysis (I2) ───────── */

export function analyzeColumns(file: ParsedCsv, members: Member[]): ImportColumn[] {
  const names = new Set(members.map((m) => m.name.toLowerCase()));
  return file.header.map((name, index) => {
    const values = file.rows.map((r) => r[index] ?? "");
    const filled = values.map((v) => v.trim()).filter(Boolean);
    const samples: string[] = [];
    for (const v of filled) {
      const s = v.slice(0, 40);
      if (!samples.includes(s)) samples.push(s);
      if (samples.length === 3) break;
    }
    const inferredType = inferType(values, names);
    return {
      index,
      name,
      samples,
      inferredType,
      emptyCount: values.length - filled.length,
      distinctCount: new Set(filled.map((v) => v.toLowerCase())).size,
      dateOrder: inferredType === "date" ? dateOrderOf(filled) : null,
    };
  });
}

/* ───────── helpers ───────── */

const can = (p: PlanProject, perm: string) => p.perms.includes(perm);

function tally(values: string[]) {
  const out: { key: string; value: string; count: number }[] = [];
  const idx = new Map<string, number>();
  for (const v of values) {
    const k = valueKey(v);
    if (!k) continue;
    const i = idx.get(k);
    if (i === undefined) {
      idx.set(k, out.length);
      out.push({ key: k, value: v.trim(), count: 1 });
    } else out[i]!.count++;
  }
  return out;
}

const plural = (n: number, one: string, many: string) => `Map ${n} more ${n === 1 ? one : many}`;

function emptyValues(): ImportRowValues {
  return {
    title: "",
    type: "feature",
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
  };
}

/* ───────── the plan ───────── */

export function planImport(file: ParsedFile, columns: ImportColumnMapping[], user: UserMaps, project: PlanProject, revision = 0): PlanResult {
  const cols = (f: ImportField) => columns.flatMap((c, i) => (c.field === f ? [i] : []));
  const col = (f: ImportField) => cols(f)[0] ?? -1;
  const cell = (r: string[], i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");
  const canEpic = can(project, "epic.manage");
  const canAssign = can(project, "task.assign");
  const canOptions = can(project, "field.manage");

  const orders = new Map<number, ImportDateOrder | null>();
  const orderOf = (i: number) => {
    if (!orders.has(i)) orders.set(i, dateOrderOf(file.rows.map((r) => r[i] ?? "")));
    return orders.get(i)!;
  };

  /* value maps */
  const statusCol = col("status");
  const typeCol = col("type");
  const assigneeCol = col("assignee");
  const personFieldCols = columns.flatMap((c, i) =>
    c.field === "customField" && project.customFields.find((f) => f.id === c.customFieldId)?.type === "user" ? [i] : [],
  );

  const statusVals: ImportValue[] =
    statusCol < 0
      ? []
      : tally(file.rows.map((r) => r[statusCol] ?? "")).map((v) => {
          const explicit = Object.prototype.hasOwnProperty.call(user.statuses, v.key);
          const target = explicit ? (user.statuses[v.key] ?? null) : matchStatus(v.value, project.statuses);
          return { ...v, target, auto: !explicit && target !== null };
        });
  const typeVals: ImportValue[] =
    typeCol < 0
      ? []
      : tally(file.rows.map((r) => r[typeCol] ?? "")).map((v) => {
          const explicit = Object.prototype.hasOwnProperty.call(user.types, v.key);
          const target = explicit ? (user.types[v.key] ?? null) : matchType(v.value, canEpic);
          return { ...v, target, auto: !explicit && target !== null };
        });
  const personCells = [assigneeCol, ...personFieldCols].filter((i) => i >= 0).flatMap((i) => file.rows.map((r) => firstPerson(r[i] ?? "")));
  const peopleVals: ImportValue[] = tally(personCells).map((v) => {
    const explicit = Object.prototype.hasOwnProperty.call(user.people, v.key);
    if (explicit) return { ...v, target: user.people[v.key] ?? null, auto: false, matchedBy: null };
    let m = matchPerson(v.value, project.members);
    // Without task.assign every suggestion except the importer becomes "Leave unassigned".
    if (!canAssign && m.target && m.target !== project.importerId) m = { target: null, matchedBy: null };
    return { ...v, target: m.target, auto: m.target !== null, matchedBy: m.matchedBy };
  });
  const statusMap = new Map(statusVals.map((v) => [v.key, v.target]));
  const typeMap = new Map(typeVals.map((v) => [v.key, v.target as ImportTaskType | null]));
  const peopleMap = new Map(peopleVals.map((v) => [v.key, v.target]));

  /* identities (sourceId columns), lower-cased; the first row wins */
  const idCols = cols("sourceId");
  const identity = new Map<string, number>(); // ref → row index
  const refsOf = file.rows.map((r, i) => {
    const refs = idCols.map((c) => valueKey(r[c] ?? "")).filter(Boolean);
    for (const ref of refs) if (!identity.has(ref)) identity.set(ref, i);
    return refs;
  });
  const existingByKey = new Map(project.tasks.map((t) => [t.key.toLowerCase(), t]));
  const labelNames = new Set(project.labels.map((l) => l.name.toLowerCase()));
  const epicByName = new Map(project.epics.map((e) => [e.name.toLowerCase(), e]));
  const sprintByName = new Map(project.sprints.map((s) => [s.name.toLowerCase(), s]));
  const fieldById = new Map(project.customFields.map((f) => [f.id, f]));

  /* pass 1: per-row values and skip checks */
  type Draft = PlannedRow & { parentRef: string; epicRef: string; isEpic: boolean; startRaw: string | null; dueRaw: string | null };
  const drafts: Draft[] = file.rows.map((r, i) => {
    const issues: ImportIssue[] = [];
    const values = emptyValues();
    let skip: ImportIssue | null = null;
    const skipIf = (field: ImportField | null, reason: string, value: string) => {
      if (!skip) skip = { severity: "skip", field, reason, value };
    };
    const title = cell(r, col("title"));
    values.title = title;
    const typeRaw = cell(r, typeCol);
    const type: ImportTaskType | null = typeCol < 0 || !typeRaw ? "feature" : (typeMap.get(valueKey(typeRaw)) ?? null);
    values.type = type ?? "feature";
    const isEpic = type === "epic";
    if (!title) skipIf("title", "Missing title", "");
    else if (isEpic && title.length > MAX_EPIC_NAME) skipIf("title", "Epic name over 80 characters", `${title.slice(0, 40)}…`);
    else if (title.length > MAX_TITLE) skipIf("title", "Title over 200 characters", `${title.slice(0, 40)}…`);

    const description = r[col("description")] ?? "";
    if (col("description") >= 0 && description.length > MAX_DESCRIPTION) skipIf("description", "Description over 20,000 characters", `${description.slice(0, 40)}…`);

    const dueRaw = cell(r, col("dueDate"));
    const startRaw = cell(r, col("startDate"));
    const due = dueRaw ? parseDate(dueRaw, orderOf(col("dueDate"))) : null;
    const start = startRaw ? parseDate(startRaw, orderOf(col("startDate"))) : null;
    if (dueRaw && !due) skipIf("dueDate", "Invalid due date", dueRaw);
    if (startRaw && !start) skipIf("startDate", "Invalid start date", startRaw);
    if (start && due && start > due) skipIf("startDate", "Start date after due date", startRaw);
    values.dueDate = due;
    values.startDate = start;

    const estRaw = cell(r, col("estimate"));
    if (estRaw) {
      const n = parseNumber(estRaw, file.delimiter);
      if (n === null || n < 0) skipIf("estimate", "Estimate is not a number", estRaw);
      else if (roundHalfUp(n) > MAX_ESTIMATE) skipIf("estimate", "Estimate over 99 points", estRaw);
      else values.estimate = roundHalfUp(n);
    }
    const timeCol = col("timeEstimate");
    const timeRaw = cell(r, timeCol);
    if (timeRaw) {
      const minutes = parseDurationCell(timeRaw, columns[timeCol]?.unit ?? "hours");
      if (minutes === null) skipIf("timeEstimate", "Time estimate is not a duration", timeRaw);
      else if (minutes > MAX_TIME_MINUTES) skipIf("timeEstimate", "Time estimate over 1000 hours", timeRaw);
      else values.timeEstimateMinutes = minutes > 0 ? minutes : null;
    }

    /* custom fields */
    const newOptions: Record<string, string> = {};
    columns.forEach((c, ci) => {
      if (c.field !== "customField" || !c.customFieldId) return;
      const f = fieldById.get(c.customFieldId);
      const raw = cell(r, ci);
      if (!f || !raw) return;
      let v: CustomFieldValue | null = null;
      if (f.type === "text") {
        if (raw.length > MAX_TEXT_FIELD) skipIf("customField", `${f.name}: up to 120 characters`, `${raw.slice(0, 40)}…`);
        else v = raw;
      } else if (f.type === "number") {
        const n = parseNumber(raw, file.delimiter);
        if (n === null || n < 0 || n > MAX_NUMBER_FIELD) skipIf("customField", `${f.name}: enter a number from 0 to 1,000,000,000`, raw);
        else v = n;
      } else if (f.type === "date") {
        const d = parseDate(raw, orderOf(ci));
        if (!d) skipIf("customField", `${f.name}: invalid date`, raw);
        else v = d;
      } else if (f.type === "select") {
        const opt = f.options.find((o) => o.name.toLowerCase() === raw.toLowerCase());
        if (opt) v = opt.id;
        else newOptions[f.id] = raw;
      } else if (f.type === "user") {
        v = peopleMap.get(valueKey(firstPerson(raw))) ?? null;
      }
      if (v !== null) values.customFields[f.id] = v;
    });

    values.statusId = statusCol < 0 || !cell(r, statusCol) ? project.defaultStatusId : (statusMap.get(valueKey(cell(r, statusCol))) ?? null);
    values.assigneeId = assigneeCol < 0 ? null : (peopleMap.get(valueKey(firstPerson(cell(r, assigneeCol)))) ?? null);
    values.priority = matchPriority(cell(r, col("priority"))) as Priority;

    if (skip) issues.push(skip);
    return {
      row: i + 2,
      outcome: skip ? "skipped" : isEpic ? "epic" : "task",
      key: null,
      taskIndex: null,
      issues,
      values,
      description,
      refs: refsOf[i]!,
      parent: null,
      epicRow: null,
      epicId: null,
      epicName: null,
      blockedBy: [],
      blocks: [],
      newOptions,
      parentRef: cell(r, col("parent")),
      epicRef: cell(r, col("epic")),
      isEpic,
      startRaw: start,
      dueRaw: due,
    };
  });

  const live = (d: Draft | undefined) => Boolean(d && d.outcome !== "skipped");
  const rowOfRef = (ref: string) => {
    const i = identity.get(valueKey(ref));
    return i === undefined ? undefined : drafts[i];
  };
  const warn = (d: Draft, field: ImportField, reason: string, value: string) => d.issues.push({ severity: "warning", field, reason, value });

  /* pass 2: references, labels, sprints, epics, options (imported rows only) */
  const newLabels: string[] = [];
  const newEpics: string[] = [];
  const optionCreates = new Map<string, string[]>();
  const addNewEpic = (name: string) => {
    const k = name.toLowerCase();
    if (!epicByName.has(k) && !newEpics.some((e) => e.toLowerCase() === k)) newEpics.push(name);
  };
  for (const d of drafts) {
    if (!live(d)) continue;
    if (d.isEpic) {
      addNewEpic(d.values.title);
      if (Boolean(d.startRaw) !== Boolean(d.dueRaw)) {
        warn(d, "startDate", "Epic dates need both start and target · dates left empty", d.startRaw ?? d.dueRaw ?? "");
        d.values.startDate = null;
        d.values.dueDate = null;
      }
      continue;
    }
    // labels: split on ; and , · trimmed, lower-cased, cut to 24, de-duplicated, max 20
    const raw = cols("labels").flatMap((c) => (file.rows[d.row - 2]![c] ?? "").split(LIST_SPLIT));
    const names = [...new Set(raw.map((x) => x.trim().toLowerCase().slice(0, 24)).filter(Boolean))];
    if (names.length > LIMITS.labelsPerTask) warn(d, "labels", "More than 20 labels · extra labels dropped", names.slice(LIMITS.labelsPerTask).join(", "));
    d.values.labels = names.slice(0, LIMITS.labelsPerTask);
    for (const n of d.values.labels) if (!labelNames.has(n) && !newLabels.includes(n)) newLabels.push(n);

    // sprint
    const sprintRaw = cell(file.rows[d.row - 2]!, col("sprint"));
    if (sprintRaw) {
      const s = sprintByName.get(sprintRaw.toLowerCase());
      if (s) d.values.sprintId = s.id;
      else warn(d, "sprint", `No sprint named “${sprintRaw}” · added to the backlog`, sprintRaw);
    }

    // epic: an epic row's ID, else an epic name (existing, new with epic.manage, or a warning)
    if (d.epicRef) {
      const target = rowOfRef(d.epicRef);
      if (target && target.isEpic && live(target)) {
        d.epicRow = target.row;
        d.epicName = target.values.title;
      } else {
        const existing = epicByName.get(d.epicRef.toLowerCase());
        if (existing) {
          d.epicId = existing.id;
          d.epicName = existing.name;
        } else if (canEpic) {
          d.epicName = d.epicRef;
          addNewEpic(d.epicRef);
        } else warn(d, "epic", `No epic named “${d.epicRef}” · left without an epic`, d.epicRef);
      }
    }

    // parent: a row of this file (epic row → the task's epic), else an existing task key
    if (d.parentRef) {
      const target = rowOfRef(d.parentRef);
      const existing = target ? undefined : existingByKey.get(d.parentRef.toLowerCase());
      if (target && live(target) && target !== d) {
        if (target.isEpic) {
          if (d.epicRow === null && !d.epicId && !d.epicName) {
            d.epicRow = target.row;
            d.epicName = target.values.title;
          }
        } else d.parent = { row: target.row };
      } else if (existing) {
        if (existing.parentId) warn(d, "parent", "Parent is a sub-task · imported as a top-level task", d.parentRef);
        else d.parent = { taskId: existing.id };
      } else warn(d, "parent", `Parent “${d.parentRef}” not found · imported as a top-level task`, d.parentRef);
    }

    // dependencies: references split on , ; and whitespace
    for (const field of ["blockedBy", "blocks"] as const) {
      const refs = cols(field).flatMap((c) => (file.rows[d.row - 2]![c] ?? "").split(REF_SPLIT)).map((x) => x.trim()).filter(Boolean);
      for (const ref of refs) {
        const target = rowOfRef(ref);
        const existing = target ? undefined : existingByKey.get(ref.toLowerCase());
        if (target && live(target) && !target.isEpic) d[field].push({ ref, row: target.row });
        else if (existing) d[field].push({ ref, taskId: existing.id });
        else warn(d, field, `“${ref}” not found · dependency skipped`, ref);
      }
    }

    // select options to create, or a warning
    for (const [fieldId, name] of Object.entries(d.newOptions)) {
      const f = fieldById.get(fieldId)!;
      const list = optionCreates.get(fieldId) ?? [];
      const known = list.some((x) => x.toLowerCase() === name.toLowerCase());
      if (canOptions && (known || f.options.length + list.length < LIMITS.options)) {
        if (!known) optionCreates.set(fieldId, [...list, name]);
      } else {
        warn(d, "customField", `${f.name}: no option “${name}” · left empty`, name);
        delete d.newOptions[fieldId];
      }
    }
  }

  /* pass 3: one-level parents, inheritance, numbering, preview values */
  let taskIndex = 0;
  for (const d of drafts) {
    if (d.outcome !== "task") continue;
    if (d.parent?.row !== undefined) {
      const p = drafts[d.parent.row - 2]!;
      if (p.parent) {
        warn(d, "parent", "Parent is a sub-task · imported as a top-level task", d.parentRef);
        d.parent = null;
      } else {
        // Sub-tasks inherit the parent's sprint, and its epic when they have none (v1).
        d.values.sprintId = p.values.sprintId;
        if (d.epicRow === null && !d.epicId && !d.epicName) {
          d.epicRow = p.epicRow;
          d.epicId = p.epicId;
          d.epicName = p.epicName;
        }
      }
    } else if (d.parent?.taskId) {
      const p = project.tasks.find((t) => t.id === d.parent!.taskId)!;
      d.values.sprintId = p.sprintId;
      if (d.epicRow === null && !d.epicId && !d.epicName && p.epicId) d.epicId = p.epicId;
    }
    d.taskIndex = taskIndex;
    d.key = `${project.key}-${project.taskSeq + 1 + taskIndex}`;
    taskIndex++;
  }
  for (const d of drafts) {
    if (d.outcome === "skipped") continue;
    d.values.epic = d.epicId
      ? { id: d.epicId, name: d.epicName ?? project.epics.find((e) => e.id === d.epicId)?.name ?? "" }
      : d.epicName
        ? { name: d.epicName, new: !epicByName.has(d.epicName.toLowerCase()) }
        : null;
    if (d.parent?.row !== undefined) d.values.parent = { ref: d.parentRef, row: d.parent.row };
    else if (d.parent?.taskId) d.values.parent = { ref: d.parentRef, taskId: d.parent.taskId };
    if (d.outcome === "task") d.issues.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "skip" ? -1 : 1));
  }

  /* validation */
  const rows: PlannedRow[] = drafts.map(({ parentRef: _p, epicRef: _e, isEpic: _i, startRaw: _s, dueRaw: _d, ...rest }) => rest);
  const tasks = rows.filter((r) => r.outcome === "task").length;
  const epics = rows.filter((r) => r.outcome === "epic").length;
  const skipped = rows.filter((r) => r.outcome === "skipped").length;
  const warnings = rows.reduce((a, r) => a + r.issues.filter((x) => x.severity === "warning").length, 0);
  const skipReasons: { reason: string; count: number }[] = [];
  for (const r of rows) {
    const s = r.issues.find((x) => x.severity === "skip");
    if (!s) continue;
    const hit = skipReasons.find((x) => x.reason === s.reason);
    if (hit) hit.count++;
    else skipReasons.push({ reason: s.reason, count: 1 });
  }

  const blockers: ImportBlocker[] = [];
  if (col("title") < 0) blockers.push({ code: "title_unmapped", message: "Map a column to Title", field: "title" });
  const seen = new Map<string, ImportField>();
  let dup: ImportField | null = null;
  let dupLabel = "";
  for (const c of columns) {
    if (MULTI_COLUMN.has(c.field)) continue;
    const k = c.field === "customField" ? `cf:${c.customFieldId}` : c.field;
    if (seen.has(k)) {
      dup = c.field;
      dupLabel = c.field === "customField" ? (fieldById.get(c.customFieldId ?? "")?.name ?? "a custom field") : IMPORT_FIELD_LABELS[c.field];
      break;
    }
    seen.set(k, c.field);
  }
  if (dup) blockers.push({ code: "duplicate_field", message: `Two columns map to ${dupLabel}`, field: dup });
  const unmappedStatuses = statusVals.filter((v) => !v.target).length;
  if (unmappedStatuses) blockers.push({ code: "status_unmapped", message: plural(unmappedStatuses, "status", "statuses"), field: "status" });
  const unmappedTypes = typeVals.filter((v) => !v.target).length;
  if (unmappedTypes) blockers.push({ code: "type_unmapped", message: plural(unmappedTypes, "type", "types"), field: "type" });
  if (statusVals.length > LIMITS.statuses) blockers.push({ code: "too_many_values", message: `Too many statuses (${statusVals.length} · max ${LIMITS.statuses})`, field: "status" });
  if (typeVals.length > LIMITS.types) blockers.push({ code: "too_many_values", message: `Too many types (${typeVals.length} · max ${LIMITS.types})`, field: "type" });
  if (peopleVals.length > LIMITS.people) blockers.push({ code: "too_many_values", message: `Too many people (${peopleVals.length} · max ${LIMITS.people})`, field: "assignee" });
  if (newLabels.length > LIMITS.labels) blockers.push({ code: "too_many_creates", message: `Too many new labels (${newLabels.length} · max ${LIMITS.labels})`, field: "labels" });
  const epicCreates = canEpic ? newEpics : [];
  if (epicCreates.length > LIMITS.epics) blockers.push({ code: "too_many_creates", message: `Too many new epics (${epicCreates.length} · max ${LIMITS.epics})`, field: "epic" });
  if (tasks + epics === 0) blockers.push({ code: "nothing_to_import", message: "No rows can be imported" });

  const validation: ImportValidation = {
    ready: blockers.length === 0,
    blockers,
    values: { statuses: statusVals, types: typeVals, people: peopleVals },
    counts: {
      rows: rows.length,
      tasks,
      epics,
      skipped,
      warnings,
      statuses: statusVals.length,
      people: peopleVals.filter((v) => v.target).length,
    },
    skipReasons,
    creates: {
      labels: newLabels,
      epics: epicCreates,
      options: canOptions ? [...optionCreates.entries()].map(([customFieldId, names]) => ({ customFieldId, names })) : [],
    },
    keyRange: tasks ? { first: `${project.key}-${project.taskSeq + 1}`, last: `${project.key}-${project.taskSeq + tasks}` } : null,
  };
  const mapping: ImportMapping = {
    revision,
    columns,
    statuses: Object.fromEntries(statusVals.map((v) => [v.key, v.target])),
    types: Object.fromEntries(typeVals.map((v) => [v.key, v.target as ImportTaskType | null])),
    people: Object.fromEntries(peopleVals.map((v) => [v.key, v.target])),
  };
  return { validation, rows, mapping };
}
