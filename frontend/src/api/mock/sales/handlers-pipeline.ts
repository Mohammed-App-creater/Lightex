import { fail, filterValues, invalid, route, type Ctx } from "../router";
import {
  bodyOf,
  checkOwner,
  contains,
  dateFilter,
  enumFilter,
  flush,
  moneyIn,
  mustReach,
  owned,
  ownerFilter,
  page,
  q,
  reaches,
  scopeOf,
  sortRows,
  text,
  wsCtx,
  type Body,
  type SalesCtx,
} from "./access";
import { createCompany, createContact, liveContacts, matchCompany, visibleCompany } from "./handlers-customers";
import { salesAudit } from "./handlers-reference";
import { addDays, isDate, money, nowISO, num, sid, wsDate, wsInstant, wsToday, type LeadRec, type OpportunityRec, type QuotationRec, type SalesStore } from "./store";
import {
  leadDisplayName,
  openStages,
  opportunityTimeline,
  settingsOf,
  stageById,
  stagesOf,
  statusOf,
  toCompany,
  toContact,
  toLead,
  toOpportunity,
  toQuotation,
  weightedOf,
} from "./views";

/* §9 leads, §10 opportunities and the pipeline, §11 quotations. */

const SOURCES = ["referral", "website", "call", "event", "visit", "social", "other"] as const;
const LEAD_STATUSES = ["new", "contacted", "qualified", "disqualified", "converted"] as const;
const QUOTE_STATUSES = ["draft", "sent", "accepted", "rejected", "expired"] as const;

const liveLeads = (sc: SalesCtx) => sc.store.leads.filter((l) => l.workspaceId === sc.wsId && !l.deletedAt);
export const liveOpps = (sc: SalesCtx) => sc.store.opportunities.filter((o) => o.workspaceId === sc.wsId && !o.deletedAt);
const oppLive = (sc: SalesCtx, id: string) => sc.store.opportunities.find((o) => o.id === id && !o.deletedAt);
/** Quotations of a deleted opportunity are hidden. */
const liveQuotes = (sc: SalesCtx) => sc.store.quotations.filter((x) => x.workspaceId === sc.wsId && !x.deletedAt && !!oppLive(sc, x.opportunityId));

function activeProduct(sc: SalesCtx, id: unknown, f: Record<string, string>) {
  if (id === undefined || id === null) return;
  if (!sc.store.products.some((p) => p.id === id && p.workspaceId === sc.wsId && p.isActive)) f.productId = "Pick an active product";
}

function visibleContactOf(sc: SalesCtx, id: unknown, companyId: string | null, f: Record<string, string>) {
  if (id === undefined || id === null) return;
  const c = liveContacts(sc).find((x) => x.id === id);
  if (!c || !reaches(sc, "sales.contact.view", c.ownerId) || (companyId && c.companyId !== companyId)) f.contactId = "Pick a contact you can see";
}

/* ───────── leads ───────── */

function leadFields(sc: SalesCtx, b: Body, lead: LeadRec | null) {
  const f: Record<string, string> = {};
  const v: Partial<LeadRec> = {};
  if (b.source !== undefined) {
    if (!SOURCES.includes(b.source as never)) f.source = "Pick a source";
    else v.source = b.source as LeadRec["source"];
  }
  if (b.status !== undefined) {
    if (b.status !== "new" && b.status !== "contacted") f.status = "Use new or contacted (the actions set the others)";
    else v.status = b.status;
  }
  for (const [k, max] of [["companyName", 200], ["contactName", 120], ["phone", 40], ["email", 254], ["notes", 5000]] as const) {
    const t = text(b, k, max, f);
    if (t !== undefined) v[k] = t;
  }
  if (b.companyId !== undefined) {
    if (b.companyId === null) v.companyId = null;
    else v.companyId = visibleCompany(sc, b.companyId).id;
    if (lead && v.companyId !== lead.companyId && b.contactId === undefined) v.contactId = null;
  }
  if (b.contactId !== undefined) {
    visibleContactOf(sc, b.contactId, v.companyId ?? lead?.companyId ?? null, f);
    v.contactId = (b.contactId as string | null) ?? null;
  }
  if (b.productId !== undefined) {
    activeProduct(sc, b.productId, f);
    v.productId = (b.productId as string | null) ?? null;
  }
  const ev = moneyIn(b, "estimatedValue", f, true);
  if (ev !== undefined) v.estimatedValue = ev;
  const merged = { companyId: lead?.companyId ?? null, companyName: lead?.companyName ?? "", contactName: lead?.contactName ?? "", ...v };
  if (!merged.companyId && !merged.companyName && !merged.contactName) f.companyName = "Name the company or the contact";
  flush(f);
  return v;
}

const leadRoute = (ctx: Ctx, perm: string) => owned(ctx, (s) => s.leads, "sales.lead.view", perm, "Lead not found.");
const notConverted = (l: LeadRec) => {
  if (l.status === "converted") fail(409, "lead_converted", "This lead is already converted.", { opportunityId: l.convertedOpportunityId });
};

/* ───────── opportunities ───────── */

