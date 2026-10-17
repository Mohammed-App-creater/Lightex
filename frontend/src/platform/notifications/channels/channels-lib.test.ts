import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/errors";
import type { NotificationChannels, PushDevice, QuietHours, SmsVerification, TelegramLink } from "@/lib/api/types";
import { backspaceAt, pasteInto, typeInto } from "./otp";
import { columnStates, defaultPreferences, pushRow, pushView, smsRow, telegramRow, testErrorCopy, toggleCell, withDefaults } from "./model";
import { formatNational, nationalDigits, phoneHelp, placeholderFor, validateNational } from "./phone";
import vectors from "./phone-vectors.json";
import { daysLabel, holds, isActive, isQuietAt, quietError, segments, summary, tzCity, tzLabel, windowEnd, zonedToUtc } from "./quiet";
import { endpointHash, sha256Hex } from "./sha256";
import { EMPTY_CODE, isFilled, otpErrorFrom, otpLocked, resendIn, smsInitial, smsReducer, smsSendError, type SmsState } from "./sms-machine";
import { TG_INITIAL, codeCells, formatClock, isWarn, remainingSeconds, telegramStartError, tgReducer } from "./telegram-machine";

/* Board 38 pure logic: phone vectors, quiet hours, the matrix / row model, the state machines, OTP editing. */

const apiErr = (status: number, code: string, details: Record<string, unknown> = {}) => new ApiError({ status, code, message: code, details });

describe("phone (shared vectors)", () => {
  it.each(vectors.format)("formats $digits with $pattern", (v) => {
    expect(formatNational(v.digits, v.pattern)).toBe(v.out);
  });
  it.each(vectors.validate)("validates $country $input", (v) => {
    const r = validateNational(v.country, v.input, "allowed" in v && v.allowed ? v.allowed : undefined);
    if (v.ok) expect(r).toMatchObject({ ok: true, e164: v.e164, display: v.display });
    else expect(r).toEqual({ ok: false, field: v.field, error: v.error });
  });
  it("keeps typing digits only, drops the trunk 0 and caps the count", () => {
    expect(nationalDigits({ code: "US", digits: 10 }, "(415) 555-01329")).toBe("4155550132");
    expect(nationalDigits({ code: "GB", digits: 10 }, "07700 900123")).toBe("7700900123");
    expect(placeholderFor("(XXX) XXX-XXXX")).toBe("(000) 000-0000");
    expect(phoneHelp({ digits: 10 }, "415")).toEqual({ text: "10 digits", tone: "muted" });
    expect(phoneHelp({ digits: 10 }, "4155550132")).toEqual({ text: "Valid number", tone: "ok" });
  });
});

const q = (p: Partial<QuietHours> = {}): QuietHours => ({
  enabled: true,
  from: "22:00",
  to: "08:00",
  timezone: "America/New_York",
  days: [true, true, true, true, true, true, true],
  urgentBypass: true,
  ...p,
});
const MON_FRI: QuietHours["days"] = [true, true, true, true, true, false, false];
const ONLY_FRI: QuietHours["days"] = [false, false, false, false, true, false, false];

