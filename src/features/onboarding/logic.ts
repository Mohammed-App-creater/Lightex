/* Onboarding rules (board 23 §3.2–3.5). Pure functions, unit-tested. */

/** Slugs the design treats as taken; the server has the full list and also checks uniqueness. */
export const RESERVED_SLUGS = ["admin", "lightex", "api", "app"];

/** Lowercase, runs of non-[a-z0-9] → "-", trim dashes, max 32. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
}

export function workspaceNameError(name: string): string | null {
  const slug = slugify(name);
  if (name.trim().length < 2 || slug.length < 2) return "Use at least 2 characters";
  if (RESERVED_SLUGS.includes(slug)) return `lightex.app/${slug} is taken`;
  return null;
}

/** One word → first 3 letters; several → initials of the first 4 words. "Platform Rebuild" → "PR". */
export function deriveKey(name: string): string {
  const words = name
    .split(/\s+/)
    .map((w) => w.replace(/[^A-Za-z]/g, ""))
    .filter(Boolean);
  if (!words.length) return "";
  if (words.length === 1) return words[0]!.slice(0, 3).toUpperCase();
  return words
    .slice(0, 4)
    .map((w) => w[0]!)
    .join("")
    .toUpperCase();
}

/** Key input is sanitised to uppercase A–Z, max 5. */
export function sanitizeKey(v: string): string {
  return v
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 5);
}

export function projectNameError(name: string): string | null {
  return name.trim().length < 2 ? "Name the project (2+ characters)" : null;
}

export function keyError(key: string): string | null {
  return /^[A-Z]{2,5}$/.test(key) ? null : "Key: 2–5 letters";
}

/* ── Invite chips ── */

export const CHIP_EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
export const MAX_CHIPS = 20;
export const MAX_CHIP_LEN = 80;

export const isEmail = (s: string) => CHIP_EMAIL_RE.test(s);

/**
 * Splits typed/pasted text on comma, whitespace or semicolon. Every complete token is committed;
 * the text after the last separator stays as the draft (unless `commitAll`).
 */
export function splitDraft(text: string, commitAll = false): { tokens: string[]; draft: string } {
  const parts = text.split(/[\s,;]+/);
  const draft = commitAll ? "" : (parts.pop() ?? "");
  return { tokens: parts.map((p) => p.trim()).filter(Boolean), draft };
}

/** Appends tokens, ignoring duplicates (case-insensitive), capped at 20 chips × 80 chars. */
export function addChips(chips: string[], tokens: string[]): string[] {
  const out = [...chips];
  const seen = new Set(out.map((c) => c.toLowerCase()));
  for (const raw of tokens) {
    const t = raw.slice(0, MAX_CHIP_LEN);
    if (!t || seen.has(t.toLowerCase())) continue;
    if (out.length >= MAX_CHIPS) break;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out;
}

export function chipsError(chips: string[]): string | null {
  const bad = chips.filter((c) => !isEmail(c));
  if (!bad.length) return null;
  return bad.length === 1 ? `“${bad[0]}” isn’t an email` : `${bad.length} emails need fixing`;
}

export function inviteCta(n: number): string {
  if (n === 0) return "Continue";
  return `Send ${n} invite${n === 1 ? "" : "s"}`;
}

export function inviteSummary(n: number, role: string): string {
  return `${n} ${n === 1 ? "person" : "people"} · ${role.charAt(0).toUpperCase()}${role.slice(1)}`;
}

export const CHIP_HUES = [200, 20, 150, 60, 330, 285];
