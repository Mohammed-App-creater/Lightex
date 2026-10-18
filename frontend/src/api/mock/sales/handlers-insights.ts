import { wsPermissions } from "../derive";
import { fail, filterValues, invalid, route, type Ctx } from "../router";
import { activeMembers, bodyOf, flush, page, recCtx, scopeOf, scopePeople, teamMates, userBrief, userRef, wsCtx, type SalesCtx } from "./access";
import { salesAudit } from "./handlers-reference";
import { liveOpps } from "./handlers-pipeline";
import { dailyMetrics, dayWeight, effectiveTargets, kpiPair, peopleTarget, periodRange, rangeTarget, statusFor, weightBetween, actualOf, wonIn, type Range, type Subject } from "./kpi";
import { addDays, addMonths, isDate, money, nowISO, num, sid, wsInstant, wsToday, type DailyReportRec, type SalesSchemas as S, type TargetRec } from "./store";
import { bucketOf, settingsOf, stageById, stagesOf, statusOf, weightedOf, oppFlags } from "./views";

/* §18 targets, §19 performance, §20 daily reports, §21 dashboard. */

/* ───────── people and subjects ───────── */

const liveTeams = (sc: SalesCtx) => sc.db.teams.filter((t) => t.workspaceId === sc.wsId && !t.deletedAt);
const teamMembers = (sc: SalesCtx, teamId: string) => sc.db.teamMembers.filter((m) => m.teamId === teamId).map((m) => m.userId);
const myTeams = (sc: SalesCtx) => liveTeams(sc).filter((t) => sc.db.teamMembers.some((m) => m.teamId === t.id && m.userId === sc.userId));

/** People a scopable code reaches (active members only). */
function peopleFor(sc: SalesCtx, code: string): string[] {
  const set = scopePeople(sc, code);
  return activeMembers(sc.db, sc.wsId).filter((u) => !set || set.has(u));
}

/** Can the caller's scope for `code` reach a target subject? (`all` → anything; `team` → team-mates and own teams; `own` → self.) */
function subjectInScope(sc: SalesCtx, code: string, s: Subject): boolean {
  const scope = scopeOf(sc, code);
  if (!scope) return false;
  if (scope === "all") return true;
  if (s.type === "company") return false;
  if (s.type === "user") return scope === "own" ? s.id === sc.userId : teamMates(sc.db, sc.wsId, sc.userId).has(s.id!);
  return scope === "team" && myTeams(sc).some((t) => t.id === s.id);
}

function subjectName(sc: SalesCtx, s: Subject) {
  if (s.type === "company") return sc.ws.name;
  if (s.type === "team") return sc.db.teams.find((t) => t.id === s.id)?.name ?? "";
  return sc.db.users.find((u) => u.id === s.id)?.name ?? "";
}

function readSubject(sc: SalesCtx, type: unknown, id: unknown): Subject {
  if (type === "company") return { type, id: null };
  if (type === "user") {
    if (typeof id !== "string" || !activeMembers(sc.db, sc.wsId).includes(id)) invalid({ subjectId: "Pick a member of this workspace" });
    return { type, id };
  }
  if (type === "team") {
    if (typeof id !== "string" || !liveTeams(sc).some((t) => t.id === id)) invalid({ subjectId: "Pick a team of this workspace" });
    return { type, id };
  }
  invalid({ subjectType: "Use user, team or company" });
}

const holdsSubmit = (sc: SalesCtx, userId: string) => (wsPermissions(sc.db, userId, sc.wsId) as string[]).includes("sales.dailyreport.submit");

/* ───────── targets ───────── */

function fiscalStart(sc: SalesCtx, year: number) {
  return `${year}-${String(settingsOf(sc.db, sc.wsId).fiscalYearStartMonth).padStart(2, "0")}-01`;
}

function periodEnd(type: TargetRec["periodType"], start: string) {
  return addDays(addMonths(start, type === "year" ? 12 : type === "quarter" ? 3 : 1), -1);
}

function validStart(sc: SalesCtx, type: TargetRec["periodType"], start: string) {
  if (!isDate(start) || !start.endsWith("-01")) return false;
  const r = periodRange(sc.db, sc.wsId, type, start);
  return r.start === start;
}

const toTarget = ({ workspaceId: _w, ...t }: TargetRec): S["SalesTarget"] => t;

function upsertTarget(sc: SalesCtx, s: Subject, type: TargetRec["periodType"], start: string, amount: number, note?: string) {
  const amt = money(amount);
  let t = sc.store.targets.find((x) => x.workspaceId === sc.wsId && x.subjectType === s.type && x.subjectId === s.id && x.periodType === type && x.periodStart === start);
  const created = !t;
  if (!t) {
    t = { id: sid(), workspaceId: sc.wsId, subjectType: s.type, subjectId: s.id, periodType: type, periodStart: start, periodEnd: periodEnd(type, start), amount: amt, note: note ?? "", updatedAt: nowISO() };
    sc.store.targets.push(t);
  } else {
    t.amount = amt;
    if (note !== undefined) t.note = note;
    t.updatedAt = nowISO();
  }
  salesAudit(sc, "sales.target.set", `${subjectName(sc, s)} ${type} ${start}`);
  return { t, created };
}

