import type { ImportIssue } from "@/lib/api/types";

/*
 * Board 40 mock: the error report (§5.7) and formula-safe CSV cells (§7.1). The backend twin is
 * apps/common/csvsafe.py; both follow fixtures/import_vectors.json ("csvSafe").
 */

const TRIGGERS = new Set(["=", "+", "-", "@", "\t", "\r", "\n", "＝", "＋", "－", "＠"]);

/**
 * One CSV field, always quoted with inner quotes doubled. A value that starts with = + - @ tab CR
 * LF (or their full-width forms ＝ ＋ － ＠), also after leading spaces, gets a leading apostrophe
 * so spreadsheet apps show it as text instead of evaluating it.
 */
export function csvSafe(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  const first = s.replace(/^ +/, "")[0];
  if (first !== undefined && TRIGGERS.has(first)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export const csvLine = (cells: unknown[]) => cells.map(csvSafe).join(",");

/** "Skipped" / "Imported with changes" (a warning on an imported row). */
const outcomeLabel = (i: ImportIssue) => (i.severity === "skip" ? "Skipped" : "Imported with changes");

/**
 * The report body (no BOM; the I8 handler adds it): Row, Outcome, Reason, Value, then every
 * original column under the file's header names. One line per issue, skips first, then warnings,
 * each by row. CRLF line ends, every field quoted and formula-safe, header included.
 */
export function buildReport(header: string[], rows: string[][], issues: (ImportIssue & { row: number })[]): string {
  const ordered = [...issues].sort((a, b) => (a.severity === b.severity ? a.row - b.row : a.severity === "skip" ? -1 : 1));
  const lines = [csvLine(["Row", "Outcome", "Reason", "Value", ...header])];
  for (const i of ordered) lines.push(csvLine([i.row, outcomeLabel(i), i.reason, i.value, ...(rows[i.row - 2] ?? header.map(() => ""))]));
  return `${lines.join("\r\n")}\r\n`;
}

/** import-errors-prj-2026-10-09.csv (project key lower-case, finish date UTC). */
export const reportFileName = (projectKey: string, finishedAt: string) => `import-errors-${projectKey.toLowerCase()}-${finishedAt.slice(0, 10)}.csv`;
