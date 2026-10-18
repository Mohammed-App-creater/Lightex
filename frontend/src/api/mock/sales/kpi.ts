import type { MockDB } from "../db-types";
import { addDays, addMonths, money, num, parseDate, pct, salesStore, weekdayIndex, wsDate, wsToday, type SalesSchemas as S, type TargetRec } from "./store";
import { calendarOf, settingsOf, statusOf, weightedOf } from "./views";

/*
 * The one mock KPI module (spec §6, api.md §18–§21): periods, working-day weights, effective targets and the KPI
 * block. Values are computed from the store; they follow the definitions but aren't meant to match the backend to
 * the cent.
 */

export type PeriodKind = "today" | "day" | "week" | "month" | "quarter" | "year" | "custom";
export type Range = { kind: string; start: string; end: string };
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

/* ───────── periods ───────── */

function fiscalYearStart(db: MockDB, wsId: string, date: string) {
  const m = settingsOf(db, wsId).fiscalYearStartMonth;
  const d = parseDate(date);
  let y = d.getUTCFullYear();
  if (d.getUTCMonth() + 1 < m) y -= 1;
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

/** The period of `kind` containing `date` (today/day = the date; week from `weekStart`; fiscal quarter / year). */
export function periodRange(db: MockDB, wsId: string, kind: string, date: string): Range {
  switch (kind) {
    case "today":
    case "day":
      return { kind, start: date, end: date };
    case "week": {
      const ws = WEEKDAYS.indexOf(settingsOf(db, wsId).weekStart);
      const back = (weekdayIndex(date) - ws + 7) % 7;
      const start = addDays(date, -back);
      return { kind, start, end: addDays(start, 6) };
    }
    case "month": {
      const start = `${date.slice(0, 7)}-01`;
      return { kind, start, end: addDays(addMonths(start, 1), -1) };
    }
    case "quarter": {
      const fy = fiscalYearStart(db, wsId, date);
      let start = fy;
      while (addMonths(start, 3) <= date) start = addMonths(start, 3);
      return { kind, start, end: addDays(addMonths(start, 3), -1) };
    }
    default: {
      const start = fiscalYearStart(db, wsId, date);
      return { kind: "year", start, end: addDays(addMonths(start, 12), -1) };
    }
  }
}

export function previousRange(db: MockDB, wsId: string, r: Range): Range {
  if (r.kind === "custom") {
    const days = Math.round((parseDate(r.end).getTime() - parseDate(r.start).getTime()) / 86_400_000) + 1;
    return { kind: "custom", start: addDays(r.start, -days), end: addDays(r.start, -1) };
  }
  return periodRange(db, wsId, r.kind, addDays(r.start, -1));
}

/* ───────── working days ───────── */

export function dayWeight(db: MockDB, wsId: string, date: string) {
  if (salesStore(db).holidays.some((h) => h.workspaceId === wsId && h.date === date)) return 0;
  return calendarOf(db, wsId).weekdayWeights[weekdayIndex(date)] ?? 0;
}

export function weightBetween(db: MockDB, wsId: string, start: string, end: string) {
  let w = 0;
  for (let d = start; d <= end; d = addDays(d, 1)) w += dayWeight(db, wsId, d);
  return w;
}

/* ───────── targets ───────── */

export type Subject = { type: "user" | "team" | "company"; id: string | null };

function stored(db: MockDB, wsId: string, s: Subject, periodType: TargetRec["periodType"], start: string) {
  return salesStore(db).targets.find((t) => t.workspaceId === wsId && t.subjectType === s.type && (t.subjectId ?? null) === s.id && t.periodType === periodType && t.periodStart === start);
}

/** Month target: stored, else the stored quarter's (else year's) amount pro-rata by working-day weight. */
export function monthTarget(db: MockDB, wsId: string, s: Subject, monthStart: string): number | null {
  const m = stored(db, wsId, s, "month", monthStart);
  if (m) return num(m.amount);
  const monthEnd = addDays(addMonths(monthStart, 1), -1);
  const mw = weightBetween(db, wsId, monthStart, monthEnd);
  for (const kind of ["quarter", "year"] as const) {
    const r = periodRange(db, wsId, kind, monthStart);
    const t = stored(db, wsId, s, kind, r.start);
    if (t) {
      const w = weightBetween(db, wsId, r.start, r.end);
      return w ? (num(t.amount) * mw) / w : 0;
    }
  }
  return null;
}

/** Effective target over any range: Σ month target × the range's weight in that month / the month's weight. */
export function rangeTarget(db: MockDB, wsId: string, s: Subject, start: string, end: string, kind?: string): number | null {
  if (kind === "quarter" || kind === "year") {
    const t = stored(db, wsId, s, kind, start);
    if (t) return num(t.amount);
  }
  let total: number | null = null;
  for (let m = `${start.slice(0, 7)}-01`; m <= end; m = addMonths(m, 1)) {
    const mt = monthTarget(db, wsId, s, m);
    if (mt === null) continue;
    const mEnd = addDays(addMonths(m, 1), -1);
    const from = m < start ? start : m;
    const to = mEnd > end ? end : mEnd;
    const mw = weightBetween(db, wsId, m, mEnd);
    total = (total ?? 0) + (mw ? (mt * weightBetween(db, wsId, from, to)) / mw : 0);
  }
  return total;
}

/** Sum of the people's own targets (null when none of them has one). */
export function peopleTarget(db: MockDB, wsId: string, people: string[], r: Range): number | null {
  let t: number | null = null;
  for (const u of people) {
    const x = rangeTarget(db, wsId, { type: "user", id: u }, r.start, r.end, r.kind);
    if (x !== null) t = (t ?? 0) + x;
  }
  return t;
}

/* ───────── KPIs ───────── */

const inRange = (d: string | null, r: Range) => !!d && d >= r.start && d <= r.end;

export function wonIn(db: MockDB, wsId: string, people: Set<string>, r: Range) {
  return salesStore(db).opportunities.filter(
    (o) => o.workspaceId === wsId && !o.deletedAt && o.wonAt && o.creditedUserId && people.has(o.creditedUserId) && inRange(wsDate(db, wsId, o.wonAt), r),
  );
}
export const actualOf = (db: MockDB, wsId: string, people: Set<string>, r: Range) => wonIn(db, wsId, people, r).reduce((s, o) => s + num(o.wonValue), 0);

export function statusFor(db: MockDB, wsId: string, r: Range, actual: number, target: number | null) {
  if (target === null) return { expected: null, status: null };
  const today = wsToday(db, wsId);
  const { statusGreenPct: green, statusYellowPct: yellow } = settingsOf(db, wsId);
  if (r.start > today) return { expected: target, status: null };
  let expected = target;
  if (r.end >= today) {
    const total = weightBetween(db, wsId, r.start, r.end);
    expected = total ? (target * weightBetween(db, wsId, r.start, today)) / total : target;
  }
  const ratio = expected ? (actual / expected) * 100 : actual > 0 ? Infinity : 100;
  return { expected, status: ratio >= green ? "green" : ratio >= yellow ? "yellow" : "red" };
}

export function kpiBlock(db: MockDB, wsId: string, peopleList: string[], r: Range, target: number | null, prevActual: number | null): S["SalesKpis"] {
  const st = salesStore(db);
  const people = new Set(peopleList);
  const date = (iso: string | null) => (iso ? wsDate(db, wsId, iso) : null);
  const won = wonIn(db, wsId, people, r);
  const actual = won.reduce((s, o) => s + num(o.wonValue), 0);
  const opps = st.opportunities.filter((o) => o.workspaceId === wsId && !o.deletedAt && o.ownerId && people.has(o.ownerId));
  const lost = opps.filter((o) => inRange(date(o.lostAt), r)).length;
  const leads = st.leads.filter((l) => l.workspaceId === wsId && !l.deletedAt && l.ownerId && people.has(l.ownerId));
  const newLeads = leads.filter((l) => inRange(date(l.createdAt), r)).length;
  const converted = leads.filter((l) => inRange(date(l.convertedAt), r)).length;
  const open = opps.filter((o) => statusOf(db, o) === "open");
  const pipeline = open.reduce((s, o) => s + num(o.expectedValue), 0);
  const inPeriod = open.filter((o) => inRange(o.expectedCloseDate, r)).reduce((s, o) => s + num(o.expectedValue), 0);
  const weighted = open.reduce((s, o) => s + weightedOf(db, o), 0);
  const due = st.followUps.filter((f) => f.workspaceId === wsId && f.ownerId && people.has(f.ownerId) && f.status !== "cancelled" && inRange(f.dueDate, r));
  const onTime = due.filter((f) => f.completedAt && wsDate(db, wsId, f.completedAt) <= f.dueDate).length;
  const { expected, status } = statusFor(db, wsId, r, actual, target);
  return {
    period: r,
    actual: money(actual),
    target: target === null ? null : money(target),
    achievement: target ? pct(actual, target) : null,
    expected: expected === null ? null : money(expected),
    status,
    wonCount: won.length,
    lostCount: lost,
    winRate: pct(won.length, won.length + lost),
    averageDealSize: won.length ? money(actual / won.length) : null,
    newLeads,
    convertedLeads: converted,
    leadToOpportunityRate: pct(converted, newLeads),
    newOpportunities: opps.filter((o) => inRange(date(o.createdAt), r)).length,
    pipelineValue: money(pipeline),
    pipelineValueInPeriod: money(inPeriod),
    weightedPipeline: money(weighted),
    pipelineCoverage: target ? Math.round((inPeriod / target) * 100) / 100 : null,
    followUpsDue: due.length,
    followUpsOnTime: onTime,
    followUpPerformance: pct(onTime, due.length),
    growth: prevActual ? pct(actual - prevActual, prevActual) : null,
  };
}

/** Current and previous KPI blocks for a set of people; `targetOf` picks the target for a range. */
export function kpiPair(db: MockDB, wsId: string, people: string[], r: Range, targetOf: (r: Range) => number | null) {
  const p = previousRange(db, wsId, r);
  const previous = kpiBlock(db, wsId, people, p, targetOf(p), null);
  const current = kpiBlock(db, wsId, people, r, targetOf(r), num(previous.actual));
  return { current, previous };
}

/* ───────── daily metrics and effective targets ───────── */

export function dailyMetrics(db: MockDB, wsId: string, userId: string, date: string): S["SalesDailyMetrics"] {
  const st = salesStore(db);
  const on = (iso: string | null) => !!iso && wsDate(db, wsId, iso) === date;
  const mine = <T extends { workspaceId: string; ownerId: string | null }>(xs: T[]) => xs.filter((x) => x.workspaceId === wsId && x.ownerId === userId);
  const r = { kind: "day", start: date, end: date };
  const target = rangeTarget(db, wsId, { type: "user", id: userId }, date, date);
  const won = wonIn(db, wsId, new Set([userId]), r);
  const sales = won.reduce((s, o) => s + num(o.wonValue), 0);
  const acts = mine(st.activities).filter((a) => on(a.occurredAt));
  return {
    target: target === null ? null : money(target),
    sales: money(sales),
    achievement: target ? pct(sales, target) : null,
    newLeads: mine(st.leads).filter((l) => !l.deletedAt && on(l.createdAt)).length,
    calls: acts.filter((a) => a.type === "call").length,
    visits: acts.filter((a) => a.type === "visit").length,
    meetings: acts.filter((a) => a.type === "meeting").length,
    quotationsSent: mine(st.quotations).filter((q) => !q.deletedAt && on(q.sentAt)).length,
    followUpsCompleted: mine(st.followUps).filter((f) => on(f.completedAt)).length,
    newOpportunities: mine(st.opportunities).filter((o) => !o.deletedAt && on(o.createdAt)).length,
    dealsWon: won.length,
    dealsLost: mine(st.opportunities).filter((o) => !o.deletedAt && on(o.lostAt)).length,
  };
}

export function effectiveTargets(db: MockDB, wsId: string, userId: string, date: string): S["SalesEffectiveTargets"] {
  const people = new Set([userId]);
  const block = (kind: string): S["SalesEffectivePeriod"] => {
    const r = periodRange(db, wsId, kind, date);
    const target = rangeTarget(db, wsId, { type: "user", id: userId }, r.start, r.end, kind);
    const actual = actualOf(db, wsId, people, { kind, start: r.start, end: date });
    const remaining = weightBetween(db, wsId, date, r.end);
    return {
      start: r.start,
      end: r.end,
      target: target === null ? null : money(target),
      actual: money(actual),
      achievement: target ? pct(actual, target) : null,
      remainingWorkingDays: remaining,
      requiredDailyRunRate: target === null || !remaining ? null : money(Math.max(target - actual, 0) / remaining),
    };
  };
  return { userId, date, day: block("day"), week: block("week"), month: block("month"), quarter: block("quarter"), year: block("year") };
}
