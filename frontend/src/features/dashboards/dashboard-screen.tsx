"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { TopBarActions } from "@/components/shell/top-bar";
import { NotFoundScreen } from "@/components/shell/edge-screens";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/feedback";
import { toast } from "@/components/ui/toast";
import { useMe } from "@/features/auth/session";
import { EditingPill } from "@/features/presence/presence-ui";
import { PresenceStack } from "@/features/presence/presence-stack";
import { editingLabel, editors, peopleAt } from "@/features/presence/presence-lib";
import { usePresence, useRoster } from "@/features/presence/use-presence";
import { errorMessage, isApiError, isNotFound } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import type { Dashboard, DashboardWidget, WidgetType } from "@/lib/api/types";
import { WIDGET_NAME, WIDGET_NEEDS } from "@/lib/domain/dashboards";
import { useIsMobile, usePrefersReducedMotion } from "@/lib/hooks/use-media-query";
import { can, canEditDashboard, useCurrentProject, useCurrentWorkspace } from "@/lib/permissions/can";
import { onScreen } from "@/lib/realtime/screen-registry";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils/cn";
import { DashboardPicker } from "./dashboard-picker";
import { DashboardSkeleton, DashboardState, GridIcon, MonoNote } from "./dashboard-states";
import { LayoutGrid } from "./layout-grid";
import { layoutEquals, liveText, newWidget, reorder, toDraft, toInput, type DraftWidget } from "./layout-lib";
import { rememberDashboard, useDashboard, useDashboards, useSaveLayout } from "./queries";
import { WidgetGallery } from "./widget-gallery";
import { HAS_SETTINGS, WidgetSettings } from "./widget-settings";
import { ActivityWidget } from "./widgets/activity-widget";
import { BurndownWidget } from "./widgets/burndown-widget";
import { MyTasksWidget } from "./widgets/my-tasks-widget";
import { ObjectivesWidget } from "./widgets/objectives-widget";
import { VelocityWidget } from "./widgets/velocity-widget";
import { WorkloadWidget } from "./widgets/workload-widget";

/*
 * One dashboard (spec §1.3–§1.7): header (crumb picker, presence, editing pills, Edit layout or
 * Add widget / Cancel / Save layout), the grid, states, live region and toasts. Edit mode works on
 * a draft (the dashboard at edit start is kept for Cancel and for the `version` of the save);
 * leaving the route discards it. Phones (≤ 760 px) stack the widgets and have no edit mode.
 */

export function DashboardScreen() {
  const { dashboardId } = useParams<{ dashboardId: string }>();
  const id = decodeURIComponent(dashboardId);
  const q = useDashboard(id);
  if (q.isPending) return <DashboardSkeleton />;
  if (q.isError) return <DashboardError error={q.error} onRetry={() => void q.refetch()} retrying={q.isRefetching} />;
  return <DashboardView key={q.data.id} dashboard={q.data} />;
}

function DashboardError({ error, onRetry, retrying }: { error: unknown; onRetry: () => void; retrying: boolean }) {
  const ws = useCurrentWorkspace()!;
  const project = useCurrentProject()!;
  if (isNotFound(error)) {
    return <NotFoundScreen bare path={routes.project(ws.slug, project.key, "dashboards")} home={routes.project(ws.slug, project.key, "dashboards")} title="Dashboard not found" />;
  }
  return (
    <div className="p-5">
      <ErrorState
        title="Couldn’t load dashboard"
        body={<MonoNote>{isApiError(error) ? `${error.status} · request ${error.ref ?? "—"}` : errorMessage(error)}</MonoNote>}
        onRetry={onRetry}
        retrying={retrying}
      />
    </div>
  );
}

type Edit = { base: Dashboard; draft: DraftWidget[] };

