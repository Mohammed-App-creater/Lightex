import { withDefaults } from "@/features/notifications/channels/model";
import { SMS_COUNTRY_RULES, countryRule, validateNational } from "@/features/notifications/channels/phone";
import { getPushPlatform, urlB64ToUint8Array } from "@/features/notifications/channels/push";
import { isKnownTimeZone } from "@/features/notifications/channels/quiet";
import { endpointHash } from "@/features/notifications/channels/sha256";
import type {
  ChannelTestResult,
  NotificationChannels,
  PushDevice,
  SmsConnection,
  SmsVerification,
  TelegramConnection,
  TelegramLink,
  TestableChannel,
} from "@/lib/api/types";
import { mockControls } from "../controls";
import { getDB, nowISO, persist, uid } from "../db";
import type { ChannelConnectionRec, MockDB, PushDeviceRec, SmsVerificationRec, TelegramLinkRec } from "../db-types";
import { SMS_USER_DAILY_CAP, newDelivery, recordDelivery, releaseDue, smsSentToday } from "../channels-dispatch";
import { mockBus } from "../realtime";
import { fail, invalid, requireUser, route, str, type Ctx } from "../router";

/*
 * Board 38 (v2) mock: personal notification channels (docs/v2/38-telegram-sms-push.md §5, §8.8).
 *
 * - Telegram: rotating design codes, a deep link, 10-minute expiry; the link "scans" itself 5 s after
 *   creation unless mock control "Telegram: manual" is on (then simulateTelegramScan()).
 * - SMS: the code is always 482913 (a dev toast shows it through mockBus); tries, cooldown and every
 *   §7.5 limit use the server's numbers; national numbers containing 5550000 fail to send (502).
 * - Push: VAPID key constant, subscriptions validated like the server (allow-list, key lengths); never
 *   contacts a push service. A push test shows a local notification when this browser is a target.
 * - Tests: synchronous, logged, throttled (12/hour) and counted toward the SMS cap; mock control
 *   "Channel failures" makes the next one fail with the channel's permanent 502.
 */

/** A real P-256 public key (the spec's example), so the browser accepts it as applicationServerKey. */
export const MOCK_VAPID_PUBLIC_KEY = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";
export const MOCK_SMS_CODE = "482913";
export const TELEGRAM_CODES = ["K7MQ2X", "R4TZ9P", "B8WN3H", "J2XC7V"];
export const BOT_USERNAME = "lightex_bot";
/** Timing knobs (tests shorten the simulated scan). */
export const channelTiming = { autoLinkMs: 5000 };

const LINK_TTL_MS = 600_000;
const OTP_TTL_MS = 600_000;
const RESEND_MS = 30_000;
const HOUR = 3600_000;
export const CHANNEL_LIMITS = { otpUserHour: 5, otpUserDay: 10, otpPhoneHour: 5, otpGlobalDay: 100, connectHour: 20, testHour: 12, pushDevices: 10 };
const PUSH_HOSTS = ["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"];
const PUSH_SUFFIXES = [".notify.windows.com", ".push.apple.com"];

/* ───────── seed / upgrade ───────── */

