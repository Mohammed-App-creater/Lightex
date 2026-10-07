"use client";

import { useId, useState } from "react";
import { Checkbox } from "@/components/ui/choice";
import { api } from "@/lib/api/endpoints";
import { routes } from "@/lib/routes";
import { useAuthFlow } from "./auth-flow";
import {
  AuthBanner,
  AuthCard,
  AuthField,
  AuthFooter,
  AuthInput,
  AuthLink,
  FieldError,
  GoogleButton,
  PasswordInput,
  PasswordStrength,
  SubmitButton,
} from "./auth-ui";
import { applyServerErrors, useAuthForm } from "./use-auth-form";
import { registerSchema, type RegisterValues } from "./validation";

/** Register (board 21 §2.5): name, work email, password with meter + rules, terms. */
export function RegisterForm() {
  const titleId = useId();
  const rulesId = useId();
  const termsErrId = useId();
  const { finish } = useAuthFlow();
  const [busy, setBusy] = useState(false);
  const [alert, setAlert] = useState<string | null>(null);
  const { form, field } = useAuthForm<RegisterValues>(registerSchema, { name: "", email: "", password: "", terms: false });
  const { errors } = form.formState;
  const password = form.watch("password");

  const onSubmit = form.handleSubmit(async (v) => {
    setBusy(true);
    setAlert(null);
    try {
      const res = await api.auth.register({ name: v.name.trim(), email: v.email.trim(), password: v.password });
      finish(res, { to: routes.onboarding() });
    } catch (err) {
      setBusy(false);
      setAlert(applyServerErrors(err, form, { name: "name", email: "email", password: "password" }));
    }
  });

  return (
    <>
      <AuthCard title="Create your account" titleId={titleId}>
        <GoogleButton />
        <form noValidate aria-labelledby={titleId} onSubmit={onSubmit} className="flex flex-col gap-4">
          {alert && <AuthBanner title="Couldn’t create your account">{alert}</AuthBanner>}
          <AuthField label="Full name" error={errors.name?.message}>
            {(a) => <AuthInput {...a} {...field("name")} type="text" autoComplete="name" placeholder="First Last" autoFocus />}
          </AuthField>
          <AuthField label="Work email" error={errors.email?.message}>
            {(a) => <AuthInput {...a} {...field("email")} type="email" autoComplete="email" placeholder="you@team.dev" />}
          </AuthField>
          <AuthField
            label="Password"
            error={errors.password?.message}
            extraDescribedBy={[rulesId]}
            after={<PasswordStrength value={password} id={rulesId} />}
          >
            {(a) => <PasswordInput {...a} {...field("password")} autoComplete="new-password" />}
          </AuthField>
          <div className="flex flex-col gap-1.5">
            <label className="flex cursor-pointer items-center gap-2.5 text-ui text-fg-2">
              <Checkbox
                {...field("terms")}
                aria-invalid={errors.terms ? true : undefined}
                aria-describedby={errors.terms ? termsErrId : undefined}
                className={errors.terms ? "border-danger" : undefined}
              />
              <span>
                I agree to the <span className="font-medium text-fg">Terms</span>
              </span>
            </label>
            {errors.terms?.message && <FieldError id={termsErrId}>{errors.terms.message}</FieldError>}
          </div>
          <SubmitButton busy={busy} busyLabel="Creating account…">
            Create account
          </SubmitButton>
        </form>
      </AuthCard>
      <AuthFooter>
        Have an account? <AuthLink href="/login">Sign in</AuthLink>
      </AuthFooter>
    </>
  );
}
