/*
 * Pure helpers for the Reports screen (board 17): axis maths, labels, range parsing and the
 * client-side CSV export. No React in here so everything is unit-tested in lib.test.ts.
 */

import type { ReportKpis, ReportRange } from "@/lib/api/endpoints";
import type { BurndownPoint, CycleBin, ProgressRow, ThroughputPoint, VelocityPoint } from "@/lib/api/types";

/* ───────────── axis ───────────── */

/** Design: `niceMax(v, step) = max(step, ceil(v / step) * step)`. */
export function niceMax(v: number, step: number): number {
  if (!Number.isFinite(v) || v <= 0) return step;
  return Math.max(step, Math.ceil(v / step) * step);
}

/** Exactly three y ticks: 0, max/2 (rounded), max. */
export function yTicks(max: number): [number, number, number] {
  return [0, Math.round(max / 2), max];
}

/* ───────────── dates ───────────── */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-07" → { y, m (0-based), d } without timezone drift. */
function parts(iso: string) {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return { y: y!, m: (m ?? 1) - 1, d: d ?? 1 };
}

/** "2026-10-07" → "Oct 7". */
export function shortDate(iso: string): string {
  const p = parts(iso);
  return `${MONTHS[p.m] ?? ""} ${p.d}`;
}

/** Sprint span: "Oct 1–14" in one month, "Sep 28 – Oct 11" across months. */
export function spanLabel(start: string, end: string): string {
  const a = parts(start);
  const b = parts(end);
  if (a.y === b.y && a.m === b.m) return `${MONTHS[a.m]} ${a.d}–${b.d}`;
  return `${shortDate(start)} – ${shortDate(end)}`;
}