describe("quiet hours", () => {
  it("draws one segment for a same-day window, two overnight, none when from = to", () => {
    expect(segments("09:00", "17:00")).toEqual([{ left: 37.5, width: 33.3 }]);
    expect(segments("22:00", "08:00")).toEqual([
      { left: 91.7, width: 8.3 },
      { left: 0, width: 33.3 },
    ]);
    expect(segments("08:00", "08:00")).toEqual([]);
  });

  it("labels days like the design", () => {
    expect(daysLabel([true, true, true, true, true, true, true])).toBe("every day");
    expect(daysLabel([false, false, false, false, false, false, false])).toBe("no days");
    expect(daysLabel(MON_FRI)).toBe("Mon–Fri");
    expect(daysLabel([false, false, false, false, false, true, true])).toBe("weekends");
    expect(daysLabel([true, false, true, false, true, false, false])).toBe("Mo We Fr");
  });

  it("summarises and labels time zones", () => {
    expect(summary(q({ days: MON_FRI }))).toBe("22:00–08:00 · Mon–Fri · New York");
    expect(summary(q({ enabled: false }))).toBe("Off");
    expect(summary(q({ timezone: null }))).toBe("22:00–08:00 · every day · no time zone");
    expect(tzCity("America/Argentina/Buenos_Aires")).toBe("Buenos Aires");
    expect(tzLabel("America/New_York", new Date("2026-10-09T12:00:00Z"))).toBe("New York · GMT−4");
    expect(tzLabel("Asia/Kolkata", new Date("2026-10-09T12:00:00Z"))).toBe("Kolkata · GMT+5:30");
  });

  it("is inactive without a zone, with from = to, or with no day", () => {
    expect(isActive(q())).toBe(true);
    expect(isActive(q({ timezone: null }))).toBe(false);
    expect(isActive(q({ from: "08:00", to: "08:00" }))).toBe(false);
    expect(isActive(q({ days: [false, false, false, false, false, false, false] }))).toBe(false);
    expect(isActive(q({ enabled: false }))).toBe(false);
  });

  it("checks a same-day window in the user's zone (from ≤ m < to)", () => {
    const day = q({ from: "09:00", to: "17:00" });
    // 2026-10-09 is a Friday; New York is UTC−4.
    expect(isQuietAt(day, new Date("2026-10-09T13:00:00Z"))).toBe(true); // 09:00 local
    expect(isQuietAt(day, new Date("2026-10-09T12:59:00Z"))).toBe(false); // 08:59
    expect(isQuietAt(day, new Date("2026-10-09T21:00:00Z"))).toBe(false); // 17:00 (end excluded)
  });

  it("checks an overnight window with 'the window that starts on this day'", () => {
    const fri = q({ days: ONLY_FRI });
    expect(isQuietAt(fri, new Date("2026-10-10T03:00:00Z"))).toBe(true); // Fri 23:00 NY
    expect(isQuietAt(fri, new Date("2026-10-10T11:00:00Z"))).toBe(true); // Sat 07:00 NY (Friday's window)
    expect(isQuietAt(fri, new Date("2026-10-11T03:00:00Z"))).toBe(false); // Sat 23:00 NY
    expect(isQuietAt(fri, new Date("2026-10-09T11:00:00Z"))).toBe(false); // Fri 07:00 NY (Thursday's window, off)
    const monFri = q({ days: MON_FRI });
    expect(isQuietAt(monFri, new Date("2026-10-12T06:00:00Z"))).toBe(false); // Mon 02:00 (Sunday night is off)
    expect(isQuietAt(monFri, new Date("2026-10-13T06:00:00Z"))).toBe(true); // Tue 02:00
  });

  it("uses the configured zone, not the runtime's", () => {
    const at = new Date("2026-10-09T21:30:00Z"); // 23:30 Berlin, 17:30 New York, 03:00 Kolkata
    expect(isQuietAt(q({ timezone: "Europe/Berlin" }), at)).toBe(true);
    expect(isQuietAt(q({ timezone: "America/New_York" }), at)).toBe(false);
    expect(isQuietAt(q({ timezone: "Asia/Kolkata" }), at)).toBe(true);
  });

  it("lets Urgent through only with the bypass on", () => {
    const at = new Date("2026-10-10T03:00:00Z");
    expect(holds(q(), at, false)).toBe(true);
    expect(holds(q(), at, true)).toBe(false);
    expect(holds(q({ urgentBypass: false }), at, true)).toBe(true);
    expect(holds(q(), new Date("2026-10-09T16:00:00Z"), false)).toBe(false);
  });

  it("ends the window at the next local `to`", () => {
    expect(windowEnd(q(), new Date("2026-10-10T03:00:00Z"))?.toISOString()).toBe("2026-10-10T12:00:00.000Z"); // 23:00 → 08:00 next day
    expect(windowEnd(q(), new Date("2026-10-10T07:00:00Z"))?.toISOString()).toBe("2026-10-10T12:00:00.000Z"); // 03:00 → 08:00 same day
    expect(windowEnd(q(), new Date("2026-10-09T16:00:00Z"))).toBeNull();
  });

  it("handles DST: a gap moves to the first valid minute, an overlap takes the first occurrence", () => {
    expect(zonedToUtc(2026, 3, 8, 2, 30, "America/New_York").toISOString()).toBe("2026-03-08T07:00:00.000Z");
    expect(zonedToUtc(2026, 11, 1, 1, 30, "America/New_York").toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expect(zonedToUtc(2026, 3, 29, 2, 30, "Europe/Berlin").toISOString()).toBe("2026-03-29T01:00:00.000Z");
    // A window ending at 02:30 on the spring-forward night ends at 03:00 EDT.
    const gap = q({ from: "23:00", to: "02:30" });
    expect(windowEnd(gap, new Date("2026-03-08T05:00:00Z"))?.toISOString()).toBe("2026-03-08T07:00:00.000Z");
  });

  it("validates before a save", () => {
    expect(quietError(q())).toBeNull();
    expect(quietError(q({ to: "22:00" }))).toEqual({ field: "to", message: "End must differ from start" });
    expect(quietError(q({ from: "25:00" }))).toEqual({ field: "from", message: "Use HH:MM" });
    expect(quietError(q({ timezone: "Mars/Olympus" }))).toEqual({ field: "timezone", message: "Unknown time zone" });
  });
});

describe("sha256", () => {
  it("matches the FIPS vectors and gives 16-char endpoint hashes", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("a".repeat(1000))).toBe("41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3");
    expect(endpointHash("https://fcm.googleapis.com/fcm/send/x")).toHaveLength(16);
  });
});

