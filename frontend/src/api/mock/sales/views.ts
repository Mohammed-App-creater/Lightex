import type { MockDB } from "../db-types";
import { reaches, userBrief, type SalesCtx } from "./access";
import {
  addDays,
  money,
  num,
  nowISO,
  salesStore,
  sid,
  wsDate,
  wsToday,
  type ActivityRec,
  type CalendarRec,
  type CompanyRec,
  type ContactRec,
  type FollowUpRec,
  type LeadRec,
  type OpportunityRec,
  type QuotationRec,
  type SalesSchemas as S,
  type SettingsRec,
  type StageRec,
  type TargetType,
} from "./store";

/* Defaults (§4: created lazily, once per workspace) and the wire shapes of every sales record. */

export function settingsOf(db: MockDB, workspaceId: string): SettingsRec {
  const st = salesStore(db);
  let s = st.settings.find((x) => x.workspaceId === workspaceId);
  if (!s) {
    s = {
      workspaceId,
      weekStart: "monday",
      fiscalYearStartMonth: 1,
      statusGreenPct: 100,
      statusYellowPct: 70,
      upcomingDays: 7,
      staleDays: 14,
      largeDealThreshold: "1000000.00",
      dailyReportCutoff: "18:00",
      dailyReportRequired: true,
      quotationValidityDays: 30,
      calendarDisplay: "gregorian",
      updatedAt: null,
    };
    st.settings.push(s);
  }
  return s;
}

export function calendarOf(db: MockDB, workspaceId: string): CalendarRec {
  const st = salesStore(db);
  let c = st.calendars.find((x) => x.workspaceId === workspaceId);
  if (!c) {
    c = { workspaceId, weekdayWeights: [1, 1, 1, 1, 1, 0, 0], updatedAt: null };
    st.calendars.push(c);
  }
  return c;
}

/** Open stages in order, then Won, then Lost (defaults created on first read). */
export function stagesOf(db: MockDB, workspaceId: string): StageRec[] {
  const st = salesStore(db);
  if (!st.stages.some((s) => s.workspaceId === workspaceId)) {
    const mk = (name: string, order: number, category: StageRec["category"], p: number, isSystem: boolean) =>
      st.stages.push({ id: sid(), workspaceId, name, order, category, defaultProbability: p, isSystem });
    mk("Opportunity", 0, "open", 20, false);
    mk("Quotation", 1, "open", 40, false);
    mk("Negotiation", 2, "open", 70, false);
    mk("Won", 3, "won", 100, true);
    mk("Lost", 4, "lost", 0, true);
  }
  const rank = { open: 0, won: 1, lost: 2 } as const;
  return st.stages.filter((s) => s.workspaceId === workspaceId).sort((a, b) => rank[a.category] - rank[b.category] || a.order - b.order);
}
export const openStages = (db: MockDB, wsId: string) => stagesOf(db, wsId).filter((s) => s.category === "open");
export const stageById = (db: MockDB, id: string) => salesStore(db).stages.find((s) => s.id === id);

/** Renumbers `order` 0…n-1 (open stages first). */
export function renumberStages(db: MockDB, wsId: string) {
  stagesOf(db, wsId).forEach((s, i) => (s.order = i));
}

const named = (x: { id: string; name: string } | undefined | null) => (x ? { id: x.id, name: x.name } : null);

export function toSettings(s: SettingsRec): S["SalesSettings"] {
  const { workspaceId: _w, ...rest } = s;
  return rest;
}

/* ───────── customers ───────── */

export function companyLastActivity(db: MockDB, c: CompanyRec): string | null {
  const st = salesStore(db);
  let best: string | null = null;
  for (const a of st.activities) if (a.companyId === c.id && (!best || a.occurredAt > best)) best = a.occurredAt;
  for (const f of st.followUps) if (f.companyId === c.id && f.completedAt && (!best || f.completedAt > best)) best = f.completedAt;
  return best;
}

export function toCompany(sc: SalesCtx, c: CompanyRec): S["SalesCompany"] {
  const { workspaceId: _w, deletedAt: _d, ...rest } = c;
  return {
    ...rest,
    owner: userBrief(sc.db, c.ownerId),
    canEdit: reaches(sc, "sales.company.edit", c.ownerId),
    canDelete: reaches(sc, "sales.company.delete", c.ownerId),
    lastActivityAt: companyLastActivity(sc.db, c),
  };
}

