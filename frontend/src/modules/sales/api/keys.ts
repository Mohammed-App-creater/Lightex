/*
 * Sales query keys. Everything sits under `["workspace", slug, "sales", <group>, …]` so one prefix invalidates a
 * whole group (and `sk.all(slug)` the whole module).
 */

export type SalesGroup =
  | "settings"
  | "stages"
  | "products"
  | "lostReasons"
  | "calendar"
  | "holidays"
  | "companies"
  | "contacts"
  | "leads"
  | "opportunities"
  | "pipeline"
  | "quotations"
  | "activities"
  | "followUps"
  | "targets"
  | "performance"
  | "dailyReports"
  | "dashboard"
  | "reports";

export const sk = {
  all: (slug: string) => ["workspace", slug, "sales"] as const,
  /** A whole group: invalidate this after a write. */
  group: (slug: string, g: SalesGroup) => ["workspace", slug, "sales", g] as const,
  /** A list / read with parameters inside a group. */
  list: (slug: string, g: SalesGroup, params: object = {}) => ["workspace", slug, "sales", g, "list", params] as const,
  /** One record (and its parts: `summary`, `timeline`…) inside a group. */
  one: (slug: string, g: SalesGroup, id: string, part?: string) =>
    (part ? (["workspace", slug, "sales", g, "id", id, part] as const) : (["workspace", slug, "sales", g, "id", id] as const)),
};

/**
 * Groups whose numbers derive from deals, leads, activities and follow-ups (KPIs, boards, reports): a write to any
 * owned record refreshes them too.
 */
export const DERIVED: readonly SalesGroup[] = ["pipeline", "dashboard", "performance", "reports", "dailyReports", "targets"];
