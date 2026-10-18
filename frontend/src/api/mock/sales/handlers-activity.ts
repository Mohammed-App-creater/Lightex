import { fail, filterValues, invalid, route, type Ctx } from "../router";
import { bodyOf, checkOwner, contains, dateFilter, enumFilter, flush, need, owned, ownerFilter, page, q, reaches, sortRows, text, wsCtx, type Body, type SalesCtx } from "./access";
import { salesAudit } from "./handlers-reference";
import { quotationHooks } from "./handlers-pipeline";
import { isDate, nowISO, sid, wsDate, wsToday, type ActivityRec, type FollowUpRec, type TargetType } from "./store";
import { bucketOf, targetCompanyId, targetName, targetRecord, toActivity, toFollowUp } from "./views";

/* §14 activities, §15 follow-ups. */

const LOGGED = ["call", "visit", "meeting", "email", "note", "other"] as const;
const TARGETS: TargetType[] = ["sales.lead", "sales.opportunity", "sales.company", "sales.contact"];
const VIEW_CODE: Record<TargetType, string> = {
  "sales.lead": "sales.lead.view",
  "sales.opportunity": "sales.opportunity.view",
  "sales.company": "sales.company.view",
  "sales.contact": "sales.contact.view",
};

/** A live record of the workspace in the caller's view scope for its type, else 422 `targetId`. */
function checkTarget(sc: SalesCtx, type: unknown, id: unknown, allowed: readonly TargetType[] = TARGETS) {
  if (!allowed.includes(type as TargetType)) invalid({ targetType: `Use ${allowed.join(", ")}` });
  const r = typeof id === "string" ? targetRecord(sc.db, type as TargetType, id) : undefined;
  if (!r || r.workspaceId !== sc.wsId || r.deletedAt || !reaches(sc, VIEW_CODE[type as TargetType], r.ownerId)) invalid({ targetId: "Pick a record you can see" });
  return { targetType: type as TargetType, targetId: id as string };
}

/** Children of a record in the trash are hidden. */
const targetLive = (sc: SalesCtx, x: { targetType: TargetType; targetId: string }) => {
  const r = targetRecord(sc.db, x.targetType, x.targetId);
  return !!r && !r.deletedAt;
};

function parseOccurredAt(b: Body, f: Record<string, string>) {
  if (b.occurredAt === undefined) return undefined;
  if (typeof b.occurredAt !== "string" || Number.isNaN(Date.parse(b.occurredAt))) {
    f.occurredAt = "Use a timestamp";
    return undefined;
  }
  const at = new Date(b.occurredAt);
  if (at.getTime() > Date.now() + 5 * 60_000) f.occurredAt = "Can’t be in the future (plan it as a follow-up)";
  return at.toISOString();
}

function activityFields(b: Body, f: Record<string, string>) {
  const v: Partial<ActivityRec> = {};
  if (b.type !== undefined) {
    if (!LOGGED.includes(b.type as never)) f.type = "Pick call, visit, meeting, email, note or other";
    else v.type = b.type as ActivityRec["type"];
  }
  const at = parseOccurredAt(b, f);
  if (at) v.occurredAt = at;
  if (b.durationMinutes !== undefined) {
    const d = b.durationMinutes;
    if (d !== null && (typeof d !== "number" || !Number.isInteger(d) || d < 0 || d > 1440)) f.durationMinutes = "Use 0–1440 minutes";
    else v.durationMinutes = d as number | null;
  }
  const summary = text(b, "summary", 2000, f);
  if (summary !== undefined) v.summary = summary;
  const outcome = text(b, "outcome", 2000, f);
  if (outcome !== undefined) v.outcome = outcome;
  return v;
}

export function logActivity(sc: SalesCtx, v: Partial<ActivityRec> & { type: ActivityRec["type"]; targetType: TargetType; targetId: string }): ActivityRec {
  const now = nowISO();
  const a: ActivityRec = {
    id: sid(),
    workspaceId: sc.wsId,
    type: v.type,
    occurredAt: v.occurredAt ?? now,
    durationMinutes: v.durationMinutes ?? null,
    targetType: v.targetType,
    targetId: v.targetId,
    companyId: targetCompanyId(sc.db, v.targetType, v.targetId),
    quotationId: v.quotationId ?? null,
    summary: v.summary ?? "",
    outcome: v.outcome ?? "",
    ownerId: v.ownerId ?? sc.userId,
    createdAt: now,
    updatedAt: now,
  };
  sc.store.activities.push(a);
  salesAudit(sc, "sales.activity.created", targetName(sc.db, a.targetType, a.targetId));
  return a;
}

function dueOk(sc: SalesCtx, due: unknown, f: Record<string, string>, key = "dueDate") {
  if (!isDate(due)) f[key] = "Use YYYY-MM-DD";
  else if (due < wsToday(sc.db, sc.wsId)) f[key] = "Pick today or a later date";
}

