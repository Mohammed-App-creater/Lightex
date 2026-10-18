import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api/endpoints";
import { mountSales, resetMock } from "../activities/test-utils";
import { CompaniesScreen } from "./companies-screen";

const search = { value: "" };
vi.mock("next/navigation", () => ({
  usePathname: () => "/platform/sales/companies",
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

describe("CompaniesScreen", () => {
  it("lists companies", async () => {
    search.value = "";
    await mountSales(<CompaniesScreen />);
    const first = (await api.sales.companies.list("platform", {})).data[0]!;
    expect(await screen.findByText(first.name)).toBeInTheDocument();
  });

  it("warns about a duplicate while creating", async () => {
    search.value = "new=1";
    await mountSales(<CompaniesScreen />);
    const existing = (await api.sales.companies.list("platform", {})).data[0]!;
    const name = await screen.findByRole("textbox", { name: "Name" });
    await userEvent.type(name, "Brand new unique co");
    expect(screen.queryByText(/already exists/)).not.toBeInTheDocument();
    await userEvent.clear(name);
    await userEvent.type(name, `${existing.name.toUpperCase()} PLC`);
    expect(await screen.findByText(/already exists/, {}, { timeout: 3000 })).toBeInTheDocument();
  });
});