/* ───────── matrix / rows ───────── */

const dev = (id: string, hash: string, status: PushDevice["status"] = "active"): PushDevice => ({
  id,
  label: "Chrome on macOS",
  endpointHash: hash,
  status,
  createdAt: "2026-10-08T00:00:00Z",
  lastSeenAt: "2026-10-09T00:00:00Z",
  lastSuccessAt: null,
});

function chans(p: { tg?: "active" | "blocked" | null; sms?: "active" | "opted_out" | "invalid" | null; devices?: PushDevice[]; available?: boolean } = {}): NotificationChannels {
  const available = p.available ?? true;
  return {
    email: { address: "alex@team.dev" },
    telegram: {
      available,
      botUsername: "lightex_bot",
      connection: p.tg ? { id: "t", username: "alexkim", firstName: "Alex", status: p.tg, connectedAt: "", lastError: null } : null,
    },
    sms: {
      available,
      countries: [],
      connection: p.sms ? { id: "s", phoneNumber: "+14155550132", display: "+1 (415) 555-0132", country: "US", status: p.sms, verifiedAt: "", lastError: null } : null,
      dailyCap: 10,
      sentToday: 0,
    },
    push: { available, vapidPublicKey: "k", devices: p.devices ?? [] },
  };
}

const off = pushView({ support: "supported", permission: "default", localHash: null, devices: [], prompting: false });

describe("pushView", () => {
  it("covers every state of this browser", () => {
    const devices = [dev("a", "aaaa"), dev("b", "bbbb")];
    expect(pushView({ support: "unsupported", permission: "default", localHash: null, devices, prompting: false }).phase).toBe("unsupported");
    expect(pushView({ support: "ios-needs-install", permission: "default", localHash: null, devices, prompting: false }).phase).toBe("ios");
    expect(pushView({ support: "supported", permission: "default", localHash: null, devices, prompting: true }).phase).toBe("prompt");
    expect(pushView({ support: "supported", permission: "denied", localHash: null, devices, prompting: false }).phase).toBe("blocked");
    const on = pushView({ support: "supported", permission: "granted", localHash: "aaaa", devices, prompting: false });
    expect(on.phase).toBe("on");
    expect(on.thisDevice?.id).toBe("a");
    expect(on.others.map((d) => d.id)).toEqual(["b"]);
    expect(pushView({ support: "supported", permission: "granted", localHash: "cccc", devices: [dev("c", "cccc", "expired")], prompting: false }).phase).toBe("expired");
    expect(pushView({ support: "supported", permission: "granted", localHash: null, devices, prompting: false }).phase).toBe("off");
  });
});

