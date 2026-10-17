"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useReducer, useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api/endpoints";
import { qk } from "@/lib/api/query-keys";
import type { SmsCountry } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";
import { ChannelDialog } from "./channel-dialog";
import { Glyph, SparkCheck, Spin } from "./icons";
import { OtpInput } from "./otp-input";
import { formatNational, isComplete, nationalDigits, phoneHelp, placeholderFor } from "./phone";
import { browserTimeZone } from "./quiet";
import { formatClock } from "./telegram-machine";
import { isFilled, otpErrorFrom, otpLocked, resendIn, smsInitial, smsReducer, smsSendError } from "./sms-machine";

/*
 * Verify a phone for SMS (board 38, spec §8.5): country + national number (formatted as you type) → Send
 * code (C6) → six boxes, verified automatically when all are filled (C8) → "+1 (415) 555-0132 verified".
 * Wrong code / too many tries / expired, and "Resend in 0:24" → Resend code (C7, tries reset). Closing
 * before verifying calls nothing: the pending code expires and the next C6 cancels it.
 */

const INPUT =
  "h-[34px] w-full min-w-0 rounded-sm border border-control bg-surface px-2.5 font-mono text-[12.5px] text-fg transition-[border-color,box-shadow] placeholder:text-fg-3 hover:border-fg-3 focus:border-accent focus:shadow-[0_0_0_3px_var(--ring)] focus:outline-none max-[760px]:h-11 max-[760px]:text-[15px]";

export function SmsDialog({ countries, onClose, onSendTest }: { countries: SmsCountry[]; onClose: () => void; onSendTest: () => void }) {
  const qc = useQueryClient();
  const [s, dispatch] = useReducer(smsReducer, countries[0]?.code ?? "US", smsInitial);
  const [now, setNow] = useState(() => Date.now());
  const helpId = useId();
  const country = countries.find((c) => c.code === (s.step === "verified" ? "" : s.country)) ?? countries[0]!;

  const waiting = s.step === "otp" && resendIn(s.verification.resendAt, now) > 0;
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [waiting]);

  const send = async () => {
    if (s.step !== "phone" || s.sending) return;
    if (!isComplete(country, s.digits)) {
      dispatch({ type: "sendFail", error: `Enter ${country.digits} digits` });
      return;
    }
    dispatch({ type: "send" });
    try {
      const v = await api.channels.startSms({ country: country.code, nationalNumber: s.digits, timezone: browserTimeZone() });
      setNow(Date.now());
      // No "Code sent" toast: the step says it inline, and on a phone a toast would cover the sheet.
      dispatch({ type: "sendOk", verification: v });
    } catch (e) {
      const err = smsSendError(e);
      dispatch({ type: "sendFail", error: err.field });
      if (err.toast) toast.error(err.toast);
    }
  };

  const verify = async (code: string[]) => {
    if (s.step !== "otp") return;
    dispatch({ type: "verify" });
    try {
      const { connection } = await api.channels.verifySms(s.verification.id, code.join(""));
      dispatch({ type: "verifyOk", connection });
      void qc.invalidateQueries({ queryKey: qk.channels() });
      toast.success("Phone verified");
    } catch (e) {
      dispatch({ type: "verifyFail", ...otpErrorFrom(e) });
    }
  };

  const onCode = (code: string[]) => {
    dispatch({ type: "code", code });
    if (s.step === "otp" && !otpLocked(s) && isFilled(code)) void verify(code);
  };

  const resend = async () => {
    if (s.step !== "otp" || s.resending) return;
    dispatch({ type: "resend" });
    try {
      const v = await api.channels.resendSms(s.verification.id);
      setNow(Date.now());
      dispatch({ type: "resendOk", verification: v });
      toast.success("Code resent");
    } catch (e) {
      dispatch({ type: "resendFail" });
      const err = smsSendError(e);
      toast.error(err.toast ?? err.field ?? "Couldn’t resend the code");
    }
  };

  const help = s.step === "phone" ? (s.error ? { text: s.error, tone: "err" as const } : phoneHelp(country, s.digits)) : null;

  return (
    <ChannelDialog channel="sms" title="SMS" label="Verify phone for SMS" onClose={onClose}>
      {s.step === "phone" && (
        <>
          <div className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-fg-2">Phone number</span>
            <div className="grid grid-cols-[104px_minmax(0,1fr)] gap-2">
              <select
                aria-label="Country code"
                value={s.country}
                onChange={(e) => dispatch({ type: "country", country: e.currentTarget.value })}
                className={cn(INPUT, "cursor-pointer")}
              >
                {countries.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.label}
                  </option>
                ))}
              </select>
              <input
                type="tel"
                inputMode="numeric"
                autoComplete="tel-national"
                aria-label="Phone number"
                aria-invalid={s.error ? true : undefined}
                aria-describedby={helpId}
                placeholder={placeholderFor(country.pattern)}
                value={formatNational(s.digits, country.pattern)}
                onChange={(e) => dispatch({ type: "digits", digits: nationalDigits(country, e.currentTarget.value) })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void send();
                  }
                }}
                autoFocus
                className={cn(INPUT, s.error && "border-danger")}
              />
            </div>
            <span
              id={helpId}
              role={help?.tone === "err" ? "alert" : undefined}
              className={cn("min-h-4 text-[12px] leading-4 text-fg-3", help?.tone === "err" && "text-danger", help?.tone === "ok" && "text-ok")}
            >
              {help?.text}
            </span>
          </div>
          <Button variant="primary" loading={s.sending} onClick={() => void send()} className="max-[760px]:h-11">
            Send code
          </Button>
        </>
      )}

      {s.step === "otp" && (
        <>
          <div className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-fg-2">
            Code sent to <b className="font-mono font-medium text-fg">{s.verification.display}</b>
            <button type="button" onClick={() => dispatch({ type: "edit" })} className="rounded text-[12px] font-medium text-accent-t hover:underline">
              Edit
            </button>
          </div>
          <OtpInput code={s.code} onChange={onCode} readOnly={otpLocked(s)} busy={s.verifying} error={Boolean(s.error)} shake={s.shake} />
          <div className="flex min-h-[30px] flex-wrap items-center gap-2">
            {s.verifying && (
              <span role="status" className="inline-flex items-center gap-2 text-[12px] text-fg-2">
                <Spin />
                Verifying…
              </span>
            )}
            {s.error && !s.verifying && (
              <span role="alert" className="inline-flex items-center gap-1.5 text-[12px] text-danger">
                <Glyph d="M8 2.5l6 10.5H2zM8 6.5v3M8 11.3v.1" size={12} stroke={1.6} />
                {s.error.text}
              </span>
            )}
            <span className="flex-1" />
            {resendIn(s.verification.resendAt, now) > 0 ? (
              <span className="font-mono text-[12px] text-fg-3">Resend in {formatClock(resendIn(s.verification.resendAt, now))}</span>
            ) : (
              !s.verifying && (
                <button type="button" onClick={() => void resend()} disabled={s.resending} className="rounded text-[12px] font-medium text-accent-t hover:underline disabled:opacity-60">
                  Resend code
                </button>
              )
            )}
          </div>
        </>
      )}

      {s.step === "verified" && (
        <>
          <div role="status" className="flex flex-col items-center gap-3 pb-0.5 pt-2.5 text-center">
            <SparkCheck />
            <span className="font-semibold">
              <span className="font-mono">{s.connection.display}</span> verified
            </span>
          </div>
          <div className="flex gap-2 [&>*]:flex-1">
            <Button onClick={onSendTest}>Send test</Button>
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </>
      )}
    </ChannelDialog>
  );
}
