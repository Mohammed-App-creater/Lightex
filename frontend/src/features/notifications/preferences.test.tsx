import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setTransport } from "@/lib/api/client";
import type { NotificationChannel, Workspace } from "@/lib/api/types";
import { mockControls } from "@/lib/mock/controls";
import { getDB, mockSession, resetDB } from "@/lib/mock/db";
import { MockTransport } from "@/lib/mock/transport";
import { WorkspaceScope } from "@/lib/permissions/can";
import { columnStates, defaultPreferences, pushView, type ColumnState } from "./channels/model";
import { PreferencesMatrix } from "./channels/preferences-matrix";
import { fakePushPlatform, setPushPlatform } from "./channels/push";
import { resetPushLocal } from "./channels/use-push";
import { NotificationPreferencesPage } from "./preferences";

/* Board 38 components (§9.2): the matrix, the page (channels, admin row, quiet hours), SMS / Telegram / push flows, Send test. */

const me = { current: { id: "u_alex", email: "alex@team.dev", name: "Alex Kim" } };
vi.mock("@/features/auth/session", () => ({ useMe: () => me.current }));
// next/dynamic doesn't resolve under jsdom: the same code split through React.lazy.
vi.mock("@/lib/hooks/lazy-with-preload", async () => {
  const React = await import("react");
  return {
    whenIdle: () => () => {},
    lazyWithPreload: <P extends object>(load: () => Promise<React.ComponentType<P>>) => {
      const Lazy = React.lazy(() => load().then((c) => ({ default: c })));
      return { Component: (p: P) => React.createElement(React.Suspense, { fallback: null }, React.createElement(Lazy, p)), preload: () => {} };
    },
  };
});

const transport = new MockTransport();

