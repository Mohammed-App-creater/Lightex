/*
 * Branch names (docs/v2/37-integrations-github-gitlab.md §6.3, §9.4). The server computes the same
 * `suggestedBranch` and validates D4 with the same rules; shared vectors in ./dev-vectors.json.
 */

export const BRANCH_MAX = 80;
const STOP = new Set(["on", "the", "a", "an", "to", "for", "of", "in", "and", "with"]);

/** The design's slug(), made deterministic: NFKD, no combining marks, 4 words, hyphens collapsed. */
export function suggestBranch(key: string, title: string, prefix = ""): string {
  const words = (title ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))
    .slice(0, 4);
  const name = [key.toLowerCase(), ...words]
    .join("-")
    .replace(/-{2,}/g, "-")
    .replace(/-+$/, "");
  return (prefix + name).slice(0, BRANCH_MAX).replace(/[-/.]+$/, "");
}

export const BRANCH_ERRORS = {
  empty: "Enter a branch name.",
  length: "Up to 80 characters.",
  dots: "Branch names can’t contain '..'.",
  chars: "Use letters, numbers, - _ . / only.",
  edges: "Branch names can’t start with - / . or end with / . .lock.",
  slashes: "Branch names can’t contain '//'.",
} as const;

/** null when valid, else the field message (§6.3: 1–80, [A-Za-z0-9._/-], edges, no .., //, @{). */
export function validateBranch(name: string): string | null {
  if (!name) return BRANCH_ERRORS.empty;
  if (name.length > BRANCH_MAX) return BRANCH_ERRORS.length;
  if (name.includes("..")) return BRANCH_ERRORS.dots;
  if (!/^[A-Za-z0-9._/-]+$/.test(name) || name.includes("@{")) return BRANCH_ERRORS.chars;
  if (/^[-/.]/.test(name) || /[/.]$/.test(name) || name.endsWith(".lock")) return BRANCH_ERRORS.edges;
  if (name.includes("//")) return BRANCH_ERRORS.slashes;
  return null;
}