export function toContact(sc: SalesCtx, c: ContactRec): S["SalesContact"] {
  const { workspaceId: _w, deletedAt: _d, ...rest } = c;
  const company = salesStore(sc.db).companies.find((x) => x.id === c.companyId);
  return {
    ...rest,
    company: { id: c.companyId, name: company?.name ?? "" },
    owner: userBrief(sc.db, c.ownerId),
    canEdit: reaches(sc, "sales.contact.edit", c.ownerId),
    canDelete: reaches(sc, "sales.contact.delete", c.ownerId),
  };
}

/* ───────── leads ───────── */

function lastActivityOn(db: MockDB, type: TargetType, id: string): string | null {
  const st = salesStore(db);
  let best: string | null = null;
  for (const a of st.activities) if (a.targetType === type && a.targetId === id && (!best || a.occurredAt > best)) best = a.occurredAt;
  for (const f of st.followUps) if (f.targetType === type && f.targetId === id && f.completedAt && (!best || f.completedAt > best)) best = f.completedAt;
  return best;
}

export function leadDisplayName(db: MockDB, l: LeadRec) {
  const company = l.companyId ? salesStore(db).companies.find((c) => c.id === l.companyId) : null;
  return company?.name || l.companyName || l.contactName;
}

export function toLead(sc: SalesCtx, l: LeadRec): S["SalesLead"] {
  const st = salesStore(sc.db);
  const { workspaceId: _w, deletedAt: _d, ...rest } = l;
  return {
    ...rest,
    displayName: leadDisplayName(sc.db, l),
    company: named(l.companyId ? st.companies.find((c) => c.id === l.companyId) : null),
    contact: named(l.contactId ? st.contacts.find((c) => c.id === l.contactId) : null),
    product: named(l.productId ? st.products.find((p) => p.id === l.productId) : null),
    owner: userBrief(sc.db, l.ownerId),
    canEdit: reaches(sc, "sales.lead.edit", l.ownerId),
    canDelete: reaches(sc, "sales.lead.delete", l.ownerId),
    lastActivityAt: lastActivityOn(sc.db, "sales.lead", l.id),
  };
}

/* ───────── opportunities ───────── */

export function probabilityOf(db: MockDB, o: OpportunityRec) {
  return o.probabilityOverride ?? stageById(db, o.stageId)?.defaultProbability ?? 0;
}
export const weightedOf = (db: MockDB, o: OpportunityRec) => num(o.expectedValue) * (probabilityOf(db, o) / 100);
export const statusOf = (db: MockDB, o: OpportunityRec) => stageById(db, o.stageId)?.category ?? "open";

const CONTACT_TYPES = new Set(["call", "visit", "meeting", "email"]);

export function oppFlags(db: MockDB, o: OpportunityRec) {
  const st = salesStore(db);
  const open = statusOf(db, o) === "open";
  const today = wsToday(db, o.workspaceId);
  const stale = settingsOf(db, o.workspaceId).staleDays;
  const last = lastActivityOn(db, "sales.opportunity", o.id) ?? o.createdAt;
  return {
    overdueClose: open && !!o.expectedCloseDate && o.expectedCloseDate < today,
    noNextStep: open && !st.followUps.some((f) => f.targetType === "sales.opportunity" && f.targetId === o.id && f.status === "pending"),
    stale: open && wsDate(db, o.workspaceId, last) < addDays(today, -stale),
  };
}

export function toOpportunity(sc: SalesCtx, o: OpportunityRec): S["SalesOpportunity"] {
  const st = salesStore(sc.db);
  const { workspaceId: _w, deletedAt: _d, ...rest } = o;
  const stage = stageById(sc.db, o.stageId);
  const company = st.companies.find((c) => c.id === o.companyId);
  let lastContactAt: string | null = null;
  for (const a of st.activities) {
    if (!CONTACT_TYPES.has(a.type)) continue;
    const on = (a.targetType === "sales.opportunity" && a.targetId === o.id) || (a.companyId === o.companyId && a.targetType === "sales.company");
    if (on && (!lastContactAt || a.occurredAt > lastContactAt)) lastContactAt = a.occurredAt;
  }
  return {
    ...rest,
    status: stage?.category ?? "open",
    company: { id: o.companyId, name: company?.name ?? "" },
    contact: named(o.contactId ? st.contacts.find((c) => c.id === o.contactId) : null),
    product: named(o.productId ? st.products.find((p) => p.id === o.productId) : null),
    stage: { id: o.stageId, name: stage?.name ?? "", category: stage?.category ?? "open" },
    probability: probabilityOf(sc.db, o),
    weightedValue: money(weightedOf(sc.db, o)),
    creditedUser: userBrief(sc.db, o.creditedUserId),
    lostReason: named(o.lostReasonId ? st.lostReasons.find((r) => r.id === o.lostReasonId) : null),
    lastActivityAt: lastActivityOn(sc.db, "sales.opportunity", o.id),
    lastContactAt,
    flags: oppFlags(sc.db, o),
    owner: userBrief(sc.db, o.ownerId),
    canEdit: reaches(sc, "sales.opportunity.edit", o.ownerId),
    canDelete: reaches(sc, "sales.opportunity.delete", o.ownerId),
    canMove: reaches(sc, "sales.opportunity.move", o.ownerId),
    canClose: reaches(sc, "sales.opportunity.close", o.ownerId),
  };
}

