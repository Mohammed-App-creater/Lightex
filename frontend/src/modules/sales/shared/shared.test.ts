import { describe, expect, expectTypeOf, it } from "vitest";
import type { SalesCompany, SalesListQuery, SalesRes } from "@/api/types";
import { addMoney, formatMoney, formatPct, fromCents, subMoney, toCents } from "./money";
import { SALES_NAV, salesNavItems } from "./nav";
import { salesAreaOf } from "./routes";

describe("money", () => {
  it("formats ETB decimal strings without floats", () => {
    expect(formatMoney("250000.50")).toBe("ETB 250,000.50");
    expect(formatMoney("1000000.00")).toBe("ETB 1,000,000");
    expect(formatMoney("1000000.00", { cents: true })).toBe("ETB 1,000,000.00");
    expect(formatMoney("0.10", { currency: false })).toBe("0.10");
    expect(formatMoney("-1234.5")).toBe("-ETB 1,234.50");
    expect(formatMoney(null)).toBe("—");
    // Beyond 2^53: still exact.
    expect(formatMoney("90071992547409930.99")).toBe("ETB 90,071,992,547,409,930.99");
  });

  it("compacts large amounts", () => {
    expect(formatMoney("1250000.00", { compact: true })).toBe("ETB 1.3M");
    expect(formatMoney("350000", { compact: true })).toBe("ETB 350K");
    expect(formatMoney("999.99", { compact: true })).toBe("ETB 999.99");
    expect(formatMoney("2000000000", { compact: true })).toBe("ETB 2B");
  });

  it("adds and subtracts in cents", () => {
    expect(addMoney("0.10", "0.20")).toBe("0.30");
    expect(subMoney("100.00", "250.25")).toBe("-150.25");
    expect(fromCents(toCents("12.3"))).toBe("12.30");
  });

  it("formats percentages", () => {
    expect(formatPct(72.46)).toBe("72.5%");
    expect(formatPct(null)).toBe("—");
  });

  it("types queries and answers from the schema", () => {
    expectTypeOf<SalesRes<"sales_companies_list">["nextCursor"]>().toEqualTypeOf<string | null>();
    expectTypeOf<SalesRes<"sales_companies_list">["data"][number]["name"]>().toEqualTypeOf<SalesCompany["name"]>();
    const q: SalesListQuery<"sales_companies_list"> = { filter: { status: "active", owner: ["me"] }, q: "abay", sort: "-createdAt" };
    // @ts-expect-error unknown status
    const bad: SalesListQuery<"sales_companies_list"> = { filter: { status: "bogus" } };
    expect([q, bad]).toHaveLength(2);
  });
});

describe("sales nav", () => {
  it("hides the section without any sales code", () => {
    expect(salesNavItems(["core.workspace.view", "tracking.project.create"])).toEqual([]);
    expect(salesNavItems(undefined)).toEqual([]);
  });

  it("gates each item by its own permission", () => {
    const salesperson = ["sales.dashboard.view", "sales.lead.view", "sales.dailyreport.submit", "sales.dailyreport.view"];
    expect(salesNavItems(salesperson).map((i) => i.label)).toEqual(["Dashboard", "Leads", "Daily report", "Team reports"]);
    expect(salesNavItems(SALES_NAV.map((i) => i.permission))).toHaveLength(SALES_NAV.length);
    expect(salesNavItems(["sales.settings.manage"]).map((i) => i.area)).toEqual(["settings"]);
  });

  it("finds the active area from the path", () => {
    expect(salesAreaOf("/platform/sales")).toBe("dashboard");
    expect(salesAreaOf("/platform/sales/opportunities/o1")).toBe("pipeline");
    expect(salesAreaOf("/platform/sales/daily-reports")).toBe("dailyReports");
    expect(salesAreaOf("/platform/my-tasks")).toBeNull();
  });
});
