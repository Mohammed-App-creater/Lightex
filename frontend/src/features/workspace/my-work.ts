import type { Status, StatusGlyph, Task } from "@/lib/api/types";
import { addDaysISO, dateRange, todayISO } from "@/lib/utils/dates";

/*
 * Pure helpers for the personal screens (board 24 Home "Due soon" + stats, board 25 My tasks).
 * Everything takes `today` so tests are deterministic.
 */

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DOW_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function parts(iso: string) {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number) as [number, number, number];
  return { y, m, d, dow: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}

function diffDays(a: string, b: string) {
  const x = parts(a);
  const y = parts(b);
  return Math.round((Date.UTC(x.y, x.m - 1, x.d) - Date.UTC(y.y, y.m - 1, y.d)) / 86_400_000);
}

/** Sunday that ends the (Monday-first) week containing `today`. */
export function weekEndISO(today = todayISO()) {
  return addDaysISO(today, (7 - parts(today).dow) % 7);
}

/** Monday that starts the week containing `today`. */
export function weekStartISO(today = todayISO()) {
  return addDaysISO(today, -((parts(today).dow + 6) % 7));
}

/** "Wednesday, Oct 7" (home greeting). */
export function longDate(today = todayISO()) {
  const p = parts(today);
  return `${DOW_LONG[p.dow]}, ${MON[p.m - 1]} ${p.d}`;
}

/** "Wed, Oct 7" (Today group meta). */
export function shortDay(today = todayISO()) {
  const p = parts(today);
  return `${DOW[p.dow]}, ${MON[p.m - 1]} ${p.d}`;
}

export type DueTone = "late" | "soon" | "muted" | "";

/**
 * Due cell copy: Today / Tomorrow / Yesterday / weekday inside `weekdayWithin` days / "Oct 23";
 * "—" when there is no date. Tone: late (overdue), soon (today), muted (closed or no date).
 */
export function dueLabel(due: string | null, closed: boolean, today = todayISO(), weekdayWithin = 7): { text: string; tone: DueTone } {
  if (!due) return { text: "—", tone: "muted" };
  const diff = diffDays(due, today);
  const p = parts(due);
  let text = `${MON[p.m - 1]} ${p.d}`;
  if (diff === 0) text = "Today";
  else if (diff === 1) text = "Tomorrow";
  else if (diff === -1) text = "Yesterday";
  else if (diff > 1 && diff < weekdayWithin) text = DOW[p.dow]!;
  return { text, tone: closed ? "muted" : diff < 0 ? "late" : diff === 0 ? "soon" : "" };
}

export type BucketId = "overdue" | "today" | "week" | "later" | "nodate";
export type Bucket = { id: BucketId; title: string; meta: string; tasks: Task[] };

/** Groups tasks by due date: Overdue, Today, This week (to Sunday), Later, No date. Empty groups dropped. */
export function bucketTasks(tasks: Task[], today = todayISO()): Bucket[] {
  const weekEnd = weekEndISO(today);
  const tomorrow = addDaysISO(today, 1);
  const b: Bucket[] = [
    { id: "overdue", title: "Overdue", meta: "", tasks: [] },
    { id: "today", title: "Today", meta: shortDay(today), tasks: [] },
    { id: "week", title: "This week", meta: tomorrow <= weekEnd ? (tomorrow === weekEnd ? shortDay(weekEnd).slice(5) : dateRange(tomorrow, weekEnd)) : "", tasks: [] },
    { id: "later", title: "Later", meta: "", tasks: [] },
    { id: "nodate", title: "No date", meta: "", tasks: [] },
  ];
  for (const t of tasks) {
    const d = t.dueDate;
    const target = !d ? b[4]! : d < today ? b[0]! : d === today ? b[1]! : d <= weekEnd ? b[2]! : b[3]!;
    target.tasks.push(t);
  }
  for (const g of b) g.tasks.sort(byDueThenPriority);
  return b.filter((x) => x.tasks.length);
}

export function byDueThenPriority(a: Task, b: Task) {
  const da = a.dueDate ?? "9999";
  const db = b.dueDate ?? "9999";
  return da < db ? -1 : da > db ? 1 : b.priority - a.priority;
}

/** Closed (done-category) within the last 7 days: the "Completed recently" group. */
export function closedRecently(t: Task, today = todayISO()) {
  const at = (t.completedAt ?? t.updatedAt ?? "").slice(0, 10);
  return Boolean(at) && at >= addDaysISO(today, -7);
}

export function closedAt(t: Task) {
  return t.completedAt ?? t.updatedAt ?? "";
}

type StatusOf = (t: Task) => Status | undefined;

/** Home quick stats (board 24): Due today, Overdue, In progress, Done this week. */
export function homeStats(tasks: Task[], statusOf: StatusOf, today = todayISO()) {
  const open = tasks.filter((t) => statusOf(t)?.category !== "done");
  const weekStart = weekStartISO(today);
  return {
    dueToday: open.filter((t) => t.dueDate === today).length,
    overdue: open.filter((t) => t.dueDate && t.dueDate < today).length,
    inProgress: open.filter((t) => statusOf(t)?.category === "in_progress").length,
    doneThisWeek: tasks.filter((t) => {
      const s = statusOf(t);
      return s?.category === "done" && s.glyph !== "canceled" && (t.completedAt ?? "").slice(0, 10) >= weekStart;
    }).length,
  };
}

/**
 * Home "Due soon": open tasks due by the end of this week (overdue included), plus tasks the user
 * just closed from this list (`keep`) so they stay struck through instead of vanishing. Max 6.
 */
export function dueSoon(tasks: Task[], statusOf: StatusOf, keep: ReadonlySet<string>, today = todayISO(), max = 6) {
  const weekEnd = weekEndISO(today);
  return tasks
    .filter((t) => {
      const s = statusOf(t);
      if (s?.glyph === "canceled") return false;
      if (s?.category === "done" && !keep.has(t.id)) return false;
      return Boolean(t.dueDate) && t.dueDate! <= weekEnd;
    })
    .sort(byDueThenPriority)
    .slice(0, max);
}

/** Cross-project board columns (board 25 "columns by status across projects"). */
export const BOARD_COLUMNS: StatusGlyph[] = ["backlog", "todo", "progress", "review", "done"];

/** Parses ?project=PRJ,MO. */
export function parseKeys(v: string | null) {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

/** Project key from a name (board 24): one word → first 3 letters, several → initials (up to 5). */
export function deriveKey(name: string) {
  const words = name
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .map((w) => w.replace(/[^A-Z]/g, ""))
    .filter(Boolean);
  if (!words.length) return "";
  if (words.length === 1) return words[0]!.slice(0, 3);
  return words
    .map((w) => w[0])
    .join("")
    .slice(0, 5);
}

/** Key error copy from the design, or null when the key is usable. */
export function validateKey(key: string, taken: readonly string[]) {
  if (!key) return "Key required";
  if (!/^[A-Z]{2,5}$/.test(key)) return "2–5 letters, A–Z";
  if (taken.includes(key)) return `${key} is taken`;
  return null;
}