/* ───────── quotations ───────── */

export function toQuotation(sc: SalesCtx, x: QuotationRec): S["SalesQuotation"] {
  const st = salesStore(sc.db);
  const { workspaceId: _w, deletedAt: _d, ...rest } = x;
  const o = st.opportunities.find((y) => y.id === x.opportunityId);
  const company = o && st.companies.find((c) => c.id === o.companyId);
  return {
    ...rest,
    opportunity: { id: x.opportunityId, title: o?.title ?? "", companyId: o?.companyId ?? "", companyName: company?.name ?? "" },
    owner: userBrief(sc.db, x.ownerId),
    canEdit: reaches(sc, "sales.quotation.edit", x.ownerId),
    canDelete: reaches(sc, "sales.quotation.delete", x.ownerId),
  };
}

/* ───────── activities and follow-ups ───────── */

export function targetRecord(db: MockDB, type: TargetType, id: string) {
  const st = salesStore(db);
  switch (type) {
    case "sales.company":
      return st.companies.find((r) => r.id === id);
    case "sales.contact":
      return st.contacts.find((r) => r.id === id);
    case "sales.lead":
      return st.leads.find((r) => r.id === id);
    case "sales.opportunity":
      return st.opportunities.find((r) => r.id === id);
  }
}

export function targetName(db: MockDB, type: TargetType, id: string): string {
  const r = targetRecord(db, type, id);
  if (!r) return "";
  if (type === "sales.lead") return leadDisplayName(db, r as LeadRec);
  if (type === "sales.opportunity") return (r as OpportunityRec).title;
  return (r as CompanyRec | ContactRec).name;
}

/** The company a target belongs to (null for a lead without one). */
export function targetCompanyId(db: MockDB, type: TargetType, id: string): string | null {
  const r = targetRecord(db, type, id);
  if (!r) return null;
  if (type === "sales.company") return r.id;
  return (r as ContactRec | LeadRec | OpportunityRec).companyId ?? null;
}

const companyBrief = (db: MockDB, id: string | null) => named(id ? salesStore(db).companies.find((c) => c.id === id) : null);

export function toActivity(sc: SalesCtx, a: ActivityRec): S["SalesActivity"] {
  const { workspaceId: _w, ...rest } = a;
  return {
    ...rest,
    target: { type: a.targetType, id: a.targetId, name: targetName(sc.db, a.targetType, a.targetId) },
    company: companyBrief(sc.db, a.companyId),
    owner: userBrief(sc.db, a.ownerId),
    canEdit: a.type !== "quotation" && reaches(sc, "sales.activity.edit", a.ownerId),
    canDelete: reaches(sc, "sales.activity.delete", a.ownerId),
  };
}

export function bucketOf(db: MockDB, f: FollowUpRec): S["SalesFollowUp"]["bucket"] {
  if (f.status !== "pending") return null;
  const today = wsToday(db, f.workspaceId);
  if (f.dueDate < today) return "overdue";
  if (f.dueDate === today) return "today";
  return f.dueDate <= addDays(today, settingsOf(db, f.workspaceId).upcomingDays) ? "upcoming" : "later";
}

export function toFollowUp(sc: SalesCtx, f: FollowUpRec): S["SalesFollowUp"] {
  const { workspaceId: _w, ...rest } = f;
  return {
    ...rest,
    bucket: bucketOf(sc.db, f),
    target: { type: f.targetType, id: f.targetId, name: targetName(sc.db, f.targetType, f.targetId) },
    company: companyBrief(sc.db, f.companyId),
    createdBy: userBrief(sc.db, f.createdById),
    owner: userBrief(sc.db, f.ownerId),
    canEdit: reaches(sc, "sales.followup.edit", f.ownerId),
    canDelete: reaches(sc, "sales.followup.delete", f.ownerId),
    canComplete: reaches(sc, "sales.followup.complete", f.ownerId),
    canReassign: reaches(sc, "sales.followup.reassign", f.ownerId),
  };
}

/* ───────── timelines ───────── */

type Item = S["SalesTimelineItem"];
const blank = { stageChange: null, quotation: null, activity: null, followUp: null };

