import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountSales, resetMock } from "../settings/test-mount";
import { TargetsScreen } from "./targets-screen";

vi.mock("next/navigation", () => ({ usePathname: () => "/platform/sales/targets", useSearchParams: () => new URLSearchParams() }));

beforeEach(() => resetMock("u_selam"));
afterEach(cleanup);

describe("TargetsScreen", () => {
  it("shows the allocation tree and a live gap in manual allocation", async () => {
    await mountSales(<TargetsScreen />);
    await screen.findByRole("table", { name: "Target allocation" });
    expect(await screen.findByText("Effective targets")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: /^Allocate / })[0]!);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Manual" }));
    expect(within(dialog).getByText(/Year gap:/).textContent).toMatch(/Balanced/);
    const q1 = within(dialog).getAllByLabelText("Quarter")[0] as HTMLInputElement;
    fireEvent.change(q1, { target: { value: "0" } });
    expect(within(dialog).getByText(/Year gap:/).textContent).toMatch(/left/);
    fireEvent.change(q1, { target: { value: "999999999" } });
    expect(within(dialog).getByText(/Year gap:/).textContent).toMatch(/Over by/);
  });
});
