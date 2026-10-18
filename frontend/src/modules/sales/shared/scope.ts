"use client";

import type { DataScope, Permission } from "@/api/types";
import { can, useCan, useDataScope } from "@/platform/roles/can";

/**
 * A sales permission and its data scope (docs/sales/api.md §3): `own` = your records, `team` = you and your
 * team-mates, `all` = the workspace. `scope` is null without a grant. The server applies the scope; this only shapes
 * the UI (e.g. hide the owner filter for `own`, offer "Team" / "Everyone" toggles for wider scopes).
 */
export function useSalesScope(code: Permission) {
  const allowed = useCan(code);
  const scope: DataScope | null = useDataScope(code);
  return {
    allowed,
    scope: allowed ? scope : null,
    isOwn: allowed && scope === "own",
    /** `team` or `all`: may act for / filter by other people. */
    beyondOwn: allowed && (scope === "team" || scope === "all"),
    isAll: allowed && scope === "all",
  };
}

/** Does the permission list hold any `sales.*` code? (The sidebar's Sales section.) */
export const hasAnySales = (perms: readonly string[] | undefined | null) => Boolean(perms?.some((p) => p.startsWith("sales.")));

export { can };