describe("columnStates", () => {
  it("makes in-app / email always live and external channels live only when usable", () => {
    const c = columnStates({ channels: chans({ tg: "active", sms: "active" }), channelsError: false, smsPolicy: true, push: off });
    expect(c.in_app.usable && c.email.usable && c.telegram.usable && c.sms.usable).toBe(true);
    expect(c.push).toEqual({ usable: false, note: "connect", reason: "not connected" });
  });
  it("says Off by admin, Blocked, STOP and Unavailable", () => {
    expect(columnStates({ channels: chans({ sms: "active" }), channelsError: false, smsPolicy: false, push: off }).sms.note).toBe("policy");
    expect(columnStates({ channels: chans({ tg: "blocked" }), channelsError: false, smsPolicy: true, push: off }).telegram.note).toBe("blocked");
    expect(columnStates({ channels: chans({ sms: "opted_out" }), channelsError: false, smsPolicy: true, push: off }).sms.note).toBe("opted_out");
    const denied = pushView({ support: "supported", permission: "denied", localHash: null, devices: [], prompting: false });
    expect(columnStates({ channels: chans(), channelsError: false, smsPolicy: true, push: denied }).push.note).toBe("blocked");
    expect(columnStates({ channels: chans({ available: false }), channelsError: false, smsPolicy: true, push: off }).telegram.note).toBe("unavailable");
  });
  it("keeps Push live while another browser has an active subscription", () => {
    const v = pushView({ support: "supported", permission: "default", localHash: null, devices: [dev("x", "xxxx")], prompting: false });
    expect(columnStates({ channels: chans({ devices: [dev("x", "xxxx")] }), channelsError: false, smsPolicy: true, push: v }).push.usable).toBe(true);
  });
  it("offers Retry on external columns when C1 failed", () => {
    const c = columnStates({ channels: undefined, channelsError: true, smsPolicy: true, push: off });
    expect(c.in_app.usable).toBe(true);
    expect([c.telegram.note, c.sms.note, c.push.note]).toEqual(["retry", "retry", "retry"]);
  });
});

describe("channel rows (§8.5 table)", () => {
  it("Telegram", () => {
    expect(telegramRow(chans().telegram, false)).toMatchObject({ status: "Not connected", tone: "off", actions: ["connect"] });
    expect(telegramRow(chans().telegram, true)).toMatchObject({ status: "Waiting…", tone: "wait", actions: [] });
    expect(telegramRow(chans({ tg: "active" }).telegram, false)).toMatchObject({ status: "@alexkim", tone: "ok", mono: true, actions: ["test", "remove"] });
    expect(telegramRow(chans({ tg: "blocked" }).telegram, false)).toMatchObject({ status: "Bot blocked in Telegram", tone: "err", actions: ["reconnect", "remove"] });
    expect(telegramRow(chans({ available: false }).telegram, false)).toMatchObject({ status: "Not available on this server", actions: [] });
  });
  it("SMS", () => {
    expect(smsRow(chans().sms, false)).toMatchObject({ status: "Off by admin", actions: [] });
    expect(smsRow(chans({ sms: "active" }).sms, false)).toMatchObject({ status: "Off by admin", actions: ["remove"] });
    expect(smsRow(chans().sms, true)).toMatchObject({ status: "Not connected", actions: ["connect"] });
    expect(smsRow(chans({ sms: "active" }).sms, true)).toMatchObject({ status: "+1 (415) 555-0132", mono: true, actions: ["test", "remove"] });
    expect(smsRow(chans({ sms: "opted_out" }).sms, true)).toMatchObject({ status: "Replied STOP · text START to resume", tone: "err", actions: ["remove"] });
    expect(smsRow(chans({ sms: "invalid" }).sms, true)).toMatchObject({ status: "Number can’t receive SMS", actions: ["connect", "remove"] });
  });
  it("Push", () => {
    const others = [dev("b", "bbbb"), dev("c", "cccc")];
    expect(pushRow(true, { phase: "off", thisDevice: null, others })).toMatchObject({ status: "Off · 2 other devices", actions: ["enable"] });
    expect(pushRow(true, { phase: "on", thisDevice: dev("a", "aaaa"), others: [others[0]!] })).toMatchObject({ status: "This browser · 1 more device", actions: ["test", "remove"] });
    expect(pushRow(true, { phase: "blocked", thisDevice: null, others: [] })).toMatchObject({ status: "Blocked in browser", tone: "err", actions: ["check"] });
    expect(pushRow(true, { phase: "prompt", thisDevice: null, others: [] })).toMatchObject({ status: "Waiting for browser…", tone: "wait" });
    expect(pushRow(true, { phase: "ios", thisDevice: null, others: [] }).status).toBe("Add Lightex to your Home Screen to enable push");
    expect(pushRow(true, { phase: "unsupported", thisDevice: null, others: [] }).status).toBe("Not supported in this browser");
  });
});