export function ensureExt38(db: MockDB) {
  db.channelConnections ??= [];
  db.telegramLinks ??= [];
  db.smsVerifications ??= [];
  db.pushDevices ??= [];
  db.otpSends ??= [];
  db.channelDeliveries ??= [];
  db.channelThrottle ??= [];
  if (db.ext38) return;
  db.ext38 = true;
  // New channel keys + quiet hours on every cached preference row (in_app / email untouched).
  for (const rec of db.prefs) rec.prefs = withDefaults(rec.prefs);
  for (const w of db.workspaces) w.smsEnabled ??= true;
  // The design's Matrix frame: Alex has Telegram @alexkim and push on Chrome on macOS.
  if (db.users.some((u) => u.id === "u_alex")) {
    const p = db.prefs.find((x) => x.userId === "u_alex");
    if (p) p.prefs.quietHours.timezone = "America/New_York";
    const at = new Date(Date.now() - 26 * HOUR).toISOString();
    if (!db.channelConnections.some((c) => c.userId === "u_alex" && c.channel === "telegram")) {
      db.channelConnections.push({ channel: "telegram", userId: "u_alex", chatId: 900_101, id: "tgc_alex", username: "alexkim", firstName: "Alex", status: "active", connectedAt: at, lastError: null });
    }
    if (!db.pushDevices.some((d) => d.userId === "u_alex")) {
      const endpoint = "https://fcm.googleapis.com/fcm/send/seed-alex-chrome-macos";
      db.pushDevices.push({
        id: "pd_alex_mac",
        userId: "u_alex",
        endpoint,
        endpointHash: endpointHash(endpoint),
        p256dh: "BLc4xRzKlKORKWlbdgFaBrrPK3ydWAHo4M0gs0i1oEKgPpWC5cW8OCzVrOQRv-1npXRWk8udnW3oYhIO4475rds",
        auth: "5I2Bu2oKdyy9CwL8QVF0NQ",
        label: "Chrome on macOS",
        status: "active",
        createdAt: at,
        lastSeenAt: new Date(Date.now() - HOUR).toISOString(),
        lastSuccessAt: new Date(Date.now() - 2 * HOUR).toISOString(),
        failureCount: 0,
      });
    }
  }
}

/* ───────── helpers ───────── */

const ext = (db: MockDB) => {
  ensureExt38(db);
  return db as Required<Pick<MockDB, "channelConnections" | "telegramLinks" | "smsVerifications" | "pushDevices" | "otpSends" | "channelDeliveries" | "channelThrottle">> & MockDB;
};

type TgRec = Extract<ChannelConnectionRec, { channel: "telegram" }>;
type SmsRec = Extract<ChannelConnectionRec, { channel: "sms" }>;
const tgConn = (db: MockDB, userId: string) => ext(db).channelConnections.find((c): c is TgRec => c.channel === "telegram" && c.userId === userId);
const smsConn = (db: MockDB, userId: string) => ext(db).channelConnections.find((c): c is SmsRec => c.channel === "sms" && c.userId === userId);

const toTelegram = ({ id, username, firstName, status, connectedAt, lastError }: TgRec): TelegramConnection => ({ id, username, firstName, status, connectedAt, lastError });
const toSms = ({ id, phoneNumber, display, country, status, verifiedAt, lastError }: SmsRec): SmsConnection => ({ id, phoneNumber, display, country, status, verifiedAt, lastError });
const toDevice = ({ id, label, endpointHash: h, status, createdAt, lastSeenAt, lastSuccessAt }: PushDeviceRec): PushDevice => ({ id, label, endpointHash: h, status, createdAt, lastSeenAt, lastSuccessAt });
const toVerification = ({ id, phoneNumber, display, expiresAt, resendAt, attemptsLeft }: SmsVerificationRec): SmsVerification => ({ id, phoneNumber, display, expiresAt, resendAt, attemptsLeft });

function toLink(db: MockDB, l: TelegramLinkRec): TelegramLink {
  const conn = l.connectionId ? ext(db).channelConnections.find((c): c is TgRec => c.id === l.connectionId && c.channel === "telegram") : undefined;
  return {
    id: l.id,
    status: l.status,
    ...(l.status === "pending" ? { code: l.code, deepLink: `https://t.me/${BOT_USERNAME}?start=${l.token}` } : {}),
    botUsername: BOT_USERNAME,
    expiresAt: l.expiresAt,
    connection: l.status === "linked" && conn ? toTelegram(conn) : null,
  };
}

/** `channels.changed` to the owner, in every workspace they belong to (user-targeted, durable). */
export function publishChannels(db: MockDB, userId: string, channel: "telegram" | "sms" | "push", op: "linked" | "disconnected" | "status") {
  for (const m of db.wsMembers.filter((x) => x.userId === userId)) {
    mockBus.publish("channels.changed", { workspaceId: m.workspaceId, userId, actorId: null, data: { channel, op } });
  }
}

