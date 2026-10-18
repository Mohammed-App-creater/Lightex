import { fail, invalid, route } from "../router";
import { need, wsCtx, type SalesCtx } from "./access";
import { audience, audienceTarget, liveTeams, periodParam, rankingRows, teamMembers } from "./handlers-insights";
import { liveOpps } from "./handlers-pipeline";
import { dailyMetrics, kpiBlock, kpiPair, rangeTarget, statusFor, type Range } from "./kpi";
import { addDays, addMonths, money, num, pct, wsDate, type OpportunityRec, type SalesSchemas as S } from "./store";
import { oppFlags, stagesOf, statusOf, weightedOf } from "./views";

/* §22 reports: the 18-report catalogue, JSON rows and CSV. Values come from the mock KPI helper. */

type ColType = S["SalesReportColumnTypeEnum"];
type Col = [string, string, ColType];
type Row = Record<string, unknown>;
type Build = (sc: SalesCtx, people: string[], r: Range, targetOf: (r: Range) => number | null) => Row[];

const USER: Col[] = [["userId", "User id", "text"], ["userName", "Salesperson", "text"]];
const ACHIEVE: Col[] = [["target", "Target", "money"], ["actual", "Actual", "money"], ["achievement", "Achievement %", "pct"], ["status", "Status", "text"]];
const GROUPED: Col[] = [
  ["wonCount", "Won", "int"],
  ["wonValue", "Won value", "money"],
  ["lostCount", "Lost", "int"],
  ["winRate", "Conversion rate %", "pct"],
  ["openCount", "Open", "int"],
  ["openValue", "Open value", "money"],
];

