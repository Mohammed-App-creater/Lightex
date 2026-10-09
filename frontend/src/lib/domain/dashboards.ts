import type { ProjectPermission, WidgetConfigMap, WidgetType } from "@/lib/api/types";

/*
 * Board 33 widget catalogue (spec §1.3, §3.3), shared by the UI and the mock backend. Values come
 * from the design's CAT (default size), minH and STACK fixtures.
 */

export const WIDGET_TYPES: readonly WidgetType[] = ["burndown", "my_tasks", "objectives", "workload", "velocity", "activity"];

export const WIDGET_NAME: Record<WidgetType, string> = {
  burndown: "Burndown",
  my_tasks: "My tasks",
  objectives: "Objective progress",
  workload: "Workload by person",
  velocity: "Velocity",
  activity: "Recent activity",
};

export const DEFAULT_SIZE: Record<WidgetType, { w: number; h: number }> = {
  burndown: { w: 6, h: 2 },
  my_tasks: { w: 3, h: 2 },
  objectives: { w: 3, h: 2 },
  workload: { w: 6, h: 2 },
  velocity: { w: 3, h: 2 },
  activity: { w: 3, h: 2 },
};

export const MIN_H: Record<WidgetType, number> = { burndown: 2, my_tasks: 1, objectives: 1, workload: 2, velocity: 2, activity: 1 };
export const MAX_H = 4;
export const MIN_W = 3;
export const COLS = 12;

/** Stacked card height on phones (px), from the design's STACK. */
export const STACK_HEIGHT: Record<WidgetType, number> = { burndown: 236, my_tasks: 200, objectives: 206, workload: 268, velocity: 214, activity: 236 };

/** The permission a viewer needs to see a widget; without it the widget isn't rendered and packing skips it. */
export const WIDGET_NEEDS: Record<WidgetType, ProjectPermission> = {
  burndown: "report.view",
  my_tasks: "project.view",
  objectives: "report.view",
  workload: "report.view",
  velocity: "report.view",
  activity: "project.view",
};

export function defaultConfig<T extends WidgetType>(type: T): WidgetConfigMap[T] {
  const c: { [K in WidgetType]: WidgetConfigMap[K] } = {
    burndown: { sprintId: null },
    my_tasks: { showDone: true },
    objectives: { quarter: null },
    workload: { unit: "points", sprintId: null, personField: null },
    velocity: { range: "last6" },
    activity: {},
  };
  return c[type];
}

/** "Sprint health" template (§1.6): the design's default layout, in order. */
export const SPRINT_HEALTH: readonly WidgetType[] = ["burndown", "my_tasks", "objectives", "workload", "velocity", "activity"];

export type PackItem = { w: number; h: number };
export type Rect = { x: number; y: number; w: number; h: number };

/**
 * First-fit packing, a port of the design's pack(): for each widget in order, the first row, then
 * the first column, where a w × h box fits without overlap on a 12-column grid. Widths above 12
 * are clamped. Shared vectors: src/features/dashboards/pack-vectors.json.
 */
export function pack(items: readonly PackItem[], cols = COLS): Rect[] {
  const occ: boolean[][] = [];
  const free = (x: number, y: number, w: number, h: number) => {
    for (let r = y; r < y + h; r++) for (let c = x; c < x + w; c++) if (occ[r]?.[c]) return false;
    return true;
  };
  return items.map((it) => {
    const w = Math.max(1, Math.min(cols, it.w));
    const h = Math.max(1, it.h);
    for (let y = 0; ; y++) {
      for (let x = 0; x <= cols - w; x++) {
        if (!free(x, y, w, h)) continue;
        for (let r = y; r < y + h; r++) {
          occ[r] ??= [];
          for (let c = x; c < x + w; c++) occ[r]![c] = true;
        }
        return { x, y, w, h };
      }
    }
  });
}

/** Rows used by a packing (the grid's height in rows). */
export function packedRows(rects: readonly Rect[]): number {
  return rects.reduce((m, r) => Math.max(m, r.y + r.h), 0);
}
