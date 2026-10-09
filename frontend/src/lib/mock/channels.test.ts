import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/errors";
import type { ChannelTestResult, NotificationChannels, NotificationPreferences, PushDevice, SmsVerification, TelegramLink, Workspace } from "@/lib/api/types";
import { endpointHash } from "@/features/notifications/channels/sha256";
import { fanOut, releaseDue } from "./channels-dispatch";
import { mockControls } from "./controls";
import { getDB, mockSession, resetDB } from "./db";
import { CHANNEL_LIMITS, MOCK_SMS_CODE, TELEGRAM_CODES, channelTiming, ensureExt38, simulateSmsReply, simulateTelegramScan } from "./handlers/channels";
import { mockBus } from "./realtime";
import { MockTransport } from "./transport";

/* Board 38 mock (§8.8, §9.2 "Mock handlers"): every route, the limits, P1 merge, W1, and the dispatcher. */

const t = new MockTransport();
const as = (u: string) => mockSession.set(u);
const req = <T,>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown) => t.request<T>({ method, path, body });
async function err(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error("expected an ApiError");
}
const p256 = "BLc4xRzKlKORKWlbdgFaBrrPK3ydWAHo4M0gs0i1oEKgPpWC5cW8OCzVrOQRv-1npXRWk8udnW3oYhIO4475rds";
const auth = "5I2Bu2oKdyy9CwL8QVF0NQ";
const sub = (endpoint: string) => ({ endpoint, expirationTime: null, keys: { p256dh: p256, auth } });

beforeEach(() => {
  resetDB();
  mockBus.resetForTests();
  channelTiming.autoLinkMs = 5000;
  mockControls.set((c) => ({ ...c, errorRate: 0, latencyMin: 0, latencyMax: 0, offline: false, teammates: false, realtime: "polling", telegramManual: false, channelFailures: false }));
  as("u_alex");
});
afterEach(() => vi.useRealTimers());

describe("seed and ensureExt38", () => {
  it("gives u_alex Telegram @alexkim and push on Chrome on macOS; others nothing", async () => {
    const c = await req<NotificationChannels>("GET", "/me/notification-channels");
    expect(c.email.address).toBe("alex@team.dev");
    expect(c.telegram).toMatchObject({ available: true, botUsername: "lightex_bot", connection: { username: "alexkim", status: "active" } });
    expect(c.sms).toMatchObject({ available: true, connection: null, dailyCap: 10, sentToday: 0 });
    expect(c.sms.countries.map((x) => x.label)).toEqual(["US +1", "UK +44", "DE +49", "IN +91"]);
    expect(c.push.devices).toHaveLength(1);
    expect(c.push.devices[0]!.label).toBe("Chrome on macOS");
    expect(c.push.vapidPublicKey).toMatch(/^B/);
    as("u_sam");
    const s = await req<NotificationChannels>("GET", "/me/notification-channels");
    expect([s.telegram.connection, s.sms.connection, s.push.devices.length]).toEqual([null, null, 0]);
  });

  it("upgrades a cached database once: channel keys and quiet hours, in_app / email untouched", () => {
    const db = getDB();
    db.ext38 = false;
    db.prefs[0]!.prefs = { events: { ...db.prefs[0]!.prefs.events, assigned: { in_app: false, email: false } }, emailDelivery: "daily" } as unknown as NotificationPreferences;
    ensureExt38(db);
    expect(db.prefs[0]!.prefs.events.assigned).toEqual({ in_app: false, email: false, telegram: true, sms: false, push: true });
    expect(db.prefs[0]!.prefs.quietHours.from).toBe("22:00");
    expect(db.prefs.find((p) => p.userId === "u_alex")!.prefs.quietHours.timezone).toBe("America/New_York");
  });
});