export function createFollowUp(sc: SalesCtx, v: { targetType: TargetType; targetId: string; title: string; dueDate: string; notes?: string; ownerId: string }): FollowUpRec {
  const now = nowISO();
  // A contact's follow-up goes on its company.
  let { targetType, targetId } = v;
  if (targetType === "sales.contact") {
    targetType = "sales.company";
    targetId = targetCompanyId(sc.db, "sales.contact", v.targetId)!;
  }
  const f: FollowUpRec = {
    id: sid(),
    workspaceId: sc.wsId,
    title: v.title,
    notes: v.notes ?? "",
    dueDate: v.dueDate,
    status: "pending",
    completedAt: null,
    completedActivityId: null,
    cancelledAt: null,
    targetType,
    targetId,
    companyId: targetCompanyId(sc.db, targetType, targetId),
    createdById: sc.userId,
    ownerId: v.ownerId,
    createdAt: now,
    updatedAt: now,
  };
  sc.store.followUps.push(f);
  salesAudit(sc, "sales.followup.created", f.title);
  return f;
}

const activityRoute = (ctx: Ctx, perm: string) => {
  const [sc, a] = owned(ctx, (s) => s.activities, "sales.activity.view", perm, "Activity not found.");
  if (!targetLive(sc, a)) fail(404, "not_found", "Activity not found.");
  return [sc, a] as const;
};
const followUpRoute = (ctx: Ctx, perm: string) => {
  const [sc, f] = owned(ctx, (s) => s.followUps, "sales.followup.view", perm, "Follow-up not found.");
  if (!targetLive(sc, f)) fail(404, "not_found", "Follow-up not found.");
  return [sc, f] as const;
};
const pendingOnly = (f: FollowUpRec, action: string) => {
  if (f.status !== "pending") fail(409, "invalid_transition", `This follow-up is ${f.status}.`, { status: f.status, action });
};
const defaultTitle = (type: string) => (type === "sales.lead" ? "Follow up on the lead" : "Follow up");

