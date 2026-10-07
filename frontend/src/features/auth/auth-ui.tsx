"use client";

import Link from "next/link";
import {
  forwardRef,
  useId,
  useState,
  type ComponentProps,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { Wordmark } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils/cn";
import { AuthStyles, authStylesClasses as s } from "./auth-styles";
import { PASSWORD_RULES, scorePassword, STRENGTH } from "./validation";

/* Board 21 primitives: backdrop, card, field, password input, meter, banner, buttons. */

const BOLT = "M50 -5L27 17H38L-4 44";

export function AuthBackdrop() {
  return (
    <div aria-hidden className={s.backdrop}>
      <div className={s.glow} />
      <div className={s.grid} />
      {[s.b1, s.b2, s.b3].map((c, i) => (
        <svg key={i} viewBox="0 0 46 39" className={cn(s.bolt, c)} overflow="visible">
          <path d={BOLT} />
        </svg>
      ))}
    </div>
  );
}

/** Full-viewport auth frame: backdrop, then wordmark, card and footer in a centred column. */
export function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <div className="relative isolate min-h-dvh overflow-hidden bg-bg">
      <AuthStyles />
      <AuthBackdrop />
      <main className="relative z-[1] flex min-h-dvh flex-col items-center justify-start px-6 py-10 max-[760px]:px-0 max-[760px]:pb-8 max-[760px]:pt-14 min-[761px]:justify-[safe_center]">
        <Link href="/login" aria-label="Lightex" className="rounded-xs">
          <Wordmark size={24} />
        </Link>
        {children}
      </main>
    </div>
  );
}

export function AuthCard({
  title,
  subtitle,
  titleId,
  children,
  className,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  titleId?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-labelledby={title ? titleId : undefined}
      className={cn(
        "mt-7 flex w-[400px] max-w-full flex-col gap-5 rounded-[14px] border border-line bg-surface p-8",
        "max-[760px]:mt-6 max-[760px]:w-full max-[760px]:gap-4 max-[760px]:rounded-none max-[760px]:border-0 max-[760px]:bg-transparent max-[760px]:px-5 max-[760px]:py-0",
        className,
      )}
    >
      {title && (
        <header>
          <h1 id={titleId} className="m-0 text-[20px] font-semibold leading-7 tracking-[-0.015em] text-fg">
            {title}
          </h1>
          {subtitle && <p className="m-0 mt-1 text-ui text-fg-2">{subtitle}</p>}
        </header>
      )}
      {children}
    </section>
  );
}

export function AuthFooter({ children }: { children: ReactNode }) {
  return <p className="m-0 mt-5 text-ui text-fg-3 max-[760px]:mt-6">{children}</p>;
}

export function AuthLink({ className, small, ...props }: ComponentProps<typeof Link> & { small?: boolean }) {
  return (
    <Link
      className={cn(
        "rounded-xs font-medium text-accent-t no-underline underline-offset-[3px] hover:underline",
        small && "text-meta",
        className,
      )}
      {...props}
    />
  );
}

function AlertIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden className="flex-none">
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 4.75v3.75" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="8" cy="11" r=".9" fill="currentColor" />
    </svg>
  );
}

export function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <span id={id} role="alert" className={cn(s.in, "flex items-start gap-1.5 text-meta text-danger")}>
      <span className="mt-0.5">
        <AlertIcon />
      </span>
      {children}
    </span>
  );
}

/** Error banner (`.au-banner`): bold line + secondary line. */
export function AuthBanner({ id, title, children }: { id?: string; title: ReactNode; children?: ReactNode }) {
  return (
    <div
      id={id}
      role="alert"
      className={cn(
        s.inSlow,
        "flex gap-2.5 rounded-md border border-danger bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] px-3 py-2.5 text-ui leading-[18px] text-fg",
      )}
    >
      <span className="mt-px text-danger">
        <AlertIcon size={16} />
      </span>
      <span>
        <b className="block font-semibold">{title}</b>
        {children && <span className="text-meta text-fg-2">{children}</span>}
      </span>
    </div>
  );
}

