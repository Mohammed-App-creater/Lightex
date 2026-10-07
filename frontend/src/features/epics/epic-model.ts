import type { GlyphKind } from "@/components/ui/glyphs";
import type { Epic, Status, Task } from "@/lib/api/types";

/* Pure helpers for the Epics view (board 27). React-free so they are unit-tested. */

/** The 8 epic colours (hue, name). Rendered through --ep-l/--ep-c so they hold up in every theme. */
export const EPIC_PALETTE: { hue: number; name: string }[] = [
  { hue: 255, name: "Blue" },
  { hue: 200, name: "Teal" },
  { hue: 150, name: "Green" },
  { hue: 110, name: "Lime" },
  { hue: 60, name: "Amber" },
  { hue: 25, name: "Coral" },
  { hue: 340, name: "Pink" },
  { hue: 295, name: "Violet" },
];

export const epicSwatch = (hue: number) => `oklch(var(--ep-l) var(--ep-c) ${hue})`;
export const epicTint = (hue: number) => `oklch(var(--ep-tl) var(--ep-tc) ${hue})`;

/** Closest palette hue (older epics were created with a random hue). */
export function nearestPaletteHue(hue: number) {
  const dist = (a: number) => Math.min(Math.abs(a - hue), 360 - Math.abs(a - hue));
  return EPIC_PALETTE.reduce((best, p) => (dist(p.hue) < dist(best) ? p.hue : best), EPIC_PALETTE[0]!.hue);
}

export type EpicCounts = Record<GlyphKind, number>;
const ZERO: EpicCounts = { backlog: 0, todo: 0, progress: 0, review: 0, done: 0, canceled: 0 };
export const COUNT_ORDER: GlyphKind[] = ["done", "review", "progress", "todo", "backlog"];
export const GROUP_ORDER: GlyphKind[] = ["progress", "review", "todo", "backlog", "done", "canceled"];

/**
 * Status counts and computed progress for one epic's tasks. Canceled tasks are excluded from the
 * total; percent = done / total (never stored). Segments show done · review · progress shares.
 */
export function epicStats(tasks: Pick<Task, "statusId">[], glyphOf: (statusId: string) => GlyphKind) {
  const c: EpicCounts = { ...ZERO };
  for (const t of tasks) c[glyphOf(t.statusId)] += 1;
  const total = tasks.length - c.canceled;
  const pct = total ? Math.round((c.done / total) * 100) : 0;
  const segments = total
    ? (["done", "review", "progress"] as GlyphKind[]).filter((k) => c[k]).map((k) => ({ kind: k, width: (c[k] / total) * 100 }))
    : [];
  const visible = COUNT_ORDER.filter((k) => c[k]);
  const aria = `${pct}% done: ${visible.map((k) => `${c[k]} ${LABEL[k]}`).join(", ") || "no tasks"}`;
  return { counts: c, total, pct, segments, visible, aria };
}

const LABEL: Record<GlyphKind, string> = {
  backlog: "backlog",
  todo: "todo",
  progress: "in progress",
  review: "in review",
  done: "done",
  canceled: "canceled",
};

export function glyphMap(statuses: Pick<Status, "id" | "glyph">[]) {
  const m = new Map(statuses.map((s) => [s.id, s.glyph]));
  return (id: string): GlyphKind => m.get(id) ?? "todo";
}

/** Title rules from the board: required, ≤60, unique (case-insensitive) within the project. */
export function validateEpicName(name: string, epics: Pick<Epic, "id" | "name">[], selfId: string | null) {
  const t = name.trim();
  if (!t) return "Title is required";
  if (t.length > 60) return "Keep titles under 60 characters";
  if (epics.some((e) => e.id !== selfId && e.name.trim().toLowerCase() === t.toLowerCase())) return "An epic with this name exists";
  return null;
}

/** Tasks the picker offers: no epic yet, not done or canceled, not a sub-task. */
export function pickable(tasks: Task[], glyphOf: (statusId: string) => GlyphKind) {
  return tasks.filter((t) => !t.epicId && !t.parentId && !t.deletedAt && glyphOf(t.statusId) !== "done" && glyphOf(t.statusId) !== "canceled");
}

export function splitEpics(epics: Epic[]) {
  return {
    active: epics.filter((e) => !e.archivedAt),
    archived: epics.filter((e) => e.archivedAt).sort((a, b) => (b.archivedAt ?? "").localeCompare(a.archivedAt ?? "")),
  };
}
