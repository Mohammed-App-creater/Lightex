import type { ImportTaskType, Priority, StatusGlyph } from "@/lib/api/types";

/*
 * Board 40 mock: value matching (§4.7): statuses, types, people and priorities. Shared vectors:
 * fixtures/import_vectors.json ("statuses", "types", "people", "priorities").
 */

/** ImportValue.key: trimmed, lower-cased, inner whitespace collapsed. */
export const valueKey = (v: string) => String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");

const loose = (s: string) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, "");

/** Design `autoStatus`: synonym → glyph. */
const STATUS_SYNONYMS: Record<string, StatusGlyph> = {
  backlog: "backlog",
  icebox: "backlog",
  todo: "todo",
  open: "todo",
  new: "todo",
  doing: "progress",
  inprogress: "progress",
  started: "progress",
  wip: "progress",
  review: "review",
  inreview: "review",
  qa: "review",
  done: "done",
  closed: "done",
  complete: "done",
  completed: "done",
  resolved: "done",
  wontdo: "canceled",
  canceled: "canceled",
  cancelled: "canceled",
};

/**
 * (1) exact name ignoring case and spaces ("to do" = "Todo"); (2) synonym → glyph → the first
 * project status with that glyph by position; (3) null (unmapped).
 */
export function matchStatus(value: string, statuses: { id: string; name: string; glyph: StatusGlyph; position: number }[]): string | null {
  const n = loose(value);
  if (!n) return null;
  const exact = statuses.find((s) => loose(s.name) === n);
  if (exact) return exact.id;
  const glyph = STATUS_SYNONYMS[n];
  if (!glyph) return null;
  return [...statuses].sort((a, b) => a.position - b.position).find((s) => s.glyph === glyph)?.id ?? null;
}

const TYPE_SYNONYMS: Record<string, ImportTaskType> = {
  story: "feature",
  task: "feature",
  feature: "feature",
  "new feature": "feature",
  improvement: "feature",
  "sub-task": "feature",
  subtask: "feature",
  bug: "bug",
  defect: "bug",
  incident: "bug",
  chore: "chore",
  maintenance: "chore",
  "tech debt": "chore",
  spike: "spike",
  research: "spike",
  investigation: "spike",
  epic: "epic",
};

/** Type value → task type; "epic" only when the importer may create epics. Unknown → null. */
export function matchType(value: string, canEpic: boolean): ImportTaskType | null {
  const t = TYPE_SYNONYMS[valueKey(value)] ?? null;
  if (t === "epic" && !canEpic) return null;
  return t;
}

export type Member = { id: string; name: string; email: string };
export type PersonMatch = { target: string | null; matchedBy: "email" | "name" | "initial" | null };

const normName = (s: string) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9@]+/g, " ")
    .trim();

/** First value of a cell that may list several people (design: split on , and ;). */
export const firstPerson = (cell: string) => String(cell ?? "").split(/[,;]/)[0]!.trim();

/**
 * (1) email equal to a member's (case-insensitive); (2) normalised full name; (3) after replacing
 * . and _ with spaces: same first name and the second token's initial equals the last-name initial
 * ("Sam P.", "jordan.lee"), only when exactly one member matches; (4) null.
 */
export function matchPerson(value: string, members: Member[]): PersonMatch {
  const v = firstPerson(value);
  if (!v) return { target: null, matchedBy: null };
  const low = v.toLowerCase();
  const byEmail = members.find((m) => m.email.toLowerCase() === low);
  if (byEmail) return { target: byEmail.id, matchedBy: "email" };
  // Step 2 compares the trimmed, lower-cased, space-collapsed name: "jordan.lee" is not a name match.
  const n = valueKey(v);
  const byName = members.find((m) => valueKey(m.name) === n);
  if (byName) return { target: byName.id, matchedBy: "name" };
  const tokens = normName(v.replace(/[._]/g, " ")).split(" ").filter(Boolean);
  if (tokens.length > 1) {
    const hits = members.filter((m) => {
      const parts = normName(m.name).split(" ").filter(Boolean);
      return parts.length > 1 && parts[0] === tokens[0] && parts[parts.length - 1]![0] === tokens[1]![0];
    });
    if (hits.length === 1) return { target: hits[0]!.id, matchedBy: "initial" };
  }
  return { target: null, matchedBy: null };
}

const PRIORITY: Record<string, Priority> = {
  urgent: 4,
  highest: 4,
  critical: 4,
  blocker: 4,
  p0: 4,
  high: 3,
  p1: 3,
  medium: 2,
  normal: 2,
  p2: 2,
  low: 1,
  lowest: 1,
  minor: 1,
  trivial: 1,
  p3: 1,
  p4: 1,
  none: 0,
  "no priority": 0,
};

/** Fixed synonyms; unknown or empty → 0 ("No priority"), never an issue. */
export function matchPriority(value: string): Priority {
  return PRIORITY[valueKey(value)] ?? 0;
}