function DashboardView({ dashboard }: { dashboard: Dashboard }) {
  const project = useCurrentProject()!;
  const ws = useCurrentWorkspace()!;
  const me = useMe();
  const router = useRouter();
  const qc = useQueryClient();
  const mobile = useIsMobile();
  const reduce = usePrefersReducedMotion();
  const list = useDashboards(project.id);
  const save = useSaveLayout();
  const [edit, setEdit] = useState<Edit | null>(null);
  const [gallery, setGallery] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);
  const [live, setLive] = useState({ msg: "", n: 0 });

  const perms = project.my_permissions;
  const archived = project.status === "archived";
  const canEdit = !archived && canEditDashboard(dashboard, perms, me.id);
  const canLayout = canEdit && !mobile;
  const readable = (t: WidgetType) => can(WIDGET_NEEDS[t], perms);
  const editing = Boolean(edit) && !mobile;
  const all: DraftWidget[] = edit ? edit.draft : toDraft(dashboard.widgets);
  const visible = all.filter((w) => readable(w.type));

  // Presence: viewing this dashboard, or editing its layout.
  usePresence({ projectId: project.id, location: { kind: "dashboard", id: dashboard.id }, state: editing ? "editing" : "viewing", field: editing ? "layout" : null });
  const roster = useRoster(project.id);
  const { others } = peopleAt(roster.data, { kind: "dashboard", id: dashboard.id }, me.id);
  const layoutEditors = editors(others, me.id).filter((p) => p.field === "layout");
  const editingText = editingLabel(layoutEditors, me.id, "the layout");

  useEffect(() => rememberDashboard(project.id, dashboard.id), [project.id, dashboard.id]);
  useEffect(() => {
    onScreen.dashboard = {
      id: dashboard.id,
      onDeleted: () => {
        toast({ tone: "warning", title: "This dashboard was deleted" });
        rememberDashboard(project.id, null);
        router.replace(routes.project(ws.slug, project.key, "dashboards"));
      },
    };
    return () => {
      if (onScreen.dashboard?.id === dashboard.id) onScreen.dashboard = null;
    };
  }, [dashboard.id, project.id, project.key, ws.slug, router]);
  useEffect(() => {
    if (!fresh) return;
    const t = setTimeout(() => setFresh(null), 500);
    return () => clearTimeout(t);
  }, [fresh]);

  const announce = (msg: string) => setLive((l) => ({ msg, n: l.n + 1 }));
  const setDraft = (fn: (d: DraftWidget[]) => DraftWidget[]) => setEdit((e) => (e ? { ...e, draft: fn(e.draft) } : e));

  const startEdit = () => setEdit({ base: dashboard, draft: toDraft(dashboard.widgets) });
  const cancel = () => {
    setEdit(null);
    announce(liveText.discarded);
  };

  /** Moves `key` to a position among the visible widgets (hidden ones keep their place in the list). */
  const moveIn = (d: DraftWidget[], key: string, toVisible: number) => {
    const vis = d.filter((w) => readable(w.type));
    const target = vis[Math.max(0, Math.min(vis.length - 1, toVisible))];
    const from = d.findIndex((w) => w.key === key);
    const to = target ? d.findIndex((w) => w.key === target.key) : from;
    return reorder(d, from, to);
  };
  const move = (key: string, toVisible: number, final: boolean) => {
    setDraft((d) => moveIn(d, key, toVisible));
    if (!final) return;
    const next = moveIn(all, key, toVisible).filter((w) => readable(w.type));
    const w = next.find((x) => x.key === key);
    if (w) announce(liveText.moved(WIDGET_NAME[w.type], next.findIndex((x) => x.key === key) + 1, next.length));
  };

  const resize = (key: string, w: number, h: number, final: boolean) => {
    setDraft((d) => d.map((x) => (x.key === key ? { ...x, w, h } : x)));
    const t = all.find((x) => x.key === key)?.type;
    if (final && t) announce(liveText.resized(WIDGET_NAME[t], w, h));
  };

  const remove = (key: string) => {
    const t = all.find((x) => x.key === key)?.type;
    setDraft((d) => d.filter((x) => x.key !== key));
    if (t) announce(liveText.removed(WIDGET_NAME[t]));
  };

  const setConfig = (key: string, config: DashboardWidget["config"]) => setDraft((d) => d.map((x) => (x.key === key ? ({ ...x, config } as DraftWidget) : x)));

  const onSaveError = (e: unknown) => {
    if (isApiError(e) && e.code === "version_conflict") {
      const current = e.details?.current as Dashboard | undefined;
      toast({
        tone: "warning",
        title: "Someone else changed this dashboard",
        body: "Your changes are still here. Reload to see theirs.",
        duration: 8000,
        action: {
          label: "Reload",
          key: "R",
          onClick: () => {
            if (current) qc.setQueryData(qk.dashboard(dashboard.id), current);
            else void qc.invalidateQueries({ queryKey: qk.dashboard(dashboard.id) });
            setEdit(null);
          },
        },
      });
      return;
    }
    if (isApiError(e) && e.code === "validation_failed") {
      const first = Object.values(e.fieldErrors)[0];
      toast.error(first ?? e.message);
      return;
    }
    toast.error("Couldn’t save the layout", { body: errorMessage(e) });
  };

  const doSave = () => {
    if (!edit) return;
    const inputs = edit.draft.map(toInput);
    if (layoutEquals(inputs, toDraft(edit.base.widgets).map(toInput))) {
      setEdit(null);
      return;
    }
    save.mutate(
      { id: dashboard.id, projectId: project.id, version: edit.base.version, widgets: inputs },
      {
        onSuccess: (d) => {
          setEdit(null);
          toast.success(`Layout saved · ${d.widgets.length} ${d.widgets.length === 1 ? "widget" : "widgets"}`);
          announce(liveText.saved);
        },
        onError: onSaveError,
      },
    );
  };

  const add = (type: WidgetType) => {
    const w = newWidget(type);
    setGallery(false);
    announce(liveText.added(WIDGET_NAME[type]));
    if (mobile) {
      // No edit mode on phones: the gallery saves at once.
      save.mutate(
        { id: dashboard.id, projectId: project.id, version: dashboard.version, widgets: [...toDraft(dashboard.widgets).map(toInput), toInput(w)] },
        { onSuccess: () => toast.success(liveText.added(WIDGET_NAME[type])), onError: onSaveError },
      );
      return;
    }
    setFresh(w.key);
    setEdit((e) => (e ? { ...e, draft: [...e.draft, w] } : { base: dashboard, draft: [...toDraft(dashboard.widgets), w] }));
  };

  const renderWidget = (w: DraftWidget) => {
    const common = { project, h: w.h, mobile, reduce };
    switch (w.type) {
      case "burndown":
        return <BurndownWidget {...common} config={w.config} />;
      case "my_tasks":
        return <MyTasksWidget {...common} config={w.config} />;
      case "objectives":
        return <ObjectivesWidget {...common} config={w.config} />;
      case "workload":
        return <WorkloadWidget {...common} config={w.config} />;
      case "velocity":
        return <VelocityWidget {...common} config={w.config} />;
      case "activity":
        return <ActivityWidget {...common} />;
    }
  };

  const presence = (
    <PresenceStack
      others={others}
      me={others.length ? me : null}
      size={mobile ? 20 : 26}
      label="Viewing now"
      editingWhat="the layout"
    />
  );

  let body;
  if (!all.length) {
    body = (
      <DashboardState title="No widgets yet">
        {canEdit ? (
          <Button variant="primary" onClick={() => setGallery(true)}>
            <Plus size={13} aria-hidden /> Add widget
          </Button>
        ) : (
          <MonoNote>Ask an editor to add widgets</MonoNote>
        )}
      </DashboardState>
    );
  } else if (!visible.length) {
    body = (
      <DashboardState title="Nothing to show">
        <MonoNote>These widgets need report access</MonoNote>
      </DashboardState>
    );
  } else {
    body = (
      <div className="px-5 pb-6 pt-3.5 max-[760px]:px-3 max-[760px]:pb-8 max-[760px]:pt-2.5">
        <LayoutGrid
          items={visible}
          editing={editing}
          stack={mobile}
          fresh={fresh}
          renderWidget={renderWidget}
          settingsFor={(w) => (HAS_SETTINGS[w.type] ? <WidgetSettings widget={w} projectId={project.id} onChange={(c) => setConfig(w.key, c)} /> : null)}
          onMove={move}
          onResize={resize}
          onRemove={remove}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {mobile && others.length > 0 && <TopBarActions>{presence}</TopBarActions>}
      <div className="flex min-h-[52px] flex-none flex-wrap items-center gap-2 border-b border-line py-2 pl-4 pr-3 max-[760px]:px-3">
        <div className="flex min-w-0 items-center gap-2 font-semibold">
          <span className="font-medium text-fg-3 max-[760px]:hidden">Dashboards</span>
          <span className="font-medium text-fg-3 max-[760px]:hidden">/</span>
          <DashboardPicker project={project} dashboard={dashboard} list={list.data ?? [{ id: dashboard.id, projectId: project.id, name: dashboard.name, visibility: dashboard.visibility, ownerId: dashboard.ownerId, widgetCount: dashboard.widgets.length, updatedAt: dashboard.updatedAt }]} />
        </div>
        {editing && (
          <span className="inline-flex h-6 animate-[fade-in_180ms_var(--ease)] items-center gap-1.5 whitespace-nowrap rounded-xl bg-accent-s px-[9px] text-[11.5px] font-semibold text-accent-t">
            <GridIcon size={12} />
            Editing layout
          </span>
        )}
        <span className="flex-1" />
        {editingText && layoutEditors[0] && <EditingPill person={layoutEditors[0]} label={editingText} icon="grid" />}
        {!editing && !mobile && presence}
        {editing ? (
          <>
            <Button size="sm" variant="secondary" onClick={() => setGallery(true)}>
              <Plus size={13} aria-hidden /> Add widget
            </Button>
            <span aria-hidden className="mx-0.5 h-5 w-px flex-none bg-line" />
            <Button size="sm" variant="ghost" onClick={cancel} disabled={save.isPending}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={doSave} loading={save.isPending}>
              Save layout
            </Button>
          </>
        ) : (
          canLayout &&
          all.length > 0 && (
            <>
              {others.length > 0 && <span aria-hidden className="mx-0.5 h-5 w-px flex-none bg-line" />}
              <Button size="sm" variant="secondary" onClick={startEdit}>
                <GridIcon size={14} />
                Edit layout
              </Button>
            </>
          )
        )}
      </div>
      <div className={cn("flex min-h-0 flex-1 flex-col")}>{body}</div>
      {canEdit && (
        <WidgetGallery
          open={gallery}
          onOpenChange={setGallery}
          mobile={mobile}
          present={new Set(all.map((w) => w.type))}
          readable={readable}
          onAdd={add}
        />
      )}
      <span className="sr-only" aria-live="polite" data-live="dashboard">
        <span key={live.n}>{live.msg}</span>
      </span>
    </div>
  );
}