function throttle(db: MockDB, userId: string, scope: "connect" | "test", limit: number, reason: string) {
  const d = ext(db);
  const now = Date.now();
  d.channelThrottle = d.channelThrottle.filter((t) => now - Date.parse(t.at) < HOUR);
  const mine = d.channelThrottle.filter((t) => t.userId === userId && t.scope === scope);
  if (mine.length >= limit) {
    const retryAt = new Date(Date.parse(mine[0]!.at) + HOUR).toISOString();
    fail(429, "throttled", "Too many requests. Try again later.", { retryAt, reason });
  }
  d.channelThrottle.push({ userId, scope, at: nowISO() });
}

/** Connect calls carry the browser's zone: it fills quiet hours' time zone once (§5.3). */
function fillTimezone(db: MockDB, userId: string, tz: unknown) {
  if (typeof tz !== "string" || !isKnownTimeZone(tz)) return;
  const rec = db.prefs.find((p) => p.userId === userId);
  if (rec) {
    rec.prefs = withDefaults(rec.prefs);
    rec.prefs.quietHours.timezone ??= tz;
  }
}

const handleOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 32) || "lightexuser";

/** Links a pending request: creates or replaces the user's Telegram connection. */
function linkNow(db: MockDB, l: TelegramLinkRec) {
  const d = ext(db);
  const user = db.users.find((u) => u.id === l.userId);
  d.channelConnections = d.channelConnections.filter((c) => !(c.channel === "telegram" && c.userId === l.userId));
  const conn: TgRec = {
    channel: "telegram",
    userId: l.userId,
    chatId: 900_000 + d.channelConnections.length + 1,
    id: uid("tgc"),
    username: handleOf(user?.name ?? "user"),
    firstName: (user?.name ?? "User").split(" ")[0]!,
    status: "active",
    connectedAt: nowISO(),
    lastError: null,
  };
  d.channelConnections.push(conn);
  l.status = "linked";
  l.connectionId = conn.id;
  publishChannels(db, l.userId, "telegram", "linked");
}

/** Lazy status (expired when read; the simulated scan when due). */
function refreshLink(db: MockDB, l: TelegramLinkRec, now = Date.now()) {
  if (l.status !== "pending") return;
  if (Date.parse(l.expiresAt) <= now) l.status = "expired";
  else if (l.autoLinkAt && Date.parse(l.autoLinkAt) <= now) linkNow(db, l);
}

function myLink(ctx: Ctx, userId: string) {
  const l = ext(ctx.db).telegramLinks.find((x) => x.id === ctx.params.linkId && x.userId === userId);
  if (!l) fail(404, "not_found", "Link not found.");
  return l;
}

function myVerification(ctx: Ctx, userId: string) {
  const v = ext(ctx.db).smsVerifications.find((x) => x.id === ctx.params.id && x.userId === userId);
  if (!v) fail(404, "not_found", "Verification not found.");
  return v;
}

/** The §7.5 OTP limits, counted from the send log (not a per-process cache). */
function otpLimits(db: MockDB, userId: string, phone: string) {
  const d = ext(db);
  const now = Date.now();
  const dayStart = new Date(new Date().setUTCHours(0, 0, 0, 0)).getTime();
  const nextDay = new Date(dayStart + 24 * HOUR).toISOString();
  const within = (at: string, ms: number) => now - Date.parse(at) < ms;
  const retryHour = (rows: { at: string }[]) => new Date(Date.parse(rows[0]!.at) + HOUR).toISOString();
  const today = d.otpSends.filter((s) => Date.parse(s.at) >= dayStart);
  const t = (reason: string, retryAt: string): never => fail(429, "throttled", "Too many codes requested. Try again later.", { retryAt, reason });
  if (today.length >= CHANNEL_LIMITS.otpGlobalDay) t("global_limit", nextDay);
  const userHour = d.otpSends.filter((s) => s.userId === userId && within(s.at, HOUR));
  if (userHour.length >= CHANNEL_LIMITS.otpUserHour) t("hourly_limit", retryHour(userHour));
  if (today.filter((s) => s.userId === userId).length >= CHANNEL_LIMITS.otpUserDay) t("daily_limit", nextDay);
  const phoneHour = d.otpSends.filter((s) => s.phone === phone && within(s.at, HOUR));
  if (phoneHour.length >= CHANNEL_LIMITS.otpPhoneHour) t("phone_limit", retryHour(phoneHour));
}