describe("preferences helpers", () => {
  it("has the design's DEF defaults and fills an older payload without touching its values", () => {
    const d = defaultPreferences();
    expect(d.events.assigned).toEqual({ in_app: true, email: true, telegram: true, sms: false, push: true });
    expect(d.events.due_soon.sms).toBe(true);
    expect(d.quietHours).toMatchObject({ enabled: true, from: "22:00", to: "08:00", timezone: null, urgentBypass: true });
    const old = withDefaults({ events: { assigned: { in_app: false, email: false } } as never, emailDelivery: "daily" });
    expect(old.events.assigned).toEqual({ in_app: false, email: false, telegram: true, sms: false, push: true });
    expect(old.emailDelivery).toBe("daily");
  });
  it("toggles exactly one cell", () => {
    const d = defaultPreferences();
    const n = toggleCell(d, "comment", "sms", true);
    expect(n.events.comment.sms).toBe(true);
    expect(n.events.comment.telegram).toBe(true);
    expect(n.events.assigned).toBe(d.events.assigned);
    expect(d.events.comment.sms).toBe(false);
  });
  it("words each test failure", () => {
    expect(testErrorCopy("telegram", apiErr(502, "channel_send_failed", { reason: "blocked" }))).toEqual({ title: "Couldn’t reach Telegram", body: "You blocked the bot. Unblock it and send /start." });
    expect(testErrorCopy("sms", apiErr(502, "channel_send_failed", { reason: "opted_out" })).body).toMatch(/You replied STOP/);
    expect(testErrorCopy("push", apiErr(502, "channel_send_failed", { reason: "expired_subscription" })).body).toBe("This browser’s subscription expired. Turn push off and on.");
    expect(testErrorCopy("sms", apiErr(429, "throttled", { reason: "daily_cap" })).title).toBe("Daily SMS limit reached");
  });
});

/* ───────── state machines ───────── */

const link = (p: Partial<TelegramLink> = {}): TelegramLink => ({
  id: "tgl_1",
  status: "pending",
  code: "K7MQ2X",
  deepLink: "https://t.me/lightex_bot?start=lx_x",
  botUsername: "lightex_bot",
  expiresAt: "2026-10-09T09:22:44Z",
  connection: null,
  ...p,
});
const conn = { id: "c", username: "alexkim", firstName: "Alex", status: "active" as const, connectedAt: "", lastError: null };