describe("Telegram C2–C5", () => {
  it("409 while an active connection exists; after disconnect, a code that links itself after 5 s", async () => {
    expect((await err(req("POST", "/me/notification-channels/telegram/link", {}))).code).toBe("already_connected");
    await req("DELETE", "/me/notification-channels/telegram");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T09:12:44Z"));
    const l = await req<TelegramLink>("POST", "/me/notification-channels/telegram/link", { timezone: "Europe/Berlin" });
    expect(l).toMatchObject({ status: "pending", code: TELEGRAM_CODES[0], botUsername: "lightex_bot", expiresAt: "2026-10-09T09:22:44.000Z" });
    expect(l.deepLink).toMatch(/^https:\/\/t\.me\/lightex_bot\?start=lx_mock[a-z0-9]+$/);
    vi.setSystemTime(new Date("2026-10-09T09:12:48Z"));
    expect((await req<TelegramLink>("GET", `/me/notification-channels/telegram/link/${l.id}`)).status).toBe("pending");
    vi.setSystemTime(new Date("2026-10-09T09:12:50Z"));
    const linked = await req<TelegramLink>("GET", `/me/notification-channels/telegram/link/${l.id}`);
    expect(linked).toMatchObject({ status: "linked", connection: { username: "alexkim", firstName: "Alex", status: "active" } });
    expect(linked.code).toBeUndefined();
    expect(linked.deepLink).toBeUndefined();
  });

  it("manual mode waits for Simulate scan; codes expire after 10 min; a new code cancels the old; C4 cancels", async () => {
    as("u_sam");
    mockControls.set((c) => ({ ...c, telegramManual: true }));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T09:00:00Z"));
    const a = await req<TelegramLink>("POST", "/me/notification-channels/telegram/link", {});
    expect(a.code).toBe(TELEGRAM_CODES[0]);
    vi.setSystemTime(new Date("2026-10-09T09:05:00Z"));
    expect((await req<TelegramLink>("GET", `/me/notification-channels/telegram/link/${a.id}`)).status).toBe("pending");
    vi.setSystemTime(new Date("2026-10-09T09:10:00Z"));
    expect((await req<TelegramLink>("GET", `/me/notification-channels/telegram/link/${a.id}`)).status).toBe("expired");
    const b = await req<TelegramLink>("POST", "/me/notification-channels/telegram/link", {});
    const c = await req<TelegramLink>("POST", "/me/notification-channels/telegram/link", {});
    expect((await req<TelegramLink>("GET", `/me/notification-channels/telegram/link/${b.id}`)).status).toBe("canceled");
    expect(simulateTelegramScan("u_sam")).toBe("Telegram linked");
    expect((await req<TelegramLink>("GET", `/me/notification-channels/telegram/link/${c.id}`)).connection?.username).toBe("sampatel");
    const d = await err(req("GET", `/me/notification-channels/telegram/link/${c.id}`).then(() => { as("u_taylor"); return req("GET", `/me/notification-channels/telegram/link/${c.id}`); }));
    expect(d.status).toBe(404);
  });

  it("fills quiet hours' time zone once, from the connect call", async () => {
    as("u_sam");
    await req("POST", "/me/notification-channels/telegram/link", { timezone: "Europe/Berlin" });
    expect((await req<NotificationPreferences>("GET", "/notification-preferences")).quietHours.timezone).toBe("Europe/Berlin");
    await req("POST", "/me/notification-channels/telegram/link", { timezone: "Asia/Kolkata" });
    expect((await req<NotificationPreferences>("GET", "/notification-preferences")).quietHours.timezone).toBe("Europe/Berlin");
  });

  it("throttles connect calls at 20 per hour", async () => {
    as("u_sam");
    for (let i = 0; i < CHANNEL_LIMITS.connectHour; i++) await req("POST", "/me/notification-channels/telegram/link", {});
    const e = await err(req("POST", "/me/notification-channels/telegram/link", {}));
    expect([e.status, e.code]).toEqual([429, "throttled"]);
    expect(e.details).toHaveProperty("retryAt");
  });
});

