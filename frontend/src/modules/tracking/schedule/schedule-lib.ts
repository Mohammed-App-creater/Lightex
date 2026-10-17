import type { CalendarMode, ISODate, StatusGlyph, Task, TimelineGroup, TimelineZoom } from "@/lib/api/types";

/*
 * Board 32 (timeline & calendar): pure date maths, geometry and URL state. No React.
 * Every date here is an ISODate string ("YYYY-MM-DD", no time zone) or its UTC day index, so a
 * DST change can never shift a bar (docs/v2/32-timeline-calendar.md §0).
 */

const DAY_MS = 86_400_000;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/* ───────── day index ───────── */

/** Days since 1970-01-01 (UTC) for an ISODate. */
export function dayIndex(iso: ISODate): number {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}
export function fromDayIndex(i: number): ISODate {
  return new Date(i * DAY_MS).toISOString().slice(0, 10);
}
export const addDays = (iso: ISODate, n: number) => fromDayIndex(dayIndex(iso) + n);
export const diffDays = (a: ISODate, b: ISODate) => dayIndex(b) - dayIndex(a);
/** 0 = Sunday … 6 = Saturday. */
export const weekday = (iso: ISODate) => new Date(dayIndex(iso) * DAY_MS).getUTCDay();
export const isWeekend = (iso: ISODate) => {
  const w = weekday(iso);
  return w === 0 || w === 6;
};
/** Monday of the week containing `iso`. */
export const mondayOf = (iso: ISODate) => addDays(iso, -((weekday(iso) + 6) % 7));
export const firstOfMonth = (iso: ISODate) => `${iso.slice(0, 7)}-01`;
const parts = (iso: ISODate) => {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return { y, m, d };
};
export function addMonths(iso: ISODate, n: number): ISODate {
  const { y, m } = parts(iso);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10);
}
export function isValidISODate(v: unknown): v is ISODate {
  if (typeof v !== "string" || !ISO_RE.test(v)) return false;
  return fromDayIndex(dayIndex(v)) === v;
}

/* ───────── formatting ───────── */

/** "Oct 8" */
export function fmtDay(iso: ISODate) {
  const { m, d } = parts(iso);
  return `${MONTHS[m - 1]} ${d}`;
}
/** "Thu Oct 8" */
export const fmtDow = (iso: ISODate) => `${DOW[weekday(iso)]} ${fmtDay(iso)}`;
/** "Thu, Oct 8" (agenda heading) */
export const fmtDowComma = (iso: ISODate) => `${DOW[weekday(iso)]}, ${fmtDay(iso)}`;
/** "Sep 1 – Nov 30" */
export const fmtRange = (a: ISODate, b: ISODate) => `${fmtDay(a)} – ${fmtDay(b)}`;
/** "October 2026" */
export const fmtMonth = (iso: ISODate) => `${MONTHS_LONG[parts(iso).m - 1]} ${parts(iso).y}`;
/** Inclusive length in days: Oct 1 → Oct 9 = 9. */
export const spanDays = (s: { start: ISODate; end: ISODate }) => diffDays(s.start, s.end) + 1;

/* ───────── spans ───────── */

export type Span = { start: ISODate; end: ISODate };
export type Dates = { startDate: ISODate | null; dueDate: ISODate | null };

/** Effective span (§2.1): [startDate ?? dueDate, dueDate ?? startDate]. Null = unscheduled. */
export function spanOf(t: Dates): Span | null {
  const start = t.startDate ?? t.dueDate;
  const end = t.dueDate ?? t.startDate;
  return start && end ? { start, end } : null;
}
/** Inclusive overlap of a span with [from, to]. */
export const overlaps = (s: Span, from: ISODate, to: ISODate) => s.end >= from && s.start <= to;
/** The client side of the L1 range filter: unscheduled tasks never match. */
export function inRange(t: Dates, from: ISODate, to: ISODate) {
  const s = spanOf(t);
  return Boolean(s && overlaps(s, from, to));
}