function history(sc: SalesCtx, o: OpportunityRec, kind: SalesStore["stageHistory"][number]["kind"], fromId: string | null, toId: string | null) {
  sc.store.stageHistory.push({
    id: sid(),
    workspaceId: sc.wsId,
    opportunityId: o.id,
    kind,
    fromStageId: fromId,
    fromStage: fromId ? (stageById(sc.db, fromId)?.name ?? null) : null,
    toStageId: toId,
    toStage: toId ? (stageById(sc.db, toId)?.name ?? null) : null,
    actorId: sc.userId,
    at: nowISO(),
  });
}

export function createOpportunity(sc: SalesCtx, v: Partial<OpportunityRec> & { title: string; companyId: string }, ownerId: string): OpportunityRec {
  const now = nowISO();
  const o: OpportunityRec = {
    id: sid(),
    workspaceId: sc.wsId,
    title: v.title,
    companyId: v.companyId,
    contactId: v.contactId ?? null,
    productId: v.productId ?? null,
    stageId: v.stageId ?? openStages(sc.db, sc.wsId)[0]!.id,
    expectedValue: v.expectedValue ?? "0.00",
    probabilityOverride: v.probabilityOverride ?? null,
    expectedCloseDate: v.expectedCloseDate ?? null,
    nextAction: v.nextAction ?? "",
    sourceLeadId: v.sourceLeadId ?? null,
    creditedUserId: null,
    wonAt: null,
    wonValue: null,
    lostAt: null,
    lostReasonId: null,
    lostNote: "",
    version: 1,
    notes: v.notes ?? "",
    ownerId,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  sc.store.opportunities.push(o);
  history(sc, o, "stage_created", null, o.stageId);
  salesAudit(sc, "sales.opportunity.created", o.title);
  return o;
}

function oppFields(sc: SalesCtx, b: Body, o: OpportunityRec | null) {
  const f: Record<string, string> = {};
  const v: Partial<OpportunityRec> = {};
  const title = text(b, "title", 200, f);
  if (title !== undefined) v.title = title;
  if ((!o || title !== undefined) && !title) f.title = "Title is required";
  if (b.companyId !== undefined || !o) {
    if (b.companyId === undefined || b.companyId === null) f.companyId = "Pick a company";
    else v.companyId = visibleCompany(sc, b.companyId).id;
    if (o && v.companyId && v.companyId !== o.companyId && b.contactId === undefined) v.contactId = null;
  }
  if (b.contactId !== undefined) {
    visibleContactOf(sc, b.contactId, v.companyId ?? o?.companyId ?? null, f);
    v.contactId = (b.contactId as string | null) ?? null;
  }
  if (b.productId !== undefined) {
    activeProduct(sc, b.productId, f);
    v.productId = (b.productId as string | null) ?? null;
  }
  if (!o && b.stageId !== undefined) {
    if (!openStages(sc.db, sc.wsId).some((s) => s.id === b.stageId)) f.stageId = "Pick an open stage";
    else v.stageId = b.stageId as string;
  }
  const ev = moneyIn(b, "expectedValue", f);
  if (ev) v.expectedValue = ev;
  if (b.probabilityOverride !== undefined) {
    const p = b.probabilityOverride;
    if (p !== null && (typeof p !== "number" || !Number.isInteger(p) || p < 0 || p > 100)) f.probabilityOverride = "Use 0–100";
    else v.probabilityOverride = p as number | null;
  }
  if (b.expectedCloseDate !== undefined) {
    if (b.expectedCloseDate !== null && !isDate(b.expectedCloseDate)) f.expectedCloseDate = "Use YYYY-MM-DD";
    else v.expectedCloseDate = b.expectedCloseDate as string | null;
  }
  const na = text(b, "nextAction", 300, f);
  if (na !== undefined) v.nextAction = na;
  const notes = text(b, "notes", 5000, f);
  if (notes !== undefined) v.notes = notes;
  flush(f);
  return v;
}

const oppRoute = (ctx: Ctx, perm: string) => owned(ctx, (s) => s.opportunities, "sales.opportunity.view", perm, "Opportunity not found.");

function checkVersion(sc: SalesCtx, o: OpportunityRec, version: unknown, required = false) {
  if (version === undefined || version === null) {
    if (required) invalid({ version: "Send the version you edited" });
    return;
  }
  if (version !== o.version) fail(409, "version_conflict", "Someone else changed this opportunity.", { current: toOpportunity(sc, o) });
}

const mustBeOpen = (sc: SalesCtx, o: OpportunityRec) => {
  const status = statusOf(sc.db, o);
  if (status !== "open") fail(409, "opportunity_closed", "This opportunity is already closed.", { status });
};

/** Changing the owner moves the quotations along; credit never changes. */
function reassign(sc: SalesCtx, o: OpportunityRec, to: string) {
  o.ownerId = to;
  for (const x of sc.store.quotations) if (x.opportunityId === o.id) x.ownerId = to;
}

function bulkAssign(ctx: Ctx, kind: "lead" | "opportunity") {
  const code = `sales.${kind}.assign`;
  const sc = wsCtx(ctx, code);
  const b = bodyOf(ctx);
  const key = kind === "lead" ? "leadIds" : "opportunityIds";
  const ids = b[key];
  if (!Array.isArray(ids) || !ids.length || ids.length > 200) invalid({ [key]: "Send 1–200 ids" });
  const rows = (kind === "lead" ? liveLeads(sc) : liveOpps(sc)) as (LeadRec | OpportunityRec)[];
  const picked = (ids as string[]).map((id) => rows.find((r) => r.id === id));
  if (picked.some((r) => !r || !reaches(sc, `sales.${kind}.view`, r.ownerId))) invalid({ [key]: "Some records can’t be found" });
  for (const r of picked) mustReach(sc, code, r!.ownerId);
  const to = checkOwner(sc, code, b.ownerId);
  if (kind === "lead") for (const r of picked) notConverted(r as LeadRec);
  let updated = 0;
  for (const r of picked) {
    if (r!.ownerId === to) continue;
    if (kind === "lead") r!.ownerId = to;
    else {
      reassign(sc, r as OpportunityRec, to);
      (r as OpportunityRec).version += 1;
    }
    r!.updatedAt = nowISO();
    updated += 1;
    salesAudit(sc, `sales.${kind}.updated`, kind === "lead" ? leadDisplayName(sc.db, r as LeadRec) : (r as OpportunityRec).title);
  }
  return { updated };
}

/** `wonAt`: a timestamp or a date (noon workspace time; today = now). §10.4 rules. */
function parseWonAt(sc: SalesCtx, o: OpportunityRec, raw: unknown): string {
  const now = new Date();
  if (raw === undefined || raw === null || raw === "") return now.toISOString();
  const today = wsToday(sc.db, sc.wsId);
  let at: string;
  if (isDate(raw)) at = raw === today ? now.toISOString() : wsInstant(sc.db, sc.wsId, raw, 12);
  else if (typeof raw === "string" && !Number.isNaN(Date.parse(raw))) at = /[zZ]|[+-]\d\d:\d\d$/.test(raw) ? new Date(raw).toISOString() : wsInstant(sc.db, sc.wsId, raw.slice(0, 10), Number(raw.slice(11, 13)) || 0, Number(raw.slice(14, 16)) || 0);
  else invalid({ wonAt: "Use a date or a timestamp" });
  if (new Date(at).getTime() > now.getTime() + 60_000) invalid({ wonAt: "Can’t be in the future" });
  const day = wsDate(sc.db, sc.wsId, at);
  if (day < today) {
    const s = scopeOf(sc, "sales.opportunity.close");
    if (s !== "team" && s !== "all") fail(403, "forbidden", "Only managers can back-date a win.", { permission: "sales.opportunity.close", scope: "team" });
    const from = `${today.slice(0, 7)}-01`;
    if (day < from) invalid({ wonAt: `Pick a date in the current period (from ${from})` });
  }
  void o;
  return at;
}

/* ───────── quotations ───────── */

const quoteRoute = (ctx: Ctx, perm: string) => {
  const [sc, x] = owned(ctx, (s) => s.quotations, "sales.quotation.view", perm, "Quotation not found.");
  if (!oppLive(sc, x.opportunityId)) fail(404, "not_found", "Quotation not found.");
  return [sc, x] as const;
};
const transition = (x: QuotationRec, action: string, from: QuotationRec["status"][]) => {
  if (!from.includes(x.status)) fail(409, "invalid_transition", `Can’t ${action} a ${x.status} quotation.`, { status: x.status, action });
};

export function nextQuoteNumber(sc: SalesCtx) {
  const year = wsToday(sc.db, sc.wsId).slice(0, 4);
  const key = `${sc.wsId}:${year}`;
  sc.store.quotationSeq[key] = (sc.store.quotationSeq[key] ?? 0) + 1;
  return `Q-${year}-${String(sc.store.quotationSeq[key]).padStart(4, "0")}`;
}

/** Hook for S3: sending a quotation logs a `quotation` activity. Set by handlers-activity. */
export const quotationHooks: { onSent?: (sc: SalesCtx, x: QuotationRec) => void } = {};

export function registerSalesPipeline() {
  /* ───── leads ───── */
  route("GET", "/sales/workspaces/:slug/leads", (ctx) => {
    const sc = wsCtx(ctx, "sales.lead.view");
    const status = enumFilter(ctx, "status", LEAD_STATUSES);
    const source = enumFilter(ctx, "source", SOURCES);
    const owners = ownerFilter(sc);
    const products = filterValues(ctx.query, "product");
    const companies = filterValues(ctx.query, "company");
    const from = dateFilter(ctx, "createdFrom");
    const to = dateFilter(ctx, "createdTo");
    const needle = q(ctx);
    const rows = liveLeads(sc).filter((l) => {
      const d = wsDate(sc.db, sc.wsId, l.createdAt);
      return (
        reaches(sc, "sales.lead.view", l.ownerId) &&
        (!status.length || status.includes(l.status)) &&
        (!source.length || source.includes(l.source)) &&
        (!owners || owners.has(l.ownerId ?? "")) &&
        (!products.length || products.includes(l.productId ?? "")) &&
        (!companies.length || companies.includes(l.companyId ?? "")) &&
        (!from || d >= from) &&
        (!to || d <= to) &&
        contains(needle, leadDisplayName(sc.db, l), l.companyName, l.contactName, l.phone, l.email)
      );
    });
    const sorted = sortRows(
      ctx,
      rows,
      { createdAt: (l) => l.createdAt, updatedAt: (l) => l.updatedAt, name: (l) => leadDisplayName(sc.db, l).toLowerCase(), status: (l) => l.status, estimatedValue: (l) => (l.estimatedValue === null ? -1 : num(l.estimatedValue)) },
      "-createdAt",
    );
    const p = page(sorted, ctx);
    return { data: p.data.map((l) => toLead(sc, l)), nextCursor: p.nextCursor };
  });

  route("POST", "/sales/workspaces/:slug/leads", (ctx) => {
    const sc = wsCtx(ctx, "sales.lead.create");
    const b = bodyOf(ctx);
    const v = leadFields(sc, b, null);
    const ownerId = checkOwner(sc, "sales.lead.assign", b.ownerId);
    const now = nowISO();
    const l: LeadRec = {
      id: sid(),
      workspaceId: sc.wsId,
      source: "other",
      status: "new",
      companyId: null,
      companyName: "",
      contactId: null,
      contactName: "",
      phone: "",
      email: "",
      productId: null,
      estimatedValue: null,
      disqualifyReason: "",
      convertedOpportunityId: null,
      convertedAt: null,
      notes: "",
      ...v,
      ownerId,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    sc.store.leads.push(l);
    salesAudit(sc, "sales.lead.created", leadDisplayName(sc.db, l));
    return toLead(sc, l);
  });

  route("POST", "/sales/workspaces/:slug/leads/bulk-assign", (ctx) => bulkAssign(ctx, "lead"));

  route("GET", "/sales/leads/:id", (ctx) => {
    const [sc, l] = leadRoute(ctx, "sales.lead.view");
    return toLead(sc, l);
  });
  route("PATCH", "/sales/leads/:id", (ctx) => {
    const [sc, l] = leadRoute(ctx, "sales.lead.edit");
    notConverted(l);
    const b = bodyOf(ctx);
    const v = leadFields(sc, b, l);
    if (b.ownerId !== undefined && b.ownerId !== l.ownerId) {
      mustReach(sc, "sales.lead.assign", l.ownerId);
      l.ownerId = checkOwner(sc, "sales.lead.assign", b.ownerId);
    }
    Object.assign(l, v, { updatedAt: nowISO() });
    salesAudit(sc, "sales.lead.updated", leadDisplayName(sc.db, l));
    return toLead(sc, l);
  });
  route("DELETE", "/sales/leads/:id", (ctx) => {
    const [sc, l] = leadRoute(ctx, "sales.lead.delete");
    l.deletedAt = nowISO();
    salesAudit(sc, "sales.lead.deleted", leadDisplayName(sc.db, l));
  });
  route("POST", "/sales/leads/:id/qualify", (ctx) => {
    const [sc, l] = leadRoute(ctx, "sales.lead.convert");
    notConverted(l);
    if (l.status !== "qualified") {
      Object.assign(l, { status: "qualified", disqualifyReason: "", updatedAt: nowISO() });
      salesAudit(sc, "sales.lead.qualified", leadDisplayName(sc.db, l));
    }
    return toLead(sc, l);
  });
  route("POST", "/sales/leads/:id/disqualify", (ctx) => {
    const [sc, l] = leadRoute(ctx, "sales.lead.convert");
    notConverted(l);
    const f: Record<string, string> = {};
    const reason = text(bodyOf(ctx), "reason", 500, f);
    if (!reason) f.reason = "Say why";
    flush(f);
    Object.assign(l, { status: "disqualified", disqualifyReason: reason, updatedAt: nowISO() });
    salesAudit(sc, "sales.lead.disqualified", leadDisplayName(sc.db, l));
    return toLead(sc, l);
  });

  route("POST", "/sales/leads/:id/convert", (ctx) => {
    const [sc, l] = leadRoute(ctx, "sales.lead.convert");
    notConverted(l);
    if (l.status === "disqualified") fail(409, "lead_disqualified", "Qualify this lead before converting it.");
    const b = bodyOf(ctx);
    if (b.companyId !== undefined && b.company !== undefined) invalid({ company: "Send companyId or company, not both" });
    const owner = l.ownerId ?? sc.userId;
    // 1. company
    let company = b.companyId !== undefined ? visibleCompany(sc, b.companyId) : undefined;
    let companyCreated = false;
    if (!company && b.company && typeof b.company === "object") {
      const c = b.company as Body;
      const f: Record<string, string> = {};
      const name = text(c, "name", 200, f);
      if (!name) f["company.name"] = "Name is required";
      flush(f);
      company = createCompany(sc, { name, industry: (c.industry as string) ?? "", region: (c.region as string) ?? "", city: (c.city as string) ?? "", address: (c.address as string) ?? "", phone: (c.phone as string) ?? "", email: (c.email as string) ?? "", website: (c.website as string) ?? "" }, owner);
      companyCreated = true;
    }
    if (!company && l.companyId) company = sc.store.companies.find((c) => c.id === l.companyId && !c.deletedAt);
    if (!company) company = matchCompany(sc, l.companyName || l.contactName, l.phone, { visibleOnly: true });
    if (!company) {
      const name = l.companyName || l.contactName;
      if (!name) invalid({ company: "Name the company to create" });
      company = createCompany(sc, { name, phone: l.phone, email: l.email }, owner);
      companyCreated = true;
    }
    // 2. contact
    const ofCompany = liveContacts(sc).filter((c) => c.companyId === company!.id);
    let contact = b.contactId !== undefined ? ofCompany.find((c) => c.id === b.contactId) : undefined;
    if (b.contactId !== undefined && !contact) invalid({ contactId: "Pick a contact of that company" });
    let contactCreated = false;
    if (!contact && b.contact && typeof b.contact === "object") {
      const c = b.contact as Body;
      if (typeof c.name !== "string" || !c.name.trim()) invalid({ "contact.name": "Name is required" });
      contact = createContact(sc, { companyId: company.id, name: (c.name as string).trim(), jobTitle: (c.jobTitle as string) ?? "", phone: (c.phone as string) ?? "", email: (c.email as string) ?? "" }, owner);
      contactCreated = true;
    }
    if (!contact && l.contactId) contact = ofCompany.find((c) => c.id === l.contactId);
    if (!contact && l.contactName) contact = ofCompany.find((c) => c.name.toLowerCase() === l.contactName.toLowerCase());
    if (!contact && l.contactName) {
      contact = createContact(sc, { companyId: company.id, name: l.contactName, phone: l.phone, email: l.email }, owner);
      contactCreated = true;
    }
    // 3. opportunity
    const ov = (b.opportunity && typeof b.opportunity === "object" ? b.opportunity : {}) as Body;
    const f: Record<string, string> = {};
    const ev = moneyIn(ov, "expectedValue", f);
    if (ov.expectedCloseDate !== undefined && ov.expectedCloseDate !== null && !isDate(ov.expectedCloseDate)) f.expectedCloseDate = "Use YYYY-MM-DD";
    flush(f);
    const product = l.productId ? sc.store.products.find((p) => p.id === l.productId) : null;
    const opp = createOpportunity(
      sc,
      {
        title: (typeof ov.title === "string" && ov.title.trim()) || (product ? `${company.name} – ${product.name}` : company.name),
        companyId: company.id,
        contactId: contact?.id ?? null,
        productId: l.productId,
        expectedValue: ev ?? l.estimatedValue ?? "0.00",
        expectedCloseDate: (ov.expectedCloseDate as string | null | undefined) ?? null,
        sourceLeadId: l.id,
      },
      owner,
    );
    const now = nowISO();
    Object.assign(l, { status: "converted", convertedOpportunityId: opp.id, convertedAt: now, companyId: company.id, contactId: contact?.id ?? null, updatedAt: now });
    salesAudit(sc, "sales.lead.converted", leadDisplayName(sc.db, l));
    return { lead: toLead(sc, l), opportunity: toOpportunity(sc, opp), company: toCompany(sc, company), contact: contact ? toContact(sc, contact) : null, companyCreated, contactCreated };
  });

  /* ───── opportunities ───── */
  const oppFilter = (sc: SalesCtx) => {
    const ctx = sc.ctx;
    const status = enumFilter(ctx, "status", ["open", "won", "lost"]);
    const stages = filterValues(ctx.query, "stage");
    const products = filterValues(ctx.query, "product");
    const companies = filterValues(ctx.query, "company");
    const owners = ownerFilter(sc);
    const [cf, ct, wf, wt] = [dateFilter(ctx, "expectedCloseFrom"), dateFilter(ctx, "expectedCloseTo"), dateFilter(ctx, "wonFrom"), dateFilter(ctx, "wonTo")];
    const needle = q(ctx);
    return (o: OpportunityRec) => {
      const won = o.wonAt ? wsDate(sc.db, sc.wsId, o.wonAt) : null;
      const company = sc.store.companies.find((c) => c.id === o.companyId);
      return (
        reaches(sc, "sales.opportunity.view", o.ownerId) &&
        (!status.length || status.includes(statusOf(sc.db, o))) &&
        (!stages.length || stages.includes(o.stageId)) &&
        (!products.length || products.includes(o.productId ?? "")) &&
        (!companies.length || companies.includes(o.companyId)) &&
        (!owners || owners.has(o.ownerId ?? "")) &&
        (!cf || (!!o.expectedCloseDate && o.expectedCloseDate >= cf)) &&
        (!ct || (!!o.expectedCloseDate && o.expectedCloseDate <= ct)) &&
        (!wf || (!!won && won >= wf)) &&
        (!wt || (!!won && won <= wt)) &&
        contains(needle, o.title, company?.name)
      );
    };
  };

  route("GET", "/sales/workspaces/:slug/opportunities", (ctx) => {
    const sc = wsCtx(ctx, "sales.opportunity.view");
    const rows = liveOpps(sc).filter(oppFilter(sc));
    const sorted = sortRows(
      ctx,
      rows,
      {
        updatedAt: (o) => o.updatedAt,
        createdAt: (o) => o.createdAt,
        title: (o) => o.title.toLowerCase(),
        expectedValue: (o) => num(o.expectedValue),
        expectedCloseDate: (o) => o.expectedCloseDate,
        wonAt: (o) => o.wonAt ?? o.createdAt,
      },
      "-updatedAt",
    );
    const p = page(sorted, ctx);
    return { data: p.data.map((o) => toOpportunity(sc, o)), nextCursor: p.nextCursor };
  });

  route("POST", "/sales/workspaces/:slug/opportunities", (ctx) => {
    const sc = wsCtx(ctx, "sales.opportunity.create");
    const b = bodyOf(ctx);
    const v = oppFields(sc, b, null);
    const ownerId = checkOwner(sc, "sales.opportunity.assign", b.ownerId);
    return toOpportunity(sc, createOpportunity(sc, v as OpportunityRec, ownerId));
  });

  route("POST", "/sales/workspaces/:slug/opportunities/bulk-assign", (ctx) => bulkAssign(ctx, "opportunity"));

  route("GET", "/sales/workspaces/:slug/pipeline", (ctx) => {
    const sc = wsCtx(ctx, "sales.opportunity.view");
    const raw = ctx.query.limit;
    const limit = raw === undefined || String(raw) === "" ? 50 : Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) invalid({ limit: "Use 1–200" });
    const keep = oppFilter(sc);
    const rows = liveOpps(sc).filter((o) => statusOf(sc.db, o) === "open" && keep(o));
    let count = 0;
    let value = 0;
    let weighted = 0;
    const stages = openStages(sc.db, sc.wsId).map((stage) => {
      const cards = rows.filter((o) => o.stageId === stage.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
      const v = cards.reduce((s, o) => s + num(o.expectedValue), 0);
      const w = cards.reduce((s, o) => s + weightedOf(sc.db, o), 0);
      count += cards.length;
      value += v;
      weighted += w;
      const { workspaceId: _w, ...st } = stage;
      return { stage: st, count: cards.length, value: money(v), weightedValue: money(w), opportunities: cards.slice(0, limit).map((o) => toOpportunity(sc, o)), nextCursor: cards.length > limit ? `o${limit}` : null };
    });
    let leadCount: number | null = null;
    if (scopeOf(sc, "sales.lead.view")) {
      const owners = ownerFilter(sc);
      const products = filterValues(ctx.query, "product");
      leadCount = liveLeads(sc).filter(
        (l) => ["new", "contacted", "qualified"].includes(l.status) && reaches(sc, "sales.lead.view", l.ownerId) && (!owners || owners.has(l.ownerId ?? "")) && (!products.length || products.includes(l.productId ?? "")),
      ).length;
    }
    return { stages, count, value: money(value), weightedValue: money(weighted), leadCount };
  });

  route("GET", "/sales/opportunities/:id", (ctx) => {
    const [sc, o] = oppRoute(ctx, "sales.opportunity.view");
    return toOpportunity(sc, o);
  });

  route("PATCH", "/sales/opportunities/:id", (ctx) => {
    const [sc, o] = oppRoute(ctx, "sales.opportunity.edit");
    const b = bodyOf(ctx);
    checkVersion(sc, o, b.version);
    const v = oppFields(sc, b, o);
    if (b.ownerId !== undefined && b.ownerId !== o.ownerId) {
      mustReach(sc, "sales.opportunity.assign", o.ownerId);
      reassign(sc, o, checkOwner(sc, "sales.opportunity.assign", b.ownerId));
    }
    if (b.creditedUserId !== undefined && b.creditedUserId !== o.creditedUserId) {
      if (statusOf(sc.db, o) !== "won") invalid({ creditedUserId: "Only won deals carry a credit" });
      mustReach(sc, "sales.opportunity.reopen", o.ownerId);
      if (typeof b.creditedUserId !== "string" || !sc.db.wsMembers.some((m) => m.workspaceId === sc.wsId && m.userId === b.creditedUserId && m.status === "active")) {
        invalid({ creditedUserId: "Pick a member of this workspace" });
      }
      o.creditedUserId = b.creditedUserId as string;
    }
    Object.assign(o, v, { updatedAt: nowISO(), version: o.version + 1 });
    salesAudit(sc, "sales.opportunity.updated", o.title);
    return toOpportunity(sc, o);
  });

  route("DELETE", "/sales/opportunities/:id", (ctx) => {
    const [sc, o] = oppRoute(ctx, "sales.opportunity.delete");
    o.deletedAt = nowISO();
    salesAudit(sc, "sales.opportunity.deleted", o.title);
  });

  route("POST", "/sales/opportunities/:id/move", (ctx) => {
    const [sc, o] = oppRoute(ctx, "sales.opportunity.move");
    const b = bodyOf(ctx);
    checkVersion(sc, o, b.version, true);
    mustBeOpen(sc, o);
    if (!openStages(sc.db, sc.wsId).some((s) => s.id === b.stageId)) invalid({ stageId: "Pick an open stage (use won / lost to close)" });
    if (b.stageId === o.stageId) return toOpportunity(sc, o);
    const from = o.stageId;
    Object.assign(o, { stageId: b.stageId, version: o.version + 1, updatedAt: nowISO() });
    history(sc, o, "stage_moved", from, o.stageId);
    salesAudit(sc, "sales.opportunity.moved", o.title);
    return toOpportunity(sc, o);
  });

  route("POST", "/sales/opportunities/:id/won", (ctx) => {
    const [sc, o] = oppRoute(ctx, "sales.opportunity.close");
    const b = bodyOf(ctx);
    checkVersion(sc, o, b.version);
    mustBeOpen(sc, o);
    const f: Record<string, string> = {};
    const wonValue = moneyIn(b, "wonValue", f, true);
    flush(f);
    const wonAt = parseWonAt(sc, o, b.wonAt);
    const from = o.stageId;
    const won = stagesOf(sc.db, sc.wsId).find((s) => s.category === "won")!;
    Object.assign(o, { stageId: won.id, wonValue: wonValue ?? o.expectedValue, wonAt, creditedUserId: o.ownerId, lostAt: null, lostReasonId: null, lostNote: "", version: o.version + 1, updatedAt: nowISO() });
    history(sc, o, "stage_won", from, won.id);
    const company = sc.store.companies.find((c) => c.id === o.companyId);
    if (company && company.status !== "active") {
      company.status = "active";
      company.updatedAt = nowISO();
      salesAudit(sc, "sales.company.updated", company.name);
    }
    salesAudit(sc, "sales.opportunity.won", o.title);
    return toOpportunity(sc, o);
  });

  route("POST", "/sales/opportunities/:id/lost", (ctx) => {
    const [sc, o] = oppRoute(ctx, "sales.opportunity.close");
    const b = bodyOf(ctx);
    checkVersion(sc, o, b.version);
    mustBeOpen(sc, o);
    const f: Record<string, string> = {};
    if (!sc.store.lostReasons.some((r) => r.id === b.lostReasonId && r.workspaceId === sc.wsId && r.isActive)) f.lostReasonId = "Pick an active lost reason";
    const note = text(b, "lostNote", 1000, f);
    flush(f);
    const from = o.stageId;
    const lost = stagesOf(sc.db, sc.wsId).find((s) => s.category === "lost")!;
    Object.assign(o, { stageId: lost.id, lostAt: nowISO(), lostReasonId: b.lostReasonId, lostNote: note ?? "", wonAt: null, wonValue: null, creditedUserId: null, version: o.version + 1, updatedAt: nowISO() });
    history(sc, o, "stage_lost", from, lost.id);
    salesAudit(sc, "sales.opportunity.lost", o.title);
    return toOpportunity(sc, o);
  });

  route("POST", "/sales/opportunities/:id/reopen", (ctx) => {
    const [sc, o] = oppRoute(ctx, "sales.opportunity.reopen");
    mustReach(sc, "sales.opportunity.close", o.ownerId);
    const b = bodyOf(ctx);
    checkVersion(sc, o, b.version);
    if (statusOf(sc.db, o) === "open") fail(409, "opportunity_open", "This opportunity is open already.");
    const open = openStages(sc.db, sc.wsId);
    if (b.stageId !== undefined && !open.some((s) => s.id === b.stageId)) invalid({ stageId: "Pick an open stage" });
    const to = (b.stageId as string | undefined) ?? open[0]!.id;
    const from = o.stageId;
    Object.assign(o, { stageId: to, wonAt: null, wonValue: null, creditedUserId: null, lostAt: null, lostReasonId: null, lostNote: "", version: o.version + 1, updatedAt: nowISO() });
    history(sc, o, "stage_reopened", from, to);
    salesAudit(sc, "sales.opportunity.reopened", o.title);
    return toOpportunity(sc, o);
  });

  route("GET", "/sales/opportunities/:id/timeline", (ctx) => {
    const [sc, o] = oppRoute(ctx, "sales.opportunity.view");
    return page(opportunityTimeline(sc.db, o), sc.ctx);
  });

  /* ───── quotations ───── */
  route("GET", "/sales/workspaces/:slug/quotations", (ctx) => {
    const sc = wsCtx(ctx, "sales.quotation.view");
    const status = enumFilter(ctx, "status", QUOTE_STATUSES);
    const opps = filterValues(ctx.query, "opportunity");
    const owners = ownerFilter(sc);
    const needle = q(ctx);
    const rows = liveQuotes(sc).filter((x) => {
      const o = sc.store.opportunities.find((y) => y.id === x.opportunityId);
      const company = o && sc.store.companies.find((c) => c.id === o.companyId);
      return (
        reaches(sc, "sales.quotation.view", x.ownerId) &&
        (!status.length || status.includes(x.status)) &&
        (!opps.length || opps.includes(x.opportunityId)) &&
        (!owners || owners.has(x.ownerId ?? "")) &&
        contains(needle, x.number, x.title, company?.name)
      );
    });
    const sorted = sortRows(ctx, rows, { createdAt: (x) => x.createdAt, updatedAt: (x) => x.updatedAt, number: (x) => x.number, amount: (x) => num(x.amount), validUntil: (x) => x.validUntil }, "-createdAt");
    const p = page(sorted, ctx);
    return { data: p.data.map((x) => toQuotation(sc, x)), nextCursor: p.nextCursor };
  });

  route("POST", "/sales/workspaces/:slug/quotations", (ctx) => {
    const sc = wsCtx(ctx, "sales.quotation.create");
    const b = bodyOf(ctx);
    const f: Record<string, string> = {};
    const o = typeof b.opportunityId === "string" ? oppLive(sc, b.opportunityId) : undefined;
    if (!o || o.workspaceId !== sc.wsId || !reaches(sc, "sales.opportunity.view", o.ownerId)) f.opportunityId = "Pick an opportunity you can see";
    const title = text(b, "title", 200, f);
    if (!title) f.title = "Title is required";
    const amount = moneyIn(b, "amount", f);
    if (b.amount === undefined) f.amount = "Enter an amount";
    if (b.validUntil !== undefined && b.validUntil !== null && !isDate(b.validUntil)) f.validUntil = "Use YYYY-MM-DD";
    const notes = text(b, "notes", 5000, f);
    flush(f);
    const now = nowISO();
    const x: QuotationRec = {
      id: sid(),
      workspaceId: sc.wsId,
      number: nextQuoteNumber(sc),
      opportunityId: o!.id,
      title: title!,
      amount: amount!,
      status: "draft",
      sentAt: null,
      validUntil: (b.validUntil as string | null | undefined) ?? null,
      respondedAt: null,
      expiredAt: null,
      notes: notes ?? "",
      ownerId: o!.ownerId,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    sc.store.quotations.push(x);
    salesAudit(sc, "sales.quotation.created", x.number);
    return toQuotation(sc, x);
  });

  route("GET", "/sales/quotations/:id", (ctx) => {
    const [sc, x] = quoteRoute(ctx, "sales.quotation.view");
    return toQuotation(sc, x);
  });
  route("PATCH", "/sales/quotations/:id", (ctx) => {
    const [sc, x] = quoteRoute(ctx, "sales.quotation.edit");
    transition(x, "edit", ["draft", "sent"]);
    const b = bodyOf(ctx);
    const f: Record<string, string> = {};
    const title = text(b, "title", 200, f);
    if (title === "") f.title = "Title is required";
    const amount = moneyIn(b, "amount", f);
    if (b.validUntil !== undefined && b.validUntil !== null && !isDate(b.validUntil)) f.validUntil = "Use YYYY-MM-DD";
    const notes = text(b, "notes", 5000, f);
    flush(f);
    if (title) x.title = title;
    if (amount) x.amount = amount;
    if (b.validUntil !== undefined) x.validUntil = b.validUntil as string | null;
    if (notes !== undefined) x.notes = notes;
    x.updatedAt = nowISO();
    salesAudit(sc, "sales.quotation.updated", x.number);
    return toQuotation(sc, x);
  });
  route("DELETE", "/sales/quotations/:id", (ctx) => {
    const [sc, x] = quoteRoute(ctx, "sales.quotation.delete");
    x.deletedAt = nowISO();
    salesAudit(sc, "sales.quotation.deleted", x.number);
  });
  route("POST", "/sales/quotations/:id/send", (ctx) => {
    const [sc, x] = quoteRoute(ctx, "sales.quotation.edit");
    transition(x, "send", ["draft"]);
    const b = bodyOf(ctx);
    const today = wsToday(sc.db, sc.wsId);
    if (b.validUntil !== undefined && (!isDate(b.validUntil) || b.validUntil < today)) invalid({ validUntil: "Pick today or a later date" });
    Object.assign(x, { status: "sent", sentAt: nowISO(), validUntil: (b.validUntil as string | undefined) ?? addDays(today, settingsOf(sc.db, sc.wsId).quotationValidityDays), updatedAt: nowISO() });
    quotationHooks.onSent?.(sc, x);
    salesAudit(sc, "sales.quotation.sent", x.number);
    return toQuotation(sc, x);
  });
  for (const [action, to] of [["accept", "accepted"], ["reject", "rejected"]] as const) {
    route("POST", `/sales/quotations/:id/${action}`, (ctx) => {
      const [sc, x] = quoteRoute(ctx, "sales.quotation.edit");
      transition(x, action, ["sent"]);
      Object.assign(x, { status: to, respondedAt: nowISO(), updatedAt: nowISO() });
      salesAudit(sc, `sales.quotation.${to}`, x.number);
      return toQuotation(sc, x);
    });
  }
}
