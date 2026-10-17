import { isApiError } from "@/lib/api/errors";
import type { SmsConnection, SmsVerification } from "@/lib/api/types";
import { retryTime } from "./telegram-machine";

/*
 * The SMS dialog (board 38, spec §8.5) as a pure reducer:
 * phone (country + national number) → sending → otp (6 boxes; auto-verify when all six are filled) →
 * verifying → verified, with wrong code (tries left, shake, boxes cleared), too many tries (read-only
 * until Resend), code expired, and the 30 s resend countdown.
 */

export type OtpError = { kind: "wrong" | "locked" | "expired" | "other"; text: string };

export type SmsState =
  | { step: "phone"; country: string; digits: string; error: string | null; sending: boolean }
  | {
      step: "otp";
      country: string;
      digits: string;
      verification: SmsVerification;
      code: string[];
      verifying: boolean;
      resending: boolean;
      attemptsLeft: number;
      error: OtpError | null;
      /** Bumped on every wrong code so the boxes replay the shake. */
      shake: number;
    }
  | { step: "verified"; connection: SmsConnection };

export type SmsAction =
  | { type: "country"; country: string }
  | { type: "digits"; digits: string }
  | { type: "send" }
  | { type: "sendOk"; verification: SmsVerification }
  | { type: "sendFail"; error: string | null }
  | { type: "edit" }
  | { type: "code"; code: string[] }
  | { type: "verify" }
  | { type: "verifyOk"; connection: SmsConnection }
  | { type: "verifyFail"; error: OtpError; attemptsLeft?: number }
  | { type: "resend" }
  | { type: "resendOk"; verification: SmsVerification }
  | { type: "resendFail" };

export const EMPTY_CODE = ["", "", "", "", "", ""];

export const smsInitial = (country: string): SmsState => ({ step: "phone", country, digits: "", error: null, sending: false });

export function smsReducer(s: SmsState, a: SmsAction): SmsState {
  switch (a.type) {
    case "country":
      // Changing country clears the number (design).
      return s.step === "phone" ? { ...s, country: a.country, digits: "", error: null } : s;
    case "digits":
      return s.step === "phone" ? { ...s, digits: a.digits, error: null } : s;
    case "send":
      return s.step === "phone" ? { ...s, sending: true, error: null } : s;
    case "sendFail":
      return s.step === "phone" ? { ...s, sending: false, error: a.error } : s;
    case "sendOk":
      if (s.step !== "phone") return s;
      return {
        step: "otp",
        country: s.country,
        digits: s.digits,
        verification: a.verification,
        code: [...EMPTY_CODE],
        verifying: false,
        resending: false,
        attemptsLeft: a.verification.attemptsLeft,
        error: null,
        shake: 0,
      };
    case "edit":
      // Back to step 1 with the number kept.
      return s.step === "otp" ? { step: "phone", country: s.country, digits: s.digits, error: null, sending: false } : s;
    case "code":
      if (s.step !== "otp" || otpLocked(s)) return s;
      return { ...s, code: a.code, error: null };
    case "verify":
      return s.step === "otp" && !otpLocked(s) && isFilled(s.code) ? { ...s, verifying: true, error: null } : s;
    case "verifyOk":
      return { step: "verified", connection: a.connection };
    case "verifyFail": {
      if (s.step !== "otp") return s;
      const attemptsLeft = a.error.kind === "locked" ? 0 : (a.attemptsLeft ?? s.attemptsLeft);
      return { ...s, verifying: false, error: a.error, attemptsLeft, code: [...EMPTY_CODE], shake: a.error.kind === "wrong" ? s.shake + 1 : s.shake };
    }
    case "resend":
      return s.step === "otp" ? { ...s, resending: true } : s;
    case "resendOk":
      // Tries reset on resend (design); the old code is dead.
      return s.step === "otp"
        ? { ...s, resending: false, verification: a.verification, attemptsLeft: a.verification.attemptsLeft, code: [...EMPTY_CODE], error: null, verifying: false }
        : s;
    case "resendFail":
      return s.step === "otp" ? { ...s, resending: false } : s;
  }
}

export const isFilled = (code: string[]) => code.length === 6 && code.every((d) => /^\d$/.test(d));

/** Boxes are read-only while verifying, after 3 wrong tries and once the code expired (until Resend). */
export const otpLocked = (s: Extract<SmsState, { step: "otp" }>) =>
  s.verifying || s.attemptsLeft <= 0 || s.error?.kind === "locked" || s.error?.kind === "expired";

/** Seconds until Resend is allowed. */
export const resendIn = (resendAt: string, now: number) => Math.max(0, Math.ceil((Date.parse(resendAt) - now) / 1000));

/** C8's errors (§5.8) as the dialog shows them. */
export function otpErrorFrom(e: unknown): { error: OtpError; attemptsLeft?: number } {
  if (!isApiError(e)) return { error: { kind: "other", text: "Couldn’t check the code. Try again." } };
  const left = (e.details as { attemptsLeft?: number } | undefined)?.attemptsLeft;
  switch (e.code) {
    case "invalid_code": {
      const n = left ?? 0;
      if (n <= 0) return { error: { kind: "locked", text: "Too many tries · resend a code" }, attemptsLeft: 0 };
      return { error: { kind: "wrong", text: `Wrong code · ${n} ${n === 1 ? "try" : "tries"} left` }, attemptsLeft: n };
    }
    case "too_many_attempts":
      return { error: { kind: "locked", text: "Too many tries · resend a code" }, attemptsLeft: 0 };
    case "code_expired":
    case "verification_closed":
      return { error: { kind: "expired", text: "Code expired · resend a code" } };
    default:
      return { error: { kind: "other", text: e.message || "Couldn’t check the code. Try again." } };
  }
}

/**
 * C6 / C7 errors (§5.6, §5.7): `field` goes under the number input, `toast` is a toast.
 */
export function smsSendError(e: unknown): { field: string | null; toast: string | null } {
  if (!isApiError(e)) return { field: "Couldn’t send a code to this number", toast: null };
  const fields = (e.details as { fields?: Record<string, string> } | undefined)?.fields;
  if (e.code === "validation_failed") return { field: fields?.nationalNumber ?? fields?.country ?? e.message, toast: null };
  if (e.code === "throttled") {
    const reason = (e.details as { reason?: string } | undefined)?.reason;
    const t = retryTime(e);
    if (reason === "resend_cooldown") return { field: null, toast: "Wait for the countdown before resending." };
    return { field: null, toast: t ? `Too many codes requested. Try again at ${t}.` : "Too many codes requested. Try again later." };
  }
  if (e.code === "channel_send_failed") return { field: "Couldn’t send a code to this number", toast: null };
  if (e.code === "channel_unavailable") return { field: "SMS isn’t available on this server", toast: null };
  if (e.code === "already_connected") return { field: "This account already has a phone. Remove it first.", toast: null };
  if (e.code === "verification_closed") return { field: null, toast: "That code request was closed. Send a new code." };
  return { field: null, toast: e.message };
}
