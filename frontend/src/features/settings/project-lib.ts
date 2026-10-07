/* Pure helpers for project settings (board 28). */

import type { Label, ProjectMember, Role, Status, StatusCategory, StatusGlyph } from "@/lib/api/types";

/** Status / label colour palette (board 28 `COLORS`): tokens only, never hex. */
export const ITEM_COLORS: { name: string; token: string }[] = [
  { name: "Gray", token: "var(--text-3)" },
  { name: "Slate", token: "var(--todo)" },
  { name: "Blue", token: "var(--accent-t)" },
  { name: "Violet", token: "var(--info)" },
  { name: "Teal", token: "var(--low)" },
  { name: "Green", token: "var(--ok)" },
  { name: "Amber", token: "var(--warn)" },
  { name: "Orange", token: "var(--orange)" },
  { name: "Red", token: "var(--danger)" },
  { name: "Cyan", token: "var(--spark)" },
];

export function colorName(token: string | null | undefined): string {
  return ITEM_COLORS.find((c) => c.token === token)?.name ?? "Default";
}

/** Project icon hues (board 28 `HUES`). */
export const PROJECT_HUES: { hue: number; name: string }[] = [
  { hue: 255, name: "Blue" },
  { hue: 215, name: "Sky" },
  { hue: 175, name: "Teal" },
  { hue: 140, name: "Green" },
  { hue: 75, name: "Amber" },
  { hue: 25, name: "Red" },
  { hue: 335, name: "Pink" },
  { hue: 300, name: "Violet" },
];

export function hueName(hue: number): string {
  return PROJECT_HUES.find((h) => h.hue === hue)?.name ?? "Custom";
}

/* ───────────────────────── General ───────────────────────── */

export const PROJECT_NAME_MAX = 40;
export const PROJECT_DESC_MAX = 200;

export function projectNameError(name: string): string | null {
  const n = name.trim();
  if (!n) return "Required";
  if (n.length < 2) return "At least 2 characters";
  if (n.length > PROJECT_NAME_MAX) return `Max ${PROJECT_NAME_MAX} characters`;
  return null;
}

/** Keys are 2–5 letters (API contract; the board also allows digits, the backend does not). */
export function projectKeyError(key: string): string | null {
  if (!key) return "Required";
  if (!/^[A-Z]{2,5}$/.test(key)) return "2–5 letters";
  return null;
}

export function sanitizeKey(raw: string) {
  return raw.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 5);
}

/* ───────────────────────── Workflow ───────────────────────── */

export const STATUS_GROUPS: { category: StatusCategory; label: string; glyph: StatusGlyph }[] = [
  { category: "todo", label: "To do", glyph: "todo" },
  { category: "in_progress", label: "In progress", glyph: "progress" },
  { category: "done", label: "Done", glyph: "done" },
];

export const STATUS_NAME_MAX = 28;
export const LABEL_NAME_MAX = 24;

/** Statuses in board order, grouped by category (todo → in progress → done). */
export function groupStatuses(list: readonly Status[]): Record<StatusCategory, Status[]> {
  const sorted = [...list].sort((a, b) => a.position - b.position);
  return {
    todo: sorted.filter((s) => s.category === "todo"),
    in_progress: sorted.filter((s) => s.category === "in_progress"),
    done: sorted.filter((s) => s.category === "done"),
  };
}

/** Flattens the groups back into one ordered list with fresh positions. */
export function flattenGroups(groups: Record<StatusCategory, Status[]>): Status[] {
  return STATUS_GROUPS.flatMap((g) => groups[g.category]).map((s, i) => ({ ...s, position: i }));
}

/**
 * Moves status `id` to index `to` inside its own category. Returns the new full ordering and the
 * global index to PATCH as `position` (the API orders all statuses in one list).
 */
export function reorderInCategory(list: readonly Status[], id: string, to: number): { list: Status[]; position: number } | null {
  const groups = groupStatuses(list);
  const s = list.find((x) => x.id === id);
  if (!s) return null;
  const g = [...groups[s.category]];
  const from = g.findIndex((x) => x.id === id);
  const target = Math.max(0, Math.min(g.length - 1, to));
  if (from === target) return null;
  g.splice(from, 1);
  g.splice(target, 0, s);
  const next = flattenGroups({ ...groups, [s.category]: g });
  return { list: next, position: next.findIndex((x) => x.id === id) };
}

/** Case-insensitive duplicate check for status / label names. */
export function nameTaken(name: string, items: readonly { id: string; name: string }[], selfId?: string): boolean {
  const n = name.trim().toLowerCase();
  return Boolean(n) && items.some((x) => x.id !== selfId && x.name.trim().toLowerCase() === n);
}

/** Default "move tasks to" target when deleting a status: same group first, then any other. */
export function defaultMoveTarget(list: readonly Status[], removing: Status): Status | undefined {
  const ordered = [...list].sort((a, b) => a.position - b.position).filter((s) => s.id !== removing.id);
  return ordered.find((s) => s.category === removing.category) ?? ordered[0];
}

/* ───────────────────────── Labels ───────────────────────── */

/** First palette colour no label uses yet (board 28 `nextCol`). */
export function nextFreeColor(labels: readonly Pick<Label, "color">[]): string {
  const used = new Set(labels.map((l) => l.color));
  return (ITEM_COLORS.find((c) => !used.has(c.token)) ?? ITEM_COLORS[2]!).token;
}

export function labelNameError(name: string, labels: readonly Label[], selfId?: string, submitted = false): string | null {
  if (!name.trim()) return submitted ? "Required" : null;
  if (nameTaken(name, labels, selfId)) return "Already exists";
  return null;
}

/* ───────────────────────── Members ───────────────────────── */

export function isAdminRole(role: Pick<Role, "permissions"> | undefined) {
  return Boolean(role?.permissions.includes("project.manage_members"));
}

/** True when `m` is the project's only member whose role can manage members (can't demote/remove). */
export function isOnlyAdmin(m: ProjectMember, members: readonly ProjectMember[], roles: readonly Role[]) {
  const admin = (x: ProjectMember) => isAdminRole(roles.find((r) => r.id === x.roleId));
  return admin(m) && members.filter(admin).length === 1;
}

export function tasksLabel(n: number) {
  return `${n} ${n === 1 ? "task" : "tasks"}`;
}
