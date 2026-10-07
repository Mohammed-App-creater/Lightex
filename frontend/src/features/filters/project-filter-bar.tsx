"use client";

import { useState, type ReactNode } from "react";
import type { FilterRule, Project, SavedView } from "@/lib/api/types";
import { can } from "@/lib/permissions/can";
import { FilterBar } from "./filter-bar";
import { SaveViewDialog } from "./save-view-dialog";
import type { FilterOptions } from "./use-filters";

/** FilterBar + Save view for a project screen (Board and List share this). */
export function ProjectFilterBar({
  slug,
  project,
  layout,
  rules,
  setRules,
  viewId,
  opts,
  count,
  leading,
  trailing,
  className,
}: {
  slug: string;
  project: Project;
  layout: SavedView["layout"];
  rules: FilterRule[];
  setRules: (r: FilterRule[], viewId?: string | null) => void;
  /** Set while the URL shows a saved view unchanged; Save view is hidden then. */
  viewId?: string | null;
  opts: FilterOptions;
  count: number | null;
  leading?: ReactNode;
  trailing?: ReactNode;
  className?: string;
}) {
  const [saving, setSaving] = useState(false);
  return (
    <>
      <FilterBar rules={rules} onChange={(r) => setRules(r)} opts={opts} count={count} onSave={viewId ? undefined : () => setSaving(true)} leading={leading} trailing={trailing} className={className} />
      <SaveViewDialog
        open={saving}
        onOpenChange={setSaving}
        slug={slug}
        projectId={project.id}
        layout={layout}
        rules={rules}
        opts={opts}
        canShare={can("task.create", project.my_permissions)}
        onSaved={(v) => setRules(v.filters, v.id)}
      />
    </>
  );
}
