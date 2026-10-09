import type { QuietHours } from "@/lib/api/types";

/*
 * Quiet hours (board 38, spec §6.6). Pure. The card draws with segments / summary / tzLabel; the mock's
 * dispatcher holds deliveries with holds() and releases them at windowEnd(), exactly as the backend does:
 *
 * - active only when enabled, a time zone is set, from ≠ to, and at least one day is selected;
 * - same-day window (from < to): quiet when days[wd] and from ≤ m < to;
 * - overnight window (from > to): quiet when days[wd] and m ≥ from, or days[wd − 1] and m < to
 *   (a day toggle means "the window that starts on this day");
 * - the Urgent bypass lets priority-4 tasks through.
 */

export const DEFAULT_QUIET: QuietHours = {
  enabled: true,
  from: "22:00",
  to: "08:00",
  timezone: null,
  // Every day (spec §10 #5: the design fixture's Mon–Fri is not a behaviour spec).
  days: [true, true, true, true, true, true, true],
  urgentBypass: true,
};

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const isValidTime = (t: string) => TIME_RE.test(t);

/** "22:30" → 1350; null when it isn't HH:MM. */
export function toMin(t: string): number | null {
  if (!isValidTime(t)) return null;
  const [h, m] = t.split(":").map(Number) as [number, number];
  return h * 60 + m;
}

const pct = (m: number) => Math.round((m / 1440) * 1000) / 10;

/** The 24 h bar's hatched parts, in %: one for a same-day window, two when it runs overnight, none when from = to. */
export function segments(from: string, to: string): { left: number; width: number }[] {
  const f = toMin(from);
  const t = toMin(to);
  if (f === null || t === null || f === t) return [];
  if (f < t) return [{ left: pct(f), width: pct(t - f) }];
  return [
    { left: pct(f), width: pct(1440 - f) },
    { left: 0, width: pct(t) },
  ];
}

export const DAYS: { short: string; full: string; abbr: string }[] = [
  { short: "Mo", full: "Monday", abbr: "Mon" },
  { short: "Tu", full: "Tuesday", abbr: "Tue" },
  { short: "We", full: "Wednesday", abbr: "Wed" },
  { short: "Th", full: "Thursday", abbr: "Thu" },
  { short: "Fr", full: "Friday", abbr: "Fri" },
  { short: "Sa", full: "Saturday", abbr: "Sat" },
  { short: "Su", full: "Sunday", abbr: "Sun" },
];

/** Design `daysLabel`: every day / no days / Mon–Fri / weekends / "Mo We Fr". */
export function daysLabel(days: readonly boolean[]): string {
  const n = days.filter(Boolean).length;
  if (n === 7) return "every day";
  if (n === 0) return "no days";
  const key = days.map((d) => (d ? 1 : 0)).join("");
  if (key === "1111100") return "Mon–Fri";
  if (key === "0000011") return "weekends";
  return DAYS.filter((_, i) => days[i]).map((d) => d.short).join(" ");
}

/** "America/Argentina/Buenos_Aires" → "Buenos Aires". */
export function tzCity(iana: string): string {
  return (iana.split("/").pop() ?? iana).replace(/_/g, " ");
}

/** "GMT−4", "GMT+5:30", "GMT" (Intl shortOffset, with the design's minus sign). */
export function gmtOffset(iana: string, at: Date = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: iana, timeZoneName: "shortOffset" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value;
    return (part ?? "GMT").replace("-", "−");
  } catch {
    return "GMT";
  }
}

/** "New York · GMT−4" (design timezone option). */
export const tzLabel = (iana: string, at: Date = new Date()) => `${tzCity(iana)} · ${gmtOffset(iana, at)}`;

/** The card header's mono line: "22:00–08:00 · Mon–Fri · New York", or "Off". */
export function summary(q: QuietHours): string {
  if (!q.enabled) return "Off";
  return `${q.from}–${q.to} · ${daysLabel(q.days)} · ${q.timezone ? tzCity(q.timezone) : "no time zone"}`;
}

export function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