const inputCls =
  "h-10 w-full rounded-md border border-line-2 bg-bg px-3 text-[14px] text-fg placeholder:text-fg-3 " +
  "transition-[border-color,box-shadow] duration-[var(--dur-fast)] ease-out hover:border-control " +
  "focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-s)] focus:outline-none focus-visible:shadow-[0_0_0_3px_var(--accent-s)] " +
  "aria-[invalid=true]:border-danger aria-[invalid=true]:focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--danger)_10%,transparent)] " +
  "read-only:cursor-default read-only:border-dashed read-only:bg-raised read-only:text-fg-2 read-only:hover:border-line-2 read-only:focus:border-line-2 " +
  "max-[760px]:h-11 max-[760px]:text-[16px]";

export type AuthInputProps = InputHTMLAttributes<HTMLInputElement> & { trailing?: ReactNode; mono?: boolean };

export const AuthInput = forwardRef<HTMLInputElement, AuthInputProps>(function AuthInput(
  { trailing, mono, className, ...props },
  ref,
) {
  const input = <input ref={ref} className={cn(inputCls, trailing && "pr-11", mono && "font-mono", className)} {...props} />;
  if (!trailing) return input;
  return (
    <span className="relative block">
      {input}
      <span className="absolute inset-y-0 right-1 flex items-center">{trailing}</span>
    </span>
  );
});

/**
 * Label row + control + error/hint. The control receives id, aria-invalid and an
 * aria-describedby that joins the banner, error, rules and hint ids.
 */
export function AuthField({
  label,
  labelAction,
  error,
  hint,
  extraDescribedBy,
  forceInvalid,
  children,
  after,
}: {
  label: ReactNode;
  labelAction?: ReactNode;
  error?: string | null;
  hint?: ReactNode;
  extraDescribedBy?: (string | false | null | undefined)[];
  /** Mark invalid without a field error (e.g. while the credentials banner shows). */
  forceInvalid?: boolean;
  children: (control: { id: string; "aria-invalid"?: true; "aria-describedby"?: string }) => ReactNode;
  /** Rendered under the error (e.g. strength meter + rules). */
  after?: ReactNode;
}) {
  const id = useId();
  const errId = `${id}-err`;
  const hintId = `${id}-hint`;
  const describedBy = [...(extraDescribedBy ?? []), error && errId, hint && hintId].filter(Boolean).join(" ");
  const invalid = Boolean(error) || Boolean(forceInvalid);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-[12.5px] font-medium text-fg-2">
          {label}
        </label>
        {labelAction}
      </div>
      {children({ id, "aria-invalid": invalid ? true : undefined, "aria-describedby": describedBy || undefined })}
      {error && <FieldError id={errId}>{error}</FieldError>}
      {after}
      {hint && (
        <span id={hintId} className="text-meta text-fg-3">
          {hint}
        </span>
      )}
    </div>
  );
}

export const PasswordInput = forwardRef<HTMLInputElement, AuthInputProps>(function PasswordInput(props, ref) {
  const [shown, setShown] = useState(false);
  return (
    <AuthInput
      ref={ref}
      {...props}
      type={shown ? "text" : "password"}
      trailing={
        <button
          type="button"
          aria-label="Show password"
          aria-pressed={shown}
          onClick={() => setShown((v) => !v)}
          className="flex h-8 w-[34px] items-center justify-center rounded-sm text-fg-3 transition-colors duration-[var(--dur-fast)] hover:bg-hover hover:text-fg max-[760px]:h-10 max-[760px]:w-10"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            {shown ? (
              <path d="M2 2l12 12M6.6 4.7A6 6 0 0 1 8 3.5c4 0 6.5 4.5 6.5 4.5a11 11 0 0 1-1.9 2.4M4.2 5.5A11 11 0 0 0 1.5 8S4 12.5 8 12.5a6 6 0 0 0 2.4-.5" />
            ) : (
              <>
                <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
                <circle cx="8" cy="8" r="2" />
              </>
            )}
          </svg>
        </button>
      }
    />
  );
});