/* ───────── zoom windows (§1.2) ───────── */

export const ZOOM: Record<TimelineZoom, { days: number; step: number; label: string }> = {
  week: { days: 28, step: 7, label: "Week" },
  month: { days: 91, step: 28, label: "Month" },
  quarter: { days: 273, step: 91, label: "Quarter" },
};
export const ZOOMS: TimelineZoom[] = ["week", "month", "quarter"];

/** Window start without `at`: week → Monday of (today − 7), month → 1st of last month, quarter → 1st of last quarter. */
export function defaultAnchor(zoom: TimelineZoom, today: ISODate): ISODate {
  if (zoom === "week") return mondayOf(addDays(today, -7));
  if (zoom === "month") return addMonths(firstOfMonth(today), -1);
  const { y, m } = parts(today);
  const qStart = `${y}-${String(m - ((m - 1) % 3)).padStart(2, "0")}-01`;
  return addMonths(qStart, -3);
}

export type Window = { from: ISODate; to: ISODate; days: number };
export function windowOf(zoom: TimelineZoom, at: ISODate): Window {
  const days = ZOOM[zoom].days;
  return { from: at, to: addDays(at, days - 1), days };
}

/* ───────── axis (§1.2) ───────── */

export type Tick = { x: number; w: number; label: string; weekend?: boolean; today?: boolean; centered?: boolean };

function segments(win: Window, keyOf: (iso: ISODate) => number, labelOf: (start: ISODate) => string): Tick[] {
  const out: { k: number; s: number; e: number }[] = [];
  const base = dayIndex(win.from);
  for (let i = 0; i < win.days; i++) {
    const k = keyOf(fromDayIndex(base + i));
    const cur = out[out.length - 1];
    if (!cur || cur.k !== k) out.push({ k, s: i, e: i });
    else cur.e = i;
  }
  return out.map((sg) => ({ x: (sg.s / win.days) * 100, w: ((sg.e - sg.s + 1) / win.days) * 100, label: labelOf(fromDayIndex(base + sg.s)) }));
}
const monthKey = (iso: ISODate) => parts(iso).y * 12 + parts(iso).m - 1;
const quarterKey = (iso: ISODate) => parts(iso).y * 4 + Math.floor((parts(iso).m - 1) / 3);
const MONDAY_0 = dayIndex("1970-01-05");
const weekKey = (iso: ISODate) => Math.floor((dayIndex(iso) - MONDAY_0) / 7);

/** Two tick rows: months/quarters on top; days, Monday dates or month names below. */
export function axisTicks(zoom: TimelineZoom, win: Window, today: ISODate): { row1: Tick[]; row2: Tick[] } {
  const monthLabel = (iso: ISODate) => `${MONTHS[parts(iso).m - 1]} ${parts(iso).y}`;
  if (zoom === "quarter") {
    return {
      row1: segments(win, quarterKey, (iso) => `Q${Math.floor((parts(iso).m - 1) / 3) + 1} ${parts(iso).y}`),
      row2: segments(win, monthKey, (iso) => MONTHS[parts(iso).m - 1]!),
    };
  }
  const row1 = segments(win, monthKey, monthLabel);
  if (zoom === "month") return { row1, row2: segments(win, weekKey, (iso) => (weekday(iso) === 1 ? String(parts(iso).d) : "")) };
  const base = dayIndex(win.from);
  const row2 = Array.from({ length: win.days }, (_, i) => {
    const iso = fromDayIndex(base + i);
    return { x: (i / win.days) * 100, w: 100 / win.days, label: String(parts(iso).d), weekend: isWeekend(iso), today: iso === today, centered: true };
  });
  return { row1, row2 };
}

/** Gridlines: major at row-1 boundaries, minor at the other row-2 boundaries. */
export function gridlines(ticks: { row1: Tick[]; row2: Tick[] }) {
  const majors = new Set(ticks.row1.map((t) => t.x.toFixed(4)));
  return [
    ...ticks.row2.filter((t) => !majors.has(t.x.toFixed(4))).map((t) => ({ x: t.x, major: false })),
    ...ticks.row1.map((t) => ({ x: t.x, major: true })),
  ];
}

