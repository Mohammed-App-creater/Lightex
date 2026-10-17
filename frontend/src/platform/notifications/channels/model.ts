import { isApiError } from "@/lib/api/errors";
import type {
  ExternalChannel,
  NotificationChannel,
  NotificationChannels,
  NotificationEvent,
  NotificationPreferences,
  PushDevice,
  TestableChannel,
} from "@/lib/api/types";
import { DEFAULT_QUIET } from "./quiet";
import type { PushSupport } from "./push";

/*
 * Board 38 view model (pure): which matrix columns are live, what each channel row says and offers, the
 * push state of this browser, the preference toggle merge, and the Send-test copy.
 */

export const CHANNEL_NAME: Record<NotificationChannel, string> = { in_app: "In-app", email: "Email", telegram: "Telegram", sms: "SMS", push: "Push" };
/** Short column labels at ≤ 760 px (design `.pm-short`). */
export const CHANNEL_SHORT: Record<NotificationChannel, string> = { in_app: "App", email: "Mail", telegram: "TG", sms: "SMS", push: "Push" };
export const CHANNEL_ORDER: NotificationChannel[] = ["in_app", "email", "telegram", "sms", "push"];
export const EXTERNAL: ExternalChannel[] = ["telegram", "sms", "push"];

/** The design's DEF table (§3.8): in_app / email are v1's defaults. */
export const DEFAULT_EVENTS: NotificationPreferences["events"] = {
  assigned: { in_app: true, email: true, telegram: true, sms: false, push: true },
  mentioned: { in_app: true, email: true, telegram: true, sms: false, push: true },
  status_change: { in_app: true, email: false, telegram: false, sms: false, push: false },
  comment: { in_app: true, email: false, telegram: true, sms: false, push: true },
  due_soon: { in_app: true, email: true, telegram: true, sms: true, push: true },
  sprint_started: { in_app: true, email: false, telegram: false, sms: false, push: false },
};

export function defaultPreferences(): NotificationPreferences {
  return {
    events: structuredClone(DEFAULT_EVENTS),
    emailDelivery: "instant",
    quietHours: { ...DEFAULT_QUIET, days: [...DEFAULT_QUIET.days] },
  };
}

/** Fills missing channel keys and quiet hours (an older payload) without touching the values that are there. */
export function withDefaults(p: Partial<NotificationPreferences> | undefined): NotificationPreferences {
  const d = defaultPreferences();
  const events = Object.fromEntries(
    (Object.keys(d.events) as NotificationEvent[]).map((ev) => [ev, { ...d.events[ev], ...(p?.events?.[ev] ?? {}) }]),
  ) as NotificationPreferences["events"];
  return { events, emailDelivery: p?.emailDelivery ?? d.emailDelivery, quietHours: p?.quietHours ? { ...d.quietHours, ...p.quietHours } : d.quietHours };
}

/** One matrix switch → the next preferences (only that cell changes). */
export function toggleCell(p: NotificationPreferences, event: NotificationEvent, channel: NotificationChannel, on: boolean): NotificationPreferences {
  return { ...p, events: { ...p.events, [event]: { ...p.events[event], [channel]: on } } };
}

/* ───────── push in this browser ───────── */

export type PushPhase = "unsupported" | "ios" | "off" | "prompt" | "on" | "expired" | "blocked";

export type PushView = {
  phase: PushPhase;
  /** This browser's device row (when its endpoint hash is listed). */
  thisDevice: PushDevice | null;
  /** Other browsers with an active subscription. */
  others: PushDevice[];
};

/**
 * `localHash`: endpointHash of this browser's subscription (null when it has none). `prompting`: the
 * browser's permission prompt is open.
 */
export function pushView(input: {
  support: PushSupport;
  permission: NotificationPermission;
  localHash: string | null;
  devices: PushDevice[];
  prompting: boolean;
}): PushView {
  const thisDevice = input.localHash ? (input.devices.find((d) => d.endpointHash === input.localHash) ?? null) : null;
  const others = input.devices.filter((d) => d.status === "active" && d !== thisDevice);
  const phase: PushPhase =
    input.support === "unsupported"
      ? "unsupported"
      : input.support === "ios-needs-install"
        ? "ios"
        : input.prompting
          ? "prompt"
          : input.permission === "denied"
            ? "blocked"
            : thisDevice?.status === "active" && input.permission === "granted"
              ? "on"
              : thisDevice?.status === "expired"
                ? "expired"
                : "off";
  return { phase, thisDevice, others };
}

