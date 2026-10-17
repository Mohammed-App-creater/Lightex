"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api/endpoints";
import { isApiError } from "@/lib/api/errors";
import {
  authStyles,
  AuthBanner,
  AuthCard,
  AuthField,
  AuthFooter,
  AuthLink,
  DoneTile,
  PasswordInput,
  PasswordStrength,
  SubmitButton,
} from "./auth-ui";
import { applyServerErrors, useAuthForm } from "./use-auth-form";
import { resetSchema, type ResetValues } from "./validation";

/** Reset password (board 21 §2.5), reached from the emailed link `/reset-password?token=…`. */
export function ResetForm() {
  const titleId = useId();
  const rulesId = useId();
  const token = useSearchParams().get("token") ?? "";
  const [busy, setBusy] = useState(false);
  const [alert, setAlert] = useState<{ title: string; body: string; badLink?: boolean } | null>(null);
  const [done, setDone] = useState(false);
  const { form, field } = useAuthForm<ResetValues>(
    resetSchema,
    { password: "", confirm: "" },
    { deps: { password: ["confirm"] } },
  );
  const { errors } = form.formState;
  const password = form.watch("password");

  const onSubmit = form.handleSubmit(async (v) => {
    setBusy(true);
    setAlert(null);
    try {
      await api.auth.resetPassword(token, v.password);
      setDone(true);
    } catch (err) {
      if (isApiError(err) && (err.code === "invalid_token" || err.status === 400 || err.status === 404 || err.status === 410)) {
        setAlert({ title: "This reset link has expired", body: "Request a new one to continue.", badLink: true });
      } else {
        const msg = applyServerErrors(err, form, { password: "password" });
        if (msg) setAlert({ title: "Couldn’t update your password", body: msg });
      }
    } finally {
      setBusy(false);
    }
  });

  if (!token) {
    return (
      <>
        <AuthCard title="This reset link isn’t valid" subtitle="Open the link from your email again, or request a new one." titleId={titleId}>
          <Button asChild variant="primary" size="lg" className="w-full rounded-md text-[14px] max-[760px]:h-[46px]">
            <Link href="/forgot-password">Request a new link</Link>
          </Button>
        </AuthCard>
        <AuthFooter>
          <AuthLink href="/login">Back to sign in</AuthLink>
        </AuthFooter>
      </>
    );
  }

  if (done) {
    return (
      <AuthCard>
        <div role="status" className={`${authStyles.inSlow} flex flex-col items-center gap-4 text-center`}>
          <DoneTile tone="ok">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12.5l4.5 4.5L19 7.5" />
            </svg>
          </DoneTile>
          <div className="flex flex-col gap-1">
            <h1 className="m-0 text-[20px] font-semibold leading-7 tracking-[-0.015em]">Password updated</h1>
            <p className="m-0 text-ui text-fg-2">Other sessions were signed out.</p>
          </div>
          <Button asChild variant="primary" size="lg" className="w-full rounded-md text-[14px] max-[760px]:h-[46px]">
            <Link href="/login">Sign in</Link>
          </Button>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Set a new password" titleId={titleId}>
      <form noValidate aria-labelledby={titleId} onSubmit={onSubmit} className="flex flex-col gap-4">
        {alert && (
          <AuthBanner title={alert.title}>
            {alert.body}
            {alert.badLink && (
              <>
                {" "}
                <AuthLink href="/forgot-password" small>
                  Request a new link
                </AuthLink>
              </>
            )}
          </AuthBanner>
        )}
        <AuthField
          label="New password"
          error={errors.password?.message}
          extraDescribedBy={[rulesId]}
          after={<PasswordStrength value={password} id={rulesId} />}
        >
          {(a) => <PasswordInput {...a} {...field("password")} autoComplete="new-password" autoFocus />}
        </AuthField>
        <AuthField label="Confirm password" error={errors.confirm?.message}>
          {(a) => <PasswordInput {...a} {...field("confirm")} autoComplete="new-password" />}
        </AuthField>
        <SubmitButton busy={busy} busyLabel="Updating…">
          Update password
        </SubmitButton>
      </form>
    </AuthCard>
  );
}