const days = (r: Range) => {
  const out: string[] = [];
  for (let d = r.start; d <= r.end && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out;
};
const months = (r: Range) => {
  const out: Range[] = [];
  for (let m = `${r.start.slice(0, 7)}-01`; m <= r.end; m = addMonths(m, 1)) {
    const end = addDays(addMonths(m, 1), -1);
    out.push({ kind: "month", start: m < r.start ? r.start : m, end: end > r.end ? r.end : end });
  }
  return out;
};
const userName = (sc: SalesCtx, id: string) => sc.db.users.find((u) => u.id === id)?.name ?? "";
const userTarget = (sc: SalesCtx, u: string) => (r: Range) => rangeTarget(sc.db, sc.wsId, { type: "user", id: u }, r.start, r.end, r.kind);

const byUser: Build = (sc, people, r) =>
  people
    .map((u) => {
      const k = kpiPair(sc.db, sc.wsId, [u], r, userTarget(sc, u)).current;
      return { userId: u, userName: userName(sc, u), ...k };
    })
    .sort((a, b) => a.userName.localeCompare(b.userName));

const ranking: Build = (sc, people, r) => rankingRows(sc, people, r).map((x) => ({ ...x, userId: x.user.id, userName: x.user.name }));

const grouped = (sc: SalesCtx, opps: OpportunityRec[], r: Range) => {
  const inR = (iso: string | null) => !!iso && wsDate(sc.db, sc.wsId, iso) >= r.start && wsDate(sc.db, sc.wsId, iso) <= r.end;
  const won = opps.filter((o) => inR(o.wonAt));
  const lost = opps.filter((o) => inR(o.lostAt));
  const open = opps.filter((o) => statusOf(sc.db, o) === "open");
  return {
    wonCount: won.length,
    wonValue: money(won.reduce((s, o) => s + num(o.wonValue), 0)),
    lostCount: lost.length,
    winRate: pct(won.length, won.length + lost.length),
    openCount: open.length,
    openValue: money(open.reduce((s, o) => s + num(o.expectedValue), 0)),
  };
};

const scopedOpps = (sc: SalesCtx, people: string[]) => {
  const set = new Set(people);
  return liveOpps(sc).filter((o) => (o.ownerId && set.has(o.ownerId)) || (o.creditedUserId && set.has(o.creditedUserId)));
};

const sumMetrics = (sc: SalesCtx, people: string[], d: string) => {
  const ms = people.map((u) => dailyMetrics(sc.db, sc.wsId, u, d));
  const add = (k: keyof S["SalesDailyMetrics"]) => ms.reduce((s, m) => s + Number(m[k] ?? 0), 0);
  return { ms, add };
};

const REPORTS: { key: string; title: string; description: string; columns: Col[]; build: Build; defaultPeriod?: S["SalesReportPeriodEnum"] }[] = [
  {
    key: "daily-sales",
    title: "Daily sales",
    description: "Won deals and value per day against the day targets.",
    columns: [["date", "Date", "date"], ["wonCount", "Won", "int"], ["actual", "Actual", "money"], ["target", "Target", "money"], ["achievement", "Achievement %", "pct"]],
    build: (sc, people, r, targetOf) =>
      days(r).map((d) => {
        const { add } = sumMetrics(sc, people, d);
        const target = targetOf({ kind: "day", start: d, end: d });
        const actual = add("sales");
        return { date: d, wonCount: add("dealsWon"), actual: money(actual), target: target === null ? null : money(target), achievement: target ? pct(actual, target) : null };
      }),
  },
  {
    key: "daily-activity",
    title: "Daily activity",
    description: "Calls, visits, meetings, emails, quotations sent, follow-ups completed, new leads and opportunities per day.",
    columns: [
      ["date", "Date", "date"],
      ["calls", "Calls", "int"],
      ["visits", "Visits", "int"],
      ["meetings", "Meetings", "int"],
      ["emails", "Emails", "int"],
      ["otherActivities", "Other activities", "int"],
      ["quotationsSent", "Quotations sent", "int"],
      ["followUpsCompleted", "Follow-ups completed", "int"],
      ["newLeads", "New leads", "int"],
      ["newOpportunities", "New opportunities", "int"],
    ],
    defaultPeriod: "today",
    build: (sc, people, r) => {
      const set = new Set(people);
      return days(r).map((d) => {
        const { add } = sumMetrics(sc, people, d);
        const acts = sc.store.activities.filter((a) => a.workspaceId === sc.wsId && a.ownerId && set.has(a.ownerId) && wsDate(sc.db, sc.wsId, a.occurredAt) === d);
        return {
          date: d,
          calls: add("calls"),
          visits: add("visits"),
          meetings: add("meetings"),
          emails: acts.filter((a) => a.type === "email").length,
          otherActivities: acts.filter((a) => a.type === "note" || a.type === "other").length,
          quotationsSent: add("quotationsSent"),
          followUpsCompleted: add("followUpsCompleted"),
          newLeads: add("newLeads"),
          newOpportunities: add("newOpportunities"),
        };
      });
    },
  },
  { key: "target-achievement", title: "Target achievement", description: "Each salesperson's target, actual sales, achievement and status color.", columns: [["rank", "Rank", "int"], ...USER, ...ACHIEVE], build: ranking },
  {
    key: "salesperson-performance",
    title: "Salesperson performance",
    description: "Every KPI per salesperson.",
    columns: [
      ...USER,
      ...ACHIEVE,
      ["wonCount", "Won", "int"],
      ["lostCount", "Lost", "int"],
      ["winRate", "Conversion rate %", "pct"],
      ["averageDealSize", "Average deal size", "money"],
      ["newLeads", "New leads", "int"],
      ["newOpportunities", "New opportunities", "int"],
      ["pipelineValue", "Pipeline value", "money"],
      ["followUpPerformance", "Follow-up performance %", "pct"],
      ["growth", "Growth %", "pct"],
    ],
    build: byUser,
  },
  {
    key: "pipeline-movement",
    title: "Pipeline movement",
    description: "Opportunities entering and leaving each stage in the period.",
    columns: [["stageName", "Stage", "text"], ["category", "Category", "text"], ["entered", "Entered", "int"], ["enteredValue", "Entered value", "money"], ["left", "Left", "int"]],
    build: (sc, people, r) => {
      const ids = new Set(scopedOpps(sc, people).map((o) => o.id));
      const hist = sc.store.stageHistory.filter((h) => ids.has(h.opportunityId) && wsDate(sc.db, sc.wsId, h.at) >= r.start && wsDate(sc.db, sc.wsId, h.at) <= r.end);
      return stagesOf(sc.db, sc.wsId).map((s) => {
        const entered = hist.filter((h) => h.toStageId === s.id);
        return {
          stageName: s.name,
          category: s.category,
          entered: entered.length,
          enteredValue: money(entered.reduce((t, h) => t + num(sc.store.opportunities.find((o) => o.id === h.opportunityId)?.expectedValue), 0)),
          left: hist.filter((h) => h.fromStageId === s.id).length,
        };
      });
    },
  },
  {
    key: "new-leads",
    title: "New leads",
    description: "Leads created in the period by source, with where they are now.",
    columns: [
      ["source", "Source", "text"],
      ["newLeads", "New leads", "int"],
      ["open", "Open", "int"],
      ["converted", "Converted", "int"],
      ["disqualified", "Disqualified", "int"],
      ["conversionRate", "Conversion %", "pct"],
      ["estimatedValue", "Estimated value", "money"],
    ],
    build: (sc, people, r) => {
      const set = new Set(people);
      const leads = sc.store.leads.filter((l) => l.workspaceId === sc.wsId && !l.deletedAt && l.ownerId && set.has(l.ownerId) && wsDate(sc.db, sc.wsId, l.createdAt) >= r.start && wsDate(sc.db, sc.wsId, l.createdAt) <= r.end);
      return ["referral", "website", "call", "event", "visit", "social", "other"]
        .map((source) => {
          const xs = leads.filter((l) => l.source === source);
          const converted = xs.filter((l) => l.status === "converted").length;
          return {
            source,
            newLeads: xs.length,
            open: xs.filter((l) => ["new", "contacted", "qualified"].includes(l.status)).length,
            converted,
            disqualified: xs.filter((l) => l.status === "disqualified").length,
            conversionRate: pct(converted, xs.length),
            estimatedValue: money(xs.reduce((s, l) => s + num(l.estimatedValue), 0)),
          };
        })
        .filter((x) => x.newLeads > 0);
    },
  },
  {
    key: "conversion",
    title: "Conversion",
    description: "Lead-to-opportunity and win rates per salesperson.",
    columns: [
      ...USER,
      ["newLeads", "New leads", "int"],
      ["convertedLeads", "Converted leads", "int"],
      ["leadToOpportunityRate", "Lead-to-opportunity %", "pct"],
      ["newOpportunities", "New opportunities", "int"],
      ["wonCount", "Won", "int"],
      ["lostCount", "Lost", "int"],
      ["winRate", "Conversion rate %", "pct"],
    ],
    build: byUser,
  },
  {
    key: "followup-performance",
    title: "Follow-up performance",
    description: "Follow-ups due in the period and how many were completed on time, per salesperson.",
    columns: [...USER, ["followUpsDue", "Due", "int"], ["followUpsOnTime", "On time", "int"], ["followUpPerformance", "On time %", "pct"]],
    build: byUser,
  },
  {
    key: "sales-performance",
    title: "Sales performance",
    description: "The KPIs of everyone in scope against the previous equal period.",
    columns: [["metric", "Metric", "text"], ["current", "Current", "text"], ["previous", "Previous", "text"], ["change", "Change %", "pct"]],
    build: (sc, people, r, targetOf) => {
      const { current, previous } = kpiPair(sc.db, sc.wsId, people, r, targetOf);
      const metrics: [string, keyof S["SalesKpis"]][] = [
        ["Actual sales", "actual"],
        ["Target", "target"],
        ["Achievement %", "achievement"],
        ["Won deals", "wonCount"],
        ["Lost deals", "lostCount"],
        ["Conversion rate %", "winRate"],
        ["Average deal size", "averageDealSize"],
        ["New leads", "newLeads"],
        ["New opportunities", "newOpportunities"],
        ["Pipeline value", "pipelineValue"],
        ["Weighted pipeline", "weightedPipeline"],
        ["Follow-up performance %", "followUpPerformance"],
      ];
      return metrics.map(([metric, k]) => {
        const c = current[k] as string | number | null;
        const p = previous[k] as string | number | null;
        const cn = c === null ? null : Number(c);
        const pn = p === null ? null : Number(p);
        return { metric, current: c === null ? null : String(c), previous: p === null ? null : String(p), change: cn !== null && pn ? pct(cn - pn, pn) : null };
      });
    },
  },
  {
    key: "target-vs-actual",
    title: "Target vs actual",
    description: "Target and actual per day (periods up to 31 days) or per month.",
    columns: [["start", "From", "date"], ["end", "To", "date"], ["target", "Target", "money"], ["actual", "Actual", "money"], ["achievement", "Achievement %", "pct"], ["variance", "Variance", "money"]],
    build: (sc, people, r, targetOf) => {
      const parts = days(r).length <= 31 ? days(r).map((d) => ({ kind: "day", start: d, end: d })) : months(r);
      return parts.map((p) => {
        const k = kpiBlock(sc.db, sc.wsId, people, p, targetOf(p), null);
        const actual = num(k.actual);
        return { start: p.start, end: p.end, target: k.target, actual: k.actual, achievement: k.achievement, variance: k.target === null ? null : money(actual - num(k.target)) };
      });
    },
  },
  { key: "ranking", title: "Ranking", description: "Salespeople ranked by actual sales.", columns: [["rank", "Rank", "int"], ...USER, ["actual", "Actual", "money"], ["wonCount", "Won", "int"], ["achievement", "Achievement %", "pct"], ["status", "Status", "text"]], build: ranking },
  {
    key: "product-performance",
    title: "Product performance",
    description: "Won, lost and open deals per product.",
    columns: [["id", "Product id", "text"], ["name", "Product", "text"], ...GROUPED],
    build: (sc, people, r) => {
      const opps = scopedOpps(sc, people);
      return sc.store.products.filter((p) => p.workspaceId === sc.wsId).map((p) => ({ id: p.id, name: p.name, ...grouped(sc, opps.filter((o) => o.productId === p.id), r) }));
    },
  },
  {
    key: "customer-performance",
    title: "Customer performance",
    description: "Won, lost and open deals per company.",
    columns: [["id", "Company id", "text"], ["name", "Company", "text"], ...GROUPED],
    build: (sc, people, r) => {
      const opps = scopedOpps(sc, people);
      const ids = [...new Set(opps.map((o) => o.companyId))];
      return ids
        .map((id) => ({ id, name: sc.store.companies.find((c) => c.id === id)?.name ?? "", ...grouped(sc, opps.filter((o) => o.companyId === id), r) }))
        .sort((a, b) => num(b.wonValue) - num(a.wonValue) || a.name.localeCompare(b.name));
    },
  },
  {
    key: "win-loss",
    title: "Win / loss",
    description: "Deals closed in the period: won, and lost by reason.",
    columns: [["outcome", "Outcome", "text"], ["reason", "Lost reason", "text"], ["count", "Deals", "int"], ["value", "Value", "money"], ["share", "Share %", "pct"]],
    build: (sc, people, r) => {
      const opps = scopedOpps(sc, people);
      const inR = (iso: string | null) => !!iso && wsDate(sc.db, sc.wsId, iso) >= r.start && wsDate(sc.db, sc.wsId, iso) <= r.end;
      const won = opps.filter((o) => inR(o.wonAt));
      const lost = opps.filter((o) => inR(o.lostAt));
      const total = won.length + lost.length;
      const rows: Row[] = [{ outcome: "won", reason: null, count: won.length, value: money(won.reduce((s, o) => s + num(o.wonValue), 0)), share: pct(won.length, total) }];
      for (const reason of sc.store.lostReasons.filter((x) => x.workspaceId === sc.wsId)) {
        const xs = lost.filter((o) => o.lostReasonId === reason.id);
        if (xs.length) rows.push({ outcome: "lost", reason: reason.name, count: xs.length, value: money(xs.reduce((s, o) => s + num(o.expectedValue), 0)), share: pct(xs.length, total) });
      }
      return rows;
    },
  },
  {
    key: "revenue-forecast",
    title: "Revenue forecast",
    description: "Open pipeline and weighted pipeline by expected close month.",
    columns: [["month", "Month", "text"], ["count", "Opportunities", "int"], ["value", "Value", "money"], ["weightedValue", "Weighted value", "money"]],
    defaultPeriod: "quarter",
    build: (sc, people, r) => {
      const open = scopedOpps(sc, people).filter((o) => statusOf(sc.db, o) === "open" && o.expectedCloseDate && o.expectedCloseDate >= r.start && o.expectedCloseDate <= r.end);
      return months(r).map((m) => {
        const xs = open.filter((o) => o.expectedCloseDate!.slice(0, 7) === m.start.slice(0, 7));
        return { month: m.start.slice(0, 7), count: xs.length, value: money(xs.reduce((s, o) => s + num(o.expectedValue), 0)), weightedValue: money(xs.reduce((s, o) => s + weightedOf(sc.db, o), 0)) };
      });
    },
  },
  {
    key: "pipeline-analysis",
    title: "Pipeline analysis",
    description: "The open pipeline now by stage: size, weighted value, age and flags (the period is ignored).",
    columns: [
      ["stageName", "Stage", "text"],
      ["count", "Opportunities", "int"],
      ["value", "Value", "money"],
      ["weightedValue", "Weighted value", "money"],
      ["averageAgeDays", "Average age (days)", "int"],
      ["stale", "Stale", "int"],
      ["noNextStep", "No next step", "int"],
      ["overdueClose", "Overdue close", "int"],
    ],
    build: (sc, people) => {
      const open = scopedOpps(sc, people).filter((o) => statusOf(sc.db, o) === "open");
      const now = Date.now();
      return stagesOf(sc.db, sc.wsId)
        .filter((s) => s.category === "open")
        .map((s) => {
          const xs = open.filter((o) => o.stageId === s.id);
          const flags = xs.map((o) => oppFlags(sc.db, o));
          return {
            stageName: s.name,
            count: xs.length,
            value: money(xs.reduce((t, o) => t + num(o.expectedValue), 0)),
            weightedValue: money(xs.reduce((t, o) => t + weightedOf(sc.db, o), 0)),
            averageAgeDays: xs.length ? Math.round(xs.reduce((t, o) => t + (now - Date.parse(o.createdAt)) / 86_400_000, 0) / xs.length) : null,
            stale: flags.filter((f) => f.stale).length,
            noNextStep: flags.filter((f) => f.noNextStep).length,
            overdueClose: flags.filter((f) => f.overdueClose).length,
          };
        });
    },
  },
  {
    key: "team-performance",
    title: "Team performance",
    description: "Each visible team's target (its own, else its members'), actual and KPIs.",
    columns: [["teamId", "Team id", "text"], ["teamName", "Team", "text"], ["members", "Members", "int"], ...ACHIEVE, ["wonCount", "Won", "int"], ["winRate", "Conversion rate %", "pct"], ["newLeads", "New leads", "int"], ["pipelineValue", "Pipeline value", "money"]],
    build: (sc, people, r) => {
      const inScope = new Set(people);
      return liveTeams(sc)
        .map((t) => ({ t, members: teamMembers(sc, t.id).filter((u) => inScope.has(u)) }))
        .filter((x) => x.members.length)
        .map(({ t, members }) => {
          const own = rangeTarget(sc.db, sc.wsId, { type: "team", id: t.id }, r.start, r.end, r.kind);
          const target = own ?? members.reduce<number | null>((s, u) => {
            const x = userTarget(sc, u)(r);
            return x === null ? s : (s ?? 0) + x;
          }, null);
          const k = kpiBlock(sc.db, sc.wsId, members, r, target, null);
          return { teamId: t.id, teamName: t.name, members: members.length, target: k.target, actual: k.actual, achievement: k.achievement, status: k.status, wonCount: k.wonCount, winRate: k.winRate, newLeads: k.newLeads, pipelineValue: k.pipelineValue };
        });
    },
  },
  {
    key: "annual-summary",
    title: "Annual summary",
    description: "Month by month over the period (the fiscal year by default).",
    columns: [["month", "Month", "text"], ["start", "From", "date"], ["end", "To", "date"], ...ACHIEVE, ["wonCount", "Won", "int"], ["lostCount", "Lost", "int"], ["newLeads", "New leads", "int"], ["newOpportunities", "New opportunities", "int"]],
    defaultPeriod: "year",
    build: (sc, people, r, targetOf) =>
      months(r).map((m) => {
        const k = kpiBlock(sc.db, sc.wsId, people, m, targetOf(m), null);
        const { status } = statusFor(sc.db, sc.wsId, m, num(k.actual), k.target === null ? null : num(k.target));
        return { month: m.start.slice(0, 7), start: m.start, end: m.end, target: k.target, actual: k.actual, achievement: k.achievement, status, wonCount: k.wonCount, lostCount: k.lostCount, newLeads: k.newLeads, newOpportunities: k.newOpportunities };
      }),
  },
];

const PERIODS: S["SalesReportPeriodEnum"][] = ["today", "week", "month", "quarter", "year", "custom"];

/** One CSV cell: quoted, formula-safe. */
function cell(v: unknown) {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function registerSalesReports() {
  route("GET", "/sales/workspaces/:slug/reports", (ctx) => {
    wsCtx(ctx, "sales.report.view");
    return REPORTS.map((r) => ({
      key: r.key,
      title: r.title,
      description: r.description,
      defaultPeriod: r.defaultPeriod ?? "month",
      periods: [...PERIODS],
      columns: r.columns.map(([key, label, type]) => ({ key, label, type })),
    }));
  });

  route("GET", "/sales/workspaces/:slug/reports/:key", (ctx) => {
    const sc = wsCtx(ctx, "sales.report.view");
    const rep = REPORTS.find((r) => r.key === ctx.params.key);
    if (!rep) fail(404, "not_found", "Report not found.");
    const format = typeof ctx.query.format === "string" && ctx.query.format ? ctx.query.format : "json";
    if (format !== "json" && format !== "csv") invalid({ format: "Use json or csv" });
    if (format === "csv") need(sc, "sales.report.export");
    if (!ctx.query.period && !ctx.query.from && !ctx.query.to) ctx.query.period = rep.defaultPeriod ?? "month";
    const r = periodParam(sc, true);
    const a = audience(sc, "sales.report.view");
    const rows = rep.build(sc, a.people, r, audienceTarget(sc, "sales.report.view", a));
    const columns = rep.columns.map(([key, label, type]) => ({ key, label, type }));
    const out = rows.map((row) => Object.fromEntries(columns.map((c) => [c.key, row[c.key] ?? null])));
    if (format === "csv") {
      const lines = [columns.map((c) => cell(c.label)).join(","), ...out.map((row) => columns.map((c) => cell(row[c.key])).join(","))];
      return new Blob([`﻿${lines.join("\r\n")}\r\n`], { type: "text/csv; charset=utf-8" });
    }
    return { key: rep.key, title: rep.title, period: r, columns, rows: out } satisfies S["SalesReport"];
  });
}
