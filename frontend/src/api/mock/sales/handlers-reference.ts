import { fail, invalid, route } from "../router";
import { audit } from "../handlers/workspaces";
import { bodyOf, flush, recCtx, text, wsCtx, type Body, type SalesCtx } from "./access";
import { isDate, nowISO, sid, type SalesStore } from "./store";
import { calendarOf, openStages, renumberStages, settingsOf, stagesOf, toSettings } from "./views";

/* §5 reference data and settings: reads need sales.dashboard.view, writes sales.settings.manage. */

const VIEW = "sales.dashboard.view";
const MANAGE = "sales.settings.manage";

export const salesAudit = (sc: SalesCtx, action: string, target: string) => audit(sc.db, sc.wsId, sc.userId, action, target);

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const intIn = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

function settingsPatch(b: Body, current: ReturnType<typeof settingsOf>) {
  const f: Record<string, string> = {};
  const out: Record<string, unknown> = {};
  const set = (k: string, ok: boolean, msg: string) => {
    if (b[k] === undefined) return;
    if (ok) out[k] = b[k];
    else f[k] = msg;
  };
  set("weekStart", WEEKDAYS.includes(b.weekStart as string), "Pick a weekday");
  set("fiscalYearStartMonth", intIn(b.fiscalYearStartMonth, 1, 12), "Use 1–12");
  set("statusGreenPct", intIn(b.statusGreenPct, 1, 1000), "Use 1–1000");
  set("statusYellowPct", intIn(b.statusYellowPct, 0, 1000), "Use 0–1000");
  set("upcomingDays", intIn(b.upcomingDays, 1, 90), "Use 1–90");
  set("staleDays", intIn(b.staleDays, 1, 365), "Use 1–365");
  set("quotationValidityDays", intIn(b.quotationValidityDays, 1, 365), "Use 1–365");
  set("largeDealThreshold", /^\d+(\.\d{1,2})?$/.test(String(b.largeDealThreshold ?? "")), "Enter an amount of 0 or more");
  set("dailyReportCutoff", /^([01]\d|2[0-3]):[0-5]\d$/.test(String(b.dailyReportCutoff ?? "")), "Use HH:MM");
  set("dailyReportRequired", typeof b.dailyReportRequired === "boolean", "Must be true or false");
  set("calendarDisplay", b.calendarDisplay === "gregorian" || b.calendarDisplay === "ethiopian", "Use gregorian or ethiopian");
  if (out.largeDealThreshold !== undefined) out.largeDealThreshold = Number(out.largeDealThreshold).toFixed(2);
  const green = (out.statusGreenPct as number | undefined) ?? current.statusGreenPct;
  const yellow = (out.statusYellowPct as number | undefined) ?? current.statusYellowPct;
  if (!f.statusYellowPct && !f.statusGreenPct && yellow > green) f.statusYellowPct = "Must be at most the green threshold";
  flush(f);
  return out;
}

/** Name unique (case-insensitive) among a workspace's rows → 409 `name_taken`. */
function uniqueName<T extends { id: string; name: string; workspaceId: string }>(rows: T[], wsId: string, name: string, selfId: string | null) {
  if (rows.some((r) => r.workspaceId === wsId && r.id !== selfId && r.name.toLowerCase() === name.toLowerCase())) {
    fail(409, "name_taken", "That name is already used.", { name });
  }
}