/** Weekend shading (week and month zoom): one band per Sat–Sun, clipped to the window. */
export function weekendBands(zoom: TimelineZoom, win: Window): { x: number; w: number }[] {
  if (zoom === "quarter") return [];
  const out: { x: number; w: number }[] = [];
  const base = dayIndex(win.from);
  for (let i = 0; i < win.days; i++) {
    const w = weekday(fromDayIndex(base + i));
    if (w === 6) out.push({ x: (i / win.days) * 100, w: (Math.min(2, win.days - i) / win.days) * 100 });
    else if (w === 0 && i === 0) out.push({ x: 0, w: 100 / win.days });
  }
  return out;
}

/** Centre of a day as a % of the window (today marker, milestone diamonds); null when outside. */
export function dayCenter(iso: ISODate, win: Window): number | null {
  const i = diffDays(win.from, iso);
  if (i < 0 || i >= win.days) return null;
  return ((i + 0.5) / win.days) * 100;
}

/* ───────── bar geometry and drag maths ───────── */

/** left / width in % of the lane. Bars outside the window get clipped by the lane. */
export function barGeometry(span: Span, win: Window) {
  return { left: (diffDays(win.from, span.start) / win.days) * 100, width: (spanDays(span) / win.days) * 100 };
}
/** Pixels per day for a lane of `laneWidth` px. */
export const pxPerDay = (laneWidth: number, win: Window) => laneWidth / win.days;
/** Whole days for a horizontal pointer delta (snaps to the nearest day). */
export const pxToDays = (dx: number, laneWidth: number, win: Window) => {
  const d = Math.round(dx / pxPerDay(laneWidth, win));
  return d === 0 ? 0 : d; // no -0
};
/** Day under an x offset inside the lane, clamped to the window. */
export function dayAtX(x: number, laneWidth: number, win: Window): ISODate {
  const i = Math.floor(x / pxPerDay(laneWidth, win));
  return addDays(win.from, Math.max(0, Math.min(win.days - 1, i)));
}
/** Pixel x of the start (left) edge of a day. */
export const dayToX = (iso: ISODate, laneWidth: number, win: Window) => diffDays(win.from, iso) * pxPerDay(laneWidth, win);

export type DragMode = "move" | "start" | "end";

/** Pointer-down zone: within `edge` px of the left / right edge resizes, otherwise moves. */
export function dragModeAt(offsetX: number, barWidth: number, edge: number): DragMode {
  if (barWidth >= edge * 3) {
    if (offsetX <= edge) return "start";
    if (offsetX >= barWidth - edge) return "end";
  }
  return "move";
}

/** Applies a whole-day delta: move shifts both edges; resizes clamp so start ≤ end (minimum 1 day). */
export function applyDelta(span: Span, mode: DragMode, delta: number): Span {
  if (mode === "move") return { start: addDays(span.start, delta), end: addDays(span.end, delta) };
  if (mode === "start") {
    const s = addDays(span.start, delta);
    return { start: s > span.end ? span.end : s, end: span.end };
  }
  const e = addDays(span.end, delta);
  return { start: span.start, end: e < span.start ? span.start : e };
}

/**
 * Maps a new bar span back to task dates. A move shifts only the dates the task has (a due-only
 * task stays due-only); a resize writes both dates, except a 1-day result on a single-date task.
 */
export function datesForSpan(task: Dates, span: Span, mode: DragMode): Dates {
  if (mode === "move") {
    return { startDate: task.startDate ? span.start : null, dueDate: task.dueDate ? span.end : null };
  }
  const single = !task.startDate || !task.dueDate;
  if (single && span.start === span.end) {
    return task.dueDate ? { startDate: null, dueDate: span.end } : { startDate: span.start, dueDate: null };
  }
  return { startDate: span.start, dueDate: span.end };
}