describe("Telegram connect machine", () => {
  it("starting → pending → linked", () => {
    let s = tgReducer(TG_INITIAL, { type: "started", link: link() });
    expect(s.phase).toBe("pending");
    s = tgReducer(s, { type: "polled", link: link() });
    expect(s.phase).toBe("pending");
    s = tgReducer(s, { type: "polled", link: link({ status: "linked", code: undefined, deepLink: undefined, connection: conn }) });
    expect(s).toEqual({ phase: "linked", connection: conn });
  });
  it("expires from the server or the clock, keeps the code, and ignores stale polls", () => {
    const p = tgReducer(TG_INITIAL, { type: "started", link: link() });
    expect(tgReducer(p, { type: "polled", link: link({ status: "expired" }) })).toMatchObject({ phase: "expired", link: { code: "K7MQ2X" } });
    expect(tgReducer(p, { type: "polled", link: link({ status: "canceled" }) }).phase).toBe("expired");
    expect(tgReducer(p, { type: "tick", now: Date.parse("2026-10-09T09:22:43Z") }).phase).toBe("pending");
    expect(tgReducer(p, { type: "tick", now: Date.parse("2026-10-09T09:22:44Z") }).phase).toBe("expired");
    expect(tgReducer(p, { type: "polled", link: link({ id: "other", status: "linked", connection: conn }) })).toBe(p);
    expect(tgReducer(p, { type: "start" })).toEqual({ phase: "starting" });
  });
  it("shows errors and formats the countdown", () => {
    expect(tgReducer(TG_INITIAL, { type: "failed", ...telegramStartError(apiErr(409, "already_connected")) })).toMatchObject({ phase: "error", code: "already_connected" });
    expect(telegramStartError(apiErr(503, "channel_unavailable")).message).toBe("Telegram isn’t available on this server.");
    expect(remainingSeconds("2026-10-09T09:22:44Z", Date.parse("2026-10-09T09:13:02Z"))).toBe(582);
    expect(formatClock(582)).toBe("9:42");
    expect(formatClock(5)).toBe("0:05");
    expect([isWarn(61), isWarn(60)]).toEqual([false, true]);
    expect(codeCells("K7MQ2X").map((c) => c.gap)).toEqual([false, false, false, true, false, false]);
  });
});

const ver = (p: Partial<SmsVerification> = {}): SmsVerification => ({
  id: "smv_1",
  phoneNumber: "+14155550132",
  display: "+1 (415) 555-0132",
  expiresAt: "2026-10-09T09:24:00Z",
  resendAt: "2026-10-09T09:14:30Z",
  attemptsLeft: 3,
  ...p,
});
type Otp = Extract<SmsState, { step: "otp" }>;