export function registerSalesActivity() {
  // S3: sending a quotation logs a `quotation` activity on its opportunity.
  quotationHooks.onSent = (sc, x) => {
    logActivity(sc, { type: "quotation", targetType: "sales.opportunity", targetId: x.opportunityId, quotationId: x.id, summary: `${x.number} sent`, ownerId: sc.userId });
  };

  /* ───── activities ───── */
  route("GET", "/sales/workspaces/:slug/activities", (ctx) => {
    const sc = wsCtx(ctx, "sales.activity.view");
    const types = enumFilter(ctx, "type", [...LOGGED, "quotation"]);
    const owners = ownerFilter(sc);
    const ttypes = enumFilter(ctx, "targetType", TARGETS);
    const targets = filterValues(ctx.query, "target");
    const companies = filterValues(ctx.query, "company");
    const from = dateFilter(ctx, "occurredFrom");
    const to = dateFilter(ctx, "occurredTo");
    const needle = q(ctx);
    const rows = sc.store.activities.filter((a) => {
      const d = wsDate(sc.db, sc.wsId, a.occurredAt);
      return (
        a.workspaceId === sc.wsId &&
        targetLive(sc, a) &&
        reaches(sc, "sales.activity.view", a.ownerId) &&
        (!types.length || types.includes(a.type)) &&
        (!owners || owners.has(a.ownerId ?? "")) &&
        (!ttypes.length || ttypes.includes(a.targetType)) &&
        (!targets.length || targets.includes(a.targetId)) &&
        (!companies.length || companies.includes(a.companyId ?? "")) &&
        (!from || d >= from) &&
        (!to || d <= to) &&
        contains(needle, a.summary, a.outcome, targetName(sc.db, a.targetType, a.targetId))
      );
    });
    const sorted = sortRows(ctx, rows, { occurredAt: (a) => a.occurredAt, createdAt: (a) => a.createdAt }, "-occurredAt");
    const p = page(sorted, ctx);
    return { data: p.data.map((a) => toActivity(sc, a)), nextCursor: p.nextCursor };
  });

  route("POST", "/sales/workspaces/:slug/activities", (ctx) => {
    const sc = wsCtx(ctx, "sales.activity.create");
    const b = bodyOf(ctx);
    const f: Record<string, string> = {};
    if (b.type === undefined) f.type = "Pick a type";
    const v = activityFields(b, f);
    const fu = b.followUp && typeof b.followUp === "object" ? (b.followUp as Body) : null;
    if (fu) dueOk(sc, fu.dueDate, f, "followUp.dueDate");
    flush(f);
    const target = checkTarget(sc, b.targetType, b.targetId);
    if (fu) need(sc, "sales.followup.create");
    const activity = logActivity(sc, { ...v, type: v.type!, ...target });
    const followUp = fu
      ? createFollowUp(sc, { ...target, title: (typeof fu.title === "string" && fu.title.trim()) || defaultTitle(target.targetType), dueDate: fu.dueDate as string, notes: typeof fu.notes === "string" ? fu.notes : "", ownerId: sc.userId })
      : null;
    return { activity: toActivity(sc, activity), followUp: followUp ? toFollowUp(sc, followUp) : null };
  });

  route("GET", "/sales/activities/:id", (ctx) => {
    const [sc, a] = activityRoute(ctx, "sales.activity.view");
    return toActivity(sc, a);
  });
  route("PATCH", "/sales/activities/:id", (ctx) => {
    const [sc, a] = activityRoute(ctx, "sales.activity.edit");
    if (a.type === "quotation") invalid({ type: "Quotation entries are written by the system" });
    const b = bodyOf(ctx);
    const f: Record<string, string> = {};
    const v = activityFields(b, f);
    if ((b.targetType === undefined) !== (b.targetId === undefined)) f.targetId = "Send targetType and targetId together";
    flush(f);
    if (b.targetType !== undefined) {
      Object.assign(v, checkTarget(sc, b.targetType, b.targetId));
      v.companyId = targetCompanyId(sc.db, v.targetType!, v.targetId!);
    }
    Object.assign(a, v, { updatedAt: nowISO() });
    salesAudit(sc, "sales.activity.updated", targetName(sc.db, a.targetType, a.targetId));
    return toActivity(sc, a);
  });
  route("DELETE", "/sales/activities/:id", (ctx) => {
    const [sc, a] = activityRoute(ctx, "sales.activity.delete");
    sc.store.activities.splice(sc.store.activities.indexOf(a), 1);
    for (const f of sc.store.followUps) if (f.completedActivityId === a.id) f.completedActivityId = null;
    salesAudit(sc, "sales.activity.deleted", targetName(sc.db, a.targetType, a.targetId));
  });

  /* ───── follow-ups ───── */
  route("GET", "/sales/workspaces/:slug/follow-ups", (ctx) => {
    const sc = wsCtx(ctx, "sales.followup.view");
    const bucket = typeof ctx.query.bucket === "string" && ctx.query.bucket ? ctx.query.bucket : "all";
    if (!["overdue", "today", "upcoming", "all"].includes(bucket)) invalid({ bucket: "Use overdue, today, upcoming or all" });
    const statuses = enumFilter(ctx, "status", ["pending", "done", "cancelled"]);
    const owners = ownerFilter(sc);
    const ttypes = enumFilter(ctx, "targetType", ["sales.lead", "sales.opportunity", "sales.company"]);
    const targets = filterValues(ctx.query, "target");
    const companies = filterValues(ctx.query, "company");
    const from = dateFilter(ctx, "dueFrom");
    const to = dateFilter(ctx, "dueTo");
    const needle = q(ctx);
    const rows = sc.store.followUps.filter(
      (f) =>
        f.workspaceId === sc.wsId &&
        targetLive(sc, f) &&
        reaches(sc, "sales.followup.view", f.ownerId) &&
        (!statuses.length || statuses.includes(f.status)) &&
        (!owners || owners.has(f.ownerId ?? "")) &&
        (!ttypes.length || ttypes.includes(f.targetType)) &&
        (!targets.length || targets.includes(f.targetId)) &&
        (!companies.length || companies.includes(f.companyId ?? "")) &&
        (!from || f.dueDate >= from) &&
        (!to || f.dueDate <= to) &&
        contains(needle, f.title, f.notes, targetName(sc.db, f.targetType, f.targetId)),
    );
    const counts = { overdue: 0, today: 0, upcoming: 0 };
    for (const f of rows) {
      const b = bucketOf(sc.db, f);
      if (b === "overdue" || b === "today" || b === "upcoming") counts[b] += 1;
    }
    const inBucket = bucket === "all" ? rows : rows.filter((f) => bucketOf(sc.db, f) === bucket);
    const sorted = sortRows(ctx, inBucket, { dueDate: (f) => f.dueDate, createdAt: (f) => f.createdAt, updatedAt: (f) => f.updatedAt }, "dueDate");
    const p = page(sorted, ctx);
    return { data: p.data.map((f) => toFollowUp(sc, f)), nextCursor: p.nextCursor, counts };
  });

  route("POST", "/sales/workspaces/:slug/follow-ups", (ctx) => {
    const sc = wsCtx(ctx, "sales.followup.create");
    const b = bodyOf(ctx);
    const f: Record<string, string> = {};
    const title = text(b, "title", 200, f);
    if (!title) f.title = "Title is required";
    const notes = text(b, "notes", 5000, f);
    dueOk(sc, b.dueDate, f);
    flush(f);
    const target = checkTarget(sc, b.targetType, b.targetId, ["sales.lead", "sales.opportunity", "sales.company"]);
    const ownerId = checkOwner(sc, "sales.followup.reassign", b.ownerId);
    return toFollowUp(sc, createFollowUp(sc, { ...target, title: title!, notes, dueDate: b.dueDate as string, ownerId }));
  });

  route("GET", "/sales/follow-ups/:id", (ctx) => {
    const [sc, f] = followUpRoute(ctx, "sales.followup.view");
    return toFollowUp(sc, f);
  });
  route("PATCH", "/sales/follow-ups/:id", (ctx) => {
    const [sc, fu] = followUpRoute(ctx, "sales.followup.edit");
    const b = bodyOf(ctx);
    pendingOnly(fu, b.status === "cancelled" ? "cancel" : "edit");
    const f: Record<string, string> = {};
    const title = text(b, "title", 200, f);
    if (title === "") f.title = "Title is required";
    const notes = text(b, "notes", 5000, f);
    if (b.dueDate !== undefined) dueOk(sc, b.dueDate, f);
    if (b.status !== undefined && b.status !== "cancelled") f.status = "Only cancelled can be set here";
    flush(f);
    if (title) fu.title = title;
    if (notes !== undefined) fu.notes = notes;
    if (b.dueDate !== undefined) fu.dueDate = b.dueDate as string;
    if (b.status === "cancelled") Object.assign(fu, { status: "cancelled", cancelledAt: nowISO() });
    fu.updatedAt = nowISO();
    salesAudit(sc, b.status === "cancelled" ? "sales.followup.cancelled" : "sales.followup.updated", fu.title);
    return toFollowUp(sc, fu);
  });
  route("DELETE", "/sales/follow-ups/:id", (ctx) => {
    const [sc, f] = followUpRoute(ctx, "sales.followup.delete");
    sc.store.followUps.splice(sc.store.followUps.indexOf(f), 1);
    salesAudit(sc, "sales.followup.deleted", f.title);
  });
  route("POST", "/sales/follow-ups/:id/reschedule", (ctx) => {
    const [sc, fu] = followUpRoute(ctx, "sales.followup.edit");
    pendingOnly(fu, "reschedule");
    const f: Record<string, string> = {};
    dueOk(sc, bodyOf(ctx).dueDate, f);
    flush(f);
    Object.assign(fu, { dueDate: bodyOf(ctx).dueDate, updatedAt: nowISO() });
    salesAudit(sc, "sales.followup.rescheduled", fu.title);
    return toFollowUp(sc, fu);
  });
  route("POST", "/sales/follow-ups/:id/reassign", (ctx) => {
    const [sc, fu] = followUpRoute(ctx, "sales.followup.reassign");
    pendingOnly(fu, "reassign");
    const to = bodyOf(ctx).ownerId;
    if (typeof to !== "string") invalid({ ownerId: "Pick a member of this workspace" });
    fu.ownerId = checkOwner(sc, "sales.followup.reassign", to);
    fu.updatedAt = nowISO();
    salesAudit(sc, "sales.followup.reassigned", fu.title);
    return toFollowUp(sc, fu);
  });

  route("POST", "/sales/follow-ups/:id/complete", (ctx) => {
    const [sc, fu] = followUpRoute(ctx, "sales.followup.complete");
    pendingOnly(fu, "complete");
    const b = bodyOf(ctx);
    const act = b.activity && typeof b.activity === "object" ? (b.activity as Body) : null;
    const next = b.createNext && typeof b.createNext === "object" ? (b.createNext as Body) : null;
    const f: Record<string, string> = {};
    const av = act ? activityFields(act, f) : null;
    if (act && act.type === undefined) f["activity.type"] = "Pick a type";
    if (next) dueOk(sc, next.dueDate, f, "createNext.dueDate");
    flush(f);
    if (act) need(sc, "sales.activity.create");
    if (next) need(sc, "sales.followup.create");
    const activity = av ? logActivity(sc, { ...av, type: av.type!, targetType: fu.targetType, targetId: fu.targetId }) : null;
    const now = nowISO();
    Object.assign(fu, { status: "done", completedAt: now, completedActivityId: activity?.id ?? null, updatedAt: now });
    const nextRec = next
      ? createFollowUp(sc, { targetType: fu.targetType, targetId: fu.targetId, title: (typeof next.title === "string" && next.title.trim()) || fu.title, dueDate: next.dueDate as string, ownerId: fu.ownerId ?? sc.userId })
      : null;
    salesAudit(sc, "sales.followup.completed", fu.title);
    return { followUp: toFollowUp(sc, fu), activity: activity ? toActivity(sc, activity) : null, next: nextRec ? toFollowUp(sc, nextRec) : null };
  });
}
