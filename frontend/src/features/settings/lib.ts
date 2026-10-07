/* Pure helpers for the settings screens (board 20). */

/* ───────────────────────── Workspace ───────────────────────── */

export const WS_NAME_MAX = 48;
export const SLUG_MIN = 3;
export const SLUG_MAX = 32;
export const URL_HOST = "lightex.app/";

export function workspaceNameError(name: string): string | null {
  if (!name.trim()) return "Required";
  if (name.trim().length > WS_NAME_MAX) return `Max ${WS_NAME_MAX} characters`;
  return null;
}

/** Local slug rules, in the design's order. `null` means "valid locally" (server still checks). */
export function slugError(slug: string): string | null {
  if (!slug) return "Required";
  if (/[A-Z]/.test(slug) && /^[a-z0-9-]*$/.test(slug.toLowerCase())) return "Lowercase only";
  if (!/^[a-z0-9-]+$/.test(slug)) return "Use a–z, 0–9 and hyphens";
  if (slug.length < SLUG_MIN) return `At least ${SLUG_MIN} characters`;
  if (slug.length > SLUG_MAX) return `Max ${SLUG_MAX} characters`;
  if (slug.startsWith("-") || slug.endsWith("-")) return "Can’t start or end with a hyphen";
  if (slug.includes("--")) return "No double hyphens";
  return null;
}

/** Splits a slug into runs of legal / illegal characters for the live URL preview. */
export function slugSegments(slug: string): { text: string; bad: boolean }[] {
  const out: { text: string; bad: boolean }[] = [];
  for (const ch of slug) {
    const bad = !/[a-z0-9-]/.test(ch);
    const last = out[out.length - 1];
    if (last && last.bad === bad) last.text += ch;
    else out.push({ text: ch, bad });
  }
  return out;
}

/** Workspace icon: first letter of word 1 + first letter of word 2 (or 2nd letter of word 1). */
export function workspaceIcon(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const a = words[0]!;
  const b = words[1];
  return ((a[0] ?? "") + (b ? b[0] : (a[1] ?? ""))).toUpperCase();
}

export type ConfirmState = "empty" | "prefix" | "match" | "mismatch";

/** Live status of a "type X to confirm" input. */
export function confirmState(input: string, target: string): ConfirmState {
  if (!input) return "empty";
  if (input === target) return "match";
  if (target.startsWith(input)) return "prefix";
  return "mismatch";
}

/* ───────────────────────── Profile ───────────────────────── */

export const NAME_MAX = 40;

export function profileNameError(name: string): string | null {
  if (!name.trim()) return "Required";
  if (name.trim().length > NAME_MAX) return `Max ${NAME_MAX} characters`;
  return null;
}

/**
 * Password strength 0–4: 0 empty, 1 if shorter than 8; otherwise 1 +1 (≥12) +1 (mixed case)
 * +1 (digit and symbol) or +0.5 (digit or symbol), floored, max 4.
 */
export function passwordScore(pw: string): 0 | 1 | 2 | 3 | 4 {
  if (!pw) return 0;
  if (pw.length < 8) return 1;
  let s = 1;
  if (pw.length >= 12) s += 1;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s += 1;
  const digit = /\d/.test(pw);
  const symbol = /[^A-Za-z0-9]/.test(pw);
  if (digit && symbol) s += 1;
  else if (digit || symbol) s += 0.5;
  return Math.min(4, Math.floor(s)) as 0 | 1 | 2 | 3 | 4;
}

export const STRENGTH: Record<1 | 2 | 3 | 4, { label: string; color: string }> = {
  1: { label: "Weak", color: "var(--danger)" },
  2: { label: "Fair", color: "var(--orange)" },
  3: { label: "Good", color: "var(--warn)" },
  4: { label: "Strong", color: "var(--ok)" },
};

export function newPasswordError(next: string, current: string, submitted: boolean): string | null {
  if (!next) return submitted ? "Required" : null;
  if (next.length < 8) return "At least 8 characters";
  if (current && next === current) return "Must differ from current";
  return null;
}

export const AVATAR_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const AVATAR_MAX = 2 * 1024 * 1024;

export function avatarFileError(file: { type: string; size: number }): string | null {
  if (!AVATAR_TYPES.includes(file.type)) return "PNG, JPG or WebP only";
  if (file.size > AVATAR_MAX) return "Max 2 MB";
  return null;
}

/* ───────────────────────── Lists ───────────────────────── */

export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (from < 0 || from >= out.length || to < 0 || to >= out.length) return out;
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x!);
  return out;
}

export const PROJECT_KEY_RE = /^[A-Z]{2,5}$/;
