import { z } from "zod";

/* Auth validation (board 21 §2.6–2.7). Copy is verbatim from the design. */

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const PASSWORD_RULES = [
  { id: "len", label: "8+ characters", test: (pw: string) => pw.length >= 8 },
  { id: "num", label: "A number", test: (pw: string) => /\d/.test(pw) },
  { id: "case", label: "Upper + lower", test: (pw: string) => /[a-z]/.test(pw) && /[A-Z]/.test(pw) },
  { id: "sym", label: "A symbol", test: (pw: string) => /[^A-Za-z0-9]/.test(pw) },
] as const;

export type StrengthScore = 0 | 1 | 2 | 3 | 4;

/** Rules met; capped at 1 below 8 characters; any input scores at least 1; empty is 0. */
export function scorePassword(pw: string): StrengthScore {
  if (!pw) return 0;
  let score = PASSWORD_RULES.filter((r) => r.test(pw)).length;
  if (pw.length < 8) score = Math.min(score, 1);
  return Math.max(1, score) as StrengthScore;
}

export const STRENGTH = {
  0: { label: "", color: "var(--line-2)" },
  1: { label: "Weak", color: "var(--danger)" },
  2: { label: "Fair", color: "var(--orange)" },
  3: { label: "Good", color: "var(--warn)" },
  4: { label: "Strong", color: "var(--ok)" },
} as const satisfies Record<StrengthScore, { label: string; color: string }>;

export const PASSING_SCORE = 3;

const email = z
  .string()
  .trim()
  .min(1, "Enter your email")
  .regex(EMAIL_RE, "Enter a valid email");

const name = z.string().trim().min(1, "Enter your name");

const newPassword = z
  .string()
  .min(1, "Create a password")
  .refine((pw) => scorePassword(pw) >= PASSING_SCORE, "Use a stronger password");

export const loginSchema = z.object({
  email,
  password: z.string().min(1, "Enter your password"),
});
export type LoginValues = z.infer<typeof loginSchema>;

export const registerSchema = z.object({
  name,
  email,
  password: newPassword,
  terms: z.boolean().refine((v) => v, "Accept the terms to continue"),
});
export type RegisterValues = z.infer<typeof registerSchema>;

export const forgotSchema = z.object({ email });
export type ForgotValues = z.infer<typeof forgotSchema>;

export const resetSchema = z
  .object({
    password: newPassword,
    confirm: z.string().min(1, "Confirm your password"),
  })
  .refine((v) => !v.confirm || v.confirm === v.password, {
    path: ["confirm"],
    message: "Passwords don’t match",
  });
export type ResetValues = z.infer<typeof resetSchema>;

export const acceptSchema = z.object({ name, password: newPassword });
export type AcceptValues = z.infer<typeof acceptSchema>;

/** Only same-origin paths are allowed as ?next targets (no open redirects). */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  return next;
}

/** "Platform team" → "PT"; "Lightex" → "LI". */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}
