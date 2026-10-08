"use client";

import { Eye, Flag, Plus, Target } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/choice";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/feedback";
import { useMilestones, useObjectives, useProjectMembers, useStatuses } from "@/features/projects/queries";
import { errorMessage, isApiError } from "@/lib/api/errors";
import type { Milestone, Objective } from "@/lib/api/types";
import { useCan, useCurrentProject, useCurrentWorkspace } from "@/lib/permissions/can";
import { replaceUrl, routes } from "@/lib/routes";
import { cn } from "@/lib/utils/cn";
import { GoalPanel, type PanelState } from "./goal-panel";
import { defaultMilestoneId, sortByDue } from "./helpers";
import { MilestonesView, type MilestoneViewMode } from "./milestones-view";
import { ObjectivesList } from "./objectives-list";
import { ViewOnlyPill, type PeopleMap } from "./parts";
import { useProjectTasks } from "./queries";

export type GoalsTab = "objectives" | "milestones";

const VIEW_KEY = "lightex-goals-view";

/**
 * Goals screen (board 16): Objectives and Milestones share one page with tabs that link between
 * the two routes. Rendered inside the project shell.
 */
export function GoalsScreen({ tab }: { tab: GoalsTab }) {
  const ws = useCurrentWorkspace()!;
  const project = useCurrentProject()!;
  const router = useRouter();
  const projectId = project.id;

  const canObjectives = useCan("objective.manage");
  const canMilestones = useCan("milestone.manage");
  const canManage = tab === "objectives" ? canObjectives : canMilestones;
  const readOnly = !canObjectives && !canMilestones;

  const objectives = useObjectives(projectId);
  const milestones = useMilestones(projectId);
  const tasksQ = useProjectTasks(projectId);
  const statusesQ = useStatuses(projectId);
  const membersQ = useProjectMembers(projectId);

  const active = tab === "objectives" ? objectives : milestones;
  const loading = active.isPending || tasksQ.isPending || statusesQ.isPending;
  const error = active.error ?? tasksQ.error ?? statusesQ.error;
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    setRetrying(true);
    await Promise.allSettled([active.refetch(), tasksQ.refetch(), statusesQ.refetch()]);
    setRetrying(false);
  };

  const tasks = useMemo(() => tasksQ.data ?? [], [tasksQ.data]);
  const statuses = useMemo(() => statusesQ.data ?? [], [statusesQ.data]);
  const members = useMemo(() => membersQ.data ?? [], [membersQ.data]);
  const people: PeopleMap = useMemo(() => new Map(members.map((m) => [m.userId, m.user])), [members]);
  const msList = useMemo(() => sortByDue(milestones.data ?? []), [milestones.data]);
  const obList = objectives.data ?? [];

  /* Milestone view mode (remembered per viewer) and selection. */
  const [mode, setModeState] = useState<MilestoneViewMode>("timeline");
  useEffect(() => {
    try {
      const v = localStorage.getItem(VIEW_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate a per-viewer preference after mount
      if (v === "list" || v === "timeline") setModeState(v);
    } catch {
      /* storage unavailable */
    }
  }, []);
  const setMode = (v: MilestoneViewMode) => {
    setModeState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* storage unavailable */
    }
  };
  const [pickedId, setPickedId] = useState<string | null>(null);
  const selectedId = pickedId && msList.some((m) => m.id === pickedId) ? pickedId : defaultMilestoneId(msList);

  /* Create / edit panel + new-row flash. */
  const [panel, setPanel] = useState<PanelState | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(flashTimer.current), []);
  const closePanel = useCallback(() => setPanel(null), []);
  const openNew = () => setPanel(tab === "objectives" ? { kind: "objective", item: null } : { kind: "milestone", item: null });

  /* `?new=1` (links from the project overview) opens the create panel once, then leaves the URL. */
  const pathname = usePathname();
  const search = useSearchParams();
  const wantsNew = search.get("new") === "1";
  useEffect(() => {
    if (!wantsNew) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot: consume the deep-link param
    if (canManage) setPanel(tab === "objectives" ? { kind: "objective", item: null } : { kind: "milestone", item: null });
    const sp = new URLSearchParams(window.location.search);
    sp.delete("new");
    const qs = sp.toString();
    replaceUrl(qs ? `${pathname}?${qs}` : pathname);
  }, [wantsNew, canManage, tab, pathname]);
  const onSaved = (kind: PanelState["kind"], id: string) => {
    setPanel(null);
    setFlashId(id);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashId(null), 1500);
    if (kind === "milestone") setPickedId(id);
    if (kind !== tab.slice(0, -1)) router.push(routes.project(ws.slug, project.key, `${kind}s` as GoalsTab));
  };

  /* Tab indicator slides to the clicked tab before the route changes. */
  const [pendingTab, setPendingTab] = useState<GoalsTab | null>(null);
  const shownTab = pendingTab ?? tab;
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- route committed; drop the pending indicator
    setPendingTab(null);
  }, [tab]);

  const empty = !loading && !error && (tab === "objectives" ? obList.length === 0 : msList.length === 0);
  const ready = !loading && !error && !empty;
  const newLabel = tab === "objectives" ? "New objective" : "New milestone";

  const tabs: { id: GoalsTab; label: string; count: number | undefined }[] = [
    { id: "objectives", label: "Objectives", count: objectives.data?.length },
    { id: "milestones", label: "Milestones", count: milestones.data?.length },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-end gap-3 border-b border-line px-8 pt-3 max-[1023px]:px-[18px] max-[760px]:gap-0 max-[760px]:px-3">
        <nav aria-label="Goals" className="relative flex max-[760px]:w-full">
          {tabs.map((t) => (
            <Link
              key={t.id}
              href={routes.project(ws.slug, project.key, t.id)}
              aria-current={t.id === tab ? "page" : undefined}
              onClick={() => t.id !== tab && setPendingTab(t.id)}
              className={cn(
                "inline-flex h-[38px] w-[132px] items-center justify-center gap-2 rounded-t-sm text-[13px] font-medium text-fg-2 transition-colors duration-[var(--dur-fast)] hover:bg-hover hover:text-fg max-[760px]:h-11 max-[760px]:w-auto max-[760px]:flex-1",
                t.id === shownTab && "text-fg",
              )}
            >
              {t.label}
              {t.count !== undefined && <span className="font-mono text-[11px] font-medium text-fg-3">{t.count}</span>}
            </Link>
          ))}
          <span
            aria-hidden
            className="absolute -bottom-px left-0 h-0.5 w-1/2 rounded-full bg-accent transition-transform duration-[260ms] ease-spring"
            style={{ transform: `translateX(${shownTab === "objectives" ? 0 : 100}%)` }}
          />
        </nav>
        <div className="ml-auto flex items-center gap-2 pb-2 max-[760px]:w-full max-[760px]:py-2.5">
          {tab === "milestones" && ready && (
            <Segmented
              label="Milestone view"
              value={mode}
              onChange={setMode}
              className="max-[760px]:flex-1 [&>button]:inline-flex [&>button]:min-w-[84px] [&>button]:items-center [&>button]:justify-center [&>button]:gap-1.5 max-[760px]:[&>button]:h-9 max-[760px]:[&>button]:flex-1"
              options={[
                { value: "timeline", label: <><ViewIcon d="M2 4h7M5 8h8M3 12h6" />Timeline</> },
                { value: "list", label: <><ViewIcon d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01" />List</> },
              ]}
            />
          )}
          {readOnly && <ViewOnlyPill icon={<Eye size={12} aria-hidden />} />}
          {canManage && ready && (
            <>
              <Button variant="primary" size="sm" onClick={openNew} className="max-[760px]:hidden">
                <Plus size={14} aria-hidden />
                {newLabel}
              </Button>
              <Button variant="primary" icon aria-label={newLabel} onClick={openNew} className="ml-auto hidden size-11 rounded-[9px] max-[760px]:inline-flex">
                <Plus size={18} aria-hidden />
              </Button>
            </>
          )}
        </div>
      </header>

      <div className="flex flex-1 flex-col gap-3 px-8 pb-10 pt-5 max-[1023px]:px-[18px] max-[1023px]:pb-7 max-[1023px]:pt-4 max-[760px]:gap-2.5 max-[760px]:px-3 max-[760px]:pb-8 max-[760px]:pt-3">
        {loading ? (
          <LoadingRows />
        ) : error ? (
          <ErrorState
            title="Couldn’t load goals"
            body={`${errorMessage(error)} Retrying won’t lose anything.`}
            refId={isApiError(error) ? (error.ref ?? undefined) : undefined}
            onRetry={retry}
            retrying={retrying}
          />
        ) : empty ? (
          <EmptyState
            align="center"
            className="py-8"
            icon={tab === "objectives" ? <Target size={22} className="text-accent-t" aria-hidden /> : <Flag size={22} className="text-accent-t" aria-hidden />}
            title={tab === "objectives" ? "No objectives yet" : "No milestones yet"}
            body={
              tab === "objectives"
                ? "Objectives tie tasks to outcomes. Progress fills in as linked tasks get done."
                : "Milestones mark dates that matter. Link tasks to see whether you’re on track."
            }
            actions={
              canManage ? (
                <Button variant="primary" size="sm" onClick={openNew}>
                  <Plus size={14} aria-hidden />
                  {newLabel}
                </Button>
              ) : undefined
            }
          />
        ) : tab === "objectives" ? (
          <ObjectivesList
            objectives={obList}
            tasks={tasks}
            statuses={statuses}
            people={people}
            canManage={canObjectives}
            projectId={projectId}
            flashId={flashId}
            onEdit={(o: Objective) => setPanel({ kind: "objective", item: o })}
          />
        ) : (
          <MilestonesView
            milestones={msList}
            mode={mode}
            projectId={projectId}
            flashId={flashId}
            selectedId={selectedId}
            onSelect={setPickedId}
            tasks={tasks}
            statuses={statuses}
            people={people}
            canManage={canMilestones}
            onEdit={(m: Milestone) => setPanel({ kind: "milestone", item: m })}
          />
        )}
      </div>

      {panel && (
        <GoalPanel
          state={panel}
          onClose={closePanel}
          onSaved={onSaved}
          projectId={projectId}
          members={members}
          tasks={tasks}
          statuses={statuses}
        />
      )}
    </div>
  );
}

function LoadingRows() {
  const widths = [46, 58, 38, 52];
  return (
    <div role="status" aria-busy="true" aria-label="Loading goals" className="flex flex-col gap-2">
      {widths.map((w, i) => (
        <div
          key={i}
          className="flex items-center gap-3.5 rounded-[10px] border border-line bg-surface px-3.5 py-3"
          style={{ opacity: 1 - i * 0.15 }}
        >
          <Skeleton className="size-10 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-3" style={{ width: `${w}%` }} />
            <Skeleton className="h-2.5 w-[34%]" />
          </div>
        </div>
      ))}
    </div>
  );
}

function ViewIcon({ d }: { d: string }) {
  return (
    <svg className="flex-none" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}
