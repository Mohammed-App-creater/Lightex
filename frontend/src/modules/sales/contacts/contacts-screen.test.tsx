import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api/endpoints";
import { mountSales, resetMock } from "../activities/test-utils";
import { ContactsScreen } from "./contacts-screen";

const search = { value: "" };
vi.mock("next/navigation", () => ({
  usePathname: () => "/platform/sales/contacts",
  useSearchParams: () => new URLSearchParams(search.value),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/platform/auth/session", () => {
  const user = { id: "u_alex", name: "Alex Kim", hue: 210 };
  return { useSession: () => ({ user, status: "authenticated" }), useMe: () => user };
});
vi.mock("@/ui/toast", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), success: vi.fn() }), Toaster: () => null }));

beforeEach(resetMock);
afterEach(cleanup);

describe("ContactsScreen", () => {
  it("lists contacts and opens one from ?contact=", async () => {
    const c = (await api.sales.contacts.list("platform", {})).data[0]!;
    search.value = `contact=${c.id}`;
    await mountSales(<ContactsScreen />);
    expect((await screen.findAllByText(c.name)).length).toBeGreaterThan(0);
    expect(await screen.findByRole("dialog", { name: c.name })).toBeInTheDocument();
  });
});