describe("SMS C6–C9", () => {
  const start = (n = "4155550132", country = "US") => req<SmsVerification>("POST", "/me/notification-channels/sms/verifications", { country, nationalNumber: n });

  it("validates like the server", async () => {
    expect((await err(start("415555013"))).details).toEqual({ fields: { nationalNumber: "Enter 10 digits" } });
    expect((await err(start("2079460000", "GB"))).details).toEqual({ fields: { nationalNumber: "Enter a mobile number" } });
    expect((await err(start("612345678", "FR"))).details).toEqual({ fields: { country: "SMS isn’t available for this country" } });
    const e = await err(start("4155550000"));
    expect([e.status, e.code, e.details]).toEqual([502, "channel_send_failed", { channel: "sms", reason: "invalid_number" }]);
  });

  it("sends 482913 (and a dev toast), counts tries down, locks at 0, Resend resets", async () => {
    const seen: unknown[] = [];
    const off = mockBus.subscribe((e) => e.type === "mock.sms_code" && seen.push(e.data));
    const v = await start();
    off();
    expect(v).toMatchObject({ phoneNumber: "+14155550132", display: "+1 (415) 555-0132", attemptsLeft: 3 });
    expect(seen).toEqual([{ code: MOCK_SMS_CODE, display: "+1 (415) 555-0132" }]);
    const verify = (code: string) => req<{ connection: unknown }>("POST", `/me/notification-channels/sms/verifications/${v.id}/verify`, { code });
    expect((await err(verify("12345"))).details).toEqual({ fields: { code: "Enter the 6-digit code" } });
    expect((await err(verify("111111"))).details).toEqual({ attemptsLeft: 2 });
    expect((await err(verify("222222"))).details).toEqual({ attemptsLeft: 1 });
    expect((await err(verify("333333"))).code).toBe("too_many_attempts");
    expect((await err(verify(MOCK_SMS_CODE))).code).toBe("too_many_attempts");
    // Resend before 30 s → cooldown.
    const cd = await err(req("POST", `/me/notification-channels/sms/verifications/${v.id}/resend`));
    expect([cd.code, (cd.details as { reason: string }).reason]).toEqual(["throttled", "resend_cooldown"]);
    getDB().smsVerifications!.find((x) => x.id === v.id)!.resendAt = new Date(Date.now() - 1000).toISOString();
    expect((await req<SmsVerification>("POST", `/me/notification-channels/sms/verifications/${v.id}/resend`)).attemptsLeft).toBe(3);
    const ok = await verify(MOCK_SMS_CODE);
    expect(ok.connection).toMatchObject({ display: "+1 (415) 555-0132", status: "active", country: "US" });
    expect((await err(verify(MOCK_SMS_CODE))).code).toBe("verification_closed");
    expect((await err(start())).code).toBe("already_connected");
    await req("DELETE", "/me/notification-channels/sms");
    expect((await req<NotificationChannels>("GET", "/me/notification-channels")).sms.connection).toBeNull();
  });

  it("expires codes after 10 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T09:00:00Z"));
    const v = await start();
    vi.setSystemTime(new Date("2026-10-09T09:10:01Z"));
    expect((await err(req("POST", `/me/notification-channels/sms/verifications/${v.id}/verify`, { code: MOCK_SMS_CODE }))).code).toBe("code_expired");
  });

  it("enforces 5 codes per hour per user and 5 per phone across users", async () => {
    for (let i = 0; i < CHANNEL_LIMITS.otpUserHour; i++) await start();
    expect(((await err(start())).details as { reason: string }).reason).toBe("hourly_limit");
    as("u_sam");
    expect(((await err(start())).details as { reason: string }).reason).toBe("phone_limit");
    // Another number is fine for Sam.
    expect((await start("4155550199")).attemptsLeft).toBe(3);
  });

  it("STOP / START from the number update the connection", async () => {
    const v = await start();
    await req("POST", `/me/notification-channels/sms/verifications/${v.id}/verify`, { code: MOCK_SMS_CODE });
    simulateSmsReply("u_alex", "STOP");
    expect((await req<NotificationChannels>("GET", "/me/notification-channels")).sms.connection?.status).toBe("opted_out");
    simulateSmsReply("u_alex", "START");
    expect((await req<NotificationChannels>("GET", "/me/notification-channels")).sms.connection?.status).toBe("active");
  });
});

