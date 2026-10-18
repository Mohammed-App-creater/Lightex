import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SalesLead } from "@/api/types";
import { calls, mountSales, resetMock, transport } from "../pipeline/test-utils";
import { LeadScreen } from "./lead-screen";

const push = vi.fn();
vi.mock("next/navigation", () => ({ usePathname: () => "/platform/sales/leads/x", useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push }) }));
vi.mock("@/ui/toast", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), success: vi.fn() }) }));

beforeEach(() => {
  resetMock();
  push.mockReset();
});
afterEach(cleanup);

describe("LeadScreen", () => {
  it("converts a qualified lead and navigates to the new opportunity", async () => {
    await transport.request({ method: "PUT", path: "/workspaces/platform/modules/sales", body: { enabled: true } });
    const page = await transport.request<{ data: SalesLead[] }>({ method: "GET", path: "/sales/workspaces/platform/leads", query: { filter: { status: ["qualified"] }, limit: 1 } });
    const lead = page.data[0]!;
    await mountSales(<LeadScreen id={lead.id} />);
    await userEvent.click(await screen.findByRole("button", { name: "Convert" }));
    expect(await screen.findByRole("dialog", { name: "Convert lead" })).toBeInTheDocument();
    if (!lead.companyId) await userEvent.click(screen.getByRole("button", { name: "Create new company" }));
    const buttons = screen.getAllByRole("button", { name: "Convert" });
    await userEvent.click(buttons[buttons.length - 1]!);
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(calls.some((c) => c.method === "POST" && c.path === `/sales/leads/${lead.id}/convert`)).toBe(true);
    expect(push.mock.calls[0]![0]).toMatch(/^\/platform\/sales\/opportunities\//);
  });
});
