/* Date formatting used across screens. Dates are local calendar dates (YYYY-MM-DD). */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parse(d: string) {
  return d.length === 10 ? new Date(`${d}T00:00:00`) : new Date(d);
}

/** "Oct 21" (adds the year when it isn't this year). */
export function shortDate(d: string | null | undefined) {
  if (!d) return "";
  const x = parse(d);
  const s = `${MONTHS[x.getMonth()]} ${x.getDate()}`;
  return x.getFullYear() === new Date().getFullYear() ? s : `${s}, ${x.getFullYear()}`;
}

/** "Oct 1–14" or "Sep 28 – Oct 11". */
export function dateRange(a: string, b: string) {
  const x = parse(a);
  const y = parse(b);
  if (x.getMonth() === y.getMonth()) return `${MONTHS[x.getMonth()]} ${x.getDate()}–${y.getDate()}`;
  return `${shortDate(a)} – ${shortDate(b)}`;
}

/** "12m", "2h", "3d" (compact, as in the inbox) or "just now". */
export function ago(iso: string, now = Date.now()) {
  const mins = Math.round((now - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d`;
  return shortDate(iso.slice(0, 10));
}

export function agoLong(iso: string) {
  const a = ago(iso);
  return a === "just now" || /^[A-Z]/.test(a) ? a : `${a} ago`;
}

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function addDaysISO(iso: string, days: number) {
  const d = parse(iso);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Due-date tone: late (danger), soon (≤2 days, warn) or muted. */
export function dueTone(due: string | null, done: boolean): "late" | "soon" | "muted" | "none" {
  if (!due) return "none";
  if (done) return "muted";
  const t = todayISO();
  if (due < t) return "late";
  if (due <= addDaysISO(t, 2)) return "soon";
  return "muted";
}

export function isToday(iso: string) {
  return iso.slice(0, 10) === todayISO() || new Date(iso).toDateString() === new Date().toDateString();
}

/** "2h" for recent activity, "Oct 2" once it's older than `days`. */
export function agoOrDate(iso: string, days = 6) {
  return Date.now() - new Date(iso).getTime() > days * 86_400_000 ? shortDate(iso.slice(0, 10)) : ago(iso);
}
