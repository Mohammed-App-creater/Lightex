"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Briefcase } from "lucide-react";
import { useEffect } from "react";
import { EmptyState, ErrorState, Skeleton } from "@/ui/feedback";
import { api } from "@/api/endpoints";
import { isForbidden, isModuleDisabled } from "@/api/errors";
import { qk } from "@/api/query-keys";
import { useCurrentWorkspace } from "@/platform/roles/can";
import { ModuleDisabledScreen, ModuleForbiddenScreen } from "@/platform/shell/module-screens";

/**
 * Sales placeholder (Stage 3 contract §4–§5): calls `GET sales/workspaces/{slug}/health` and shows an empty
 * state. The shell's route guard already covers "turned off" and "no permission"; the API's 403s are handled
 * too in case the cached workspace is stale.
 */
export function SalesScreen() {
  const ws = useCurrentWorkspace()!;
  const qc = useQueryClient();
  const health = useQuery({
    queryKey: qk.salesHealth(ws.slug),
    queryFn: () => api.sales.health(ws.slug),
    retry: (count, err) => !isForbidden(err) && count < 2,
  });
  const disabled = health.isError && isModuleDisabled(health.error);
  // The server says the module is off: refresh the workspace so the sidebar and guard catch up.
  useEffect(() => {
    if (disabled) void qc.invalidateQueries({ queryKey: qk.workspace(ws.slug), exact: true });
  }, [disabled, qc, ws.slug]);

  if (disabled) return <ModuleDisabledScreen name="Sales" />;
  if (health.isError && isForbidden(health.error)) return <ModuleForbiddenScreen name="Sales" />;

  return (
    <div className="flex min-h-full flex-col gap-5 px-6 pb-7 pt-[22px] max-[760px]:px-4 max-[760px]:pt-4">
      <h1 className="m-0 text-[20px] font-semibold leading-7 tracking-[-0.015em] max-[760px]:text-[17px]">Sales</h1>
      {health.isPending ? (
        <div aria-busy="true" aria-label="Loading Sales" className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-6">
          <Skeleton className="size-11 rounded-[10px]" />
          <Skeleton className="h-4 w-[180px]" />
          <Skeleton className="h-3 w-[280px] max-w-full" />
        </div>
      ) : health.isError ? (
        <ErrorState title="Couldn’t reach Sales" onRetry={() => void health.refetch()} retrying={health.isFetching} />
      ) : (
        <div className="rounded-xl border border-line bg-surface p-6">
          <EmptyState
            icon={<Briefcase size={20} strokeWidth={1.5} aria-hidden />}
            title="Sales is on"
            body="Leads, opportunities and pipeline health will live here. Nothing to show yet."
          />
          <p className="m-0 mt-3 font-mono text-[11px] text-fg-3">
            health · {health.data.status} · {health.data.workspace}
          </p>
        </div>
      )}
    </div>
  );
}