function sendOtp(db: MockDB, userId: string, v: Pick<SmsVerificationRec, "phoneNumber" | "display">) {
  ext(db).otpSends.push({ userId, phone: v.phoneNumber, at: nowISO() });
  // Dev-only "Mock SMS · code 482913" toast (DevTools listens; the stream never forwards "mock." events).
  mockBus.publish("mock.sms_code", { workspaceId: "", userId, durable: false, data: { code: MOCK_SMS_CODE, display: v.display } });
}

function deviceLabel(ua: string): string {
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad|iPod/.test(ua) ? "iOS" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "Unknown OS";
  return `${browser} on ${os}`;
}

function decodedLength(b64: string): number | null {
  try {
    return urlB64ToUint8Array(b64).length;
  } catch {
    return null;
  }
}

function p256First(b64: string) {
  try {
    return urlB64ToUint8Array(b64)[0];
  } catch {
    return undefined;
  }
}

/** Push service allow-list (SSRF guard, §2.4). */
export function allowedEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    if (u.protocol !== "https:") return false;
    return PUSH_HOSTS.includes(u.hostname) || PUSH_SUFFIXES.some((s) => u.hostname.endsWith(s));
  } catch {
    return false;
  }
}

/** A permanent failure of a test updates the connection (§5.11, §6.8). */
function permanentFailure(db: MockDB, userId: string, channel: TestableChannel): string {
  if (channel === "telegram") {
    const c = tgConn(db, userId);
    if (c) {
      c.status = "blocked";
      c.lastError = "You blocked the bot in Telegram.";
    }
    publishChannels(db, userId, "telegram", "status");
    return "blocked";
  }
  if (channel === "sms") {
    const c = smsConn(db, userId);
    if (c) c.status = "opted_out";
    publishChannels(db, userId, "sms", "status");
    return "opted_out";
  }
  if (channel === "push") {
    for (const d of ext(db).pushDevices.filter((x) => x.userId === userId && x.status === "active")) d.status = "expired";
    publishChannels(db, userId, "push", "status");
    return "expired_subscription";
  }
  return "provider_error";
}

const sendFailed = (channel: TestableChannel, reason: string): never =>
  fail(502, "channel_send_failed", "The provider didn’t accept the message.", { channel, reason });

/* ───────── routes ───────── */

