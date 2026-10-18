import { beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "@/api/errors";
import type { components } from "@/api/schema";
import type { HttpMethod, ListQuery } from "@/api/transport";
import { mockControls } from "../controls";
import { getDB, mockSession, resetDB } from "../db";
import { MockTransport } from "../transport";
import { salesStore, wsToday } from "./store";

type S = components["schemas"];
const t = new MockTransport();
const as = (userId: string) => mockSession.set(userId);
const call = <T>(method: HttpMethod, path: string, body?: unknown, query?: ListQuery) => t.request<T>({ method, path, body, query });
const W = "/sales/workspaces/platform";

async function failure(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error("expected the request to fail");
}

beforeEach(() => {
  resetDB();
  mockControls.set((c) => ({ ...c, errorRate: 0, latencyMin: 0, latencyMax: 0, offline: false, teammates: false, realtime: "polling" }));
  as("u_abel");
});

describe("sales seed and scope", () => {
  it("seeds the demo pipeline", () => {
    const st = salesStore(getDB());
    expect(st.companies).toHaveLength(20);
    expect(st.leads).toHaveLength(40);
    expect(st.opportunities).toHaveLength(60);
    expect(st.opportunities.filter((o) => o.wonAt)).toHaveLength(14);
    expect(st.opportunities.filter((o) => o.lostAt)).toHaveLength(10);
  });

  it("shows a salesperson only their own records, a manager the team's, the CEO everything", async () => {
    const owners = async () => new Set((await call<S["SalesOpportunityPage"]>("GET", `${W}/opportunities`, undefined, { limit: 200 })).data.map((o) => o.ownerId));
    expect([...(await owners())]).toEqual(["u_abel"]);
    as("u_dawit");
    expect(await owners()).toEqual(new Set(["u_abel", "u_meron"]));
    as("u_selam");
    expect((await owners()).size).toBe(4);
  });

  it("answers 404 for a record outside the view scope and 403 module_disabled when sales is off", async () => {
    const other = salesStore(getDB()).companies.find((c) => c.ownerId === "u_yonas")!;
    expect((await failure(call("GET", `/sales/companies/${other.id}`))).status).toBe(404);
    as("u_alex");
    await call("PUT", "/workspaces/platform/modules/sales", { enabled: false });
    const e = await failure(call("GET", `/sales/companies/${other.id}`));
    expect([e.status, e.code]).toEqual([403, "module_disabled"]);
  });
});

describe("opportunities", () => {
  it("moves with the version and answers 409 version_conflict on a stale one", async () => {
    const page = await call<S["SalesPipeline"]>("GET", `${W}/pipeline`);
    const card = page.stages[0]!.opportunities[0]!;
    const target = page.stages[1]!.stage.id;
    const moved = await call<S["SalesOpportunity"]>("POST", `/sales/opportunities/${card.id}/move`, { stageId: target, version: card.version });
    expect(moved).toMatchObject({ stageId: target, version: card.version + 1 });
    const e = await failure(call("POST", `/sales/opportunities/${card.id}/move`, { stageId: page.stages[2]!.stage.id, version: card.version }));
    expect([e.status, e.code]).toEqual([409, "version_conflict"]);
    expect((e.details as { current: S["SalesOpportunity"] }).current.version).toBe(card.version + 1);
  });

  it("wins and credits the owner; reopen needs Sales Admin", async () => {
    const card = (await call<S["SalesPipeline"]>("GET", `${W}/pipeline`)).stages[0]!.opportunities[0]!;
    const won = await call<S["SalesOpportunity"]>("POST", `/sales/opportunities/${card.id}/won`, {});
    expect(won).toMatchObject({ status: "won", creditedUserId: "u_abel", wonValue: card.expectedValue });
    expect((await failure(call("POST", `/sales/opportunities/${card.id}/reopen`, {}))).status).toBe(403);
    as("u_kal");
    expect(await call<S["SalesOpportunity"]>("POST", `/sales/opportunities/${card.id}/reopen`, {})).toMatchObject({ status: "open", creditedUserId: null });
  });
});

describe("lead conversion", () => {
  it("creates the company, contact and opportunity and links the lead", async () => {
    const lead = await call<S["SalesLead"]>("POST", `${W}/leads`, { companyName: "Blue Nile Coffee PLC", contactName: "Tigist Haile", phone: "+251 911 000 111", estimatedValue: "150000.00" });
    const r = await call<S["SalesLeadConvertResult"]>("POST", `/sales/leads/${lead.id}/convert`, {});
    expect(r).toMatchObject({ companyCreated: true, contactCreated: true, company: { name: "Blue Nile Coffee PLC", ownerId: "u_abel" }, contact: { name: "Tigist Haile", isPrimary: true } });
    expect(r.opportunity).toMatchObject({ expectedValue: "150000.00", sourceLeadId: lead.id, status: "open", stage: { name: "Opportunity" } });
    expect(r.lead).toMatchObject({ status: "converted", convertedOpportunityId: r.opportunity.id, companyId: r.company.id });
    expect((await failure(call("POST", `/sales/leads/${lead.id}/convert`, {}))).code).toBe("lead_converted");
  });
});

describe("follow-ups", () => {
  it("buckets pending follow-ups and completes one with an activity and the next", async () => {
    const all = await call<S["SalesFollowUpPage"]>("GET", `${W}/follow-ups`, undefined, { limit: 200 });
    expect(all.counts.overdue).toBeGreaterThan(0);
    expect(all.counts.today).toBeGreaterThan(0);
    const today = wsToday(getDB(), "ws_platform");
    const due = await call<S["SalesFollowUpPage"]>("GET", `${W}/follow-ups`, undefined, { bucket: "today" });
    expect(due.data.every((f) => f.dueDate === today && f.bucket === "today")).toBe(true);
    expect(due.counts).toEqual(all.counts);

    const f = due.data[0]!;
    const r = await call<S["SalesFollowUpCompleteResult"]>("POST", `/sales/follow-ups/${f.id}/complete`, { activity: { type: "call", summary: "Spoke to the buyer" }, createNext: { dueDate: today } });
    expect(r.followUp).toMatchObject({ status: "done", bucket: null, completedActivityId: r.activity!.id });
    expect(r.next).toMatchObject({ status: "pending", targetId: f.targetId, bucket: "today" });
    expect((await failure(call("POST", `/sales/follow-ups/${f.id}/complete`, {}))).code).toBe("invalid_transition");
  });
});

describe("daily reports", () => {
  it("builds today's draft from the day's work, submits once and gets reviewed by the manager", async () => {
    const draft = await call<S["SalesDailyReport"]>("GET", `${W}/daily-reports/me/today`);
    expect(draft).toMatchObject({ status: "draft", user: { id: "u_abel" }, canEdit: true });
    expect(draft.metrics.calls + draft.metrics.visits + draft.metrics.meetings).toBeGreaterThanOrEqual(0);
    await call("PUT", `/sales/daily-reports/${draft.id}`, { comments: ["Busy day"], tomorrowPlan: [{ text: "Call Abay" }] });
    const sent = await call<S["SalesDailyReport"]>("POST", `/sales/daily-reports/${draft.id}/submit`);
    expect(sent).toMatchObject({ status: "submitted", comments: ["Busy day"] });
    expect((await failure(call("POST", `/sales/daily-reports/${draft.id}/submit`))).code).toBe("report_submitted");
    expect((await failure(call("POST", `/sales/daily-reports/${draft.id}/review`, {}))).status).toBe(403);
    as("u_dawit");
    expect(await call<S["SalesDailyReport"]>("POST", `/sales/daily-reports/${draft.id}/review`, { comment: "Good" })).toMatchObject({ status: "reviewed", reviewedBy: { id: "u_dawit" } });
    const team = await call<S["SalesTeamDailyReport"]>("GET", `${W}/daily-reports/team`);
    expect(team.users.map((u) => u.user.id).sort()).toEqual(["u_abel", "u_dawit", "u_meron"]);
  });
});

describe("insights", () => {
  it("computes the dashboard, effective targets and a report with the shapes of the schema", async () => {
    const d = await call<S["SalesDashboard"]>("GET", `${W}/dashboard`);
    expect(d).toMatchObject({ scope: "own", userCount: 1 });
    expect(Number(d.kpis.target)).toBeGreaterThan(0);
    const eff = await call<S["SalesEffectiveTargets"]>("GET", `${W}/targets/effective`);
    expect(Number(eff.year.target)).toBeCloseTo(7_200_000, 0);
    as("u_selam");
    const rep = await call<S["SalesReport"]>("GET", `${W}/reports/ranking`);
    expect(rep.rows.length).toBeGreaterThanOrEqual(4);
    const csv = await call<Blob>("GET", `${W}/reports/ranking`, undefined, { format: "csv" });
    expect(csv.type).toContain("text/csv");
    expect(await csv.text()).toContain('"Salesperson"');
    as("u_abel");
    expect((await failure(call("GET", `${W}/reports/ranking`))).status).toBe(403);
  });
});
