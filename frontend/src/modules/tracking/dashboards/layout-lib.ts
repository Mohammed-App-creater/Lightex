import type { DashboardWidget, DashboardWidgetInput, WidgetType } from "@/lib/api/types";
import { COLS, DEFAULT_SIZE, MAX_H, MIN_H, MIN_W, STACK_HEIGHT, WIDGET_NAME, defaultConfig, pack, packedRows, type Rect } from "@/lib/domain/dashboards";

/*
 * Layout maths for the dashboard grid (spec §1.4). Pure; unit-tested with the shared vectors.
 * A layout is an ordered list of widgets with w × h; positions come from pack().
 */

export { COLS, DEFAULT_SIZE, MAX_H, MIN_H, MIN_W, STACK_HEIGHT, WIDGET_NAME, pack, packedRows, type Rect };

/** A draft widget: a saved one (`id`) or a new one (`key` only, no id yet). */
export type DraftWidget = DashboardWidget & { key: string; isNew?: boolean };

/** Row unit U: 152 px when the grid is at least 1024 px wide, 128 px below (§1.4 geometry). */
export function rowUnit(gridWidth: number) {
  return gridWidth >= 1024 ? 152 : 128;
}

/** Moves the item at `from` to `to` (both clamped). Returns the same array when nothing moves. */
export function reorder<T>(list: readonly T[], from: number, to: number): T[] {
  const t = Math.max(0, Math.min(list.length - 1, to));
  if (from === t || from < 0 || from >= list.length) return list as T[];
  const next = list.slice();
  const [m] = next.splice(from, 1);
  next.splice(t, 0, m!);
  return next;
}

/** Width 3–12 columns, height minH–4 rows (per type). */
export function clampSize(type: WidgetType, w: number, h: number): { w: number; h: number } {
  return {
    w: Math.max(MIN_W, Math.min(COLS, Math.round(w))),
    h: Math.max(MIN_H[type], Math.min(MAX_H, Math.round(h))),
  };
}

/** My tasks: as many rows as fit (h1: 3, h2: 7, h3: 11, h4: 15). */
export function rowsFor(h: number) {
  return Math.max(1, Math.min(MAX_H, h)) * 4 - 1;
}

/** Order, sizes and configs equal (ids of saved widgets; new widgets compare by type). */
export function layoutEquals(a: readonly DashboardWidgetInput[], b: readonly DashboardWidgetInput[]) {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i]!;
    return x.type === y.type && (x.id ?? null) === (y.id ?? null) && x.w === y.w && x.h === y.h && JSON.stringify(x.config) === JSON.stringify(y.config);
  });
}

/** Draft → PUT body item (new widgets go without an id). */
export function toInput(w: DraftWidget): DashboardWidgetInput {
  const base = { type: w.type, w: w.w, h: w.h, config: w.config } as DashboardWidgetInput;
  return w.isNew ? base : ({ ...base, id: w.id } as DashboardWidgetInput);
}

export function toDraft(widgets: readonly DashboardWidget[]): DraftWidget[] {
  return widgets.map((w) => ({ ...w, key: w.id }));
}

let newSeq = 0;
/** A new widget at its default size and config (Add widget). */
export function newWidget(type: WidgetType): DraftWidget {
  const key = `new-${type}-${++newSeq}`;
  return { id: key, key, isNew: true, type, ...DEFAULT_SIZE[type], config: defaultConfig(type) } as DraftWidget;
}

/** Packs only the widgets the viewer can see (hidden ones are skipped, spec §1.3). */
export function packVisible<T extends { w: number; h: number }>(items: readonly T[]) {
  const rects = pack(items);
  return { rects, rows: packedRows(rects) };
}

/** Index of the widget whose packed rect contains the grid cell (col, row), or -1. */
export function hitIndex(rects: readonly Rect[], col: number, row: number) {
  return rects.findIndex((r) => col >= r.x && col < r.x + r.w && row >= r.y && row < r.y + r.h);
}

/** Live-region copy, exactly as specified (§1.4). */
export const liveText = {
  moved: (name: string, pos: number, total: number) => `${name} moved to position ${pos} of ${total}`,
  resized: (name: string, w: number, h: number) => `${name} resized to ${w} by ${h}`,
  added: (name: string) => `${name} added`,
  removed: (name: string) => `${name} removed`,
  saved: "Layout saved",
  discarded: "Layout changes discarded",
};