export function registerChannels() {
  /* C1 */
  route("GET", "/me/notification-channels", (ctx) => {
    const userId = requireUser(ctx);
    const db = ext(ctx.db);
    releaseDue(db);
    const user = db.users.find((u) => u.id === userId)!;
    const tg = tgConn(db, userId);
    const sms = smsConn(db, userId);
    const week = Date.now() - 7 * 24 * HOUR;
    const devices = db.pushDevices
      .filter((d) => d.userId === userId && (d.status === "active" || Date.parse(d.lastSeenAt) >= week))
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
      .map(toDevice);
    const out: NotificationChannels = {
      email: { address: user.email },
      telegram: { available: true, botUsername: BOT_USERNAME, connection: tg ? toTelegram(tg) : null },
      sms: {
        available: true,
        countries: SMS_COUNTRY_RULES.map(({ code, dial, label, digits, pattern }) => ({ code, dial, label, digits, pattern })),
        connection: sms ? toSms(sms) : null,
        dailyCap: SMS_USER_DAILY_CAP,
        sentToday: smsSentToday(db, userId),
      },
      push: { available: true, vapidPublicKey: MOCK_VAPID_PUBLIC_KEY, devices },
    };
    return out;
  });

  /* C2 */
  route("POST", "/me/notification-channels/telegram/link", (ctx) => {
    const userId = requireUser(ctx);
    const db = ext(ctx.db);
    if (tgConn(db, userId)?.status === "active") fail(409, "already_connected", "Telegram is already connected. Disconnect it first.", {});
    throttle(db, userId, "connect", CHANNEL_LIMITS.connectHour, "connect_limit");
    fillTimezone(db, userId, (ctx.body as { timezone?: unknown } | null)?.timezone);
    for (const l of db.telegramLinks) if (l.userId === userId && l.status === "pending") l.status = "canceled";
    const n = db.telegramLinks.filter((l) => l.userId === userId).length;
    const now = Date.now();
    const token = `lx_mock${Array.from({ length: 36 }, () => "abcdefghijkmnpqrstuvwxyz23456789"[Math.floor(Math.random() * 32)]).join("")}`;
    const rec: TelegramLinkRec = {
      id: uid("tgl"),
      userId,
      code: TELEGRAM_CODES[n % TELEGRAM_CODES.length]!,
      token,
      status: "pending",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + LINK_TTL_MS).toISOString(),
      autoLinkAt: mockControls.get().telegramManual ? null : new Date(now + channelTiming.autoLinkMs).toISOString(),
      connectionId: null,
    };
    db.telegramLinks.push(rec);
    if (db.telegramLinks.length > 50) db.telegramLinks.splice(0, db.telegramLinks.length - 50);
    if (rec.autoLinkAt && typeof window !== "undefined") {
      // The simulated scan: link it (and publish channels.changed) when it is due, even if nobody polls.
      setTimeout(() => {
        const cur = getDB();
        const l = cur.telegramLinks?.find((x) => x.id === rec.id);
        if (l && l.status === "pending") {
          refreshLink(cur, l);
          persist();
        }
      }, channelTiming.autoLinkMs + 20);
    }
    return toLink(db, rec);
  });

  /* C3 */
  route("GET", "/me/notification-channels/telegram/link/:linkId", (ctx) => {
    const userId = requireUser(ctx);
    const l = myLink(ctx, userId);
    refreshLink(ctx.db, l);
    return toLink(ctx.db, l);
  });

  /* C4 */
  route("DELETE", "/me/notification-channels/telegram/link/:linkId", (ctx) => {
    const userId = requireUser(ctx);
    const l = myLink(ctx, userId);
    refreshLink(ctx.db, l);
    if (l.status === "pending") l.status = "canceled";
    return undefined;
  });

  /* C5 */
  route("DELETE", "/me/notification-channels/telegram", (ctx) => {
    const userId = requireUser(ctx);
    const db = ext(ctx.db);
    const had = Boolean(tgConn(db, userId));
    db.channelConnections = db.channelConnections.filter((c) => !(c.channel === "telegram" && c.userId === userId));
    skipQueued(db, userId, "telegram");
    if (had) publishChannels(db, userId, "telegram", "disconnected");
    return undefined;
  });

  /* C6 */
  route("POST", "/me/notification-channels/sms/verifications", (ctx) => {
    const userId = requireUser(ctx);
    const db = ext(ctx.db);
    const country = str(ctx.body, "country") ?? "";
    const national = str(ctx.body, "nationalNumber") ?? "";
    const check = validateNational(country, national, SMS_COUNTRY_RULES.map((c) => c.code));
    if (!check.ok) invalid({ [check.field]: check.error });
    if (smsConn(db, userId)?.status === "active") fail(409, "already_connected", "Remove your phone number first.", {});
    throttle(db, userId, "connect", CHANNEL_LIMITS.connectHour, "connect_limit");
    otpLimits(db, userId, check.e164);
    fillTimezone(db, userId, (ctx.body as { timezone?: unknown } | null)?.timezone);
    for (const v of db.smsVerifications) if (v.userId === userId && v.status === "pending") v.status = "canceled";
    ext(db).otpSends.push({ userId, phone: check.e164, at: nowISO() });
    // The fake carrier refuses …5550000 numbers (the error state).
    if (check.national.includes("5550000")) sendFailed("sms", "invalid_number");
    const now = Date.now();
    const rec: SmsVerificationRec = {
      id: uid("smv"),
      userId,
      country: countryRule(country)!.code,
      phoneNumber: check.e164,
      display: check.display,
      expiresAt: new Date(now + OTP_TTL_MS).toISOString(),
      resendAt: new Date(now + RESEND_MS).toISOString(),
      attemptsLeft: 3,
      status: "pending",
      sendCount: 1,
    };
    db.smsVerifications.push(rec);
    if (db.smsVerifications.length > 50) db.smsVerifications.splice(0, db.smsVerifications.length - 50);
    mockBus.publish("mock.sms_code", { workspaceId: "", userId, durable: false, data: { code: MOCK_SMS_CODE, display: rec.display } });
    return toVerification(rec);
  });

  /* C7 */
  route("POST", "/me/notification-channels/sms/verifications/:id/resend", (ctx) => {
    const userId = requireUser(ctx);
    const v = myVerification(ctx, userId);
    if (v.status !== "pending") fail(410, "verification_closed", "This code request is closed.", {});
    if (Date.now() < Date.parse(v.resendAt)) fail(429, "throttled", "Wait before resending.", { retryAt: v.resendAt, reason: "resend_cooldown" });
    otpLimits(ctx.db, userId, v.phoneNumber);
    sendOtp(ctx.db, userId, v);
    const now = Date.now();
    v.attemptsLeft = 3;
    v.sendCount += 1;
    v.expiresAt = new Date(now + OTP_TTL_MS).toISOString();
    v.resendAt = new Date(now + RESEND_MS).toISOString();
    return toVerification(v);
  });

  /* C8 */
  route("POST", "/me/notification-channels/sms/verifications/:id/verify", (ctx) => {
    const userId = requireUser(ctx);
    const db = ext(ctx.db);
    const v = myVerification(ctx, userId);
    if (v.status === "expired") fail(410, "code_expired", "Code expired.", {});
    if (v.status !== "pending") fail(410, "verification_closed", "This code request is closed.", {});
    const code = str(ctx.body, "code") ?? "";
    if (!/^\d{6}$/.test(code)) invalid({ code: "Enter the 6-digit code" });
    if (Date.now() >= Date.parse(v.expiresAt)) {
      v.status = "expired";
      fail(410, "code_expired", "Code expired.", {});
    }
    if (v.attemptsLeft <= 0) fail(422, "too_many_attempts", "Too many tries.", { attemptsLeft: 0 });
    if (code !== MOCK_SMS_CODE) {
      v.attemptsLeft -= 1;
      // At 0 the code is dead, even if the next guess would be right.
      if (v.attemptsLeft <= 0) fail(422, "too_many_attempts", "Too many tries.", { attemptsLeft: 0 });
      fail(422, "invalid_code", "Wrong code.", { attemptsLeft: v.attemptsLeft });
    }
    v.status = "verified";
    db.channelConnections = db.channelConnections.filter((c) => !(c.channel === "sms" && c.userId === userId));
    const conn: SmsRec = {
      channel: "sms",
      userId,
      id: uid("smc"),
      phoneNumber: v.phoneNumber,
      display: v.display,
      country: v.country,
      status: "active",
      verifiedAt: nowISO(),
      lastError: null,
    };
    db.channelConnections.push(conn);
    publishChannels(db, userId, "sms", "linked");
    return { connection: toSms(conn) };
  });

  /* C9 */
  route("DELETE", "/me/notification-channels/sms", (ctx) => {
    const userId = requireUser(ctx);
    const db = ext(ctx.db);
    const had = Boolean(smsConn(db, userId));
    db.channelConnections = db.channelConnections.filter((c) => !(c.channel === "sms" && c.userId === userId));
    skipQueued(db, userId, "sms");
    if (had) publishChannels(db, userId, "sms", "disconnected");
    return undefined;
  });

  /* C10 (public) */
  route("GET", "/push/vapid-public-key", () => ({ publicKey: MOCK_VAPID_PUBLIC_KEY }), { anonymous: true });

  /* C11 */
  route("PUT", "/me/push-subscriptions", (ctx) => {
    const userId = requireUser(ctx);
    const db = ext(ctx.db);
    const body = (ctx.body ?? {}) as { mode?: string; subscription?: { endpoint?: unknown; expirationTime?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } };
    const sub = body.subscription;
    const endpoint = typeof sub?.endpoint === "string" ? sub.endpoint : "";
    const p256dh = typeof sub?.keys?.p256dh === "string" ? sub.keys.p256dh : "";
    const auth = typeof sub?.keys?.auth === "string" ? sub.keys.auth : "";
    const fields: Record<string, string> = {};
    if (body.mode !== "subscribe" && body.mode !== "refresh") fields.mode = "Use subscribe or refresh";
    if (!allowedEndpoint(endpoint)) fields["subscription.endpoint"] = "Unsupported push service";
    if (decodedLength(p256dh) !== 65 || p256First(p256dh) !== 4) fields["subscription.keys.p256dh"] = "Invalid key";
    if (decodedLength(auth) !== 16) fields["subscription.keys.auth"] = "Invalid key";
    if (Object.keys(fields).length) invalid(fields);
    fillTimezone(db, userId, (ctx.body as { timezone?: unknown }).timezone);
    const hash = endpointHash(endpoint);
    const existing = db.pushDevices.find((d) => d.endpointHash === hash);
    const now = nowISO();
    const label = deviceLabel(typeof navigator === "undefined" ? "" : navigator.userAgent);
    if (body.mode === "refresh") {
      if (!existing || existing.userId !== userId || existing.status !== "active") fail(404, "not_found", "Subscription not found.");
      Object.assign(existing, { lastSeenAt: now, p256dh, auth, label });
      return toDevice(existing);
    }
    let dev: PushDeviceRec;
    if (existing) {
      // A browser subscription belongs to whoever subscribed it last.
      Object.assign(existing, { userId, p256dh, auth, label, status: "active", lastSeenAt: now, failureCount: 0 });
      dev = existing;
    } else {
      dev = { id: uid("pd"), userId, endpoint, endpointHash: hash, p256dh, auth, label, status: "active", createdAt: now, lastSeenAt: now, lastSuccessAt: null, failureCount: 0 };
      db.pushDevices.push(dev);
    }
    const active = db.pushDevices.filter((d) => d.userId === userId && d.status === "active").sort((a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt));
    while (active.length > CHANNEL_LIMITS.pushDevices) active.shift()!.status = "expired";
    publishChannels(db, userId, "push", "linked");
    return toDevice(dev);
  });

  /* C12 */
  route("POST", "/me/push-subscriptions/remove", (ctx) => {
    const userId = requireUser(ctx);
    const db = ext(ctx.db);
    const endpoint = str(ctx.body, "endpoint") ?? "";
    const hash = endpointHash(endpoint);
    const before = db.pushDevices.length;
    db.pushDevices = db.pushDevices.filter((d) => !(d.userId === userId && d.endpointHash === hash));
    if (db.pushDevices.length !== before) publishChannels(db, userId, "push", "disconnected");
    return undefined;
  });

  /* C13 */
  route("DELETE", "/me/push-subscriptions/:id", (ctx) => {
    const userId = requireUser(ctx);
    const db = ext(ctx.db);
    const d = db.pushDevices.find((x) => x.id === ctx.params.id && x.userId === userId);
    if (!d) fail(404, "not_found", "Device not found.");
    db.pushDevices = db.pushDevices.filter((x) => x !== d);
    publishChannels(db, userId, "push", "disconnected");
    return undefined;
  });

  /* C14 */
  route("POST", "/me/notification-channels/:channel/test", (ctx) => {
    const userId = requireUser(ctx);
    const db = ext(ctx.db);
    const channel = ctx.params.channel as TestableChannel;
    if (!["email", "telegram", "sms", "push"].includes(channel)) fail(404, "not_found", "Unknown channel.");
    const deviceId = str(ctx.body, "deviceId");
    let target = userId;
    let devices: PushDeviceRec[] = [];
    if (channel === "telegram") {
      const c = tgConn(db, userId);
      if (!c) fail(409, "channel_not_connected", "Telegram isn’t connected.", { channel });
      if (c.status === "blocked") sendFailed(channel, "blocked");
      target = c.id;
    } else if (channel === "sms") {
      const c = smsConn(db, userId);
      if (!c) fail(409, "channel_not_connected", "SMS isn’t connected.", { channel });
      if (c.status === "opted_out") sendFailed(channel, "opted_out");
      if (c.status === "invalid") sendFailed(channel, "invalid_number");
      target = c.id;
    } else if (channel === "push") {
      const mine = db.pushDevices.filter((d) => d.userId === userId && (!deviceId || d.id === deviceId));
      devices = mine.filter((d) => d.status === "active");
      if (!devices.length) {
        if (mine.length) sendFailed(channel, "expired_subscription");
        fail(409, "channel_not_connected", "Push isn’t on for any device.", { channel });
      }
      target = devices[0]!.id;
    }
    throttle(db, userId, "test", CHANNEL_LIMITS.testHour, "test_limit");
    if (channel === "sms" && smsSentToday(db, userId) >= SMS_USER_DAILY_CAP) {
      const next = new Date(new Date().setUTCHours(24, 0, 0, 0)).toISOString();
      fail(429, "throttled", "Daily SMS limit reached.", { retryAt: next, reason: "daily_cap" });
    }
    if (mockControls.get().channelFailures) {
      // One-shot: the switch turns itself off.
      mockControls.set((c) => ({ ...c, channelFailures: false }));
      const reason = permanentFailure(db, userId, channel);
      recordDelivery(db, newDelivery({ userId, workspaceId: null, channel, kind: "test", event: "test", target, notificationId: null, taskKey: null, urgent: false, status: "failed" }));
      persist();
      sendFailed(channel, reason);
    }
    const row = recordDelivery(db, newDelivery({ userId, workspaceId: null, channel, kind: "test", event: "test", target, notificationId: null, taskKey: null, urgent: false, status: "sent" }));
    if (channel === "push") {
      const sentAt = nowISO();
      for (const d of devices) {
        d.lastSuccessAt = sentAt;
        d.failureCount = 0;
      }
      if (typeof window !== "undefined") {
        // A real OS notification through the registered service worker, when this browser is a target.
        void (async () => {
          const p = getPushPlatform();
          const sub = await p.current();
          if (sub && devices.some((d) => d.endpoint === sub.endpoint)) await p.showLocal("Test notification", "Lightex notifications will appear on this device.");
        })().catch(() => undefined);
      }
    }
    const out: ChannelTestResult = { channel, status: "sent", deliveryId: row.id, sentAt: row.sentAt ?? nowISO() };
    return out;
  });
}