function yearNode(sc: SalesCtx, s: Subject, year: number): S["SalesTargetYear"] {
  const start = fiscalStart(sc, year);
  const end = periodEnd("year", start);
  const get = (type: TargetRec["periodType"], ps: string) =>
    sc.store.targets.find((x) => x.workspaceId === sc.wsId && x.subjectType === s.type && x.subjectId === s.id && x.periodType === type && x.periodStart === ps);
  const y = get("year", start);
  const gap = (parent: number | null, kids: (number | null)[]) => {
    const stored = kids.filter((k): k is number => k !== null);
    return parent === null || !stored.length ? null : money(parent - stored.reduce((a, b) => a + b, 0));
  };
  const allMonths: (number | null)[] = [];
  const quarters = [0, 1, 2, 3].map((i) => {
    const qs = addMonths(start, i * 3);
    const qt = get("quarter", qs);
    const months = [0, 1, 2].map((j) => {
      const ms = addMonths(qs, j);
      const mt = get("month", ms);
      allMonths.push(mt ? num(mt.amount) : null);
      return { start: ms, end: periodEnd("month", ms), amount: mt?.amount ?? null };
    });
    return { start: qs, end: periodEnd("quarter", qs), amount: qt?.amount ?? null, months, allocationGap: gap(qt ? num(qt.amount) : null, months.map((m) => (m.amount ? num(m.amount) : null))) };
  });
  const yv = y ? num(y.amount) : null;
  return {
    subjectType: s.type,
    subjectId: s.id,
    name: subjectName(sc, s),
    year,
    start,
    end,
    target: y?.amount ?? null,
    quarters,
    quarterGap: gap(yv, quarters.map((q) => (q.amount ? num(q.amount) : null))),
    monthGap: gap(yv, allMonths),
  };
}

function allocationNode(sc: SalesCtx, s: Subject, year: number, children: S["SalesTargetAllocationUser"][]): S["SalesTargetAllocationUser"] {
  const node = yearNode(sc, s, year);
  const allocated = children.reduce((a, c) => a + num(c.target), 0);
  const target = node.target === null ? null : num(node.target);
  return {
    ...node,
    allocated: money(allocated),
    unallocated: target === null ? null : money(Math.max(target - allocated, 0)),
    allocationGap: target === null ? null : money(target - allocated),
    children,
  };
}

/** Splits `total` into parts by weight, in cents; the remainder goes to the heaviest part. */
function split(total: number, weights: number[]) {
  const cents = Math.round(total * 100);
  const sum = weights.reduce((a, b) => a + b, 0);
  const parts = weights.map((w) => (sum ? Math.floor((cents * w) / sum) : Math.floor(cents / weights.length)));
  const rest = cents - parts.reduce((a, b) => a + b, 0);
  const heaviest = weights.indexOf(Math.max(...weights));
  parts[heaviest === -1 ? 0 : heaviest]! += rest;
  return parts.map((c) => c / 100);
}

/* ───────── daily reports ───────── */

function reportRequired(sc: SalesCtx, date: string) {
  return settingsOf(sc.db, sc.wsId).dailyReportRequired && dayWeight(sc.db, sc.wsId, date) > 0;
}
function cutoffAt(sc: SalesCtx, date: string) {
  const [h, m] = settingsOf(sc.db, sc.wsId).dailyReportCutoff.split(":").map(Number) as [number, number];
  return wsInstant(sc.db, sc.wsId, date, h, m);
}

function toReport(sc: SalesCtx, r: DailyReportRec): S["SalesDailyReport"] {
  return {
    id: r.id,
    user: userRef(sc.db, r.userId),
    reportDate: r.reportDate,
    status: r.status,
    required: reportRequired(sc, r.reportDate),
    cutoffAt: cutoffAt(sc, r.reportDate),
    comments: [...r.comments],
    tomorrowPlan: r.tomorrowPlan.map((p) => ({ ...p })),
    submittedAt: r.submittedAt,
    isLate: r.isLate,
    reviewedBy: r.reviewedById ? userRef(sc.db, r.reviewedById) : null,
    reviewedAt: r.reviewedAt,
    reviewComment: r.reviewComment,
    metrics: r.snapshot ?? dailyMetrics(sc.db, sc.wsId, r.userId, r.reportDate),
    canEdit: r.userId === sc.userId && r.status !== "reviewed" && sc.perms.has("sales.dailyreport.submit"),
    updatedAt: r.updatedAt,
  };
}