/* ───────── matrix columns ───────── */

export type ColumnNote = "connect" | "policy" | "blocked" | "unavailable" | "retry" | "opted_out" | null;
export type ColumnState = {
  usable: boolean;
  note: ColumnNote;
  /** aria-label suffix of a dead cell ("not connected"). */
  reason: string;
};

const live: ColumnState = { usable: true, note: null, reason: "" };

export function columnStates(input: {
  channels: NotificationChannels | undefined;
  /** C1 failed: external columns show "Unavailable · Retry". */
  channelsError: boolean;
  smsPolicy: boolean;
  push: PushView;
}): Record<NotificationChannel, ColumnState> {
  const { channels: c, channelsError, smsPolicy, push } = input;
  const dead = (note: ColumnNote, reason: string): ColumnState => ({ usable: false, note, reason });
  if (!c) {
    const x = channelsError ? dead("retry", "unavailable") : dead(null, "loading");
    return { in_app: live, email: live, telegram: x, sms: x, push: x };
  }
  const telegram = !c.telegram.available
    ? dead("unavailable", "not available")
    : c.telegram.connection?.status === "active"
      ? live
      : c.telegram.connection?.status === "blocked"
        ? dead("blocked", "bot blocked")
        : dead("connect", "not connected");
  const sms = !c.sms.available
    ? dead("unavailable", "not available")
    : !smsPolicy
      ? dead("policy", "off by admin")
      : c.sms.connection?.status === "active"
        ? live
        : c.sms.connection?.status === "opted_out"
          ? dead("opted_out", "replied STOP")
          : dead("connect", "not connected");
  // Push reaches any active subscription, this browser or another (§6.2 #3).
  const anyActive = push.phase === "on" || push.others.length > 0;
  const pushCol = !c.push.available
    ? dead("unavailable", "not available")
    : anyActive
      ? live
      : push.phase === "blocked"
        ? dead("blocked", "blocked in browser")
        : push.phase === "unsupported" || push.phase === "ios"
          ? dead("unavailable", "not supported here")
          : push.phase === "prompt"
            ? dead(null, "waiting for browser")
            : dead("connect", "not connected");
  return { in_app: live, email: live, telegram, sms, push: pushCol };
}

/* ───────── channel rows (spec §8.5 table) ───────── */

export type RowTone = "ok" | "off" | "wait" | "err";
export type RowAction = "test" | "connect" | "reconnect" | "enable" | "check" | "remove";
export type RowModel = { status: string; tone: RowTone; mono: boolean; actions: RowAction[]; removeLabel: string };

export function telegramRow(c: NotificationChannels["telegram"], dialogOpen: boolean): RowModel {
  const removeLabel = "Disconnect Telegram";
  if (!c.available) return { status: "Not available on this server", tone: "off", mono: false, actions: [], removeLabel };
  const conn = c.connection;
  if (conn?.status === "active")
    return { status: conn.username ? `@${conn.username}` : conn.firstName, tone: "ok", mono: Boolean(conn.username), actions: ["test", "remove"], removeLabel };
  if (dialogOpen) return { status: "Waiting…", tone: "wait", mono: false, actions: [], removeLabel };
  if (conn?.status === "blocked") return { status: "Bot blocked in Telegram", tone: "err", mono: false, actions: ["reconnect", "remove"], removeLabel };
  return { status: "Not connected", tone: "off", mono: false, actions: ["connect"], removeLabel };
}

export function smsRow(c: NotificationChannels["sms"], policy: boolean): RowModel {
  const removeLabel = "Disconnect SMS";
  if (!c.available) return { status: "Not available on this server", tone: "off", mono: false, actions: [], removeLabel };
  const conn = c.connection;
  // §10 #11: with a number connected, × stays even when the admin turned SMS off.
  if (!policy) return { status: "Off by admin", tone: "off", mono: false, actions: conn ? ["remove"] : [], removeLabel };
  if (!conn) return { status: "Not connected", tone: "off", mono: false, actions: ["connect"], removeLabel };
  if (conn.status === "opted_out") return { status: "Replied STOP · text START to resume", tone: "err", mono: false, actions: ["remove"], removeLabel };
  if (conn.status === "invalid") return { status: "Number can’t receive SMS", tone: "err", mono: false, actions: ["connect", "remove"], removeLabel };
  return { status: conn.display, tone: "ok", mono: true, actions: ["test", "remove"], removeLabel };
}