/** Products and lost reasons share routes and rules (§5.3, §5.4). */
function refRoutes(
  path: string,
  single: string,
  rows: (s: SalesStore) => { id: string; workspaceId: string; name: string; isActive: boolean; createdAt: string | null; updatedAt: string | null; code?: string; category?: string }[],
  kind: "product" | "lostreason",
) {
  const isProduct = kind === "product";
  const out = (r: ReturnType<typeof rows>[number]) => {
    const { workspaceId: _w, ...rest } = r;
    return rest;
  };
  const read = (b: Body, partial: boolean) => {
    const f: Record<string, string> = {};
    const name = text(b, "name", 120, f);
    if (!partial && !name) f.name = "Name is required";
    if (partial && name === "") f.name = "Name is required";
    const code = isProduct ? text(b, "code", 40, f) : undefined;
    const category = isProduct ? text(b, "category", 80, f) : undefined;
    if (b.isActive !== undefined && typeof b.isActive !== "boolean") f.isActive = "Must be true or false";
    flush(f);
    return { name, code, category, isActive: b.isActive as boolean | undefined };
  };
  const checkCode = (sc: SalesCtx, code: string | undefined, selfId: string | null) => {
    if (code && rows(sc.store).some((r) => r.workspaceId === sc.wsId && r.id !== selfId && (r.code ?? "").toLowerCase() === code.toLowerCase())) {
      fail(409, "code_taken", "That code is already used.", { code });
    }
  };
  route("GET", `/sales/workspaces/:slug/${path}`, (ctx) => {
    const sc = wsCtx(ctx, VIEW);
    const active = ctx.query.filter?.active;
    return rows(sc.store)
      .filter((r) => r.workspaceId === sc.wsId && (active === undefined || String(r.isActive) === String(active)))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(out);
  });
  route("POST", `/sales/workspaces/:slug/${path}`, (ctx) => {
    const sc = wsCtx(ctx, MANAGE);
    const v = read(bodyOf(ctx), false);
    uniqueName(rows(sc.store), sc.wsId, v.name!, null);
    checkCode(sc, v.code, null);
    const now = nowISO();
    const rec = { id: sid(), workspaceId: sc.wsId, name: v.name!, isActive: v.isActive ?? true, createdAt: now, updatedAt: now, ...(isProduct ? { code: v.code ?? "", category: v.category ?? "" } : {}) };
    (rows(sc.store) as unknown[]).push(rec);
    salesAudit(sc, `sales.${kind}.created`, rec.name);
    return out(rec);
  });
  route("PATCH", `/sales/${path}/:id`, (ctx) => {
    const [sc, rec] = recCtx(ctx, rows, MANAGE, `${single} not found.`);
    const v = read(bodyOf(ctx), true);
    if (v.name !== undefined) uniqueName(rows(sc.store), sc.wsId, v.name, rec.id);
    checkCode(sc, v.code, rec.id);
    if (v.name !== undefined) rec.name = v.name;
    if (v.isActive !== undefined) rec.isActive = v.isActive;
    if (isProduct && v.code !== undefined) rec.code = v.code;
    if (isProduct && v.category !== undefined) rec.category = v.category;
    rec.updatedAt = nowISO();
    salesAudit(sc, `sales.${kind}.updated`, rec.name);
    return out(rec);
  });
  route("DELETE", `/sales/${path}/:id`, (ctx) => {
    const [sc, rec] = recCtx(ctx, rows, MANAGE, `${single} not found.`);
    if (isProduct && (sc.store.leads.some((l) => l.productId === rec.id) || sc.store.opportunities.some((o) => o.productId === rec.id))) {
      fail(409, "product_in_use", "Leads or opportunities use this product. Deactivate it instead.");
    }
    if (!isProduct && sc.store.opportunities.some((o) => o.lostReasonId === rec.id)) {
      fail(409, "lost_reason_in_use", "Lost opportunities name this reason. Deactivate it instead.");
    }
    const list = rows(sc.store);
    list.splice(list.indexOf(rec), 1);
    salesAudit(sc, `sales.${kind}.deleted`, rec.name);
  });
}