function reportFor(sc: SalesCtx, userId: string, date: string, create: boolean) {
  let r = sc.store.dailyReports.find((x) => x.workspaceId === sc.wsId && x.userId === userId && x.reportDate === date);
  if (!r && create) {
    r = { id: sid(), workspaceId: sc.wsId, userId, reportDate: date, status: "draft", comments: [], tomorrowPlan: [], submittedAt: null, isLate: false, reviewedById: null, reviewedAt: null, reviewComment: "", snapshot: null, updatedAt: nowISO() };
    sc.store.dailyReports.push(r);
    salesAudit(sc, "sales.dailyreport.created", date);
  }
  return r;
}

const reportRoute = (ctx: Ctx, perm: string) => {
  const [sc, r] = recCtx(ctx, (s) => s.dailyReports, perm, "Report not found.");
  const people = scopePeople(sc, "sales.dailyreport.view");
  if (r.userId !== sc.userId && people && !people.has(r.userId)) fail(404, "not_found", "Report not found.");
  return [sc, r] as const;
};
const authorOnly = (sc: SalesCtx, r: DailyReportRec) => {
  if (r.userId !== sc.userId) fail(403, "forbidden", "Only the author can change this report.", { permission: "sales.dailyreport.submit" });
};
const reviewer = (sc: SalesCtx, r: DailyReportRec) => {
  const people = scopePeople(sc, "sales.dailyreport.review");
  if (r.userId === sc.userId || (people && !people.has(r.userId))) fail(403, "forbidden", "You can’t review this report.", { permission: "sales.dailyreport.review" });
};

const METRIC_KEYS = ["newLeads", "calls", "visits", "meetings", "quotationsSent", "followUpsCompleted", "newOpportunities", "dealsWon", "dealsLost"] as const;

/* ───────── dashboard helpers ───────── */

function periodParam(sc: SalesCtx, allowCustom: boolean): Range {
  const ctx = sc.ctx;
  const kinds = ["today", "week", "month", "quarter", "year", ...(allowCustom ? ["custom"] : [])];
  const date = typeof ctx.query.date === "string" && ctx.query.date ? ctx.query.date : wsToday(sc.db, sc.wsId);
  if (!isDate(date)) invalid({ date: "Use YYYY-MM-DD" });
  const from = typeof ctx.query.from === "string" ? ctx.query.from : "";
  const to = typeof ctx.query.to === "string" ? ctx.query.to : "";
  const period = typeof ctx.query.period === "string" && ctx.query.period ? ctx.query.period : from || to ? "custom" : "month";
  if (!kinds.includes(period)) invalid({ period: `Use ${kinds.join(", ")}` });
  if (period === "custom") {
    if (!isDate(from)) invalid({ from: "Use YYYY-MM-DD" });
    if (!isDate(to) || to < from) invalid({ to: "Pick a date on or after from" });
    if (addDays(from, 365) < to) invalid({ to: "At most 366 days" });
    return { kind: "custom", start: from, end: to };
  }
  return periodRange(sc.db, sc.wsId, period === "today" ? "today" : period, date);
}

/** `userId` / `teamId` inside the code's scope (403 outside), else everyone the scope reaches. */
function audience(sc: SalesCtx, code: string): { people: string[]; teamId: string | null; userId: string | null } {
  const q = sc.ctx.query;
  const userId = typeof q.userId === "string" && q.userId ? q.userId : null;
  const teamId = typeof q.teamId === "string" && q.teamId ? q.teamId : null;
  const reach = scopePeople(sc, code);
  if (userId) {
    if (!activeMembers(sc.db, sc.wsId).includes(userId) || (reach && !reach.has(userId))) fail(403, "forbidden", "That person is outside your scope.", { permission: code });
    return { people: [userId], teamId: null, userId };
  }
  if (teamId) {
    if (!liveTeams(sc).some((t) => t.id === teamId) || !subjectInScope(sc, code, { type: "team", id: teamId })) fail(403, "forbidden", "That team is outside your scope.", { permission: code });
    return { people: teamMembers(sc, teamId), teamId, userId: null };
  }
  return { people: peopleFor(sc, code), teamId: null, userId: null };
}

function rankingRows(sc: SalesCtx, people: string[], r: Range): S["SalesRankingRow"][] {
  const rows = people
    .map((u) => {
      const set = new Set([u]);
      const target = rangeTarget(sc.db, sc.wsId, { type: "user", id: u }, r.start, r.end, r.kind);
      const actual = actualOf(sc.db, sc.wsId, set, r);
      const wonCount = wonIn(sc.db, sc.wsId, set, r).length;
      const sells = (wsPermissions(sc.db, u, sc.wsId) as string[]).includes("sales.opportunity.create");
      return { u, target, actual, wonCount, keep: sells || actual > 0 || target !== null };
    })
    .filter((x) => x.keep)
    .sort((a, b) => b.actual - a.actual || (sc.db.users.find((x) => x.id === a.u)?.name ?? "").localeCompare(sc.db.users.find((x) => x.id === b.u)?.name ?? ""));
  let rank = 0;
  let last = -1;
  return rows.map((x, i) => {
    if (x.actual !== last) rank = i + 1;
    last = x.actual;
    const { status } = statusFor(sc.db, sc.wsId, r, x.actual, x.target);
    return {
      rank,
      user: userBrief(sc.db, x.u)!,
      actual: money(x.actual),
      target: x.target === null ? null : money(x.target),
      achievement: x.target ? Math.round((x.actual / x.target) * 1000) / 10 : null,
      status,
      wonCount: x.wonCount,
    };
  });
}

