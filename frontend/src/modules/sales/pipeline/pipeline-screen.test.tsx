import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { calls, mountSales, resetMock } from "./test-utils";
import { PipelineScreen } from "./pipeline-screen";

vi.mock("next/navigation", () => ({ usePathname: () => "/platform/sales/pipeline", useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/ui/toast", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), success: vi.fn() }) }));

beforeEach(() => resetMock());
afterEach(cleanup);

describe("PipelineScreen", () => {
  it("renders open-stage columns with totals and marks a deal won from the card menu", async () => {
    await mountSales(<PipelineScreen />);
    const stages = await screen.findByRole("list", { name: "Pipeline stages" });
    const columns = within(stages).getAllByRole("listitem").filter((el) => el.tagName === "SECTION");
    expect(columns.length).toBeGreaterThan(1);
    expect(screen.getByText(/open deals/)).toBeInTheDocument();
    const [trigger] = screen.getAllByRole("button", { name: /^Actions for / });
    await userEvent.click(trigger!);
    await userEvent.click(await screen.findByRole("menuitem", { name: "Mark won…" }));
    await userEvent.click(await screen.findByRole("button", { name: "Mark won" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && /\/sales\/opportunities\/[^/]+\/won$/.test(c.path))).toBe(true));
    const won = calls.find((c) => c.path.endsWith("/won"))!;
    expect(won.body).toMatchObject({ version: expect.any(Number), wonValue: expect.any(String) });
  });
});
