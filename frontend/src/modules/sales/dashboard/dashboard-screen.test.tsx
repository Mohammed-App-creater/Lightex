import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardScreen } from "./dashboard-screen";
import { mountAs, resetMock } from "./test-utils";

vi.mock("next/navigation", () => ({
  usePathname: () => "/platform/sales",
  useSearchParams: () => new URLSearchParams("period=quarter"),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

beforeEach(resetMock);
afterEach(cleanup);

describe("DashboardScreen", () => {
  it("shows the CEO the company view with team and person filters", async () => {
    await mountAs("u_selam", <DashboardScreen />);
    expect(await screen.findByText("Conversion rate")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Sales dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Quarter" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Team")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Person: Everyone/ })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Ranking" })).toBeInTheDocument();
  });

  it("shows a salesperson their own view with today's target", async () => {
    await mountAs("u_abel", <DashboardScreen />);
    expect(await screen.findByRole("heading", { name: "My sales" })).toBeInTheDocument();
    expect(await screen.findByText("Today’s target")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Person:/ })).not.toBeInTheDocument();
  });
});