/** Target for a dashboard: the team's own (teamId), the company's (an `all` caller without filters), else the people's. */
function audienceTarget(sc: SalesCtx, code: string, a: ReturnType<typeof audience>) {
  return (r: Range) => {
    if (a.teamId) {
      const t = rangeTarget(sc.db, sc.wsId, { type: "team", id: a.teamId }, r.start, r.end, r.kind);
      if (t !== null) return t;
    }
    if (!a.teamId && !a.userId && scopeOf(sc, code) === "all") {
      const t = rangeTarget(sc.db, sc.wsId, { type: "company", id: null }, r.start, r.end, r.kind);
      if (t !== null) return t;
    }
    return peopleTarget(sc.db, sc.wsId, a.people, r);
  };
}

export { audience, audienceTarget, periodParam, peopleFor, rankingRows, liveTeams, teamMembers };

export function registerSalesInsights() {
  /* ───── targets ───── */
  route("GET", "/sales/workspaces/:slug/targets", (ctx) => {
    const sc = wsCtx(ctx, "sales.target.view");
    const [st, sid_, pt, year] = ["subjectType", "subjectId", "periodType", "year"].map((k) => filterValues(ctx.query, k)[0]);
    if (year !== undefined && !/^\d{4}$/.test(year)) invalid({ "filter[year]": "Use a four-digit year" });
    const range = year ? { start: fiscalStart(sc, Number(year)), end: periodEnd("year", fiscalStart(sc, Number(year))) } : null;
    return sc.store.targets
      .filter(
        (t) =>
          t.workspaceId === sc.wsId &&
          subjectInScope(sc, "sales.target.view", { type: t.subjectType, id: t.subjectId }) &&
          (!st || t.subjectType === st) &&
          (!sid_ || t.subjectId === sid_) &&
          (!pt || t.periodType === pt) &&
          (!range || (t.periodStart >= range.start && t.periodStart <= range.end)),
      )
      .sort((a, b) => a.periodStart.localeCompare(b.periodStart) || a.periodType.localeCompare(b.periodType))
      .map(toTarget);
  });

  route("POST", "/sales/workspaces/:slug/targets", (ctx) => {
    const sc = wsCtx(ctx, "sales.target.manage");
    const b = bodyOf(ctx);
    const s = readSubject(sc, b.subjectType, b.subjectId);
    if (!subjectInScope(sc, "sales.target.manage", s)) fail(403, "forbidden", "That subject is outside your scope.", { permission: "sales.target.manage" });
    const f: Record<string, string> = {};
    const type = b.periodType as TargetRec["periodType"];
    if (!["year", "quarter", "month"].includes(type)) f.periodType = "Use year, quarter or month";
    else if (typeof b.periodStart !== "string" || !validStart(sc, type, b.periodStart)) f.periodStart = `Use the first day of a ${type === "month" ? "calendar month" : `fiscal ${type}`}`;
    const amount = Number(b.amount);
    if (b.amount === undefined || !Number.isFinite(amount) || amount < 0) f.amount = "Enter an amount of 0 or more";
    if (b.note !== undefined && (typeof b.note !== "string" || b.note.length > 500)) f.note = "At most 500 characters";
    flush(f);
    return toTarget(upsertTarget(sc, s, type, b.periodStart as string, amount, b.note as string | undefined).t);
  });

  route("GET", "/sales/targets/:id", (ctx) => {
    const [sc, t] = recCtx(ctx, (s) => s.targets, "sales.target.view", "Target not found.");
    if (!subjectInScope(sc, "sales.target.view", { type: t.subjectType, id: t.subjectId })) fail(404, "not_found", "Target not found.");
    return toTarget(t);
  });
  route("DELETE", "/sales/targets/:id", (ctx) => {
    const [sc, t] = recCtx(ctx, (s) => s.targets, "sales.target.manage", "Target not found.");
    const s = { type: t.subjectType, id: t.subjectId };
    if (!subjectInScope(sc, "sales.target.view", s)) fail(404, "not_found", "Target not found.");
    if (!subjectInScope(sc, "sales.target.manage", s)) fail(403, "forbidden", "That subject is outside your scope.", { permission: "sales.target.manage" });
    sc.store.targets.splice(sc.store.targets.indexOf(t), 1);
    salesAudit(sc, "sales.target.deleted", `${subjectName(sc, s)} ${t.periodType} ${t.periodStart}`);
  });

  route("GET", "/sales/workspaces/:slug/targets/allocation", (ctx) => {
    const sc = wsCtx(ctx, "sales.target.view");
    const raw = typeof ctx.query.subject === "string" && ctx.query.subject ? ctx.query.subject : scopeOf(sc, "sales.target.view") === "all" ? "company" : `user:${sc.userId}`;
    const [type, id] = raw.split(":");
    const s = readSubject(sc, type, id);
    if (!subjectInScope(sc, "sales.target.view", s)) fail(403, "forbidden", "That subject is outside your scope.", { permission: "sales.target.view" });
    const year = ctx.query.year ? Number(ctx.query.year) : Number(periodRange(sc.db, sc.wsId, "year", wsToday(sc.db, sc.wsId)).start.slice(0, 4));
    if (!Number.isInteger(year) || year < 2000 || year > 2100) invalid({ year: "Use a four-digit year" });
    const userNode = (u: string) => allocationNode(sc, { type: "user", id: u }, year, []);
    const teamNode = (t: string) => allocationNode(sc, { type: "team", id: t }, year, teamMembers(sc, t).map(userNode));
    if (s.type === "user") return userNode(s.id!);
    if (s.type === "team") return teamNode(s.id!);
    return allocationNode(sc, s, year, liveTeams(sc).map((t) => teamNode(t.id)) as unknown as S["SalesTargetAllocationUser"][]);
  });

  route("POST", "/sales/workspaces/:slug/targets/allocate", (ctx) => {
    const sc = wsCtx(ctx, "sales.target.manage");
    const b = bodyOf(ctx);
    const s = readSubject(sc, b.subjectType, b.subjectId);
    if (!subjectInScope(sc, "sales.target.manage", s)) fail(403, "forbidden", "That subject is outside your scope.", { permission: "sales.target.manage" });
    const year = Number(b.year);
    if (!Number.isInteger(year)) invalid({ year: "Use a four-digit year" });
    const method = b.method;
    if (!["equal", "working_days", "manual"].includes(method as string)) invalid({ method: "Use equal, working_days or manual" });
    const start = fiscalStart(sc, year);
    const y = sc.store.targets.find((t) => t.workspaceId === sc.wsId && t.subjectType === s.type && t.subjectId === s.id && t.periodType === "year" && t.periodStart === start);
    const qStarts = [0, 1, 2, 3].map((i) => addMonths(start, i * 3));
    const mStarts = Array.from({ length: 12 }, (_, i) => addMonths(start, i));
    if (method === "manual") {
      const f: Record<string, string> = {};
      const list = (key: "quarters" | "months", n: number) => {
        const v = b[key];
        if (v === undefined || v === null) return null;
        if (!Array.isArray(v) || v.length !== n || v.some((x) => !Number.isFinite(Number(x)) || Number(x) < 0)) {
          f[key] = `Send ${n} amounts of 0 or more`;
          return null;
        }
        return v.map(Number);
      };
      const qs = list("quarters", 4);
      const ms = list("months", 12);
      if (!qs && !ms && !f.quarters && !f.months) f.quarters = "Send quarters and/or months";
      flush(f);
      qs?.forEach((a, i) => upsertTarget(sc, s, "quarter", qStarts[i]!, a));
      ms?.forEach((a, i) => upsertTarget(sc, s, "month", mStarts[i]!, a));
    } else {
      if (!y) invalid({ year: "Set the year target first" });
      const monthWeights = mStarts.map((m) => (method === "equal" ? 1 : weightBetween(sc.db, sc.wsId, m, periodEnd("month", m))));
      const quarterWeights = [0, 1, 2, 3].map((i) => monthWeights.slice(i * 3, i * 3 + 3).reduce((a, c) => a + c, 0));
      const quarters = split(num(y.amount), quarterWeights);
      quarters.forEach((qa, i) => {
        upsertTarget(sc, s, "quarter", qStarts[i]!, qa);
        split(qa, monthWeights.slice(i * 3, i * 3 + 3)).forEach((ma, j) => upsertTarget(sc, s, "month", mStarts[i * 3 + j]!, ma));
      });
    }
    return yearNode(sc, s, year);
  });

  route("GET", "/sales/workspaces/:slug/targets/effective", (ctx) => {
    const sc = wsCtx(ctx, "sales.target.view");
    const userId = typeof ctx.query.userId === "string" && ctx.query.userId ? ctx.query.userId : sc.userId;
    if (!subjectInScope(sc, "sales.target.view", { type: "user", id: userId })) fail(404, "not_found", "Person not found.");
    const date = typeof ctx.query.date === "string" && ctx.query.date ? ctx.query.date : wsToday(sc.db, sc.wsId);
    if (!isDate(date)) invalid({ date: "Use YYYY-MM-DD" });
    return effectiveTargets(sc.db, sc.wsId, userId, date);
  });

  /* ───── performance ───── */
  route("GET", "/sales/workspaces/:slug/performance/users/:userId", (ctx) => {
    const sc = wsCtx(ctx, "sales.performance.view");
    const u = ctx.params.userId!;
    const reach = scopePeople(sc, "sales.performance.view");
    if (!activeMembers(sc.db, sc.wsId).includes(u) || (reach && !reach.has(u))) fail(404, "not_found", "Person not found.");
    const kind = typeof ctx.query.period === "string" && ctx.query.period ? ctx.query.period : "month";
    if (!["day", "week", "month", "quarter", "year"].includes(kind)) invalid({ period: "Use day, week, month, quarter or year" });
    const date = typeof ctx.query.date === "string" && ctx.query.date ? ctx.query.date : wsToday(sc.db, sc.wsId);
    if (!isDate(date)) invalid({ date: "Use YYYY-MM-DD" });
    const r = periodRange(sc.db, sc.wsId, kind, date);
    const pair = kpiPair(sc.db, sc.wsId, [u], r, (x) => rangeTarget(sc.db, sc.wsId, { type: "user", id: u }, x.start, x.end, x.kind));
    return { user: userBrief(sc.db, u)!, ...pair };
  });

  route("GET", "/sales/workspaces/:slug/performance/ranking", (ctx) => {
    const sc = wsCtx(ctx, "sales.performance.view");
    const kind = typeof ctx.query.period === "string" && ctx.query.period ? ctx.query.period : "month";
    if (!["day", "week", "month", "quarter", "year"].includes(kind)) invalid({ period: "Use day, week, month, quarter or year" });
    const date = typeof ctx.query.date === "string" && ctx.query.date ? ctx.query.date : wsToday(sc.db, sc.wsId);
    const r = periodRange(sc.db, sc.wsId, kind, date);
    let people = peopleFor(sc, "sales.performance.view");
    const teamId = typeof ctx.query.teamId === "string" && ctx.query.teamId ? ctx.query.teamId : null;
    if (teamId) {
      if (!liveTeams(sc).some((t) => t.id === teamId)) invalid({ teamId: "Unknown team" });
      const members = new Set(teamMembers(sc, teamId));
      people = people.filter((u) => members.has(u));
    }
    return { period: r, rows: rankingRows(sc, people, r) };
  });

  /* ───── daily reports ───── */
  route("GET", "/sales/workspaces/:slug/daily-reports/me/today", (ctx) => {
    const sc = wsCtx(ctx, "sales.dailyreport.submit");
    return toReport(sc, reportFor(sc, sc.userId, wsToday(sc.db, sc.wsId), true)!);
  });

  route("GET", "/sales/workspaces/:slug/daily-reports", (ctx) => {
    const sc = wsCtx(ctx, "sales.dailyreport.view");
    const reach = scopePeople(sc, "sales.dailyreport.view");
    const [date, from, to] = ["date", "dateFrom", "dateTo"].map((k) => filterValues(ctx.query, k)[0]);
    const users = filterValues(ctx.query, "user").map((v) => (v === "me" ? sc.userId : v));
    const teams = filterValues(ctx.query, "team");
    const statuses = filterValues(ctx.query, "status");
    const teamPeople = new Set(teams.flatMap((t) => teamMembers(sc, t)));
    const rows = sc.store.dailyReports.filter(
      (r) =>
        r.workspaceId === sc.wsId &&
        (r.userId === sc.userId || !reach || reach.has(r.userId)) &&
        (!date || r.reportDate === date) &&
        (!from || r.reportDate >= from) &&
        (!to || r.reportDate <= to) &&
        (!users.length || users.includes(r.userId)) &&
        (!teams.length || teamPeople.has(r.userId)) &&
        (!statuses.length || statuses.includes(r.status)),
    );
    rows.sort((a, b) => b.reportDate.localeCompare(a.reportDate) || a.id.localeCompare(b.id));
    const p = page(rows, ctx);
    return { data: p.data.map((r) => toReport(sc, r)), nextCursor: p.nextCursor };
  });

  route("GET", "/sales/workspaces/:slug/daily-reports/team", (ctx) => {
    const sc = wsCtx(ctx, "sales.dailyreport.view");
    const date = typeof ctx.query.date === "string" && ctx.query.date ? ctx.query.date : wsToday(sc.db, sc.wsId);
    if (!isDate(date)) invalid({ date: "Use YYYY-MM-DD" });
    let people = peopleFor(sc, "sales.dailyreport.view");
    const teamId = typeof ctx.query.teamId === "string" && ctx.query.teamId ? ctx.query.teamId : null;
    if (teamId) {
      const members = new Set(teamMembers(sc, teamId));
      people = people.filter((u) => members.has(u));
    }
    people = people.filter((u) => holdsSubmit(sc, u) || !!reportFor(sc, u, date, false));
    const required = reportRequired(sc, date);
    const users = people
      .map((u) => {
        const r = reportFor(sc, u, date, false);
        return {
          user: userRef(sc.db, u),
          reportId: r?.id ?? null,
          status: r?.status ?? ("missing" as const),
          isLate: r?.isLate ?? false,
          submittedAt: r?.submittedAt ?? null,
          comments: r ? [...r.comments] : [],
          tomorrowPlan: r ? r.tomorrowPlan.map((p) => ({ ...p })) : [],
          metrics: r?.snapshot ?? dailyMetrics(sc.db, sc.wsId, u, date),
        };
      })
      .sort((a, b) => a.user.name.localeCompare(b.user.name));
    const sum = (k: (typeof METRIC_KEYS)[number]) => users.reduce((a, x) => a + x.metrics[k], 0);
    const targets = users.map((x) => x.metrics.target).filter((t): t is string => t !== null);
    const target = targets.length ? targets.reduce((a, t) => a + num(t), 0) : null;
    const sales = users.reduce((a, x) => a + num(x.metrics.sales), 0);
    return {
      date,
      required,
      users,
      totals: {
        target: target === null ? null : money(target),
        sales: money(sales),
        achievement: target ? Math.round((sales / target) * 1000) / 10 : null,
        ...(Object.fromEntries(METRIC_KEYS.map((k) => [k, sum(k)])) as Record<(typeof METRIC_KEYS)[number], number>),
        people: users.length,
        submitted: users.filter((x) => x.status === "submitted").length,
        reviewed: users.filter((x) => x.status === "reviewed").length,
        drafts: users.filter((x) => x.status === "draft").length,
        missing: users.filter((x) => x.status === "missing").length,
        late: users.filter((x) => x.isLate).length,
      },
    };
  });

  route("GET", "/sales/daily-reports/:id", (ctx) => {
    const [sc, r] = reportRoute(ctx, "sales.dailyreport.view");
    return toReport(sc, r);
  });

  route("PUT", "/sales/daily-reports/:id", (ctx) => {
    const [sc, r] = reportRoute(ctx, "sales.dailyreport.submit");
    authorOnly(sc, r);
    if (r.status === "reviewed") fail(409, "report_reviewed", "This report has been reviewed.");
    const b = bodyOf(ctx);
    const f: Record<string, string> = {};
    if (b.comments !== undefined && (!Array.isArray(b.comments) || b.comments.some((c) => typeof c !== "string" || c.length > 2000) || b.comments.length > 50)) f.comments = "Send up to 50 comments";
    if (b.tomorrowPlan !== undefined && (!Array.isArray(b.tomorrowPlan) || b.tomorrowPlan.some((p) => !p || typeof (p as { text?: unknown }).text !== "string" || !(p as { text: string }).text.trim()))) {
      f.tomorrowPlan = "Each plan item needs text";
    }
    flush(f);
    if (b.comments !== undefined) r.comments = (b.comments as string[]).map((c) => c.trim()).filter(Boolean);
    if (b.tomorrowPlan !== undefined) {
      r.tomorrowPlan = (b.tomorrowPlan as S["SalesDailyPlanItem"][]).map((p) => ({ text: p.text.trim(), targetType: p.targetType ?? null, targetId: p.targetId ?? null }));
    }
    r.updatedAt = nowISO();
    salesAudit(sc, "sales.dailyreport.updated", r.reportDate);
    return toReport(sc, r);
  });

  route("POST", "/sales/daily-reports/:id/submit", (ctx) => {
    const [sc, r] = reportRoute(ctx, "sales.dailyreport.submit");
    authorOnly(sc, r);
    if (r.status !== "draft") fail(409, "report_submitted", "This report is already submitted.");
    const now = nowISO();
    Object.assign(r, { status: "submitted", snapshot: dailyMetrics(sc.db, sc.wsId, r.userId, r.reportDate), submittedAt: now, isLate: now > cutoffAt(sc, r.reportDate), updatedAt: now });
    salesAudit(sc, "sales.dailyreport.submitted", r.reportDate);
    return toReport(sc, r);
  });

  route("POST", "/sales/daily-reports/:id/review", (ctx) => {
    const [sc, r] = reportRoute(ctx, "sales.dailyreport.review");
    reviewer(sc, r);
    if (r.status !== "submitted") fail(409, "report_not_submitted", "Only submitted reports can be reviewed.");
    const comment = bodyOf(ctx).comment;
    if (comment !== undefined && (typeof comment !== "string" || comment.length > 2000)) invalid({ comment: "At most 2000 characters" });
    Object.assign(r, { status: "reviewed", reviewedById: sc.userId, reviewedAt: nowISO(), reviewComment: ((comment as string | undefined) ?? "").trim(), updatedAt: nowISO() });
    salesAudit(sc, "sales.dailyreport.reviewed", r.reportDate);
    return toReport(sc, r);
  });

  route("POST", "/sales/daily-reports/:id/reopen", (ctx) => {
    const [sc, r] = reportRoute(ctx, "sales.dailyreport.review");
    reviewer(sc, r);
    if (r.status === "draft") fail(409, "report_draft", "This report is still a draft.");
    Object.assign(r, { status: "draft", snapshot: null, submittedAt: null, isLate: false, reviewedById: null, reviewedAt: null, reviewComment: "", updatedAt: nowISO() });
    salesAudit(sc, "sales.dailyreport.reopened", r.reportDate);
    return toReport(sc, r);
  });

  /* ───── dashboard ───── */
  route("GET", "/sales/workspaces/:slug/dashboard", (ctx) => {
    const sc = wsCtx(ctx, "sales.dashboard.view");
    const r = periodParam(sc, false);
    const a = audience(sc, "sales.dashboard.view");
    const people = new Set(a.people);
    const pair = kpiPair(sc.db, sc.wsId, a.people, r, audienceTarget(sc, "sales.dashboard.view", a));
    const today = wsToday(sc.db, sc.wsId);
    const opps = liveOpps(sc).filter((o) => o.ownerId && people.has(o.ownerId));
    const open = opps.filter((o) => statusOf(sc.db, o) === "open");
    const leads = sc.store.leads.filter((l) => l.workspaceId === sc.wsId && !l.deletedAt && l.ownerId && people.has(l.ownerId) && ["new", "contacted", "qualified"].includes(l.status));
    const fus = sc.store.followUps.filter((f) => f.workspaceId === sc.wsId && f.ownerId && people.has(f.ownerId) && f.status === "pending");
    const counts = { overdue: 0, today: 0, upcoming: 0 };
    for (const f of fus) {
      const bk = bucketOf(sc.db, f);
      if (bk === "overdue" || bk === "today" || bk === "upcoming") counts[bk] += 1;
    }
    const ownerName = (id: string | null) => (id ? (sc.db.users.find((u) => u.id === id)?.name ?? null) : null);
    const oppItem = (o: (typeof open)[number]) => ({
      id: o.id,
      ownerId: o.ownerId,
      ownerName: ownerName(o.ownerId),
      title: o.title,
      companyName: sc.store.companies.find((c) => c.id === o.companyId)?.name ?? "",
      stageName: stageById(sc.db, o.stageId)?.name ?? "",
      expectedValue: o.expectedValue,
      expectedCloseDate: o.expectedCloseDate,
    });
    const list = <T, U>(xs: T[], map: (x: T) => U) => ({ count: xs.length, items: xs.slice(0, 10).map(map) });
    const week = periodRange(sc.db, sc.wsId, "week", today);
    const threshold = num(settingsOf(sc.db, sc.wsId).largeDealThreshold);
    const overdue = fus.filter((f) => f.dueDate < today).sort((x, y) => x.dueDate.localeCompare(y.dueDate));
    const sent = sc.store.quotations.filter((x) => x.workspaceId === sc.wsId && !x.deletedAt && x.status === "sent" && x.ownerId && people.has(x.ownerId));
    const flags = new Map(open.map((o) => [o.id, oppFlags(sc.db, o)]));
    const byValue = (x: (typeof open)[number], y: (typeof open)[number]) => num(y.expectedValue) - num(x.expectedValue);
    return {
      period: r,
      scope: scopeOf(sc, "sales.dashboard.view"),
      userCount: a.people.length,
      kpis: pair.current,
      previous: pair.previous,
      pipeline: {
        leads: { count: leads.length, value: money(leads.reduce((s, l) => s + num(l.estimatedValue), 0)) },
        stages: stagesOf(sc.db, sc.wsId)
          .filter((s) => s.category === "open")
          .map((s) => {
            const cards = open.filter((o) => o.stageId === s.id);
            return { stageId: s.id, name: s.name, count: cards.length, value: money(cards.reduce((t, o) => t + num(o.expectedValue), 0)), weightedValue: money(cards.reduce((t, o) => t + weightedOf(sc.db, o), 0)) };
          }),
      },
      ranking: rankingRows(sc, a.people, r),
      followUps: counts,
      attention: {
        overdueFollowUps: list(overdue, (f) => ({ id: f.id, ownerId: f.ownerId, ownerName: ownerName(f.ownerId), title: f.title, dueDate: f.dueDate, targetType: f.targetType, targetId: f.targetId })),
        quotationsAwaitingResponse: list(sent, (x) => {
          const o = sc.store.opportunities.find((y) => y.id === x.opportunityId);
          return { id: x.id, ownerId: x.ownerId, ownerName: ownerName(x.ownerId), number: x.number, title: x.title, amount: x.amount, sentAt: x.sentAt, validUntil: x.validUntil, opportunityId: x.opportunityId, companyName: sc.store.companies.find((c) => c.id === o?.companyId)?.name ?? "" };
        }),
        largeClosingThisWeek: list(
          open.filter((o) => num(o.expectedValue) >= threshold && !!o.expectedCloseDate && o.expectedCloseDate >= week.start && o.expectedCloseDate <= week.end).sort(byValue),
          oppItem,
        ),
        noNextStep: list(open.filter((o) => flags.get(o.id)!.noNextStep).sort(byValue), oppItem),
        stale: list(open.filter((o) => flags.get(o.id)!.stale).sort(byValue), oppItem),
      },
    } satisfies S["SalesDashboard"];
  });
}
