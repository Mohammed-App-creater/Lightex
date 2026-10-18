import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountAs, resetMock } from "../dashboard/test-utils";
import { ReportScreen } from "./report-screen";
import { ReportsScreen } from "./reports-screen";

const search = vi.hoisted(() => ({ value: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/platform/sales/reports",
  useSearchParams: () => new URLSearchParams(search.value),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

beforeEach(() => {
  resetMock();
  search.value = "";
});
afterEach(cleanup);

describe("Reports", () => {
  it("lists the catalogue in groups and carries the filters into the links", async () => {
    search.value = "period=year";
    await mountAs("u_selam", <ReportsScreen />);
    expect(await screen.findByText("Pipeline and leads")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Ranking/ })).toHaveAttribute("href", "/platform/sales/reports/ranking?period=year");
  });

  it("renders a report table with totals and the CSV button", async () => {
    await mountAs("u_selam", <ReportScreen reportKey="daily-sales" />);
    const table = await screen.findByRole("table", { name: "Daily sales" });
    expect(table).toHaveTextContent("Achievement %");
    expect(table).toHaveTextContent("Total");
    expect(screen.getByRole("button", { name: /Export CSV/ })).toBeInTheDocument();
  });

  it("asks for a range when custom is incomplete", async () => {
    search.value = "period=custom&from=2026-10-01";
    await mountAs("u_selam", <ReportScreen reportKey="daily-sales" />);
    expect(await screen.findByText("Pick a date range")).toBeInTheDocument();
  });
});
