import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountAs, resetMock } from "../dashboard/test-utils";
import { PerformanceScreen } from "./performance-screen";
import { PerformanceUserScreen } from "./performance-user-screen";

vi.mock("next/navigation", () => ({
  usePathname: () => "/platform/sales/performance",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

beforeEach(resetMock);
afterEach(cleanup);

describe("Performance", () => {
  it("ranks a manager's team", async () => {
    await mountAs("u_dawit", <PerformanceScreen />);
    const table = await screen.findByRole("table", { name: "Ranking" });
    expect(table).toHaveTextContent("Abel Kebede");
    expect(table).toHaveTextContent("Meron Alemu");
    expect(table).not.toHaveTextContent("Yonas Haile");
  });

  it("shows a person's KPIs and effective targets", async () => {
    await mountAs("u_abel", <PerformanceUserScreen userId="u_abel" />);
    expect(await screen.findByText("Abel Kebede")).toBeInTheDocument();
    expect(await screen.findByText("Conversion rate")).toBeInTheDocument();
    const targets = await screen.findByRole("table", { name: "Effective targets" });
    expect(targets).toHaveTextContent("Quarter");
  });

  it("says not found for someone outside the view", async () => {
    await mountAs("u_abel", <PerformanceUserScreen userId="u_liya" />);
    expect(await screen.findByText("Person not found")).toBeInTheDocument();
  });
});