/** Only the keys that changed (a PATCH never re-sends an unchanged date). */
export function changedDates(before: Dates, after: Dates): Partial<Dates> {
  const out: Partial<Dates> = {};
  if (before.startDate !== after.startDate) out.startDate = after.startDate;
  if (before.dueDate !== after.dueDate) out.dueDate = after.dueDate;
  return out;
}
export const sameDates = (a: Dates, b: Dates) => a.startDate === b.startDate && a.dueDate === b.dueDate;

/** Calendar move (§1.4, §8 #24): due goes to `day`, start shifts by the same delta when set. */
export function calendarMove(task: Dates, day: ISODate): Dates {
  if (!task.dueDate) return { startDate: task.startDate, dueDate: day };
  const delta = diffDays(task.dueDate, day);
  return { startDate: task.startDate ? addDays(task.startDate, delta) : null, dueDate: day };
}

/**
 * Timeline keyboard reducer: ← / → move a day, Shift+← / → resize the due edge (clamped).
 * Returns null for keys it doesn't handle.
 */
export function timelineKey(span: Span, key: string, shift: boolean): { span: Span; mode: DragMode } | null {
  const d = key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : 0;
  if (!d) return null;
  return shift ? { span: applyDelta(span, "end", d), mode: "end" } : { span: applyDelta(span, "move", d), mode: "move" };
}
/** Calendar keyboard: Alt+← / → ±1 day, Alt+↑ / ↓ ±7 days. */
export function calendarKey(key: string): number | null {
  return ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 } as Record<string, number>)[key] ?? null;
}

/* ───────── dependencies (§1.6) ───────── */

/** Conflict: the blocked task starts on or before the blocker ends. */
export const isDependencyConflict = (blocker: Span, blocked: Span) => blocked.start <= blocker.end;

/* ───────── task display ───────── */

/** Bar fill by status glyph (design): done 100, review 80, progress 45, else 0. */
export function fillPercent(glyph: StatusGlyph | undefined) {
  return glyph === "done" ? 100 : glyph === "review" ? 80 : glyph === "progress" ? 45 : 0;
}

const DAY_ORDER: Record<StatusGlyph, number> = { progress: 0, review: 1, todo: 2, backlog: 3, done: 4, canceled: 5 };
/** Calendar order within a day: progress, review, todo, backlog, done; then priority desc; then number. */
export function sortDay<T extends Pick<Task, "priority" | "number" | "statusId">>(tasks: T[], glyphOf: (statusId: string) => StatusGlyph | undefined): T[] {
  return [...tasks].sort(
    (a, b) => (DAY_ORDER[glyphOf(a.statusId) ?? "todo"] - DAY_ORDER[glyphOf(b.statusId) ?? "todo"]) || b.priority - a.priority || a.number - b.number,
  );
}

/** Month cell overflow: ≤ cap chips shown as they are; more → cap − 1 chips and "+N more". */
export function splitOverflow<T>(list: T[], cap = 3): { shown: T[]; more: number } {
  if (list.length <= cap) return { shown: list, more: 0 };
  return { shown: list.slice(0, cap - 1), more: list.length - (cap - 1) };
}

/** Timeline order inside a group: effective start ascending, then task number. */
export function sortBySpan<T extends Dates & { number: number }>(tasks: T[]): T[] {
  return [...tasks].sort((a, b) => {
    const sa = spanOf(a)?.start ?? "9999-99-99";
    const sb = spanOf(b)?.start ?? "9999-99-99";
    return sa < sb ? -1 : sa > sb ? 1 : a.number - b.number;
  });
}

/** Derived epic span: min task start → max task end (dashed bar). */
export function derivedSpan(tasks: Dates[]): Span | null {
  let start: ISODate | null = null;
  let end: ISODate | null = null;
  for (const t of tasks) {
    const s = spanOf(t);
    if (!s) continue;
    if (start === null || s.start < start) start = s.start;
    if (end === null || s.end > end) end = s.end;
  }
  return start && end ? { start, end } : null;
}

