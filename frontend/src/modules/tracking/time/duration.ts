import { addDaysISO, shortDate, todayISO } from "@/lib/utils/dates";

/* Durations for time tracking (board 39 §6.6). Pure; unit-tested. */

export const MAX_ENTRY_MINUTES = 1440;
export const MAX_ESTIMATE_MINUTES = 60_000;

export type Parsed = { minutes: number; error?: undefined } | { minutes?: undefined; error: string };

/**
 * "1:30" → 90 · "1.5" / "2" (bare number ≤ 12 = hours) → 90 / 120 · "45" (bare > 12 = minutes) → 45 ·
 * "1h 30m", "1h", "30m", "1.5h", "2 hours 5 mins" → 90, 60, 30, 90, 125. Empty → "Enter a duration";
 * anything else → "Use a format like 1h 30m". Range checks are separate (checkEntry / checkEstimate).
 */
export function parseDuration(input: string): Parsed {
  const t = String(input ?? "").trim().toLowerCase();
  if (!t) return { error: "Enter a duration" };
  let m = /^(\d{1,2}):([0-5]\d)$/.exec(t);
  if (m) return { minutes: Number(m[1]) * 60 + Number(m[2]) };
  m = /^(\d+(?:\.\d+)?)$/.exec(t);
  if (m) {
    const n = parseFloat(m[1]!);
    return { minutes: Math.round(n <= 12 ? n * 60 : n) };
  }
  m = /^(?:(\d+(?:\.\d+)?)\s*h(?:rs?|ours?)?)?\s*(?:(\d+)\s*m(?:in(?:s|utes?)?)?)?$/.exec(t);
  if (!m || (!m[1] && !m[2])) return { error: "Use a format like 1h 30m" };
  return { minutes: Math.round((m[1] ? parseFloat(m[1]) * 60 : 0) + (m[2] ? Number(m[2]) : 0)) };
}

/** Parses and range-checks a time entry: > 0 and ≤ 24h. */
export function checkEntry(input: string): Parsed {
  const p = parseDuration(input);
  if (p.error !== undefined) return p;
  if (p.minutes <= 0) return { error: "Duration must be over 0" };
  if (p.minutes > MAX_ENTRY_MINUTES) return { error: "Max 24h per entry" };
  return p;
}

/** Parses and range-checks a time estimate: 1 minute to 1000 hours. */
export function checkEstimate(input: string): Parsed {
  const p = parseDuration(input);
  if (p.error !== undefined) return p;
  if (p.minutes < 1 || p.minutes > MAX_ESTIMATE_MINUTES) return { error: "Estimate is 1 minute to 1000 hours" };
  return p;
}

/** Log date check with local dates: not after today, not before today − 365. Null when fine. */
export function checkLogDate(date: string, today = todayISO()): string | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return "Pick a date";
  if (date > today) return "Can’t log future time";
  if (date < addDaysISO(today, -365)) return "Date is too far back";
  return null;
}

/** "4h 25m", "45m", "6h", "0m". */
export function formatMinutes(min: number) {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h ? (r ? `${h}h ${r}m` : `${h}h`) : `${r}m`;
}

/** Live clock: "mm:ss" under an hour, "h:mm:ss" after. */
export function formatClock(ms: number) {
  const s = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(ss)}` : `${p(m)}:${p(ss)}`;
}

/** Hours with one decimal, no trailing ".0": 390 → "6.5", 480 → "8". */
export function formatHours(min: number) {
  const h = Math.round((min / 60) * 10) / 10;
  return Number.isInteger(h) ? String(h) : h.toFixed(1);
}

/** Hint under a valid log form: "= 1h 30m · Oct 7". */
export const logHint = (minutes: number, date: string) => `= ${formatMinutes(minutes)} · ${shortDate(date)}`;
