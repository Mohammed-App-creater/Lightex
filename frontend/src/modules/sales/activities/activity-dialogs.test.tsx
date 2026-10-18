import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api/endpoints";
import { QUICK_ACTION_DIALOGS } from "../shared/quick-actions";
import { LogActivityDialog } from "./activity-dialogs";
import { mountSales, resetMock } from "./test-utils";

vi.mock("next/navigation", () => ({ usePathname: () => "/platform/sales", useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/platform/auth/session", () => {
  const user = { id: "u_alex", name: "Alex Kim", hue: 210 };
  return { useSession: () => ({ user, status: "authenticated" }), useMe: () => user };
});
vi.mock("@/ui/toast", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), success: vi.fn() }), Toaster: () => null }));

beforeEach(resetMock);
afterEach(cleanup);

describe("LogActivityDialog", () => {
  it("is registered for the quick actions", () => {
    expect(Object.keys(QUICK_ACTION_DIALOGS).sort()).toEqual(["add-follow-up", "log-call", "log-visit"]);
  });

  it("logs a visit on the prefilled record with a follow-up", async () => {
    const co = (await api.sales.companies.list("platform", {})).data[0]!;
    const onClose = vi.fn();
    await mountSales(<LogActivityDialog target={{ targetType: "sales.company", targetId: co.id, name: co.name }} onClose={onClose} defaultType="visit" />);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(co.name)).toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: "Visit" })).toHaveAttribute("aria-checked", "true");
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Summary" }), "Site visit");
    await userEvent.click(within(dialog).getByRole("switch", { name: "Add a follow-up" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const acts = (await api.sales.activities.list("platform", { filter: { target: co.id } })).data;
    expect(acts.some((a) => a.type === "visit" && a.summary === "Site visit")).toBe(true);
  });
});