/** Local calendar date as ISO (YYYY-MM-DD). */
export function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function addDays(iso: string, n: number): string {
  const p = parts(iso);
  return isoDay(new Date(p.y, p.m, p.d + n));
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const isIso = (s: string | null | undefined): s is string => !!s && ISO_RE.test(s) && !Number.isNaN(Date.parse(s));

/* ───────────── range ───────────── */

export const RANGE_OPTIONS: { value: Exclude<ReportRange, "custom">; label: string }[] = [
  { value: "last2", label: "Last 2 sprints" },
  { value: "last6", label: "Last 6 sprints" },
  { value: "last90", label: "Last 90 days" },
];

export type RangeState = { range: ReportRange; from?: string; to?: string };

/** Default custom window: 65 days back (Aug 3 → Oct 7 in the design). */
export function defaultCustom(today: string): { from: string; to: string } {
  return { from: addDays(today, -65), to: today };
}

/**
 * Apply rules for the custom range: reversed dates are swapped, anything in the future is
 * clamped to today, and missing/invalid input falls back to the defaults.
 */
export function normalizeCustom(from: string, to: string, today: string): { from: string; to: string } {
  if (!isIso(from) || !isIso(to)) return defaultCustom(today);
  let a = from;
  let b = to;
  if (a > b) [a, b] = [b, a];
  if (b > today) b = today;
  if (a > today) a = today;
  return { from: a, to: b };
}

/** Reads ?range=&from=&to= (unknown values fall back to Last 6 sprints). */
export function parseRange(sp: { get(name: string): string | null }, today: string): RangeState {
  const r = sp.get("range");
  if (r === "last2" || r === "last6" || r === "last90") return { range: r };
  if (r === "custom") {
    const d = defaultCustom(today);
    return { range: "custom", ...normalizeCustom(sp.get("from") ?? d.from, sp.get("to") ?? d.to, today) };
  }
  return { range: "last6" };
}

/** Query string for a range ("" for the default so URLs stay clean). */
export function rangeSearch(s: RangeState): string {
  if (s.range === "last6") return "";
  const q = new URLSearchParams({ range: s.range });
  if (s.range === "custom" && s.from && s.to) {
    q.set("from", s.from);
    q.set("to", s.to);
  }
  return `?${q.toString()}`;
}

export function rangeLabel(s: RangeState): string {
  if (s.range === "custom") return s.from && s.to ? `${shortDate(s.from)} – ${shortDate(s.to)}` : "Custom range";
  return RANGE_OPTIONS.find((o) => o.value === s.range)?.label ?? "Last 6 sprints";
}

/* ───────────── KPI copy ───────────── */

/** "+6", "−3" (U+2212), "0". */
export function signed(n: number): string {
  if (n > 0) return `+${n}`;
  if (n < 0) return `−${Math.abs(n)}`;
  return "0";
}

export function headerCaption(sprint: ReportKpis["sprint"], range: RangeState): string {
  const r = rangeLabel(range);
  if (!sprint) return `No active sprint · ${r}`;
  return `Sprint ${sprint.number} · day ${sprint.dayIndex} of ${sprint.lengthDays} · ${r}`;
}

export function fmtDays(n: number): string {
  return `${(Math.round(n * 10) / 10).toFixed(1)}d`;
}

/** Burndown verdict for the chart's aria-label. */
export function burndownSummary(
  sprintName: string,
  points: BurndownPoint[],
): { text: string; todayIdx: number } {
  let todayIdx = -1;
  points.forEach((p, i) => {
    if (p.remaining != null) todayIdx = i;
  });
  const start = points[0]?.ideal ?? 0;
  if (todayIdx < 0) return { text: `${sprintName} burndown: no data yet.`, todayIdx };
  const p = points[todayIdx]!;
  const rem = p.remaining!;
  const verdict = rem < p.ideal ? "ahead of ideal" : rem > p.ideal ? "behind ideal" : "on ideal";
  return {
    text: `${sprintName} burndown: ${rem} of ${start} points remaining on ${shortDate(p.date)}, ideal ${p.ideal}, ${verdict}.`,
    todayIdx,
  };
}

/* ───────────── CSV ───────────── */

export type ReportCsvInput = {
  project: { key: string; name: string };
  range: RangeState;
  generated: string;
  kpis?: ReportKpis | null;
  burndown?: { sprintName?: string | null; points: BurndownPoint[] } | null;
  velocity?: VelocityPoint[] | null;
  cycle?: { bins: CycleBin[]; total: number; medianDays: number } | null;
  throughput?: ThroughputPoint[] | null;
  progress?: ProgressRow[] | null;
};

/** RFC 4180 field. Strings that a spreadsheet would run as a formula are prefixed with '. */
export function csvCell(v: string | number | null | undefined): string {
  if (v == null) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  let s = v;
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const row = (...cells: (string | number | null | undefined)[]) => cells.map(csvCell).join(",");

/** Builds a sectioned CSV of everything on the page (CRLF line endings). */
export function buildReportCsv(input: ReportCsvInput): string {
  const lines: string[] = [];
  lines.push(row("Project", `${input.project.name} (${input.project.key})`));
  lines.push(row("Range", rangeLabel(input.range)));
  if (input.range.range === "custom" && input.range.from && input.range.to) {
    lines.push(row("From", input.range.from), row("To", input.range.to));
  }
  lines.push(row("Generated", input.generated));

  const k = input.kpis;
  if (k) {
    lines.push("", row("KPIs"), row("Metric", "Value"));
    if (k.sprint) lines.push(row("Sprint", k.sprint.name), row("Sprint day", `${k.sprint.dayIndex} of ${k.sprint.lengthDays}`));
    lines.push(
      row("Completed this sprint", k.completedThisSprint),
      row("Planned this sprint", k.plannedThisSprint),
      row("Avg cycle time (days)", k.avgCycleTimeDays),
      row("p85 cycle time (days)", k.p85CycleTimeDays),
      row("Overdue", k.overdueCount),
      row("Oldest overdue", k.oldestOverdueKey ?? ""),
      row("Scope change (pts)", k.scopeChangePts),
    );
  }
  if (input.burndown?.points.length) {
    lines.push("", row(`Sprint burndown${input.burndown.sprintName ? ` · ${input.burndown.sprintName}` : ""}`));
    lines.push(row("Date", "Remaining", "Ideal"));
    input.burndown.points.forEach((p) => lines.push(row(p.date, p.remaining, p.ideal)));
  }
  if (input.velocity?.length) {
    lines.push("", row("Velocity"), row("Sprint", "Committed", "Completed"));
    input.velocity.forEach((v) => lines.push(row(v.sprint, v.committed, v.completed)));
  }
  if (input.cycle?.bins.length) {
    lines.push("", row("Cycle time"), row("Bin", "Tasks"));
    input.cycle.bins.forEach((b) => lines.push(row(b.label, b.count)));
    lines.push(row("Total", input.cycle.total), row("Median (days)", input.cycle.medianDays));
  }
  if (input.throughput?.length) {
    lines.push("", row("Throughput"), row("Week of", "Tasks completed"));
    input.throughput.forEach((t) => lines.push(row(t.week, t.done)));
  }
  if (input.progress?.length) {
    lines.push("", row("Objectives & milestones"), row("Kind", "Name", "Progress %", "Expected %", "Due"));
    input.progress.forEach((p) => lines.push(row(p.kind, p.name, p.percent, p.expected, p.dueDate ?? "")));
  }
  return lines.join("\r\n") + "\r\n";
}

export function csvFileName(projectKey: string, range: RangeState, generated: string): string {
  return `lightex-${projectKey.toLowerCase()}-report-${range.range}-${generated}.csv`;
}
