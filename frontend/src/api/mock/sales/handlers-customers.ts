import { fail, filterValues, invalid, route, type Ctx } from "../router";
import {
  bodyOf,
  checkOwner,
  contains,
  enumFilter,
  flush,
  owned,
  page,
  q,
  reaches,
  sortRows,
  text,
  wsCtx,
  type Body,
  type SalesCtx,
} from "./access";
import { salesAudit } from "./handlers-reference";
import { money, nowISO, num, sid, type CompanyRec, type ContactRec } from "./store";
import { companyTimeline, statusOf, toCompany, toContact } from "./views";

/* §6 companies, §7 contacts. */

const STATUSES = ["prospect", "active", "inactive"] as const;
const LEGAL = new Set(["plc", "ltd", "limited", "llc", "inc", "co", "corp", "company", "sc", "share", "pvt", "private", "plc."]);

export function normName(s: string) {
  const words = s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\./g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  while (words.length > 1 && LEGAL.has(words[words.length - 1]!)) words.pop();
  return words.join(" ");
}
export function normPhone(s: string) {
  const d = s.replace(/\D/g, "");
  return d.length < 7 ? "" : d.slice(-9);
}

/** Live (not deleted) companies of the workspace. */
export const liveCompanies = (sc: SalesCtx) => sc.store.companies.filter((c) => c.workspaceId === sc.wsId && !c.deletedAt);
const companyLive = (sc: SalesCtx, id: string) => sc.store.companies.find((c) => c.id === id && !c.deletedAt);
/** Contacts of a deleted company are hidden. */
export const liveContacts = (sc: SalesCtx) => sc.store.contacts.filter((c) => c.workspaceId === sc.wsId && !c.deletedAt && !!companyLive(sc, c.companyId));

function companyFields(b: Body, partial: boolean) {
  const f: Record<string, string> = {};
  const v = {
    name: text(b, "name", 200, f),
    industry: text(b, "industry", 80, f),
    region: text(b, "region", 80, f),
    city: text(b, "city", 80, f),
    address: text(b, "address", 300, f),
    phone: text(b, "phone", 40, f),
    email: text(b, "email", 254, f),
    website: text(b, "website", 200, f),
    notes: text(b, "notes", 5000, f),
    status: b.status as CompanyRec["status"] | undefined,
  };
  if ((!partial || v.name !== undefined) && !v.name) f.name = "Name is required";
  if (v.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) f.email = "Enter a valid email";
  if (v.status !== undefined && !STATUSES.includes(v.status)) f.status = "Use prospect, active or inactive";
  flush(f);
  return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)) as Partial<CompanyRec>;
}