/* ───────── calendar grid (§1.3) ───────── */

/** Monday-first month grid: first visible day and 4–6 rows. */
export function monthGrid(anyDayInMonth: ISODate): { start: ISODate; rows: number; first: ISODate; last: ISODate } {
  const first = firstOfMonth(anyDayInMonth);
  const next = addMonths(first, 1);
  const dim = diffDays(first, next);
  const lead = (weekday(first) + 6) % 7;
  return { start: addDays(first, -lead), rows: Math.ceil((lead + dim) / 7), first, last: addDays(next, -1) };
}

/** Agenda (390 px): from the selected day, up to 4 day groups with tasks within 21 days; the selected day always shows. */
export function agendaDays(selected: ISODate, hasTasks: (iso: ISODate) => boolean, maxGroups = 4, horizon = 21): ISODate[] {
  const out: ISODate[] = [];
  for (let i = 0; i < horizon && out.length < maxGroups; i++) {
    const iso = addDays(selected, i);
    if (i === 0 || hasTasks(iso)) out.push(iso);
  }
  return out;
}

/* ───────── URL state (§6.7) ───────── */

export type TimelineParams = { zoom: TimelineZoom; at: ISODate | null; group: TimelineGroup; deps: boolean; tray: boolean };
export type CalendarParams = { mode: CalendarMode; at: ISODate | null; day: ISODate | null; tray: boolean };

/** Invalid values fall back to the default (and are not rewritten until the user changes something). */
export function parseTimelineParams(sp: URLSearchParams): TimelineParams {
  const zoom = sp.get("zoom");
  const group = sp.get("group");
  const at = sp.get("at");
  return {
    zoom: zoom === "week" || zoom === "quarter" || zoom === "month" ? zoom : "month",
    at: isValidISODate(at) ? at : null,
    group: group === "assignee" ? "assignee" : "epic",
    deps: sp.get("deps") !== "0",
    tray: sp.get("tray") === "1",
  };
}
export function parseCalendarParams(sp: URLSearchParams): CalendarParams {
  const mode = sp.get("mode");
  const at = sp.get("at");
  const day = sp.get("day");
  return { mode: mode === "week" ? "week" : "month", at: isValidISODate(at) ? at : null, day: isValidISODate(day) ? day : null, tray: sp.get("tray") === "1" };
}

/** Writes a patch onto a query string; defaults are omitted. Other params (`f`, `task`, …) are kept. */
export function withTimelineParams(search: string, patch: Partial<TimelineParams>): string {
  const sp = new URLSearchParams(search);
  const set = (k: string, v: string | null) => (v === null ? sp.delete(k) : sp.set(k, v));
  if (patch.zoom !== undefined) set("zoom", patch.zoom === "month" ? null : patch.zoom);
  if (patch.at !== undefined) set("at", patch.at);
  if (patch.group !== undefined) set("group", patch.group === "epic" ? null : patch.group);
  if (patch.deps !== undefined) set("deps", patch.deps ? null : "0");
  if (patch.tray !== undefined) set("tray", patch.tray ? "1" : null);
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}
export function withCalendarParams(search: string, patch: Partial<CalendarParams>): string {
  const sp = new URLSearchParams(search);
  const set = (k: string, v: string | null) => (v === null ? sp.delete(k) : sp.set(k, v));
  if (patch.mode !== undefined) set("mode", patch.mode === "month" ? null : patch.mode);
  if (patch.at !== undefined) set("at", patch.at);
  if (patch.day !== undefined) set("day", patch.day);
  if (patch.tray !== undefined) set("tray", patch.tray ? "1" : null);
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}
/** Calendar `at` is normalised when written: the 1st (month) or the Monday (week). */
export const normaliseCalendarAt = (mode: CalendarMode, iso: ISODate) => (mode === "month" ? firstOfMonth(iso) : mondayOf(iso));