export function registerSalesReference() {
  /* settings */
  route("GET", "/sales/workspaces/:slug/settings", (ctx) => {
    const sc = wsCtx(ctx, VIEW);
    return toSettings(settingsOf(sc.db, sc.wsId));
  });
  route("PUT", "/sales/workspaces/:slug/settings", (ctx) => {
    const sc = wsCtx(ctx, MANAGE);
    const s = settingsOf(sc.db, sc.wsId);
    const patch = settingsPatch(bodyOf(ctx), s);
    const changed = Object.entries(patch).some(([k, v]) => (s as Record<string, unknown>)[k] !== v);
    Object.assign(s, patch);
    if (changed) {
      s.updatedAt = nowISO();
      salesAudit(sc, "sales.settings.updated", "Sales settings");
    }
    return toSettings(s);
  });

  /* stages */
  route("GET", "/sales/workspaces/:slug/stages", (ctx) => {
    const sc = wsCtx(ctx, VIEW);
    return stagesOf(sc.db, sc.wsId).map(({ workspaceId: _w, ...s }) => s);
  });
  route("POST", "/sales/workspaces/:slug/stages", (ctx) => {
    const sc = wsCtx(ctx, MANAGE);
    const b = bodyOf(ctx);
    const f: Record<string, string> = {};
    const name = text(b, "name", 60, f);
    if (!name) f.name = "Name is required";
    if (!intIn(b.defaultProbability, 0, 100)) f.defaultProbability = "Use 0–100";
    flush(f);
    const all = stagesOf(sc.db, sc.wsId);
    uniqueName(all, sc.wsId, name!, null);
    const open = all.filter((s) => s.category === "open");
    if (open.length >= 20) fail(409, "too_many_stages", "A pipeline has at most 20 open stages.");
    const rec = { id: sid(), workspaceId: sc.wsId, name: name!, order: open.length - 0.5, category: "open" as const, defaultProbability: b.defaultProbability as number, isSystem: false };
    sc.store.stages.push(rec);
    renumberStages(sc.db, sc.wsId);
    salesAudit(sc, "sales.stage.created", rec.name);
    const { workspaceId: _w, ...out } = rec;
    return out;
  });
  route("POST", "/sales/workspaces/:slug/stages/reorder", (ctx) => {
    const sc = wsCtx(ctx, MANAGE);
    const ids = bodyOf(ctx).stageIds;
    const open = openStages(sc.db, sc.wsId);
    if (!Array.isArray(ids) || ids.length !== open.length || new Set(ids).size !== ids.length || !ids.every((id) => open.some((s) => s.id === id))) {
      invalid({ stageIds: "List every open stage exactly once" });
    }
    (ids as string[]).forEach((id, i) => (open.find((s) => s.id === id)!.order = i));
    renumberStages(sc.db, sc.wsId);
    salesAudit(sc, "sales.stage.reordered", "Pipeline stages");
    return stagesOf(sc.db, sc.wsId).map(({ workspaceId: _w, ...s }) => s);
  });
  route("PATCH", "/sales/stages/:id", (ctx) => {
    const [sc, rec] = recCtx(ctx, (s) => s.stages as (SalesStore["stages"][number] & { deletedAt?: null })[], MANAGE, "Stage not found.");
    const b = bodyOf(ctx);
    const f: Record<string, string> = {};
    const name = text(b, "name", 60, f);
    if (name === "") f.name = "Name is required";
    if (b.defaultProbability !== undefined) {
      if (rec.isSystem && b.defaultProbability !== rec.defaultProbability) f.defaultProbability = "Won and Lost have a fixed probability";
      else if (!intIn(b.defaultProbability, 0, 100)) f.defaultProbability = "Use 0–100";
    }
    flush(f);
    if (name) uniqueName(stagesOf(sc.db, sc.wsId), sc.wsId, name, rec.id);
    if (name) rec.name = name;
    if (b.defaultProbability !== undefined) rec.defaultProbability = b.defaultProbability as number;
    salesAudit(sc, "sales.stage.updated", rec.name);
    const { workspaceId: _w, ...out } = rec;
    return out;
  });
  route("DELETE", "/sales/stages/:id", (ctx) => {
    const [sc, rec] = recCtx(ctx, (s) => s.stages as (SalesStore["stages"][number] & { deletedAt?: null })[], MANAGE, "Stage not found.");
    if (rec.isSystem) fail(409, "stage_is_system", "Won and Lost can’t be deleted.");
    if (openStages(sc.db, sc.wsId).length <= 1) fail(409, "last_open_stage", "Keep at least one open stage.");
    if (sc.store.opportunities.some((o) => o.stageId === rec.id)) fail(409, "stage_in_use", "Opportunities are in this stage. Move them first.");
    sc.store.stages.splice(sc.store.stages.indexOf(rec), 1);
    renumberStages(sc.db, sc.wsId);
    salesAudit(sc, "sales.stage.deleted", rec.name);
  });

  refRoutes("products", "Product", (s) => s.products, "product");
  refRoutes("lost-reasons", "Lost reason", (s) => s.lostReasons, "lostreason");

  /* calendar */
  route("GET", "/sales/workspaces/:slug/calendar", (ctx) => {
    const sc = wsCtx(ctx, VIEW);
    const c = calendarOf(sc.db, sc.wsId);
    return { weekdayWeights: [...c.weekdayWeights], updatedAt: c.updatedAt };
  });
  route("PUT", "/sales/workspaces/:slug/calendar", (ctx) => {
    const sc = wsCtx(ctx, MANAGE);
    const raw = bodyOf(ctx).weekdayWeights;
    const w = Array.isArray(raw) ? raw.map(Number) : [];
    const ok = Array.isArray(raw) && w.length === 7 && w.every((x) => Number.isFinite(x) && x >= 0 && x <= 1 && Math.round(x * 100) === x * 100) && w.some((x) => x > 0);
    if (!ok) invalid({ weekdayWeights: "Seven numbers between 0 and 1 (two decimals at most), at least one above 0" });
    const c = calendarOf(sc.db, sc.wsId);
    c.weekdayWeights = w;
    c.updatedAt = nowISO();
    salesAudit(sc, "sales.calendar.updated", "Working calendar");
    return { weekdayWeights: [...w], updatedAt: c.updatedAt };
  });

  /* holidays */
  const holidayOut = ({ workspaceId: _w, ...h }: SalesStore["holidays"][number]) => h;
  route("GET", "/sales/workspaces/:slug/holidays", (ctx) => {
    const sc = wsCtx(ctx, VIEW);
    const year = ctx.query.filter?.year;
    if (year !== undefined && !/^\d{4}$/.test(String(year))) invalid({ "filter[year]": "Use a four-digit year" });
    return sc.store.holidays
      .filter((h) => h.workspaceId === sc.wsId && (year === undefined || h.date.startsWith(String(year))))
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(holidayOut);
  });
  const readHoliday = (sc: SalesCtx, b: Body, selfId: string | null, partial: boolean) => {
    const f: Record<string, string> = {};
    const name = text(b, "name", 120, f);
    if ((!partial || name !== undefined) && !name) f.name = "Name is required";
    if ((!partial || b.date !== undefined) && !isDate(b.date)) f.date = "Use YYYY-MM-DD";
    flush(f);
    const date = b.date as string | undefined;
    if (date && sc.store.holidays.some((h) => h.workspaceId === sc.wsId && h.id !== selfId && h.date === date)) fail(409, "date_taken", "There is already a holiday on that date.", { date });
    return { name, date };
  };
  route("POST", "/sales/workspaces/:slug/holidays", (ctx) => {
    const sc = wsCtx(ctx, MANAGE);
    const v = readHoliday(sc, bodyOf(ctx), null, false);
    const rec = { id: sid(), workspaceId: sc.wsId, date: v.date!, name: v.name! };
    sc.store.holidays.push(rec);
    salesAudit(sc, "sales.holiday.created", rec.name);
    return holidayOut(rec);
  });
  route("PATCH", "/sales/holidays/:id", (ctx) => {
    const [sc, rec] = recCtx(ctx, (s) => s.holidays as (SalesStore["holidays"][number] & { deletedAt?: null })[], MANAGE, "Holiday not found.");
    const v = readHoliday(sc, bodyOf(ctx), rec.id, true);
    if (v.name) rec.name = v.name;
    if (v.date) rec.date = v.date;
    salesAudit(sc, "sales.holiday.updated", rec.name);
    return holidayOut(rec);
  });
  route("DELETE", "/sales/holidays/:id", (ctx) => {
    const [sc, rec] = recCtx(ctx, (s) => s.holidays as (SalesStore["holidays"][number] & { deletedAt?: null })[], MANAGE, "Holiday not found.");
    sc.store.holidays.splice(sc.store.holidays.indexOf(rec), 1);
    salesAudit(sc, "sales.holiday.deleted", rec.name);
  });
}