export function LockIcon() {
  return (
    <span aria-hidden className="flex h-8 w-[34px] items-center justify-center text-fg-3">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
        <rect x="3" y="7" width="10" height="7" rx="1.5" />
        <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
      </svg>
    </span>
  );
}

/** Strength meter + 4 rules (board 21 §2.7). `id` is the rules list id for aria-describedby. */
export function PasswordStrength({ value, id }: { value: string; id: string }) {
  const score = scorePassword(value);
  const meta = STRENGTH[score];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2.5">
        <div
          role="meter"
          aria-label="Password strength"
          aria-valuemin={0}
          aria-valuemax={4}
          aria-valuenow={score}
          aria-valuetext={meta.label || "None"}
          className="grid flex-1 grid-cols-4 gap-1"
        >
          {[1, 2, 3, 4].map((i) => (
            <span
              key={i}
              className="h-1 rounded-[2px] transition-[background-color] duration-200"
              style={{ background: i <= score ? meta.color : "var(--line-2)" }}
            />
          ))}
        </div>
        <span aria-live="polite" className="min-w-11 text-right font-mono text-[11px] font-medium" style={{ color: meta.color }}>
          {meta.label}
        </span>
      </div>
      <ul id={id} aria-label="Password rules" className="m-0 grid list-none grid-cols-2 gap-x-3 gap-y-1 p-0">
        {PASSWORD_RULES.map((r) => {
          const met = r.test(value);
          return (
            <li key={r.id} className={cn("flex items-center gap-1.5 text-meta leading-[18px]", met ? "text-fg-2" : "text-fg-3")}>
              {met ? (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden className="flex-none text-ok">
                  <path d="M2.5 6.2l2.3 2.3 4.7-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                <span aria-hidden className="flex size-3 flex-none items-center justify-center">
                  <span className="size-[3.2px] rounded-full bg-fg-3" />
                </span>
              )}
              {r.label}
              <span className="sr-only">{met ? ", met" : ", not met"}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Full-width primary submit with spinner + busy label. */
export function SubmitButton({ busy, busyLabel, children }: { busy: boolean; busyLabel: string; children: ReactNode }) {
  return (
    <Button
      type="submit"
      variant="primary"
      size="lg"
      aria-busy={busy || undefined}
      className={cn("w-full rounded-md text-[14px] max-[760px]:h-[46px] max-[760px]:text-[15px]", busy && "cursor-progress")}
      onClick={busy ? (e) => e.preventDefault() : undefined}
    >
      {busy && <Spinner className="size-[15px] text-white" />}
      {busy ? busyLabel : children}
    </Button>
  );
}

/** Google SSO: not in the API contract yet, so it's visible but marked "Coming soon". */
export function GoogleButton() {
  return (
    <>
      <Button
        variant="secondary"
        size="lg"
        disabledReason="Coming soon"
        className="w-full rounded-md border-line-2 text-[14px] max-[760px]:h-[46px]"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
          <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.6" opacity=".35" />
          <path d="M13.6 7.1H8.2v2.2h3.1A3.5 3.5 0 1 1 10.4 5.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        Continue with Google
      </Button>
      <div aria-hidden className="flex items-center gap-3 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-fg-3">
        <span className="h-px flex-1 bg-line" />
        OR
        <span className="h-px flex-1 bg-line" />
      </div>
    </>
  );
}

/** Centred done state (forgot sent, reset success). */
export function DoneTile({ tone = "accent", children }: { tone?: "accent" | "ok"; children: ReactNode }) {
  const sparks: [number, number][] = [
    [0, -30],
    [26, -15],
    [26, 15],
    [0, 30],
    [-26, 15],
    [-26, -15],
  ];
  return (
    <span
      aria-hidden
      className={cn(
        "relative flex size-[52px] items-center justify-center rounded-[14px] border border-line-2 bg-raised",
        tone === "ok" ? cn("text-ok", s.pop) : "text-accent-t",
      )}
    >
      {children}
      {tone === "ok" &&
        sparks.map(([dx, dy], i) => (
          <span key={i} className={s.spark} style={{ ["--dx" as string]: `${dx}px`, ["--dy" as string]: `${dy}px` }} />
        ))}
    </span>
  );
}

export { s as authStyles };
