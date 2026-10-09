import { isApiError } from "@/lib/api/errors";
import type { TelegramConnection, TelegramLink } from "@/lib/api/types";

/*
 * The Telegram connect dialog (board 38, spec §8.5) as a pure reducer:
 * starting → pending (code + deep link, countdown, C3 polled every 2 s) → linked | expired (→ New code)
 * and error (C2 refused: already connected, throttled, unavailable).
 */

export type PendingLink = TelegramLink & { code: string; deepLink: string };

export type TgState =
  | { phase: "starting" }
  | { phase: "pending"; link: PendingLink }
  /** The code stays visible, struck through. */
  | { phase: "expired"; link: PendingLink }
  | { phase: "linked"; connection: TelegramConnection }
  | { phase: "error"; message: string; code: string | null };

export type TgAction =
  | { type: "start" }
  | { type: "started"; link: TelegramLink }
  | { type: "polled"; link: TelegramLink }
  | { type: "tick"; now: number }
  /** A mock scan / channels.changed told us before the poll did. */
  | { type: "linked"; connection: TelegramConnection }
  | { type: "failed"; message: string; code: string | null };

export const TG_INITIAL: TgState = { phase: "starting" };

export function tgReducer(s: TgState, a: TgAction): TgState {
  switch (a.type) {
    case "start":
      return { phase: "starting" };
    case "started":
      if (a.link.status === "linked" && a.link.connection) return { phase: "linked", connection: a.link.connection };
      if (!a.link.code || !a.link.deepLink) return { phase: "error", message: "Couldn’t create a code. Try again.", code: null };
      return { phase: "pending", link: a.link as PendingLink };
    case "polled": {
      if (s.phase !== "pending" || a.link.id !== s.link.id) return s;
      if (a.link.status === "linked" && a.link.connection) return { phase: "linked", connection: a.link.connection };
      // Canceled (another tab asked for a newer code) behaves like expired: offer a new code.
      if (a.link.status === "expired" || a.link.status === "canceled") return { phase: "expired", link: s.link };
      return s;
    }
    case "tick":
      if (s.phase === "pending" && remainingSeconds(s.link.expiresAt, a.now) <= 0) return { phase: "expired", link: s.link };
      return s;
    case "linked":
      return s.phase === "linked" ? s : { phase: "linked", connection: a.connection };
    case "failed":
      return { phase: "error", message: a.message, code: a.code };
  }
}

/** Seconds left on a code (server time; client clock skew ignored, §8.5). */
export const remainingSeconds = (expiresAt: string, now: number) => Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));

/** 582 → "9:42". */
export const formatClock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** The countdown turns warn at ≤ 1:00. */
export const isWarn = (s: number) => s <= 60;

/** "K7MQ2X" → six cells with a gap after the third (design `K7M Q2X`). */
export const codeCells = (code: string) => code.split("").map((c, i) => ({ c, gap: i === 3 }));

/** "Connected as @alexkim" (or the first name when the account has no username). */
export const telegramHandle = (c: Pick<TelegramConnection, "username" | "firstName">) => (c.username ? `@${c.username}` : c.firstName);

const retryTime = (e: unknown) => {
  const at = isApiError(e) ? (e.details as { retryAt?: string } | undefined)?.retryAt : undefined;
  return at ? new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
};

/** C2's errors as the dialog shows them. */
export function telegramStartError(e: unknown): { message: string; code: string | null } {
  if (!isApiError(e)) return { message: "Couldn’t create a code. Try again.", code: null };
  switch (e.code) {
    case "already_connected":
      return { message: "Telegram is already connected. Disconnect it first.", code: e.code };
    case "throttled": {
      const t = retryTime(e);
      return { message: t ? `Too many codes requested. Try again at ${t}.` : "Too many codes requested. Try again later.", code: e.code };
    }
    case "channel_unavailable":
      return { message: "Telegram isn’t available on this server.", code: e.code };
    default:
      return { message: e.message || "Couldn’t create a code. Try again.", code: e.code };
  }
}

export { retryTime };
