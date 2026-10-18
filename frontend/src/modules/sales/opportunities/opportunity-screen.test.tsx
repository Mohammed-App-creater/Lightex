import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SalesOpportunity } from "@/api/types";
import { calls, mountSales, resetMock, transport } from "../pipeline/test-utils";
import { OpportunityScreen } from "./opportunity-screen";

vi.mock("next/navigation", () => ({ usePathname: () => "/platform/sales/opportunities/x", useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/ui/toast", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), success: vi.fn() }) }));

beforeEach(() => resetMock());
afterEach(cleanup);

describe("OpportunityScreen", () => {
  it("shows the deal and moves it to another stage with its version", async () => {
    await transport.request({ method: "PUT", path: "/workspaces/platform/modules/sales", body: { enabled: true } });
    const page = await transport.request<{ data: SalesOpportunity[] }>({ method: "GET", path: "/sales/workspaces/platform/opportunities", query: { filter: { status: ["open"] }, limit: 1 } });
    const opp = page.data[0]!;
    await mountSales(<OpportunityScreen id={opp.id} />);
    expect(await screen.findByRole("heading", { name: opp.title })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: new RegExp(`^Stage: ${opp.stage.name}`) }));
    const target = (await screen.findAllByRole("menuitem")).find((el) => el.getAttribute("aria-disabled") !== "true" && el.getAttribute("data-disabled") == null)!;
    await userEvent.click(target);
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === `/sales/opportunities/${opp.id}/move`)).toBe(true));
    expect(calls.find((c) => c.path.endsWith("/move"))!.body).toMatchObject({ version: opp.version });
  });
});