describe("SMS verify machine", () => {
  it("phone → otp → verifying → verified", () => {
    let s = smsInitial("US");
    s = smsReducer(s, { type: "digits", digits: "4155550132" });
    s = smsReducer(s, { type: "send" });
    expect(s).toMatchObject({ step: "phone", sending: true });
    s = smsReducer(s, { type: "sendOk", verification: ver() });
    expect(s).toMatchObject({ step: "otp", attemptsLeft: 3, code: EMPTY_CODE });
    s = smsReducer(s, { type: "code", code: ["4", "8", "2", "9", "1", "3"] });
    s = smsReducer(s, { type: "verify" });
    expect((s as Otp).verifying).toBe(true);
    expect(otpLocked(s as Otp)).toBe(true);
    s = smsReducer(s, { type: "verifyOk", connection: { id: "c", phoneNumber: "+14155550132", display: "+1 (415) 555-0132", country: "US", status: "active", verifiedAt: "", lastError: null } });
    expect(s.step).toBe("verified");
  });
  it("counts wrong codes down to the lock, then Resend resets the tries", () => {
    let s: SmsState = smsReducer(smsReducer(smsInitial("US"), { type: "digits", digits: "4155550132" }), { type: "sendOk", verification: ver() });
    s = smsReducer(s, { type: "verifyFail", ...otpErrorFrom(apiErr(422, "invalid_code", { attemptsLeft: 2 })) });
    expect((s as Otp).error?.text).toBe("Wrong code · 2 tries left");
    expect((s as Otp).shake).toBe(1);
    expect((s as Otp).code).toEqual(EMPTY_CODE);
    s = smsReducer(s, { type: "verifyFail", ...otpErrorFrom(apiErr(422, "invalid_code", { attemptsLeft: 1 })) });
    expect((s as Otp).error?.text).toBe("Wrong code · 1 try left");
    s = smsReducer(s, { type: "verifyFail", ...otpErrorFrom(apiErr(422, "too_many_attempts", { attemptsLeft: 0 })) });
    expect((s as Otp).error?.text).toBe("Too many tries · resend a code");
    expect(otpLocked(s as Otp)).toBe(true);
    // Locked: typing does nothing.
    expect(smsReducer(s, { type: "code", code: ["1", "", "", "", "", ""] })).toBe(s);
    s = smsReducer(s, { type: "resendOk", verification: ver({ attemptsLeft: 3 }) });
    expect(s).toMatchObject({ attemptsLeft: 3, error: null });
    expect(otpLocked(s as Otp)).toBe(false);
  });
  it("handles expiry, Edit, country change and send errors", () => {
    expect(otpErrorFrom(apiErr(410, "code_expired")).error).toEqual({ kind: "expired", text: "Code expired · resend a code" });
    let s: SmsState = smsReducer(smsReducer(smsInitial("US"), { type: "digits", digits: "4155550132" }), { type: "sendOk", verification: ver() });
    s = smsReducer(s, { type: "edit" });
    expect(s).toMatchObject({ step: "phone", digits: "4155550132" });
    expect(smsReducer(s, { type: "country", country: "GB" })).toMatchObject({ country: "GB", digits: "" });
    expect(smsSendError(apiErr(422, "validation_failed", { fields: { nationalNumber: "Enter 10 digits" } }))).toEqual({ field: "Enter 10 digits", toast: null });
    expect(smsSendError(apiErr(502, "channel_send_failed", { reason: "invalid_number" })).field).toBe("Couldn’t send a code to this number");
    expect(smsSendError(apiErr(429, "throttled", { reason: "hourly_limit", retryAt: "2026-10-09T10:42:00Z" })).toast).toMatch(/^Too many codes requested\. Try again at /);
    expect(isFilled(["1", "2", "3", "4", "5", ""])).toBe(false);
    expect(resendIn("2026-10-09T09:14:30Z", Date.parse("2026-10-09T09:14:06Z"))).toBe(24);
  });
});

describe("OTP editing", () => {
  const E = ["", "", "", "", "", ""];
  it("types, advances and replaces", () => {
    expect(typeInto(E, 0, "4")).toEqual({ code: ["4", "", "", "", "", ""], focus: 1 });
    expect(typeInto(["4", "", "", "", "", ""], 0, "47")).toEqual({ code: ["7", "", "", "", "", ""], focus: 1 });
    expect(typeInto(["4", "", "", "", "", ""], 0, "")).toEqual({ code: E, focus: 0 });
    expect(typeInto(E, 5, "9").focus).toBe(5);
  });
  it("spreads pastes and autofill (6 digits start at box 1)", () => {
    expect(pasteInto(["1", "", "", "", "", ""], 3, "482913")).toEqual({ code: ["4", "8", "2", "9", "1", "3"], focus: 5 });
    expect(pasteInto(E, 2, "48-29")).toEqual({ code: ["", "", "4", "8", "2", "9"], focus: 5 });
    expect(typeInto(E, 0, "482913").code).toEqual(["4", "8", "2", "9", "1", "3"]);
    expect(pasteInto(E, 0, "abc")).toBeNull();
  });
  it("backspaces into the previous box", () => {
    expect(backspaceAt(["4", "8", "", "", "", ""], 2)).toEqual({ code: ["4", "", "", "", "", ""], focus: 1 });
    expect(backspaceAt(["4", "8", "2", "", "", ""], 2)).toBeNull();
    expect(backspaceAt(E, 0)).toBeNull();
  });
});
