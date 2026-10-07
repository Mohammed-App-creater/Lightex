"use client";

import { useSearchParams } from "next/navigation";
import { useId, useState } from "react";
import { api } from "@/lib/api/endpoints";
import { errorMessage, isApiError } from "@/lib/api/errors";
import { apiMode } from "@/lib/env";
import { useAuthFlow } from "./auth-flow";
import {
  AuthBanner,
  AuthCard,
  AuthField,
  AuthFooter,
  AuthInput,
  AuthLink,
  GoogleButton,
  PasswordInput,
  SubmitButton,
} from "./auth-ui";
import { useAuthForm } from "./use-auth-form";
import { loginSchema, safeNext, type LoginValues } from "./validation";

type Banner = { kind: "credentials" } | { kind: "other"; message: string } | null;

/** Login (board 21 §2.5): Google (coming soon), email, password, banner on wrong credentials. */
export function LoginForm() {
  const titleId = useId();
  const bannerId = useId() + "-banner";
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const { finish } = useAuthFlow();
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);
  const { form, field } = useAuthForm<LoginValues>(
    loginSchema,
    { email: "", password: "" },
    { onAnyChange: () => setBanner(null) },
  );
  const { errors } = form.formState;
  const credsBad = banner?.kind === "credentials";

  const onSubmit = form.handleSubmit(async (v) => {
    setBusy(true);
    setBanner(null);
    try {
      const res = await api.auth.login(v.email.trim(), v.password);
      finish(res, { to: next });
    } catch (err) {
      setBusy(false);
      if (isApiError(err) && err.status === 401) setBanner({ kind: "credentials" });
      else setBanner({ kind: "other", message: errorMessage(err) });
    }
  });

  return (
    <>
      <AuthCard title="Welcome back" titleId={titleId}>
        <GoogleButton />
        <form noValidate aria-labelledby={titleId} onSubmit={onSubmit} className="flex flex-col gap-4">
          {banner &&
            (credsBad ? (
              <AuthBanner id={bannerId} title="Incorrect email or password">
                Try again or reset your password.
              </AuthBanner>
            ) : (
              <AuthBanner id={bannerId} title="Couldn’t sign in">
                {banner.message}
              </AuthBanner>
            ))}
          <AuthField
            label="Email"
            error={errors.email?.message}
            extraDescribedBy={[credsBad && bannerId]}
            forceInvalid={credsBad}
          >
            {(a) => (
              <AuthInput {...a} {...field("email")} type="email" autoComplete="email" placeholder="you@team.dev" autoFocus />
            )}
          </AuthField>
          <AuthField
            label="Password"
            labelAction={
              <AuthLink href="/forgot-password" small>
                Forgot password?
              </AuthLink>
            }
            error={errors.password?.message}
            extraDescribedBy={[credsBad && bannerId]}
            forceInvalid={credsBad}
          >
            {(a) => <PasswordInput {...a} {...field("password")} autoComplete="current-password" />}
          </AuthField>
          <SubmitButton busy={busy} busyLabel="Signing in…">
            Sign in
          </SubmitButton>
          {apiMode === "mock" && (
            <p className="m-0 text-center text-meta text-fg-3">
              Demo: seeded accounts (e.g. <span className="font-mono text-fg-2">alex@team.dev</span>) use the password{" "}
              <span className="font-mono text-fg-2">password</span>
            </p>
          )}
        </form>
      </AuthCard>
      <AuthFooter>
        New to Lightex?{" "}
        <AuthLink href="/register">Create account</AuthLink>
      </AuthFooter>
    </>
  );
}