describe("Push C10–C13", () => {
  it("serves the VAPID key without a session", async () => {
    mockSession.set(null);
    expect((await req<{ publicKey: string }>("GET", "/push/vapid-public-key")).publicKey).toMatch(/^B/);
  });

  it("validates the endpoint allow-list and key lengths", async () => {
    const e = await err(req("PUT", "/me/push-subscriptions", { mode: "subscribe", subscription: { endpoint: "http://169.254.169.254/x", expirationTime: null, keys: { p256dh: "AAAA", auth: "AA" } } }));
    expect((e.details as { fields: Record<string, string> }).fields).toEqual({
      "subscription.endpoint": "Unsupported push service",
      "subscription.keys.p256dh": "Invalid key",
      "subscription.keys.auth": "Invalid key",
    });
    const ok = await req<PushDevice>("PUT", "/me/push-subscriptions", { mode: "subscribe", subscription: sub("https://wns2-par02p.notify.windows.com/w/?token=1") });
    expect(ok.status).toBe("active");
  });

  it("subscribe moves an endpoint between users; refresh 404s for someone else's; remove is idempotent", async () => {
    const endpoint = "https://fcm.googleapis.com/fcm/send/shared-browser";
    const d = await req<PushDevice>("PUT", "/me/push-subscriptions", { mode: "subscribe", subscription: sub(endpoint) });
    expect(d.endpointHash).toBe(endpointHash(endpoint));
    as("u_sam");
    expect((await err(req("PUT", "/me/push-subscriptions", { mode: "refresh", subscription: sub(endpoint) }))).status).toBe(404);
    await req("PUT", "/me/push-subscriptions", { mode: "subscribe", subscription: sub(endpoint) });
    expect((await req<NotificationChannels>("GET", "/me/notification-channels")).push.devices).toHaveLength(1);
    as("u_alex");
    expect((await req<NotificationChannels>("GET", "/me/notification-channels")).push.devices).toHaveLength(1); // the seeded Mac only
    as("u_sam");
    await req("POST", "/me/push-subscriptions/remove", { endpoint });
    await req("POST", "/me/push-subscriptions/remove", { endpoint });
    expect((await req<NotificationChannels>("GET", "/me/notification-channels")).push.devices).toHaveLength(0);
    expect((await err(req("DELETE", "/me/push-subscriptions/pd_alex_mac"))).status).toBe(404);
  });

  it("keeps at most 10 active subscriptions", async () => {
    as("u_sam");
    for (let i = 0; i < 11; i++) {
      await req("PUT", "/me/push-subscriptions", { mode: "subscribe", subscription: sub(`https://fcm.googleapis.com/fcm/send/d${i}`) });
    }
    const devices = (await req<NotificationChannels>("GET", "/me/notification-channels")).push.devices;
    expect(devices.filter((d) => d.status === "active")).toHaveLength(10);
  });
});

describe("Send test C14", () => {
  it("sends on connected channels, 409 otherwise, and counts SMS toward the daily cap", async () => {
    const r = await req<ChannelTestResult>("POST", "/me/notification-channels/telegram/test", {});
    expect(r).toMatchObject({ channel: "telegram", status: "sent" });
    expect((await req<ChannelTestResult>("POST", "/me/notification-channels/email/test", {})).status).toBe("sent");
    expect((await req<ChannelTestResult>("POST", "/me/notification-channels/push/test", {})).status).toBe("sent");
    expect((await err(req("POST", "/me/notification-channels/sms/test", {}))).code).toBe("channel_not_connected");
  });

  it("'Channel failures' fails the next test with the permanent 502 and updates the connection (one-shot)", async () => {
    mockControls.set((c) => ({ ...c, channelFailures: true }));
    const e = await err(req("POST", "/me/notification-channels/telegram/test", {}));
    expect([e.status, e.details]).toEqual([502, { channel: "telegram", reason: "blocked" }]);
    expect(mockControls.get().channelFailures).toBe(false);
    expect((await req<NotificationChannels>("GET", "/me/notification-channels")).telegram.connection).toMatchObject({ status: "blocked", lastError: "You blocked the bot in Telegram." });
    expect((await err(req("POST", "/me/notification-channels/telegram/test", {}))).details).toEqual({ channel: "telegram", reason: "blocked" });
  });

  it("throttles tests at 12 per hour", async () => {
    for (let i = 0; i < CHANNEL_LIMITS.testHour; i++) await req("POST", "/me/notification-channels/email/test", {});
    const e = await err(req("POST", "/me/notification-channels/email/test", {}));
    expect([e.code, (e.details as { reason: string }).reason]).toEqual(["throttled", "test_limit"]);
  });
});

describe("P1 preferences", () => {
  it("a v1-shaped PUT keeps the new keys; quietHours is validated and replaced whole", async () => {
    const cur = await req<NotificationPreferences>("GET", "/notification-preferences");
    const v1 = Object.fromEntries(Object.entries(cur.events).map(([k, v]) => [k, { in_app: v.in_app, email: !v.email }]));
    const out = await req<NotificationPreferences>("PUT", "/notification-preferences", { events: v1, emailDelivery: "hourly" });
    expect(out.events.assigned).toEqual({ in_app: true, email: false, telegram: true, sms: false, push: true });
    expect(out.quietHours.timezone).toBe("America/New_York");
    const bad = await err(req("PUT", "/notification-preferences", { ...out, quietHours: { ...out.quietHours, from: "08:00", to: "08:00", timezone: "Mars/Base", days: [true] } }));
    expect((bad.details as { fields: Record<string, string> }).fields).toEqual({
      "quietHours.to": "End must differ from start",
      "quietHours.timezone": "Unknown time zone",
      "quietHours.days": "Pick 7 days",
    });
    const q = { enabled: true, from: "21:30", to: "07:00", timezone: "Europe/Berlin", days: [true, true, true, true, true, false, false], urgentBypass: false };
    expect((await req<NotificationPreferences>("PUT", "/notification-preferences", { ...out, quietHours: q })).quietHours).toEqual(q);
  });
});

