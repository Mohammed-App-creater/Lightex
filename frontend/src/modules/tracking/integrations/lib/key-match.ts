/*
 * Task-key matching (docs/v2/37-integrations-github-gitlab.md §6.1–§6.2), identical to the backend's
 * `integrations.matching`. Shared vectors: ./dev-vectors.json.
 *
 * - Case-insensitive; the prefix is upper-cased. 2–5 letters (project keys are ^[A-Z]{2,5}$), a number
 *   without a leading zero, up to 7 digits. Boundaries are letters and digits only.
 * - Distinct (PREFIX, number) pairs in first-seen order, at most 10 per object, then only the
 *   workspace's project keys are kept (UTF-8, SHA-256 and ISO-8601 drop out there).
 */

export const KEY_RE = /(?<![A-Za-z0-9])([A-Za-z]{2,5})-([1-9][0-9]{0,6})(?![A-Za-z0-9])/g;
export const MAX_KEYS = 10;

/** Every candidate key in one text, in order, upper-cased (duplicates kept). */
function scan(text: string): { key: string; prefix: string; index: number; length: number }[] {
  const out: { key: string; prefix: string; index: number; length: number }[] = [];
  for (const m of text.matchAll(new RegExp(KEY_RE.source, "g"))) {
    const prefix = m[1]!.toUpperCase();
    out.push({ key: `${prefix}-${m[2]}`, prefix, index: m.index!, length: m[0].length });
  }
  return out;
}

/**
 * Keys referenced by an object's texts (PR: title then head branch; branch: its name; commit: the
 * message), §6.2 steps 1–2: distinct, first-seen order, capped at 10, then filtered to `prefixes`.
 */
export function findKeys(texts: string | readonly string[], prefixes: Iterable<string>): string[] {
  const allowed = new Set([...prefixes].map((p) => p.toUpperCase()));
  const seen: { key: string; prefix: string }[] = [];
  for (const text of typeof texts === "string" ? [texts] : texts) {
    for (const k of scan(text ?? "")) {
      if (seen.length >= MAX_KEYS) break;
      if (!seen.some((s) => s.key === k.key)) seen.push(k);
    }
  }
  return seen.filter((s) => allowed.has(s.prefix)).map((s) => s.key);
}

export type HighlightPart = { text: string; key: boolean };

/**
 * Splits text into plain and key parts for `<mark>` rendering (React parts, never innerHTML).
 * Only keys whose prefix is one of `prefixes` (the workspace's current project keys) are marked.
 */
export function highlightKeys(text: string, prefixes: Iterable<string>): HighlightPart[] {
  const allowed = new Set([...prefixes].map((p) => p.toUpperCase()));
  const parts: HighlightPart[] = [];
  let last = 0;
  for (const k of scan(text)) {
    if (!allowed.has(k.prefix)) continue;
    if (k.index > last) parts.push({ text: text.slice(last, k.index), key: false });
    parts.push({ text: text.slice(k.index, k.index + k.length), key: true });
    last = k.index + k.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), key: false });
  return parts;
}