beforeEach(() => {
  resetDB();
  resetPushLocal();
  setPushPlatform(fakePushPlatform({ support: "unsupported" }).platform);
  mockControls.set((c) => ({ ...c, errorRate: 0, latencyMin: 0, latencyMax: 0, offline: false, teammates: false, realtime: "polling", telegramManual: true, channelFailures: false }));
  setTransport(transport);
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {}, onchange: null, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  globalThis.requestAnimationFrame ??= ((cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number) as typeof requestAnimationFrame;
});
afterEach(() => {
  cleanup();
  setPushPlatform(null);
});

async function mount(user: "u_alex" | "u_sam" | "u_taylor") {
  mockSession.set(user);
  me.current = { id: user, email: `${user.slice(2)}@team.dev`, name: user };
  const ws = await transport.request<Workspace>({ method: "GET", path: "/workspaces/platform" });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  qc.setQueryData(["workspace", "platform"], ws);
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <WorkspaceScope workspace={ws}>
          <NotificationPreferencesPage />
        </WorkspaceScope>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  await screen.findByRole("table", { name: "Notification preferences" });
  return qc;
}

const row = (channel: string) => document.querySelector(`li[data-channel="${channel}"]`) as HTMLElement;

describe("PreferencesMatrix", () => {
  const live: ColumnState = { usable: true, note: null, reason: "" };
  const cols = (p: Partial<Record<NotificationChannel, ColumnState>>): Record<NotificationChannel, ColumnState> => ({
    in_app: live,
    email: live,
    telegram: { usable: false, note: "connect", reason: "not connected" },
    sms: { usable: false, note: "policy", reason: "off by admin" },
    push: { usable: false, note: "blocked", reason: "blocked in browser" },
    ...p,
  });

  it("has 30 cells; live switches only for usable channels; dead cells are images with no input", async () => {
    const onToggle = vi.fn();
    const onConnect = vi.fn();
    render(<PreferencesMatrix prefs={defaultPreferences()} columns={cols({})} onToggle={onToggle} onConnect={onConnect} />);
    expect(screen.getAllByRole("cell")).toHaveLength(30);
    expect(screen.getAllByRole("switch")).toHaveLength(12);
    const dead = screen.getByRole("img", { name: "Mentioned, Telegram: not connected" });
    expect(dead.tagName).toBe("SPAN");
    expect(dead.querySelector("input, button")).toBeNull();
    expect(screen.getByRole("img", { name: "Due soon, SMS: off by admin" })).toBeInTheDocument();
    await userEvent.click(dead);
    expect(onToggle).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("switch", { name: "New comment, Email" }));
    expect(onToggle).toHaveBeenCalledWith("comment", "email", true);
    await userEvent.click(screen.getByRole("button", { name: "Connect Telegram" }));
    expect(onConnect).toHaveBeenCalledWith("telegram");
    expect(screen.getByText("Off by admin")).toBeInTheDocument();
    expect(screen.getByText("Blocked")).toBeInTheDocument();
  });

  it("renders the live channel's stored values and short labels for narrow screens", () => {
    render(<PreferencesMatrix prefs={defaultPreferences()} columns={cols({ telegram: live })} onToggle={() => {}} />);
    expect(screen.getByRole("switch", { name: "Assigned to me, Telegram" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Status change on my tasks, Telegram" })).not.toBeChecked();
    expect([...document.querySelectorAll("[data-short]")].map((e) => e.textContent)).toEqual(["App", "Mail", "TG", "SMS", "Push"]);
  });

  it("derives the columns from C1 (columnStates feeds the matrix)", () => {
    const off = pushView({ support: "supported", permission: "default", localHash: null, devices: [], prompting: false });
    const c = columnStates({ channels: undefined, channelsError: true, smsPolicy: true, push: off });
    render(<PreferencesMatrix prefs={defaultPreferences()} columns={c} onToggle={() => {}} onRetry={() => {}} />);
    expect(screen.getAllByRole("button", { name: /unavailable\. Retry$/ })).toHaveLength(3);
  });
});

describe("Notifications page", () => {
  it("shows u_alex's channels, the admin SMS row and a live Telegram / Push column", async () => {
    await mount("u_alex");
    expect(within(row("telegram")).getByText("@alexkim")).toBeInTheDocument();
    expect(within(row("email")).getByText("alex@team.dev")).toBeInTheDocument();
    expect(within(row("sms")).getByText("Not connected")).toBeInTheDocument();
    expect(within(row("push")).getByText("Not supported in this browser")).toBeInTheDocument();
    expect(screen.getByText("SMS for Platform team")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Mentioned, Telegram" })).toBeChecked();
    // Another browser (the seeded Mac) keeps the Push column live.
    expect(screen.getByRole("switch", { name: "Mentioned, Push" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Mentioned, SMS: not connected" })).toBeInTheDocument();
    expect(screen.getByTestId("quiet-summary")).toHaveTextContent("22:00–08:00 · every day · New York");
    expect(screen.queryByText("Coming soon")).toBeNull();
  });

  it("has no admin row without workspace.update (u_sam) and shows Off by admin when the policy is off", async () => {
    getDB().workspaces.find((w) => w.slug === "platform")!.smsEnabled = false;
    await mount("u_sam");
    expect(screen.queryByText(/SMS for/)).toBeNull();
    expect(within(row("sms")).getByText("Off by admin")).toBeInTheDocument();
    expect(within(row("sms")).queryByRole("button")).toBeNull();
    expect(screen.getByRole("img", { name: "Due soon, SMS: off by admin" })).toBeInTheDocument();
  });

  it("toggles the workspace SMS policy (optimistic PATCH)", async () => {
    await mount("u_alex");
    await userEvent.click(screen.getByRole("switch", { name: "Allow SMS for the workspace" }));
    await waitFor(() => expect(getDB().workspaces.find((w) => w.slug === "platform")!.smsEnabled).toBe(false));
    expect(within(row("sms")).getByText("Off by admin")).toBeInTheDocument();
  });

  it("saves a matrix toggle and quiet-hours changes through the debounced save", async () => {
    await mount("u_alex");
    await userEvent.click(screen.getByRole("switch", { name: "New comment, Telegram" }));
    expect(screen.getByText("Saving")).toBeInTheDocument();
    await screen.findByText("Saved", undefined, { timeout: 3000 });
    expect(getDB().prefs.find((p) => p.userId === "u_alex")!.prefs.events.comment.telegram).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Saturday" }));
    await userEvent.click(screen.getByRole("button", { name: "Sunday" }));
    expect(screen.getByTestId("quiet-summary")).toHaveTextContent("Mon–Fri");
    await userEvent.click(screen.getByRole("switch", { name: "Urgent still notifies" }));
    await waitFor(() => expect(getDB().prefs.find((p) => p.userId === "u_alex")!.prefs.quietHours).toMatchObject({ urgentBypass: false, days: [true, true, true, true, true, false, false] }), { timeout: 3000 });
    expect(screen.getAllByRole("img", { name: "Quiet from 22:00 to 08:00" })[0]!.querySelectorAll("[data-seg]")).toHaveLength(2);
  });

  it("refuses From = To before saving", async () => {
    await mount("u_alex");
    const to = screen.getByLabelText("Quiet until");
    fireEvent.change(to, { target: { value: "22:00" } });
    fireEvent.blur(to);
    expect(await screen.findByText("End must differ from start")).toBeInTheDocument();
    expect(getDB().prefs.find((p) => p.userId === "u_alex")!.prefs.quietHours.to).toBe("08:00");
  });

  it("Send test: success toast + preview, and the 502 copy", async () => {
    await mount("u_alex");
    await userEvent.click(within(row("telegram")).getByRole("button", { name: "Send test" }));
    expect(await screen.findByText("Test sent · Telegram")).toBeInTheDocument();
    const pv = screen.getByRole("status", { name: "Notification preview" });
    expect(pv).toHaveTextContent("Lightex notifications will arrive in this chat.");
    expect(pv).not.toHaveTextContent("PRJ-42");
    mockControls.set((c) => ({ ...c, channelFailures: true }));
    await userEvent.click(within(row("telegram")).getByRole("button", { name: "Send test" }));
    expect(await screen.findByText("Couldn’t reach Telegram")).toBeInTheDocument();
    expect(screen.getByText("You blocked the bot. Unblock it and send /start.")).toBeInTheDocument();
    expect(await within(row("telegram")).findByText("Bot blocked in Telegram")).toBeInTheDocument();
    expect(within(row("telegram")).getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
  });

  it("disconnects Telegram from the row", async () => {
    await mount("u_alex");
    await userEvent.click(within(row("telegram")).getByRole("button", { name: "Disconnect Telegram" }));
    expect(await within(row("telegram")).findByText("Not connected")).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: "Mentioned, Telegram: not connected" })).toBeInTheDocument();
  });
});

describe("SMS dialog", () => {
  it("validates, sends, counts wrong codes, then verifies with a pasted 482913", async () => {
    await mount("u_sam");
    await userEvent.click(within(row("sms")).getByRole("button", { name: "Connect" }));
    const dialog = await screen.findByRole("dialog", { name: "Verify phone for SMS" }, { timeout: 5000 });
    const phone = within(dialog).getByLabelText("Phone number");
    await userEvent.type(phone, "415555{Enter}");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Enter 10 digits");
    await userEvent.type(phone, "0132");
    expect(phone).toHaveValue("(415) 555-0132");
    expect(within(dialog).getByText("Valid number")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Send code" }));
    expect(await within(dialog).findByText("+1 (415) 555-0132")).toBeInTheDocument();
    expect(within(dialog).getByText(/Resend in 0:(2|3)\d/)).toBeInTheDocument();
    const box = (n: number) => within(dialog).getByLabelText(`Digit ${n}`);
    expect(box(1)).toHaveAttribute("autocomplete", "one-time-code");
    expect(box(2)).toHaveAttribute("autocomplete", "off");
    fireEvent.paste(box(1), { clipboardData: { getData: () => "111111" } });
    expect(await within(dialog).findByText("Wrong code · 2 tries left")).toBeInTheDocument();
    expect(box(1)).toHaveValue("");
    fireEvent.paste(box(1), { clipboardData: { getData: () => "482913" } });
    expect(await within(dialog).findByText("verified", { exact: false })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(await within(row("sms")).findByText("+1 (415) 555-0132")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Due soon, SMS" })).toBeChecked();
  });

  it("locks after three wrong codes and shows the send failure for 555-0000", async () => {
    await mount("u_sam");
    await userEvent.click(within(row("sms")).getByRole("button", { name: "Connect" }));
    const dialog = await screen.findByRole("dialog", { name: "Verify phone for SMS" }, { timeout: 5000 });
    await userEvent.type(within(dialog).getByLabelText("Phone number"), "4155550000{Enter}");
    expect(await within(dialog).findByText("Couldn’t send a code to this number")).toBeInTheDocument();
    const phone = within(dialog).getByLabelText("Phone number");
    await userEvent.clear(phone);
    await userEvent.type(phone, "4155550132{Enter}");
    await within(dialog).findByLabelText("Digit 1");
    const steps = [
      ["111111", "Wrong code · 2 tries left"],
      ["222222", "Wrong code · 1 try left"],
      ["333333", "Too many tries · resend a code"],
    ];
    for (const [code, text] of steps) {
      // The boxes remount on every wrong code (the shake), so always query them fresh.
      await waitFor(() => expect(within(dialog).getByLabelText("Digit 1")).not.toHaveAttribute("readonly"));
      fireEvent.paste(within(dialog).getByLabelText("Digit 1"), { clipboardData: { getData: () => code } });
      expect(await within(dialog).findByText(text!)).toBeInTheDocument();
    }
    expect(within(dialog).getByLabelText("Digit 1")).toHaveAttribute("readonly");
  });
});

describe("Telegram dialog", () => {
  it("shows the code and deep link, links on a (mock) scan, and cancels when closed early", async () => {
    await mount("u_sam");
    await userEvent.click(within(row("telegram")).getByRole("button", { name: "Connect" }));
    const dialog = await screen.findByRole("dialog", { name: "Connect Telegram" }, { timeout: 5000 });
    expect(await within(dialog).findByRole("group", { name: "Link code K7MQ2X" })).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "Open Telegram" })).toHaveAttribute("href", expect.stringMatching(/^https:\/\/t\.me\/lightex_bot\?start=lx_mock/));
    expect(within(dialog).getByText("@lightex_bot")).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/^Code expires in (9:5\d|10:00)$/)).toBeInTheDocument();
    expect(within(row("telegram")).getByText("Waiting…")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(getDB().telegramLinks!.at(-1)!.status).toBe("canceled"));

    await userEvent.click(within(row("telegram")).getByRole("button", { name: "Connect" }));
    const again = await screen.findByRole("dialog", { name: "Connect Telegram" }, { timeout: 5000 });
    await within(again).findByRole("group", { name: /^Link code/ });
    await userEvent.click(within(again).getByRole("button", { name: "Simulate scan (mock)" }));
    expect(await within(again).findByText("Connected as", { exact: false })).toHaveTextContent("Connected as @sampatel");
    await userEvent.click(within(again).getByRole("button", { name: "Done" }));
    expect(await within(row("telegram")).findByText("@sampatel")).toBeInTheDocument();
  });

  it("offers New code once the code expires", async () => {
    await mount("u_sam");
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fireEvent.click(within(row("telegram")).getByRole("button", { name: "Connect" }));
      const dialog = await screen.findByRole("dialog", { name: "Connect Telegram" }, { timeout: 5000 });
      await within(dialog).findByRole("group", { name: "Link code K7MQ2X" });
      await act(async () => {
        vi.setSystemTime(Date.now() + 541_000);
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(within(dialog).getByLabelText(/^Code expires in 0:5\d$/)).toHaveAttribute("data-warn", "true");
      await act(async () => {
        vi.setSystemTime(Date.now() + 60_000);
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(within(dialog).getByRole("alert")).toHaveTextContent("Code expired");
      fireEvent.click(within(dialog).getByRole("button", { name: "New code" }));
      expect(await within(dialog).findByRole("group", { name: "Link code R4TZ9P" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Push row", () => {
  it("Enable → granted → On (This browser), Send test, Turn off", async () => {
    const f = fakePushPlatform({ answer: "granted" });
    setPushPlatform(f.platform);
    await mount("u_sam");
    expect(within(row("push")).getByText("Off")).toBeInTheDocument();
    await userEvent.click(within(row("push")).getByRole("button", { name: "Enable" }));
    expect(await within(row("push")).findByText("This browser")).toBeInTheDocument();
    expect(f.state.calls).toEqual(["requestPermission", "subscribe"]);
    expect(screen.getByRole("switch", { name: "Mentioned, Push" })).toBeInTheDocument();
    await userEvent.click(within(row("push")).getByRole("button", { name: "Send test" }));
    expect(await screen.findByText("Test sent · Push")).toBeInTheDocument();
    await userEvent.click(within(row("push")).getByRole("button", { name: "Turn off push in this browser" }));
    expect(await within(row("push")).findByText("Off")).toBeInTheDocument();
    expect(getDB().pushDevices!.filter((d) => d.userId === "u_sam")).toHaveLength(0);
  });

  it("denied → Blocked in browser → Check again stays blocked", async () => {
    setPushPlatform(fakePushPlatform({ answer: "denied" }).platform);
    await mount("u_sam");
    await userEvent.click(within(row("push")).getByRole("button", { name: "Enable" }));
    expect(await within(row("push")).findByText("Blocked in browser")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Mentioned, Push: blocked in browser" })).toBeInTheDocument();
    await userEvent.click(within(row("push")).getByRole("button", { name: "Check again" }));
    expect(await screen.findByText("Still blocked in browser")).toBeInTheDocument();
  });
});