export function createCompany(sc: SalesCtx, v: Partial<CompanyRec>, ownerId: string): CompanyRec {
  const now = nowISO();
  const rec: CompanyRec = {
    id: sid(),
    workspaceId: sc.wsId,
    name: v.name ?? "",
    industry: v.industry ?? "",
    region: v.region ?? "",
    city: v.city ?? "",
    address: v.address ?? "",
    phone: v.phone ?? "",
    email: v.email ?? "",
    website: v.website ?? "",
    status: v.status ?? "prospect",
    notes: v.notes ?? "",
    ownerId,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  sc.store.companies.push(rec);
  salesAudit(sc, "sales.company.created", rec.name);
  return rec;
}

export function createContact(sc: SalesCtx, v: Partial<ContactRec> & { companyId: string; name: string }, ownerId: string): ContactRec {
  const now = nowISO();
  const hasPrimary = liveContacts(sc).some((c) => c.companyId === v.companyId && c.isPrimary);
  const rec: ContactRec = {
    id: sid(),
    workspaceId: sc.wsId,
    companyId: v.companyId,
    name: v.name,
    jobTitle: v.jobTitle ?? "",
    phone: v.phone ?? "",
    email: v.email ?? "",
    isPrimary: v.isPrimary ?? !hasPrimary,
    notes: v.notes ?? "",
    ownerId,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  if (rec.isPrimary) for (const c of sc.store.contacts) if (c.companyId === rec.companyId) c.isPrimary = false;
  sc.store.contacts.push(rec);
  salesAudit(sc, "sales.contact.created", rec.name);
  return rec;
}

/** A company the caller can see (422 on `field` otherwise). */
export function visibleCompany(sc: SalesCtx, id: unknown, field = "companyId"): CompanyRec {
  const c = typeof id === "string" ? companyLive(sc, id) : undefined;
  if (!c || c.workspaceId !== sc.wsId || !reaches(sc, "sales.company.view", c.ownerId)) invalid({ [field]: "Pick a company you can see" });
  return c;
}

/** The oldest live company matching a normalized name or phone (optionally among visible ones). */
export function matchCompany(sc: SalesCtx, name: string, phone: string, opts: { excludeId?: string; visibleOnly?: boolean } = {}) {
  const n = name ? normName(name) : "";
  const p = phone ? normPhone(phone) : "";
  return liveCompanies(sc)
    .filter((c) => c.id !== opts.excludeId && (!opts.visibleOnly || reaches(sc, "sales.company.view", c.ownerId)))
    .filter((c) => (n && normName(c.name) === n) || (p && normPhone(c.phone) === p))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
}

export function registerSalesCustomers() {
  /* ───── companies ───── */
  route("GET", "/sales/workspaces/:slug/companies", (ctx) => {
    const sc = wsCtx(ctx, "sales.company.view");
    const status = enumFilter(ctx, "status", STATUSES);
    const owners = filterValues(ctx.query, "owner").map((v) => (v === "me" ? sc.userId : v));
    const ci = (key: string) => filterValues(ctx.query, key).map((v) => v.toLowerCase());
    const [industry, region, city] = [ci("industry"), ci("region"), ci("city")];
    const needle = q(ctx);
    const rows = liveCompanies(sc).filter(
      (c) =>
        reaches(sc, "sales.company.view", c.ownerId) &&
        (!status.length || status.includes(c.status)) &&
        (!owners.length || owners.includes(c.ownerId ?? "")) &&
        (!industry.length || industry.includes(c.industry.toLowerCase())) &&
        (!region.length || region.includes(c.region.toLowerCase())) &&
        (!city.length || city.includes(c.city.toLowerCase())) &&
        contains(needle, c.name, c.phone, c.email, c.city),
    );
    const sorted = sortRows(ctx, rows, { name: (c) => c.name.toLowerCase(), createdAt: (c) => c.createdAt, updatedAt: (c) => c.updatedAt, status: (c) => c.status }, "name");
    const p = page(sorted, ctx);
    return { data: p.data.map((c) => toCompany(sc, c)), nextCursor: p.nextCursor };
  });

  route("POST", "/sales/workspaces/:slug/companies", (ctx) => {
    const sc = wsCtx(ctx, "sales.company.create");
    const b = bodyOf(ctx);
    const v = companyFields(b, false);
    const ownerId = checkOwner(sc, "sales.company.edit", b.ownerId);
    return toCompany(sc, createCompany(sc, v, ownerId));
  });

  route("GET", "/sales/workspaces/:slug/companies/check-duplicate", (ctx) => {
    const sc = wsCtx(ctx, "sales.company.view");
    const name = typeof ctx.query.name === "string" ? ctx.query.name : "";
    const phone = typeof ctx.query.phone === "string" ? ctx.query.phone : "";
    if (!name.trim() && !phone.trim()) invalid({ name: "Send a name or a phone number" });
    const excludeId = typeof ctx.query.excludeId === "string" ? ctx.query.excludeId : undefined;
    const m = matchCompany(sc, name, phone, { excludeId });
    return { exists: !!m, ownerName: m?.ownerId ? (sc.db.users.find((u) => u.id === m.ownerId)?.name ?? null) : null };
  });

  const companyRoute = (ctx: Ctx, perm: string) => owned(ctx, (s) => s.companies, "sales.company.view", perm, "Company not found.");

  route("GET", "/sales/companies/:id", (ctx) => {
    const [sc, c] = companyRoute(ctx, "sales.company.view");
    return toCompany(sc, c);
  });

  route("PATCH", "/sales/companies/:id", (ctx) => {
    const [sc, c] = companyRoute(ctx, "sales.company.edit");
    const b = bodyOf(ctx);
    const v = companyFields(b, true);
    if (b.ownerId !== undefined && b.ownerId !== c.ownerId) c.ownerId = checkOwner(sc, "sales.company.edit", b.ownerId);
    Object.assign(c, v, { updatedAt: nowISO() });
    salesAudit(sc, "sales.company.updated", c.name);
    return toCompany(sc, c);
  });

  route("DELETE", "/sales/companies/:id", (ctx) => {
    const [sc, c] = companyRoute(ctx, "sales.company.delete");
    if (sc.store.opportunities.some((o) => o.companyId === c.id)) {
      fail(409, "company_has_opportunities", "This company has opportunities. Archive it (status Inactive) instead.");
    }
    c.deletedAt = nowISO();
    salesAudit(sc, "sales.company.deleted", c.name);
  });

  route("GET", "/sales/companies/:id/summary", (ctx) => {
    const [sc, c] = companyRoute(ctx, "sales.company.view");
    const contacts = liveContacts(sc).filter((x) => x.companyId === c.id && reaches(sc, "sales.contact.view", x.ownerId));
    const opps = sc.store.opportunities.filter((o) => o.companyId === c.id && !o.deletedAt && reaches(sc, "sales.opportunity.view", o.ownerId));
    const open = opps.filter((o) => statusOf(sc.db, o) === "open");
    const won = opps.filter((o) => statusOf(sc.db, o) === "won");
    const timeline = companyTimeline(sc.db, c);
    const lastContact = sc.store.activities
      .filter((a) => a.companyId === c.id && ["call", "visit", "meeting", "email"].includes(a.type))
      .map((a) => a.occurredAt)
      .sort()
      .pop();
    return {
      company: toCompany(sc, c),
      contactCount: contacts.length,
      primaryContact: (() => {
        const p = contacts.find((x) => x.isPrimary);
        return p ? toContact(sc, p) : null;
      })(),
      openOpportunityCount: open.length,
      pipelineValue: money(open.reduce((s, o) => s + num(o.expectedValue), 0)),
      wonValue: money(won.reduce((s, o) => s + num(o.wonValue), 0)),
      openFollowUpCount: sc.store.followUps.filter((f) => f.companyId === c.id && f.status === "pending" && reaches(sc, "sales.followup.view", f.ownerId)).length,
      lastContactAt: lastContact ?? null,
      timeline: timeline.slice(0, 20),
    };
  });

  route("GET", "/sales/companies/:id/timeline", (ctx) => {
    const [sc, c] = companyRoute(ctx, "sales.company.view");
    return page(companyTimeline(sc.db, c), sc.ctx);
  });

  /* ───── contacts ───── */
  route("GET", "/sales/workspaces/:slug/contacts", (ctx) => {
    const sc = wsCtx(ctx, "sales.contact.view");
    const companies = filterValues(ctx.query, "company");
    const owners = filterValues(ctx.query, "owner").map((v) => (v === "me" ? sc.userId : v));
    const primary = filterValues(ctx.query, "primary")[0];
    const needle = q(ctx);
    const rows = liveContacts(sc).filter((c) => {
      const company = sc.store.companies.find((x) => x.id === c.companyId);
      return (
        reaches(sc, "sales.contact.view", c.ownerId) &&
        (!companies.length || companies.includes(c.companyId)) &&
        (!owners.length || owners.includes(c.ownerId ?? "")) &&
        (primary === undefined || String(c.isPrimary) === primary) &&
        contains(needle, c.name, c.phone, c.email, company?.name)
      );
    });
    const sorted = sortRows(ctx, rows, { name: (c) => c.name.toLowerCase(), createdAt: (c) => c.createdAt, updatedAt: (c) => c.updatedAt }, "name");
    const p = page(sorted, ctx);
    return { data: p.data.map((c) => toContact(sc, c)), nextCursor: p.nextCursor };
  });

  const contactFields = (sc: SalesCtx, b: Body, partial: boolean) => {
    const f: Record<string, string> = {};
    const v = {
      name: text(b, "name", 120, f),
      jobTitle: text(b, "jobTitle", 120, f),
      phone: text(b, "phone", 40, f),
      email: text(b, "email", 254, f),
      notes: text(b, "notes", 5000, f),
      isPrimary: b.isPrimary as boolean | undefined,
    };
    if ((!partial || v.name !== undefined) && !v.name) f.name = "Name is required";
    if (v.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) f.email = "Enter a valid email";
    if (!partial && b.companyId === undefined) f.companyId = "Pick a company";
    flush(f);
    if (b.companyId !== undefined) visibleCompany(sc, b.companyId);
    return Object.fromEntries(Object.entries({ ...v, companyId: b.companyId }).filter(([, x]) => x !== undefined)) as Partial<ContactRec>;
  };

  route("POST", "/sales/workspaces/:slug/contacts", (ctx) => {
    const sc = wsCtx(ctx, "sales.contact.create");
    const b = bodyOf(ctx);
    const v = contactFields(sc, b, false);
    const ownerId = checkOwner(sc, "sales.contact.edit", b.ownerId);
    return toContact(sc, createContact(sc, { ...v, companyId: v.companyId!, name: v.name!, isPrimary: v.isPrimary ?? false }, ownerId));
  });

  const contactRoute = (ctx: Ctx, perm: string) => {
    const [sc, c] = owned(ctx, (s) => s.contacts, "sales.contact.view", perm, "Contact not found.");
    if (!companyLive(sc, c.companyId)) fail(404, "not_found", "Contact not found.");
    return [sc, c] as const;
  };

  route("GET", "/sales/contacts/:id", (ctx) => {
    const [sc, c] = contactRoute(ctx, "sales.contact.view");
    return toContact(sc, c);
  });
  route("PATCH", "/sales/contacts/:id", (ctx) => {
    const [sc, c] = contactRoute(ctx, "sales.contact.edit");
    const b = bodyOf(ctx);
    const v = contactFields(sc, b, true);
    if (b.ownerId !== undefined && b.ownerId !== c.ownerId) c.ownerId = checkOwner(sc, "sales.contact.edit", b.ownerId);
    Object.assign(c, v, { updatedAt: nowISO() });
    if (v.isPrimary) for (const x of sc.store.contacts) if (x.companyId === c.companyId && x.id !== c.id) x.isPrimary = false;
    salesAudit(sc, "sales.contact.updated", c.name);
    return toContact(sc, c);
  });
  route("DELETE", "/sales/contacts/:id", (ctx) => {
    const [sc, c] = contactRoute(ctx, "sales.contact.delete");
    c.deletedAt = nowISO();
    salesAudit(sc, "sales.contact.deleted", c.name);
  });
}