/** A disconnect skips that channel's queued / deferred rows (`not_connected`). */
function skipQueued(db: MockDB, userId: string, channel: "telegram" | "sms") {
  for (const d of ext(db).channelDeliveries) {
    if (d.userId === userId && d.channel === channel && (d.status === "deferred" || d.status === "queued")) {
      d.status = "skipped";
      d.skipReason = "not_connected";
    }
  }
}

/* ───────── dev-pill simulators (what the webhooks would do) ───────── */

/** "Simulate scan": links the user's pending code now (manual mode, or before the 5 s). */
export function simulateTelegramScan(userId: string | null): string {
  if (!userId) return "Sign in first";
  const db = ext(getDB());
  const l = [...db.telegramLinks].reverse().find((x) => x.userId === userId && x.status === "pending");
  if (!l) return "No pending Telegram code";
  refreshLink(db, l);
  if (l.status === "pending") linkNow(db, l);
  persist();
  return l.status === "linked" ? "Telegram linked" : "That code expired";
}

/** `my_chat_member` kicked: the user blocked the bot. */
export function simulateTelegramBlocked(userId: string | null): string {
  const c = userId ? tgConn(getDB(), userId) : undefined;
  if (!c || !userId) return "Telegram isn’t connected";
  c.status = "blocked";
  c.lastError = "You blocked the bot in Telegram.";
  publishChannels(getDB(), userId, "telegram", "status");
  persist();
  return "The bot is now blocked in Telegram";
}

/** Inbound STOP / START (H2). STOP applies to every connection with that number. */
export function simulateSmsReply(userId: string | null, word: "STOP" | "START"): string {
  const db = ext(getDB());
  const c = userId ? smsConn(db, userId) : undefined;
  if (!c) return "No phone number connected";
  for (const x of db.channelConnections) {
    if (x.channel !== "sms" || x.phoneNumber !== c.phoneNumber) continue;
    if (word === "STOP") x.status = "opted_out";
    else if (x.status === "opted_out") x.status = "active";
    publishChannels(db, x.userId, "sms", "status");
  }
  persist();
  return word === "STOP" ? `${c.display} replied STOP` : `${c.display} replied START`;
}