describe("W1 workspace SMS policy", () => {
  it("is on every workspace response; PATCH needs workspace.update and is audited", async () => {
    expect((await req<Workspace>("GET", "/workspaces/platform")).notificationPolicy).toEqual({ sms: true });
    as("u_sam");
    const e = await err(req("PATCH", "/workspaces/platform", { notificationPolicy: { sms: false } }));
    expect([e.status, (e.details as { permission: string }).permission]).toEqual([403, "workspace.update"]);
    as("u_alex");
    expect((await req<Workspace>("PATCH", "/workspaces/platform", { notificationPolicy: { sms: false } })).notificationPolicy).toEqual({ sms: false });
    expect(getDB().audit[0]!.changes).toEqual([{ field: "smsNotifications", kind: "value", before: "true", after: "false" }]);
    as("u_sam");
    expect((await req<Workspace>("GET", "/workspaces/platform")).notificationPolicy).toEqual({ sms: false });
  });
});

describe("dispatcher (fan-out, quiet hours, summaries)", () => {
  const prefsOf = (u: string) => getDB().prefs.find((p) => p.userId === u)!.prefs;
  const send = (urgent: boolean, now: Date, event: "assigned" | "comment" = "assigned") =>
    fanOut(getDB(), "u_alex", event, { workspaceId: "ws_platform", notificationId: null, taskKey: "PRJ-42", urgent, now });

  it("sends to wanted, usable targets outside quiet hours (one row per push device)", () => {
    const rows = send(false, new Date("2026-10-09T16:00:00Z")); // 12:00 New York
    expect(rows.map((r) => [r.channel, r.status])).toEqual([
      ["telegram", "sent"],
      ["push", "sent"],
    ]);
  });

  it("defers during quiet hours to the window's end, unless Urgent with the bypass", () => {
    const night = new Date("2026-10-10T03:00:00Z"); // Fri 23:00 New York
    const held = send(false, night);
    expect(held.every((r) => r.status === "deferred" && r.nextAttemptAt === "2026-10-10T12:00:00.000Z")).toBe(true);
    expect(send(true, night).every((r) => r.status === "sent")).toBe(true);
    prefsOf("u_alex").quietHours.urgentBypass = false;
    expect(send(true, night).every((r) => r.status === "deferred")).toBe(true);
  });

  it("releases one row as is and several as one summary (originals coalesced)", () => {
    const night = new Date("2026-10-10T03:00:00Z");
    send(false, night);
    send(false, night, "comment");
    const summaries = releaseDue(getDB(), new Date("2026-10-10T12:00:30Z"));
    expect(summaries.map((s) => [s.channel, s.kind, s.status]).sort()).toEqual([
      ["push", "summary", "sent"],
      ["telegram", "summary", "sent"],
    ]);
    expect(getDB().channelDeliveries!.filter((d) => d.status === "coalesced")).toHaveLength(4);
  });

  it("skips SMS when the workspace policy is off or the number replied STOP", () => {
    const db = getDB();
    db.channelConnections!.push({ channel: "sms", userId: "u_alex", id: "smc", phoneNumber: "+14155550132", display: "", country: "US", status: "active", verifiedAt: "", lastError: null });
    prefsOf("u_alex").events.assigned.sms = true;
    db.workspaces.find((w) => w.id === "ws_platform")!.smsEnabled = false;
    expect(send(false, new Date("2026-10-09T16:00:00Z")).find((r) => r.channel === "sms")).toMatchObject({ status: "skipped", skipReason: "policy" });
    db.workspaces.find((w) => w.id === "ws_platform")!.smsEnabled = true;
    (db.channelConnections!.find((c) => c.id === "smc") as { status: string }).status = "opted_out";
    expect(send(false, new Date("2026-10-09T16:00:00Z")).find((r) => r.channel === "sms")).toMatchObject({ status: "skipped", skipReason: "opted_out" });
  });
});