export function isKnownTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Every IANA zone (spec §10 #6), the browser's first, and `current` kept even if the runtime doesn't list it. */
export function timeZoneOptions(browser = browserTimeZone(), current?: string | null): string[] {
  let all: string[] = [];
  try {
    all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    all = [];
  }
  if (!all.length) all = ["UTC", "America/New_York", "America/Los_Angeles", "Europe/London", "Europe/Berlin", "Asia/Kolkata"];
  const head = [browser, current].filter((z): z is string => Boolean(z));
  return [...new Set([...head, ...all])];
}

/* ───────── the window (spec §6.6) ───────── */

type Parts = { y: number; mo: number; d: number; h: number; mi: number; wd: number };
const WD: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
const fmtCache = new Map<string, Intl.DateTimeFormat>();

/** Wall-clock parts of an instant in a zone; `wd` is Mon = 0. */
export function localParts(at: Date, tz: string): Parts {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    fmtCache.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, mi: Number(p.minute), wd: WD[p.weekday!] ?? 0 };
}

/** The wall clock of an instant as if it were UTC (ms), minute precision. */
const wallMs = (at: number, tz: string) => {
  const p = localParts(new Date(at), tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
};

/**
 * The UTC instant of a local wall time. In a DST overlap the first occurrence wins (fold = 0); a wall
 * time inside a DST gap moves to the first valid minute after it.
 */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  const target = Date.UTC(y, mo - 1, d, h, mi);
  const before = target - (wallMs(target - 86_400_000, tz) - (target - 86_400_000));
  const after = target - (wallMs(target + 86_400_000, tz) - (target + 86_400_000));
  const hits = [before, after].filter((c) => wallMs(c, tz) === target);
  if (hits.length) return new Date(Math.min(...hits));
  // Gap: the first instant whose wall clock is at or after the target (binary search, minute steps).
  let lo = Math.min(before, after);
  let hi = Math.max(before, after);
  while (hi - lo > 60_000) {
    const mid = lo + Math.floor((hi - lo) / 120_000) * 60_000;
    if (wallMs(mid, tz) >= target) hi = mid;
    else lo = mid;
  }
  return new Date(hi);
}

/** Quiet hours can hold anything at all (enabled, a zone, from ≠ to, a day). */
export function isActive(q: QuietHours): boolean {
  if (!q.enabled || !q.timezone || !isKnownTimeZone(q.timezone)) return false;
  const f = toMin(q.from);
  const t = toMin(q.to);
  return f !== null && t !== null && f !== t && q.days.some(Boolean);
}

/** Is `at` inside the quiet window? */
export function isQuietAt(q: QuietHours, at: Date): boolean {
  if (!isActive(q)) return false;
  const f = toMin(q.from)!;
  const t = toMin(q.to)!;
  const p = localParts(at, q.timezone!);
  const m = p.h * 60 + p.mi;
  if (f < t) return q.days[p.wd]! && m >= f && m < t;
  return (q.days[p.wd]! && m >= f) || (q.days[(p.wd + 6) % 7]! && m < t);
}

/** Does quiet hours hold a delivery? Urgent (priority 4 at enqueue) passes when the bypass is on. */
export const holds = (q: QuietHours, at: Date, urgent: boolean) => isQuietAt(q, at) && !(q.urgentBypass && urgent);

/** When the current window ends (the next local `to`), or null when `at` isn't quiet. */
export function windowEnd(q: QuietHours, at: Date): Date | null {
  if (!isQuietAt(q, at)) return null;
  const tz = q.timezone!;
  const f = toMin(q.from)!;
  const t = toMin(q.to)!;
  const p = localParts(at, tz);
  const m = p.h * 60 + p.mi;
  // Overnight and still before midnight: it ends tomorrow; otherwise today.
  const addDay = f > t && m >= f ? 1 : 0;
  const day = new Date(Date.UTC(p.y, p.mo - 1, p.d + addDay));
  return zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), Math.floor(t / 60), t % 60, tz);
}

/** Client-side check before a save (the server repeats it, §5.13). */
export function quietError(q: QuietHours): { field: "from" | "to" | "timezone"; message: string } | null {
  if (!isValidTime(q.from)) return { field: "from", message: "Use HH:MM" };
  if (!isValidTime(q.to)) return { field: "to", message: "Use HH:MM" };
  if (q.from === q.to) return { field: "to", message: "End must differ from start" };
  if (q.timezone && !isKnownTimeZone(q.timezone)) return { field: "timezone", message: "Unknown time zone" };
  return null;
}
