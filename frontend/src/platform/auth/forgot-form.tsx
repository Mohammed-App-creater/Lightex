"use client";

import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/errors";
import { authStyles, AuthBanner, AuthCard, AuthField, AuthFooter, AuthInput, AuthLink, DoneTile, SubmitButton } from "./auth-ui";
import { useAuthForm } from "./use-auth-form";
import { forgotSchema, type ForgotValues } from "./validation";

export const RESEND_COOLDOWN = 30;

export const formatCountdown = (sec: number) => `0:${String(Math.max(0, sec)).padStart(2, "0")}`;

/** Ticks a seconds countdown down to 0. */
function useCountdown() {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (left <= 0) return;
    const id = setTimeout(() => setLeft((l) => l - 1), 1000);
    return () => clearTimeout(id);
  }, [left]);
  return [left, setLeft] as const;
}

/** Forgot password (board 21 §2.5): email → "Check your inbox" with a 30s resend cooldown. */
export function ForgotForm() {
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const [alert, setAlert] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [resent, setResent] = useState(false);
  const [resending, setResending] = useState(false);
  const [left, setLeft] = useCountdown();
  const { form, field } = useAuthForm<ForgotValues>(forgotSchema, { email: "" });
  const { errors } = form.formState;

  const onSubmit = form.handleSubmit(async (v) => {
    setBusy(true);
    setAlert(null);
    try {
      await api.auth.forgotPassword(v.email.trim());
      setSentTo(v.email.trim());
      setLeft(RESEND_COOLDOWN);
    } catch (err) {
      setAlert(errorMessage(err));
    } finally {
      setBusy(false);
    }
  });

  const resend = async () => {
    if (!sentTo || left > 0 || resending) return;
    setResending(true);
    setAlert(null);
    try {
      await api.auth.forgotPassword(sentTo);
      setResent(true);
      setLeft(RESEND_COOLDOWN);
    } catch (err) {
      setAlert(errorMessage(err));
    } finally {
      setResending(false);
    }
  };

  return (
    <>
      <AuthCard
        title={sentTo ? undefined : "Reset your password"}
        subtitle="We’ll email you a link."
        titleId={titleId}
      >
        {sentTo ? (
          <div role="status" className={`${authStyles.inSlow} flex flex-col items-center gap-4 text-center`}>
            <DoneTile>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
                <rect x="3" y="5" width="18" height="14" rx="2.5" />
                <path d="M3.5 6.5l8.5 6.5 8.5-6.5" strokeLinecap="round" />
              </svg>
            </DoneTile>
            <div className="flex flex-col gap-1">
              <h1 className="m-0 text-[20px] font-semibold leading-7 tracking-[-0.015em]">Check your inbox</h1>
              <p className="m-0 text-ui text-fg-2">
                Link sent to <span className="break-all font-mono text-[12.5px] text-fg">{sentTo}</span>
              </p>
            </div>
            {alert && <AuthBanner title="Couldn’t resend">{alert}</AuthBanner>}
            <Button
              variant="secondary"
              size="lg"
              loading={resending}
              disabledReason={left > 0 ? "You can resend once the timer runs out" : undefined}
              onClick={() => void resend()}
              className="w-full rounded-md border-line-2 text-[14px] max-[760px]:h-[46px]"
            >
              {left > 0 ? (
                <>
                  Resend in <span className="font-mono text-[12.5px]">{formatCountdown(left)}</span>
                </>
              ) : (
                "Resend email"
              )}
            </Button>
            {resent && left > 0 && <span className="text-meta text-fg-3">Sent again</span>}
          </div>
        ) : (
          <form noValidate aria-labelledby={titleId} onSubmit={onSubmit} className="flex flex-col gap-4">
            {alert && <AuthBanner title="Couldn’t send the link">{alert}</AuthBanner>}
            <AuthField label="Email" error={errors.email?.message}>
              {(a) => (
                <AuthInput {...a} {...field("email")} type="email" autoComplete="email" placeholder="you@team.dev" autoFocus />
              )}
            </AuthField>
            <SubmitButton busy={busy} busyLabel="Sending…">
              Send reset link
            </SubmitButton>
          </form>
        )}
      </AuthCard>
      <AuthFooter>
        <AuthLink href="/login">Back to sign in</AuthLink>
      </AuthFooter>
    </>
  );
}
