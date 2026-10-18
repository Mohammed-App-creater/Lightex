import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SalesStage } from "@/api/types";
import { SalesSettingsScreen } from "./settings-screen";
import { mountSales, resetMock, transport } from "./test-mount";

vi.mock("next/navigation", () => ({ usePathname: () => "/platform/sales/settings", useSearchParams: () => new URLSearchParams("tab=stages") }));

beforeEach(() => resetMock("u_alex"));
afterEach(cleanup);

describe("SalesSettingsScreen", () => {
  it("reorders open stages and keeps Won / Lost locked", async () => {
    await mountSales(<SalesSettingsScreen />);
    const list = await screen.findByRole("list", { name: "Stages" });
    expect(within(list).getAllByLabelText("Locked")).toHaveLength(2);
    fireEvent.click(await screen.findByRole("button", { name: "Move Quotation up" }));
    await waitFor(async () => {
      const stages = await transport.request<SalesStage[]>({ method: "GET", path: "/sales/workspaces/platform/stages" });
      expect(stages.filter((s) => s.category === "open").map((s) => s.name).slice(0, 2)).toEqual(["Quotation", "Opportunity"]);
    });
    await waitFor(() => expect((within(list).getAllByLabelText("Stage name")[0] as HTMLInputElement).value).toBe("Quotation"));
  });
});
