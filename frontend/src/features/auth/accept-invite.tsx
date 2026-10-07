"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/feedback";
import { Tooltip } from "@/components/ui/tooltip";
import { api } from "@/lib/api/endpoints";
import { errorMessage, isApiError, isNotFound } from "@/lib/api/errors";
import type { Invite } from "@/lib/api/types";
import { routes } from "@/lib/routes";
import { useAuthFlow } from "./auth-flow";
import {
  AuthBanner,
  AuthCard,
  AuthField,
  AuthFooter,
  AuthInput,
  AuthLink,
  DoneTile,
  LockIcon,
  PasswordInput,
  PasswordStrength,
  SubmitButton,
} from "./auth-ui";
import { applyServerErrors, useAuthForm } from "./use-auth-form";
import { acceptSchema, initialsOf, type AcceptValues } from "./validation";

/** The contract's Invite has no role description yet; these mirror the default roles. */
const ROLE_HINT: Record<string, string> = {
  Member: "Create and edit tasks",
  Admin: "Manage members, roles and settings",
  Owner: "Full control of the workspace",
};

/** Accept invitation (board 21 §2.5): workspace + inviter header, locked email, name, password. */
export function AcceptInvite({ token }: { token: string }) {
  const q = useQuery({
    queryKey: ["invite", token],
    queryFn: () => api.auth.invite(token),
    retry: (n, err) => !isApiError(err) || (err.status >= 500 && n < 2),
  });

  if (q.isPending) {
    return (
      <AuthCard>
        <div role="status" aria-label="Loading invitation" className="flex flex-col items-center gap-3 border-b border-line pb-5">
          <Skeleton className="size-12 rounded-lg" />
          <Skeleton className="h-6 w-44" />
          <Skeleton className="h-4 w-36" />
        </div>
        <div className="flex flex-col gap-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex flex-col gap-1.5">
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-10 w-full rounded-md" />
            </div>
          ))}
        </div>
      </AuthCard>
    );
  }

  if (q.isError) {
    if (isNotFound(q.error)) return <InviteProblem kind="invalid" />;
    return (
      <AuthCard title="Couldn’t load this invitation" subtitle={errorMessage(q.error)}>
        <Button variant="primary" size="lg" className="w-full rounded-md text-[14px]" onClick={() => void q.refetch()}>
          Retry
        </Button>
      </AuthCard>
    );
  }

  if (q.data.status !== "pending") return <InviteProblem kind={q.data.status} invite={q.data} />;
  return <AcceptForm token={token} invite={q.data} onGone={() => void q.refetch()} />;
}

function InviteProblem({ kind, invite }: { kind: "invalid" | "expired" | "revoked" | "accepted"; invite?: Invite }) {
  const copy = {
    invalid: { title: "This invite link isn’t valid", body: "Check the link in your email, or ask a workspace admin for a new invite." },
    expired: {
      title: "This invite has expired",
      body: `Ask ${invite?.invitedBy.name ?? "a workspace admin"} to send you a new invite to ${invite?.workspaceName ?? "the workspace"}.`,
    },
    revoked: {
      title: "This invite was withdrawn",
      body: `It no longer gives access to ${invite?.workspaceName ?? "the workspace"}. Ask a workspace admin if you still need access.`,
    },
    accepted: { title: "You’ve already joined", body: `This invite to ${invite?.workspaceName ?? "the workspace"} was already accepted. Sign in to continue.` },
  }[kind];
  return (
    <>
      <AuthCard>
        <div className="flex flex-col items-center gap-4 text-center">
          <DoneTile>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="5" width="18" height="14" rx="2.5" />
              <path d="M3.5 6.5l8.5 6.5 8.5-6.5" />
              {kind !== "accepted" && <path d="M16 2l6 6M22 2l-6 6" stroke="var(--danger)" />}
            </svg>
          </DoneTile>
          <div className="flex flex-col gap-1">
            <h1 className="m-0 text-[20px] font-semibold leading-7 tracking-[-0.015em]">{copy.title}</h1>
            <p className="m-0 text-ui text-fg-2">{copy.body}</p>
          </div>
          <Button asChild variant="primary" size="lg" className="w-full rounded-md text-[14px] max-[760px]:h-[46px]">
            <Link href="/login">Sign in</Link>
          </Button>
        </div>
      </AuthCard>
      <AuthFooter>
        New to Lightex? <AuthLink href="/register">Create account</AuthLink>
      </AuthFooter>
    </>
  );
}

