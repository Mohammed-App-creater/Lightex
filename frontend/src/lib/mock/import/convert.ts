import type { ImportColumnType, ImportDateOrder, ImportTimeUnit } from "@/lib/api/types";
import { parseDuration } from "@/features/time/duration";

/*
 * Board 40 mock: value conversion (§4.7 "Dates", "Numbers", "Durations"). Shared vectors:
 * fixtures/import_vectors.json ("dates", "dateOrder", "numbers", "durations").
 */

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const FULL_MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function monthOf(name: string): number | null {
  const n = name.toLowerCase().replace(/\.$/, "");
  const i = MONTHS.indexOf(n);
  if (i >= 0) return i + 1;
  const j = FULL_MONTHS.indexOf(n);
  if (j >= 0) return j + 1;
  if (n === "sept") return 9;
  return null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A real calendar date as YYYY-MM-DD, or null (2026-02-30 is impossible). */
export function isoOf(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d) || y < 1000 || y > 9999 || m < 1 || m > 12 || d < 1) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

const year = (s: string) => (s.length === 2 ? 2000 + Number(s) : Number(s));

const ISO_RE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ].*)?$/;
const NUM_SLASH_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})(?:[ T].*)?$/;
const NUM_DOT_RE = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})(?:[ T].*)?$/;
const JIRA_RE = /^(\d{1,2})\/([A-Za-z]{3})\/(\d{2}|\d{4})(?:\s+\d{1,2}:\d{2}(?:\s*[AaPp][Mm])?)?$/;
const MDY_TEXT_RE = /^([A-Za-z]+\.?)\s+(\d{1,2}),?\s+(\d{4})(?:\s+.*)?$/;
const DMY_TEXT_RE = /^(\d{1,2})\s+([A-Za-z]+\.?),?\s+(\d{4})(?:\s+.*)?$/;

type Kind = "iso" | "slash" | "dot" | "jira" | "text";

function kindOf(t: string): Kind | null {
  if (ISO_RE.test(t)) return "iso";
  if (JIRA_RE.test(t)) return "jira";
  if (NUM_SLASH_RE.test(t)) return "slash";
  if (NUM_DOT_RE.test(t)) return "dot";
  if (MDY_TEXT_RE.test(t) || DMY_TEXT_RE.test(t)) return "text";
  return null;
}

/**
 * The column's date order (§4.3 `dateOrder`), from its non-empty values: the most common pattern;
 * numeric slashes are `mdy` unless some value's first part is > 12 (→ `dmy`); dots → `dmy`.
 * Null when no value looks like a date.
 */
export function dateOrderOf(values: string[]): ImportDateOrder | null {
  const counts = new Map<Kind, number>();
  let firstOver12 = false;
  for (const raw of values) {
    const t = raw.trim();
    if (!t) continue;
    const k = kindOf(t);
    if (!k) continue;
    counts.set(k, (counts.get(k) ?? 0) + 1);
    if (k === "slash" && Number(NUM_SLASH_RE.exec(t)![1]) > 12) firstOver12 = true;
  }
  if (!counts.size) return null;
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  if (top === "iso") return "ymd";
  if (top === "jira") return "jira";
  if (top === "text") return "text";
  if (top === "dot") return "dmy";
  return firstOver12 ? "dmy" : "mdy";
}

/**
 * Parses a date cell (trimmed; a time part is ignored; no timezone conversion). ISO, Jira and
 * month-name formats are read in any column; numeric slashes follow the column order (`dmy` when
 * the column says so, else `mdy`); dots are always day-first. Anything else → null.
 */
export function parseDate(raw: string, order: ImportDateOrder | null = null): string | null {
  const t = String(raw ?? "").trim();
  if (!t) return null;
  let m = ISO_RE.exec(t);
  if (m) return isoOf(Number(m[1]), Number(m[2]), Number(m[3]));
  m = JIRA_RE.exec(t);
  if (m) {
    const mo = monthOf(m[2]!);
    return mo ? isoOf(year(m[3]!), mo, Number(m[1])) : null;
  }
  m = NUM_SLASH_RE.exec(t);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return order === "dmy" ? isoOf(year(m[3]!), b, a) : isoOf(year(m[3]!), a, b);
  }
  m = NUM_DOT_RE.exec(t);
  if (m) return isoOf(year(m[3]!), Number(m[2]), Number(m[1]));
  m = MDY_TEXT_RE.exec(t);
  if (m) {
    const mo = monthOf(m[1]!);
    return mo ? isoOf(Number(m[3]), mo, Number(m[2])) : null;
  }
  m = DMY_TEXT_RE.exec(t);
  if (m) {
    const mo = monthOf(m[2]!);
    return mo ? isoOf(Number(m[3]), mo, Number(m[1])) : null;
  }
  return null;
}

/**
 * Numbers: "1240", "1,240", "1 240", "12.5"; with ";" as the file delimiter a comma is the decimal
 * mark ("12,5" → 12.5). Null when the cell isn't a number.
 */
export function parseNumber(raw: string, delimiter = ","): number | null {
  const t = String(raw ?? "").trim();
  if (!t) return null;
  if (delimiter === ";" && /^-?\d+,\d+$/.test(t)) return Number(t.replace(",", "."));
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return Number(t.replace(/,/g, ""));
  if (/^-?\d{1,3}( \d{3})+(\.\d+)?$/.test(t)) return Number(t.replace(/ /g, ""));
  return null;
}

/** Story points: round half up (v1 `_estimate`). */
export const roundHalfUp = (n: number) => Math.floor(n + 0.5);

/**
 * Time estimate in minutes: board 39's grammar ("1h 30m", "90m", "1.5h", "1:30", "2 hours 5 mins"),
 * except that a bare number uses the column's unit (default hours). Null = unreadable; 0 = none.
 */
export function parseDurationCell(raw: string, unit: ImportTimeUnit = "hours"): number | null {
  const t = String(raw ?? "").trim();
  if (!t) return 0;
  const bare = parseNumber(t);
  if (bare !== null) {
    if (bare < 0) return null;
    return Math.round(unit === "seconds" ? bare / 60 : unit === "minutes" ? bare : bare * 60);
  }
  const p = parseDuration(t);
  return p.error === undefined ? p.minutes : null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LIST_RE = /;|, /;

/**
 * §4.3 `inferredType` (drives suggestions only, never rejects): empty · number · date · duration ·
 * person (≥ 80 % emails or member names) · list (≥ 30 % contain ; or ", ") · text.
 */
export function inferType(values: string[], memberNames: Set<string>): ImportColumnType {
  const filled = values.map((v) => v.trim()).filter(Boolean);
  if (!filled.length) return "empty";
  const share = (pred: (v: string) => boolean) => filled.filter(pred).length / filled.length;
  if (share((v) => parseNumber(v) !== null) === 1) return "number";
  if (share((v) => parseDate(v) !== null) >= 0.8) return "date";
  if (share((v) => /[a-z]/i.test(v) && parseDuration(v).error === undefined) >= 0.8) return "duration";
  if (share((v) => EMAIL_RE.test(v) || memberNames.has(v.toLowerCase())) >= 0.8) return "person";
  if (share((v) => LIST_RE.test(v)) >= 0.3) return "list";
  return "text";
}
