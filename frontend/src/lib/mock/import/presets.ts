import type { ImportColumnMapping, ImportField, ImportPreset } from "@/lib/api/types";

/*
 * Board 40 mock: header → field synonyms and preset detection (§4.7). Shared vectors:
 * fixtures/import_vectors.json ("headers", "presets").
 */

/**
 * Lower-case, strip a Jira `custom field (…)` wrapper, drop ’ and ', non-alphanumerics → one
 * space, trim. "Custom field (Story Points)" → "story points"; "Section/Column" → "section column".
 */
export function normHeader(s: string): string {
  let t = String(s ?? "").toLowerCase().trim();
  const m = /^custom field \((.*)\)$/.exec(t);
  if (m) t = m[1]!;
  return t
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export const SYNONYMS: Record<Exclude<ImportField, "customField" | "skip">, string[]> = {
  title: ["title", "summary", "name", "card name", "task", "task name", "subject", "issue"],
  description: ["description", "desc", "details", "body", "notes"],
  status: ["status", "list", "state", "column", "stage", "section", "section column"],
  assignee: ["assignee", "assignee email", "members", "member", "owner", "assigned to", "assigned"],
  priority: ["priority", "prio", "severity"],
  estimate: ["estimate", "story points", "story point estimate", "points", "sp", "estimation", "effort"],
  timeEstimate: ["original estimate", "time estimate", "estimated time", "time estimate h"],
  startDate: ["start", "start date", "starts"],
  dueDate: ["due", "due date", "deadline", "due on", "target date"],
  labels: ["labels", "tags", "label", "tag"],
  type: ["type", "issue type", "task type", "kind"],
  epic: ["epic", "epic link", "epic name"],
  sprint: ["sprint", "cycle", "cycle name", "iteration"],
  parent: ["parent", "parent id", "parent issue", "parent task", "parent key"],
  sourceId: ["id", "key", "issue key", "issue id", "task id", "card id"],
  blockedBy: ["blocked by", "depends on", "inward issue link blocks"],
  blocks: ["blocks", "outward issue link blocks"],
};

/** Fields that may take several columns (§4.5): Jira repeats Labels; Issue key + Issue id are both IDs. */
export const MULTI_COLUMN: ReadonlySet<ImportField> = new Set<ImportField>(["labels", "sourceId", "blockedBy", "blocks", "skip"]);

const BY_SYNONYM = new Map<string, ImportField>();
for (const [field, list] of Object.entries(SYNONYMS)) for (const s of list) BY_SYNONYM.set(s, field as ImportField);

/** The field a header suggests on its own, or null. */
export function fieldForHeader(header: string): ImportField | null {
  return BY_SYNONYM.get(normHeader(header)) ?? null;
}

/** §4.7 presets, first match wins. */
export function detectPreset(headers: string[]): ImportPreset {
  const h = new Set(headers.map(normHeader));
  if (h.has("issue key") && h.has("summary") && h.has("issue type")) return "jira";
  if (h.has("id") && h.has("title") && (h.has("cycle name") || h.has("team"))) return "linear";
  if (h.has("task id") && h.has("name") && h.has("section column")) return "asana";
  return "generic";
}

/**
 * Suggested mapping for the raw header cells. Single-column fields: the first matching column wins
 * (design `used`), later ones are "skip". Multi-column fields take every match. A header equal to a
 * project custom field's name (same normalisation) maps to that field, once per field. Asana's
 * "Assignee Email" beats "Assignee" (the name column becomes "skip"). Jira's "Original Estimate"
 * is in seconds.
 */
export function suggestColumns(rawHeader: string[], preset: ImportPreset, customFields: { id: string; name: string }[]): ImportColumnMapping[] {
  const norm = rawHeader.map(normHeader);
  const emailCol = norm.indexOf("assignee email");
  const used = new Set<string>();
  return norm.map((n, i) => {
    let field = BY_SYNONYM.get(n) ?? null;
    if (field === "assignee" && emailCol >= 0 && i !== emailCol) field = null;
    if (field) {
      if (MULTI_COLUMN.has(field)) return { field };
      if (!used.has(field)) {
        used.add(field);
        if (field === "timeEstimate") return { field, unit: preset === "jira" && (n === "original estimate" || n === "remaining estimate") ? "seconds" : "hours" };
        return { field };
      }
      return { field: "skip" };
    }
    const cf = customFields.find((f) => normHeader(f.name) === n);
    if (cf && !used.has(`cf:${cf.id}`)) {
      used.add(`cf:${cf.id}`);
      return { field: "customField", customFieldId: cf.id };
    }
    return { field: "skip" };
  });
}
