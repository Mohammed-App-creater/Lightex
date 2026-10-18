import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SalesDailyReport } from "@/api/types";
import { mockSession } from "@/api/mock/db";
import { mountSales, resetMock, transport } from "../settings/test-mount";
import { DailyReportScreen } from "./daily-report-screen";
import { TeamReportsScreen } from "./team-reports-screen";

vi.mock("next/navigation", () => ({ usePathname: () => "/platform/sales/daily-report", useSearchParams: () => new URLSearchParams() }));

const today = () => transport.request<SalesDailyReport>({ method: "GET", path: "/sales/workspaces/platform/daily-reports/me/today" });

beforeEach(() => resetMock("u_abel"));
afterEach(cleanup);

describe("DailyReportScreen", () => {
  it("adds a comment and submits today's report", async () => {
    await mountSales(<DailyReportScreen />);
    expect(await screen.findByText("Quotations sent")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
    const box = screen.getAllByLabelText(/^Comment \d+$/).at(-1)!;
    fireEvent.change(box, { target: { value: "Visited three clients" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit report" }));
    await waitFor(async () => expect(await today()).toMatchObject({ status: "submitted" }));
    expect((await today()).comments).toContain("Visited three clients");
    expect(await screen.findByText("Submitted", { selector: "span" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit report" })).not.toBeInTheDocument();
  });
});

describe("TeamReportsScreen", () => {
  it("lets a manager review a submitted report", async () => {
    const r = await today();
    await transport.request({ method: "POST", path: `/sales/daily-reports/${r.id}/submit` });
    mockSession.set("u_dawit");
    await mountSales(<TeamReportsScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    fireEvent.change(await screen.findByLabelText("Comment (optional)"), { target: { value: "Nice work" } });
    fireEvent.click(screen.getByRole("button", { name: "Mark reviewed" }));
    await waitFor(async () => {
      const x = await transport.request<SalesDailyReport>({ method: "GET", path: `/sales/daily-reports/${r.id}` });
      expect(x).toMatchObject({ status: "reviewed", reviewComment: "Nice work" });
    });
  });
});

