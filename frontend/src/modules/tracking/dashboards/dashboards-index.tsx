"use client";

import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/ui/button";
import { ErrorState } from "@/ui/feedback";
import { isApiError } from "@/api/errors";
import type { DashboardSummary } from "@/api/types";
import { can, useCurrentProject, useCurrentWorkspace } from "@/platform/roles/can";
import { routes } from "@/lib/routes";
import { NewDashboardDialog } from "./dashboard-dialogs";
import { DashboardSkeleton, DashboardState, MonoNote } from "./dashboard-states";
import { isPendingDelete, lastDashboard, useDashboards } from "./queries";

/** The dashboard to open (§1.2): the last one opened here, else the first shared, else your first personal. */
export function pickDashboard(list: readonly DashboardSummary[], last: string | null): string | null {
  const live = list.filter((d) => !isPendingDelete(d.id));
  if (last && live.some((d) => d.id === last)) return last;
  return live.find((d) => d.visibility === "shared")?.id ?? live.find((d) => d.visibility === "personal")?.id ?? null;
}

/** `/[ws]/projects/[key]/dashboards`: opens a dashboard, or shows "No dashboards yet". */
export function DashboardsIndex() {
  const project = useCurrentProject()!;
  const ws = useCurrentWorkspace()!;
  const router = useRouter();
  const q = useDashboards(project.id);
  const [creating, setCreating] = useState(false);
  const target = q.data ? pickDashboard(q.data, lastDashboard(project.id)) : null;

  useEffect(() => {
    if (target) router.replace(routes.dashboard(ws.slug, project.key, target));
  }, [target, router, ws.slug, project.key]);

  if (q.isPending || target) return <DashboardSkeleton />;
  if (q.isError) {
    return (
      <div className="p-5">
        <ErrorState
          title="Couldn’t load dashboards"
          body={isApiError(q.error) ? <MonoNote>{`${q.error.status} · request ${q.error.ref ?? "—"}`}</MonoNote> : undefined}
          onRetry={() => void q.refetch()}
          retrying={q.isRefetching}
        />
      </div>
    );
  }
  const canCreate = project.status !== "archived" && can("tracking.dashboard.create", project.my_permissions);
  return (
    <DashboardState title="No dashboards yet">
      {canCreate ? (
        <>
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus size={13} aria-hidden /> New dashboard
          </Button>
          <NewDashboardDialog project={project} open={creating} onOpenChange={setCreating} />
        </>
      ) : (
        <MonoNote>Ask a project admin to create one</MonoNote>
      )}
    </DashboardState>
  );
}
