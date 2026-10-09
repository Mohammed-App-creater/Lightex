import type { Timesheet } from "@/lib/api/types";
import { addDaysISO } from "@/lib/utils/dates";
import { formatHours } from "./duration";

/* Timesheet maths (board 39): weeks, heat scale, CSV, export gate. Pure; unit-tested. */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const parts = (iso: string) => iso.split("-").map(Number) as [number, number, number];

/** Monday of the week containing `iso` (local calendar date). */
export function weekStart(iso: string) {
  const [y, m, d] = parts(iso);
  const dow = (new Date(y, m - 1, d).getDay() + 6) % 7;
  return addDaysISO(iso, -dow);
}

export const shiftWeek = (monday: string, weeks: number) => addDaysISO(monday, weeks * 7);

/** "Oct 5 – 11", or "Sep 28 – Oct 4" across a month boundary. */
export function weekLabel(monday: string) {
  const [, am, ad] = parts(monday);
  const [, bm, bd] = parts(addDaysISO(monday, 6));
  return `${MONTHS[am - 1]} ${ad} – ${am === bm ? "" : `${MONTHS[bm - 1]} `}${bd}`;
}

/** "Wed Oct 7" for a day of the week. */
export function dayLabel(iso: string, index: number) {
  const [, m, d] = parts(iso);
  return `${DOW[index]} ${MONTHS[m - 1]} ${d}`;
}

/** Heat: 0 h → none; otherwise 12 % + 70 % × min(1, h / 8) of the chart colour. `hi` = light text. */
export function heat(minutes: number) {
  if (minutes <= 0) return { percent: 0, hi: false };
  const percent = Math.round(12 + 70 * Math.min(1, minutes / 60 / 8));
  return { percent, hi: percent >= 60 };
}
export const heatBg = (percent: number) => (percent > 0 ? `color-mix(in oklab, var(--c1) ${percent}%, transparent)` : "transparent");
/** Legend swatches (1, 3, 5, 7, 9 h). */
export const LEGEND = [1, 3, 5, 7, 9].map((h) => heat(h * 60).percent);

/** Cell text: one decimal, "–" for 0, blank for future days. */
export const cellText = (minutes: number, future: boolean) => (future ? "" : minutes ? formatHours(minutes) : "–");

/** CSV text built in the browser from S1 (§1.2). Future days are blank. */
export function timesheetCsv(ts: Timesheet, today: string) {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const fut = (i: number) => ts.days[i]! > today;
  const lines = [["Person", ...ts.days.map((d, i) => dayLabel(d, i)), "Total"].map(esc).join(",")];
  for (const r of ts.rows) {
    lines.push([r.user.name, ...r.cells.map((c, i) => (fut(i) ? "" : formatHours(c.minutes))), formatHours(r.totalMinutes)].map(esc).join(","));
  }
  lines.push(["Total", ...ts.dayTotals.map((m, i) => (fut(i) ? "" : formatHours(m))), formatHours(ts.totalMinutes)].map(esc).join(","));
  return lines.join("\n");
}

/** `timesheet-<projectkey or all>-<weekStart>.csv`, lower-case. */
export const csvName = (projectKey: string | null, monday: string) => `timesheet-${(projectKey ?? "all").toLowerCase()}-${monday}.csv`;

/** Export: report.view on the selected project, or on at least one listed project for All projects. */
export function canExport(ts: Pick<Timesheet, "projects"> | undefined, projectId: string | null) {
  if (!ts) return false;
  const list = projectId ? ts.projects.filter((p) => p.id === projectId) : ts.projects;
  return list.some((p) => p.my_permissions.includes("report.view"));
}
