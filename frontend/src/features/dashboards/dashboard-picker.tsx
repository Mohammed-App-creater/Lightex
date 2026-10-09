"use client";

import { Check, ChevronDown } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import { useMe } from "@/features/auth/session";
import { errorMessage, isApiError } from "@/lib/api/errors";
import type { Dashboard, DashboardSummary, Project } from "@/lib/api/types";
import { can, canChangeVisibility, canEditDashboard, useCurrentWorkspace } from "@/lib/permissions/can";
import { routes } from "@/lib/routes";
import { DeleteDashboardDialog, NewDashboardDialog, RenameDashboardDialog } from "./dashboard-dialogs";
import { usePendingDashboardDelete, useUpdateDashboard } from "./queries";

/*
 * The crumb picker "Dashboards / Sprint 14 health ▾" (spec §1.6): Shared and Personal sections,
 * New dashboard…, Rename…, Share with project / Make personal, Delete… (with a 5 s Undo). Items
 * you can't use are not rendered; archived projects show only the list.
 */

export function DashboardPicker({ project, dashboard, list }: { project: Project; dashboard: Dashboard; list: DashboardSummary[] }) {
  const ws = useCurrentWorkspace()!;
  const me = useMe();
  const router = useRouter();
  const update = useUpdateDashboard();
  const [dialog, setDialog] = useState<"new" | "rename" | "delete" | null>(null);
  const perms = project.my_permissions;
  const archived = project.status === "archived";
  const canEdit = !archived && canEditDashboard(dashboard, perms, me.id);
  const canVisibility = !archived && canChangeVisibility(dashboard, perms, me.id);
  const canCreate = !archived && can("dashboard.create", perms);
  const shared = list.filter((d) => d.visibility === "shared");
  const personal = list.filter((d) => d.visibility === "personal");
  const removeLater = usePendingDashboardDelete((d) => router.push(routes.dashboard(ws.slug, project.key, d.id)));

  const go = (id: string) => {
    if (id !== dashboard.id) router.push(routes.dashboard(ws.slug, project.key, id));
  };
  const toggleVisibility = async () => {
    const visibility = dashboard.visibility === "shared" ? "personal" : "shared";
    try {
      const d = await update.mutateAsync({ d: dashboard, patch: { visibility } });
      toast.success(d.visibility === "shared" ? `“${d.name}” is shared with the project` : `“${d.name}” is now personal`);
    } catch (e) {
      toast.error(isApiError(e) && e.code === "version_conflict" ? "Someone else changed this dashboard" : "Couldn’t change who sees it", { body: errorMessage(e) });
    }
  };

  const item = (d: DashboardSummary) => (
    <MenuItem key={d.id} onSelect={() => go(d.id)} icon={d.id === dashboard.id ? <Check size={14} aria-hidden /> : <span className="size-3.5" />}>
      <span className="truncate">{d.name}</span>
    </MenuItem>
  );

  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <button
            type="button"
            aria-label={`Dashboard: ${dashboard.name}. Switch dashboard`}
            className="-ml-1 inline-flex h-[30px] min-w-0 items-center gap-1.5 rounded-[7px] px-2 text-[13px] font-semibold text-fg hover:bg-hover data-[state=open]:bg-hover max-[760px]:h-11"
          >
            <span className="truncate">{dashboard.name}</span>
            <ChevronDown size={12} className="flex-none text-fg-3" aria-hidden />
          </button>
        </MenuTrigger>
        <MenuContent align="start" width={260} aria-label="Dashboards">
          <MenuLabel>Shared</MenuLabel>
          {shared.length ? shared.map(item) : <p className="m-0 px-2 py-1.5 text-[12px] text-fg-3">No shared dashboards</p>}
          {personal.length > 0 && (
            <>
              <MenuLabel>Personal</MenuLabel>
              {personal.map(item)}
            </>
          )}
          {canCreate && (
            <>
              <MenuSeparator />
              <MenuItem onSelect={() => setDialog("new")}>New dashboard…</MenuItem>
            </>
          )}
          {(canEdit || canVisibility) && <MenuSeparator />}
          {canEdit && <MenuItem onSelect={() => setDialog("rename")}>Rename…</MenuItem>}
          {canVisibility && <MenuItem onSelect={() => void toggleVisibility()}>{dashboard.visibility === "shared" ? "Make personal" : "Share with project"}</MenuItem>}
          {canEdit && (
            <MenuItem danger onSelect={() => setDialog("delete")}>
              Delete…
            </MenuItem>
          )}
        </MenuContent>
      </Menu>
      {canCreate && <NewDashboardDialog project={project} open={dialog === "new"} onOpenChange={(o) => setDialog(o ? "new" : null)} />}
      {canEdit && dialog === "rename" && <RenameDashboardDialog dashboard={dashboard} open onOpenChange={(o) => setDialog(o ? "rename" : null)} />}
      {canEdit && (
        <DeleteDashboardDialog
          dashboard={dashboard}
          open={dialog === "delete"}
          onOpenChange={(o) => setDialog(o ? "delete" : null)}
          onConfirm={() => {
            removeLater(dashboard);
            router.push(routes.project(ws.slug, project.key, "dashboards"));
          }}
        />
      )}
    </>
  );
}
