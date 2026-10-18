import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api/endpoints";
import { addDaysISO, todayISO } from "@/lib/utils/dates";
import { mountSales, resetMock } from "../activities/test-utils";
import { FollowUpsScreen } from "./follow-ups-screen";

const search = { value: "" };
vi.mock("next/navigation", () => ({
  usePathname: () => "/platform/sales/follow-ups",
  useSearchParams: () => new URLSearchParams(search.value),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/platform/auth/session", () => {
  const user = { id: "u_alex", name: "Alex Kim", hue: 210 };
  return { useSession: () => ({ user, status: "authenticated" }), useMe: () => user };
});
vi.mock("@/ui/toast", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), success: vi.fn() }), Toaster: () => null }));

beforeEach(resetMock);
afterEach(cleanup);

describe("FollowUpsScreen", () => {
  it("shows the bucket counts from the API on the tabs", async () => {
    search.value = "";
    await mountSales(<FollowUpsScreen />);
    const page = await api.sales.followUps.list("platform", { filter: { status: "pending" } });
    const tabs = await screen.findByRole("tablist", { name: "Follow-up buckets" });
    await waitFor(() => expect(within(tabs).getByRole("tab", { name: /Overdue/ }).textContent).toBe(`Overdue${page.counts.overdue}`));
    expect(within(tabs).getByRole("tab", { name: /Today/ }).textContent).toBe(`Today${page.counts.today}`);
    expect(within(tabs).getByRole("tab", { name: /Upcoming/ }).textContent).toBe(`Upcoming${page.counts.upcoming}`);
    expect(within(tabs).getByRole("tab", { name: /Today/ })).toHaveAttribute("aria-selected", "true");
  });

  it("completes a follow-up and schedules the next one", async () => {
    search.value = "bucket=all";
    await mountSales(<FollowUpsScreen />);
    const btn = (await screen.findAllByRole("button", { name: /^Complete / }))[0]!;
    const title = btn.getAttribute("aria-label")!.replace(/^Complete /, "");
    const before = (await api.sales.followUps.list("platform", { bucket: "all", filter: { status: "pending" }, limit: 100 })).data.find((f) => f.title === title)!;
    await userEvent.click(btn);
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("switch", { name: "Schedule the next follow-up" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Complete" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const done = await api.sales.followUps.get(before.id);
    expect(done.status).toBe("done");
    const next = (await api.sales.followUps.list("platform", { filter: { target: before.targetId, status: "pending" } })).data;
    expect(next.some((f) => f.dueDate === addDaysISO(todayISO(), 7) && f.id !== before.id)).toBe(true);
  });
});