export function activityItem(db: MockDB, a: ActivityRec): Item {
  const st = salesStore(db);
  const q = a.quotationId ? st.quotations.find((x) => x.id === a.quotationId) : null;
  return {
    ...blank,
    id: `activity:${a.id}`,
    kind: "activity_logged",
    at: a.occurredAt,
    actor: userBrief(db, a.ownerId),
    summary: a.summary || `${a.type[0]!.toUpperCase()}${a.type.slice(1)} logged`,
    activity: { id: a.id, type: a.type, occurredAt: a.occurredAt, durationMinutes: a.durationMinutes, summary: a.summary, outcome: a.outcome, targetType: a.targetType, targetId: a.targetId, ownerId: a.ownerId },
    quotation: q ? { id: q.id, number: q.number, title: q.title, amount: q.amount, status: q.status } : null,
  };
}

export function followUpItems(db: MockDB, f: FollowUpRec): Item[] {
  const fu = { id: f.id, title: f.title, dueDate: f.dueDate, status: f.status, targetType: f.targetType, targetId: f.targetId, ownerId: f.ownerId };
  const out: Item[] = [{ ...blank, id: `followup:${f.id}:scheduled`, kind: "followup_scheduled", at: f.createdAt, actor: userBrief(db, f.createdById), summary: `Follow-up scheduled: ${f.title}`, followUp: fu }];
  if (f.completedAt) out.push({ ...blank, id: `followup:${f.id}:completed`, kind: "followup_completed", at: f.completedAt, actor: userBrief(db, f.ownerId), summary: `Follow-up done: ${f.title}`, followUp: fu });
  if (f.cancelledAt) out.push({ ...blank, id: `followup:${f.id}:cancelled`, kind: "followup_cancelled", at: f.cancelledAt, actor: userBrief(db, f.ownerId), summary: `Follow-up cancelled: ${f.title}`, followUp: fu });
  return out;
}

export function opportunityTimeline(db: MockDB, o: OpportunityRec): Item[] {
  const st = salesStore(db);
  const items: Item[] = [];
  for (const h of st.stageHistory.filter((x) => x.opportunityId === o.id)) {
    const summary =
      h.kind === "stage_created" ? `Created in ${h.toStage}` : h.kind === "stage_won" ? "Marked won" : h.kind === "stage_lost" ? "Marked lost" : h.kind === "stage_reopened" ? `Reopened to ${h.toStage}` : `Moved from ${h.fromStage} to ${h.toStage}`;
    items.push({ ...blank, id: h.id, kind: h.kind, at: h.at, actor: userBrief(db, h.actorId), summary, stageChange: { fromStageId: h.fromStageId, fromStage: h.fromStage, toStageId: h.toStageId, toStage: h.toStage } });
  }
  for (const q of st.quotations.filter((x) => x.opportunityId === o.id && !x.deletedAt)) {
    const quotation = { id: q.id, number: q.number, title: q.title, amount: q.amount, status: q.status };
    const push = (kind: Item["kind"], at: string | null, actor: string | null, verb: string) => {
      if (at) items.push({ ...blank, id: `${q.id}:${kind.replace("quotation_", "")}`, kind, at, actor: userBrief(db, actor), summary: `${q.number} ${verb}`, quotation });
    };
    push("quotation_created", q.createdAt, q.ownerId, "created");
    push("quotation_sent", q.sentAt, q.ownerId, "sent");
    if (q.status === "accepted") push("quotation_accepted", q.respondedAt, q.ownerId, "accepted");
    if (q.status === "rejected") push("quotation_rejected", q.respondedAt, q.ownerId, "rejected");
    push("quotation_expired", q.expiredAt, null, "expired");
  }
  for (const a of st.activities) if (a.targetType === "sales.opportunity" && a.targetId === o.id && a.type !== "quotation") items.push(activityItem(db, a));
  for (const f of st.followUps) if (f.targetType === "sales.opportunity" && f.targetId === o.id) items.push(...followUpItems(db, f));
  return sortTimeline(items);
}

export function companyTimeline(db: MockDB, c: CompanyRec): Item[] {
  const st = salesStore(db);
  const items: Item[] = [];
  for (const a of st.activities) if (a.companyId === c.id) items.push(activityItem(db, a));
  for (const f of st.followUps) if (f.companyId === c.id) items.push(...followUpItems(db, f));
  return sortTimeline(items);
}

const sortTimeline = (items: Item[]) => items.sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));

export const touch = <T extends { updatedAt: string }>(r: T) => {
  r.updatedAt = nowISO();
  return r;
};
