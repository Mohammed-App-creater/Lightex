import type { GlyphKind } from "@/components/ui/glyphs";
import type { Status, Task } from "@/lib/api/types";
import { DAY, parseDate, startOfToday } from "@/lib/domain/progress";

/* Pure helpers for the Goals screen (board 16). Kept free of React so they are unit-tested. */

/** Group order everywhere (board 16 §0.2): In progress → In review → Todo → Backlog → Done. */
export const GLYPH_ORDER: GlyphKind[] = ["progress", "review", "todo", "backlog", "done", "canceled"];

export type TaskGroup<T> = { status: Pick<Status, "id" | "name" | "glyph">; tasks: T[] };

/**
 * Groups tasks by their status, ordered by glyph (In progress first, Done last) then by the
 * project's status position. Empty groups are omitted; tasks with an unknown status are dropped.
 */
export function groupTasksByStatus<T extends Pick<Task, "statusId" | "number">>(
  tasks: T[],
  statuses: Pick<Status, "id" | "name" | "glyph" | "position">[],
): TaskGroup<T>[] {
  const rank = (s: Pick<Status, "glyph" | "position">) => GLYPH_ORDER.indexOf(s.glyph) * 1000 + s.position;
  return [...statuses]
    .sort((a, b) => rank(a) - rank(b))
    .map((status) => ({
      status,
      tasks: tasks.filter((t) => t.statusId === status.id).sort((a, b) => a.number - b.number),
    }))
    .filter((g) => g.tasks.length > 0);
}

/** Case-insensitive substring match on key or title (link picker search). */
export function matchTask(t: Pick<Task, "key" | "title">, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return t.key.toLowerCase().includes(q) || t.title.toLowerCase().includes(q);
}

/** ISO yyyy-mm-dd from a local Date. */
export function isoDate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Oct 21"; the year is appended when it differs from today's ("Jan 5, 2027"). */
export function shortDate(iso: string | null | undefined, now = new Date()) {
  if (!iso) return "No date";
  const d = parseDate(iso);
  if (Number.isNaN(d.getTime())) return "No date";
  const base = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === now.getFullYear() ? base : `${base}, ${d.getFullYear()}`;
}

export type TimelineMonth = { iso: string; label: string; pct: number };

export type TimelineScale = {
  start: string;
  end: string;
  months: TimelineMonth[];
  /** Position of an ISO date in percent (clamped 0..100). */
  x: (iso: string) => number;
  today: number;
};

/**
 * Linear time scale for the milestone timeline. The domain covers every milestone's start→due
 * window plus today, padded out to whole months (first of the earliest month → first of the
 * month after the latest date). Replaces the design's fixed Sep–Jan scale.
 */
export function timelineScale(items: { startDate: string; dueDate: string }[], now = new Date()): TimelineScale {
  const today = startOfToday(now);
  const dates = [today.getTime()];
  for (const it of items) {
    const s = parseDate(it.startDate).getTime();
    const d = parseDate(it.dueDate).getTime();
    if (!Number.isNaN(s)) dates.push(s);
    if (!Number.isNaN(d)) dates.push(d);
  }
  const min = new Date(Math.min(...dates));
  const max = new Date(Math.max(...dates));
  const start = new Date(min.getFullYear(), min.getMonth(), 1);
  let end = new Date(max.getFullYear(), max.getMonth() + 1, 1);
  // At least two months so a single milestone still reads as a timeline.
  if (monthsBetween(start, end) < 2) end = new Date(start.getFullYear(), start.getMonth() + 2, 1);
  const span = end.getTime() - start.getTime();
  const pctOf = (t: number) => Math.max(0, Math.min(100, ((t - start.getTime()) / span) * 100));

  const months: TimelineMonth[] = [];
  const multiYear = start.getFullYear() !== new Date(end.getTime() - DAY).getFullYear();
  for (let m = new Date(start); m < end; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) {
    const name = MONTHS[m.getMonth()]!;
    const label = multiYear && (m.getMonth() === 0 || months.length === 0) ? `${name} ${m.getFullYear()}` : name;
    months.push({ iso: isoDate(m), label, pct: pctOf(m.getTime()) });
  }

  return {
    start: isoDate(start),
    end: isoDate(end),
    months,
    x: (iso) => pctOf(parseDate(iso).getTime()),
    today: pctOf(today.getTime()),
  };
}

function monthsBetween(a: Date, b: Date) {
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
}

/** Show a month label only every `step` months so labels never collide on narrow tracks. */
export function monthLabelStep(monthCount: number, trackWidth: number, minGap = 44) {
  if (monthCount <= 0 || trackWidth <= 0) return 1;
  const per = trackWidth / monthCount;
  return Math.max(1, Math.ceil(minGap / per));
}

/** Bar geometry for a milestone: left/width in percent (min width 0.6%, board 16 §1.5). */
export function barGeometry(scale: Pick<TimelineScale, "x">, startDate: string, dueDate: string) {
  const a = scale.x(startDate);
  const b = scale.x(dueDate);
  const left = Math.min(a, b);
  const width = Math.max(0.6, Math.abs(b - a));
  return { left: Math.min(left, 100 - 0.6), width, end: b, flip: b > 80 };
}

/** First not-done milestone (default selection), else the first one. */
export function defaultMilestoneId(list: { id: string; completedAt: string | null }[]) {
  return (list.find((m) => !m.completedAt) ?? list[0])?.id ?? null;
}

export function sortByDue<T extends { dueDate: string }>(list: T[]) {
  return [...list].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}