const more = (n: number, word: "other" | "more") => (n ? ` · ${n} ${word} device${n === 1 ? "" : "s"}` : "");

export function pushRow(available: boolean, v: PushView): RowModel {
  const removeLabel = "Turn off push in this browser";
  if (!available) return { status: "Not available on this server", tone: "off", mono: false, actions: [], removeLabel };
  switch (v.phase) {
    case "unsupported":
      return { status: "Not supported in this browser", tone: "off", mono: false, actions: [], removeLabel };
    case "ios":
      return { status: "Add Lightex to your Home Screen to enable push", tone: "off", mono: false, actions: [], removeLabel };
    case "prompt":
      return { status: "Waiting for browser…", tone: "wait", mono: false, actions: [], removeLabel };
    case "blocked":
      return { status: "Blocked in browser", tone: "err", mono: false, actions: ["check"], removeLabel };
    case "on":
      return { status: `This browser${more(v.others.length, "more")}`, tone: "ok", mono: false, actions: ["test", "remove"], removeLabel };
    case "expired":
      return { status: "This browser’s subscription expired", tone: "err", mono: false, actions: ["enable", "remove"], removeLabel };
    default:
      return { status: `Off${more(v.others.length, "other")}`, tone: "off", mono: false, actions: ["enable"], removeLabel };
  }
}

/* ───────── Send test (§8.5, §6.5 "test" copy, §10 #13) ───────── */

export type PreviewChannel = "in_app" | TestableChannel;
export type PreviewCard = { app: string; from: string; title: string | null; body: string; logo: boolean };

export function previewFor(channel: PreviewChannel, opts: { email?: string; host?: string } = {}): PreviewCard {
  switch (channel) {
    case "in_app":
      return { app: "Lightex", from: "In-app", title: "Test notification", body: "Lightex notifications will appear in your inbox.", logo: true };
    case "email":
      return { app: "Mail", from: opts.email ?? "Lightex", title: "Lightex test notification", body: "This is a test. Email notifications are on.", logo: false };
    case "telegram":
      return { app: "Telegram", from: "Lightex bot", title: "Test notification", body: "Lightex notifications will arrive in this chat.", logo: false };
    case "sms":
      return { app: "Messages", from: "Lightex", title: null, body: "Lightex: test message. SMS notifications are on. Reply STOP to opt out", logo: false };
    case "push":
      return { app: "Lightex", from: opts.host ?? "Lightex", title: "Test notification", body: "Lightex notifications will appear on this device.", logo: true };
  }
}

/** C14 errors → the error toast (§5.11). */
export function testErrorCopy(channel: TestableChannel, e: unknown): { title: string; body?: string } {
  const name = CHANNEL_NAME[channel];
  if (!isApiError(e)) return { title: `Couldn’t send a test · ${name}` };
  const reason = (e.details as { reason?: string } | undefined)?.reason;
  if (e.code === "channel_send_failed") {
    const body =
      reason === "blocked"
        ? "You blocked the bot. Unblock it and send /start."
        : reason === "opted_out"
          ? "You replied STOP. Text START to the Lightex number to resume."
          : reason === "expired_subscription"
            ? "This browser’s subscription expired. Turn push off and on."
            : reason === "invalid_number"
              ? "This number can’t receive SMS."
              : "The provider didn’t accept the message. Try again later.";
    return { title: `Couldn’t reach ${name}`, body };
  }
  if (e.code === "throttled") {
    const at = (e.details as { retryAt?: string } | undefined)?.retryAt;
    const t = at ? new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
    return {
      title: reason === "daily_cap" ? "Daily SMS limit reached" : "Too many tests",
      body: t ? `Try again at ${t}.` : "Try again later.",
    };
  }
  if (e.code === "channel_not_connected") return { title: `${name} isn’t connected` };
  if (e.code === "channel_unavailable") return { title: `${name} isn’t available on this server` };
  return { title: `Couldn’t send a test · ${name}`, body: e.message };
}