function AcceptForm({ token, invite, onGone }: { token: string; invite: Invite; onGone: () => void }) {
  const titleId = useId();
  const rulesId = useId();
  const { finish } = useAuthFlow();
  const [busy, setBusy] = useState(false);
  const [alert, setAlert] = useState<string | null>(null);
  const { form, field } = useAuthForm<AcceptValues>(acceptSchema, { name: "", password: "" });
  const { errors } = form.formState;
  const password = form.watch("password");
  const roleHint = ROLE_HINT[invite.roleName];

  const onSubmit = form.handleSubmit(async (v) => {
    setBusy(true);
    setAlert(null);
    try {
      const res = await api.auth.acceptInvite(token, { name: v.name.trim(), password: v.password });
      finish(res, { to: routes.home(res.workspaceSlug), workspaceName: invite.workspaceName });
    } catch (err) {
      setBusy(false);
      if (isApiError(err) && (err.status === 410 || err.status === 404)) {
        onGone();
        return;
      }
      setAlert(applyServerErrors(err, form, { name: "name", password: "password" }));
    }
  });

  const role = (
    <span className="inline-flex h-6 items-center gap-1.5 rounded-full border border-line-2 bg-raised px-[9px] text-meta font-medium text-fg">
      <span aria-hidden className="size-1.5 rounded-full bg-accent-t" />
      Role: {invite.roleName}
      {roleHint && <span className="sr-only">. {roleHint}</span>}
    </span>
  );

  return (
    <>
      <AuthCard>
        <header className="flex flex-col items-center gap-3 border-b border-line pb-5 text-center">
          <span
            aria-hidden
            className="flex size-12 items-center justify-center rounded-lg border border-line-2 text-[16px] font-semibold tracking-[-0.02em] text-fg"
            style={{ background: "oklch(var(--av-l) var(--av-c) 255)" }}
          >
            {initialsOf(invite.workspaceName)}
          </span>
          <h1 id={titleId} className="m-0 text-[20px] font-semibold leading-7 tracking-[-0.015em]">
            Join {invite.workspaceName}
          </h1>
          <p className="m-0 flex items-center gap-2 text-ui text-fg-2">
            <Avatar name={invite.invitedBy.name} hue={invite.invitedBy.hue} size={20} ring={false} decorative />
            <span>
              <b className="font-medium text-fg">{invite.invitedBy.name}</b> invited you
            </span>
          </p>
          {roleHint ? (
            <Tooltip content={roleHint}>
              <span tabIndex={0} className="rounded-full">
                {role}
              </span>
            </Tooltip>
          ) : (
            role
          )}
        </header>
        <form noValidate aria-labelledby={titleId} onSubmit={onSubmit} className="flex flex-col gap-4">
          {alert && <AuthBanner title="Couldn’t join the workspace">{alert}</AuthBanner>}
          <AuthField label="Email" hint="From your invite">
            {(a) => <AuthInput {...a} value={invite.email} readOnly type="email" trailing={<LockIcon />} />}
          </AuthField>
          <AuthField label="Full name" error={errors.name?.message}>
            {(a) => <AuthInput {...a} {...field("name")} type="text" autoComplete="name" placeholder="First Last" autoFocus />}
          </AuthField>
          <AuthField
            label="Set a password"
            error={errors.password?.message}
            extraDescribedBy={[rulesId]}
            after={<PasswordStrength value={password} id={rulesId} />}
          >
            {(a) => <PasswordInput {...a} {...field("password")} autoComplete="new-password" />}
          </AuthField>
          <SubmitButton busy={busy} busyLabel="Joining…">
            Join workspace
          </SubmitButton>
        </form>
      </AuthCard>
      <AuthFooter>
        Not {invite.email}? <AuthLink href="/login">Sign in</AuthLink>
      </AuthFooter>
    </>
  );
}
