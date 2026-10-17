"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, MoreHorizontal, Play, Plus, RefreshCcw } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/feedback";
import { StatusGlyph } from "@/components/ui/glyphs";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import { useSprints } from "@/features/projects/queries";
import { api } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import type { Sprint } from "@/lib/api/types";
import { useIsMobile } from "@/lib/hooks/use-media-query";
import { useCan, useCurrentProject, useCurrentWorkspace } from "@/lib/permissions/can";
import { pushUrl, routes } from "@/lib/routes";
import { cn } from "@/lib/utils/cn";
import { dateRange } from "@/lib/utils/dates";
import { DeleteSprintDialog, EditSprintDialog, StartSprintDialog } from "./sprint-dialogs";
import { SprintBoard } from "./sprint-board";
import { groupSprints, nextPlanned, sprintWhen } from "./sprint-model";
import { CompleteSprintDialog } from "./sprint-review";

/** Columns of the sprint table (board 26 .sp-gr). Dates drop out under 900px; mobile stacks. */
export const SPRINT_GRID =
  "grid grid-cols-[minmax(0,1fr)_116px_104px_168px_96px_132px] items-center gap-3 max-[1100px]:grid-cols-[minmax(0,1fr)_96px_130px_70px_132px]";

type DialogState = { kind: "start" | "complete" | "edit" | "delete"; sprint: Sprint } | null;

/** Sprints (board 26): active / planned / completed table, sprint board, 3-step close. */
export function SprintsScreen() {
  return (
    <Suspense fallback={null}>
      <SprintsInner />
    </Suspense>
  );
}

function SprintsInner() {
  const project = useCurrentProject()!;
  const q = useSprints(project.id);
  const search = useSearchParams();
  const pathname = usePathname();
  const [dialog, setDialog] = useState<DialogState>(null);
  const sprints = q.data ?? [];
  const openId = search.get("sprint");
  const open = openId ? sprints.find((s) => s.id === openId) : undefined;
  const next = nextPlanned(sprints);

  const setOpen = (id: string | null) => {
    const sp = new URLSearchParams(search.toString());
    if (id) sp.set("sprint", id);
    else sp.delete("sprint");
    sp.delete("task");
    const qs = sp.toString();
    pushUrl(qs ? `${pathname}?${qs}` : pathname);
  };

  return (
    <>
      {open ? (
        <SprintBoard sprint={open} onBack={() => setOpen(null)} onComplete={() => setDialog({ kind: "complete", sprint: open })} />
      ) : (
        <SprintList
          sprints={sprints}
          pending={q.isPending}
          error={q.isError ? q.error : null}
          retrying={q.isFetching}
          onRetry={() => void q.refetch()}
          onOpen={setOpen}
          onDialog={setDialog}
        />
      )}
      {dialog?.kind === "start" && <StartSprintDialog sprint={dialog.sprint} open onOpenChange={(o) => !o && setDialog(null)} />}
      {dialog?.kind === "complete" && (
        <CompleteSprintDialog
          sprint={dialog.sprint}
          next={next}
          open
          onOpenChange={(o) => {
            if (!o) {
              setDialog(null);
              if (openId) setOpen(null);
            }
          }}
        />
      )}
      {dialog?.kind === "edit" && <EditSprintDialog sprint={dialog.sprint} open onOpenChange={(o) => !o && setDialog(null)} />}
      {dialog?.kind === "delete" && <DeleteSprintDialog sprint={dialog.sprint} open onOpenChange={(o) => !o && setDialog(null)} />}
    </>
  );
}

function SprintList({
  sprints,
  pending,
  error,
  retrying,
  onRetry,
  onOpen,
  onDialog,
}: {
  sprints: Sprint[];
  pending: boolean;
  error: unknown;
  retrying: boolean;
  onRetry: () => void;
  onOpen: (id: string) => void;
  onDialog: (d: DialogState) => void;
}) {
  const project = useCurrentProject()!;
  const ws = useCurrentWorkspace()!;
  const qc = useQueryClient();
  const canSprint = useCan("sprint.manage");
  const create = useMutation({
    mutationFn: () => api.planning.createSprint(project.id),
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: qk.scope(project.id) });
      toast.success(`${s.name} created`, { body: "Plan it from the backlog." });
    },
    onError: (e) => toast.error("Couldn’t create a sprint", { body: errorMessage(e) }),
  });
  const g = groupSprints(sprints);
  const hasActive = g.active.length > 0;
  const backlogHref = routes.project(ws.slug, project.key, "backlog");

  return (
    <div className="mx-auto flex w-full max-w-[1180px] flex-col px-8 pb-16 pt-5 max-[760px]:px-3 max-[760px]:pt-3">
      <div className="flex flex-wrap items-center gap-2 pb-3">
        <h1 className="m-0 text-h3">Sprints</h1>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" asChild>
          <Link href={backlogHref}>Plan in backlog</Link>
        </Button>
        {canSprint && (
          <Button size="sm" variant="primary" loading={create.isPending} onClick={() => create.mutate()} aria-label="New sprint">
            <Plus size={13} aria-hidden /> <span className="max-[760px]:hidden">New sprint</span>
          </Button>
        )}
      </div>
      {pending ? (
        <div aria-busy="true" aria-label="Loading sprints">
          <TableHeader />
          {[132, 110, 124, 98].map((w, i) => (
            <div key={i} className={cn(SPRINT_GRID, "min-h-[60px] px-3 max-[760px]:flex max-[760px]:flex-col max-[760px]:items-start max-[760px]:py-3")}>
              <span className="flex items-center gap-2.5">
                <Skeleton className="size-3.5 rounded-full" />
                <span className="flex flex-col gap-1.5">
                  <Skeleton className="h-2.5" style={{ width: w }} />
                  <Skeleton className="h-2 opacity-60" style={{ width: w + 70 }} />
                </span>
              </span>
              <Skeleton className="h-2.5 w-[76px] max-[1100px]:hidden" />
              <Skeleton className="h-2.5 w-[52px] max-[760px]:hidden" />
              <Skeleton className="h-2.5 w-full" />
              <Skeleton className="h-2.5 w-[44px] max-[760px]:hidden" />
              <span />
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="flex justify-center py-10">
          <ErrorState className="w-full max-w-[440px]" title="Couldn’t load sprints" body={`${errorMessage(error)} · retrying won’t lose work`} onRetry={onRetry} retrying={retrying} />
        </div>
      ) : sprints.length === 0 ? (
        <div className="flex justify-center py-14">
          <EmptyState
            align="center"
            icon={<RefreshCcw size={20} aria-hidden />}
            title="No sprints yet"
            body="Time-box work into 1–4 week cycles."
            actions={
              canSprint ? (
                <>
                  <Button variant="primary" loading={create.isPending} onClick={() => create.mutate()}>
                    <Plus size={13} aria-hidden /> Create sprint
                  </Button>
                  <Button variant="secondary" asChild>
                    <Link href={backlogHref}>Open backlog</Link>
                  </Button>
                </>
              ) : (
                <Button variant="secondary" asChild>
                  <Link href={backlogHref}>Open backlog</Link>
                </Button>
              )
            }
          />
        </div>
      ) : (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.18 }}>
          <TableHeader />
          <Section name="Active" list={g.active} sectionKey="active">
            {(s) => (
              <SprintRow
                key={s.id}
                sprint={s}
                onOpen={onOpen}
                action={
                  canSprint ? (
                    <Button size="sm" variant="secondary" onClick={() => onDialog({ kind: "complete", sprint: s })}>
                      Complete sprint
                    </Button>
                  ) : null
                }
                menu={canSprint ? <RowMenu sprint={s} onDialog={onDialog} /> : null}
              />
            )}
          </Section>
          <Section name="Planned" list={g.planned} sectionKey="planned">
            {(s) => {
              const isNext = g.planned[0]?.id === s.id;
              const reason = s.progress.total === 0 ? "Add tasks to the sprint before starting it" : undefined;
              return (
                <SprintRow
                  key={s.id}
                  sprint={s}
                  onOpen={onOpen}
                  action={
                    canSprint && isNext && !hasActive ? (
                      <Button size="sm" variant="secondary" disabledReason={reason} onClick={() => onDialog({ kind: "start", sprint: s })}>
                        <Play size={11} aria-hidden /> Start
                      </Button>
                    ) : null
                  }
                  menu={canSprint ? <RowMenu sprint={s} onDialog={onDialog} /> : null}
                />
              );
            }}
          </Section>
          <Section name="Completed" list={g.completed} sectionKey="completed">
            {(s) => <SprintRow key={s.id} sprint={s} onOpen={onOpen} action={null} menu={null} />}
          </Section>
        </motion.div>
      )}
    </div>
  );
}

function TableHeader() {
  return (
    <div className={cn(SPRINT_GRID, "h-[34px] border-b border-line px-3 font-mono text-[11px] font-medium tracking-[.02em] text-fg-3 max-[760px]:hidden")} aria-hidden>
      <span>Sprint</span>
      <span className="max-[1100px]:hidden">Dates</span>
      <span>Time</span>
      <span>Progress</span>
      <span>Velocity · pts</span>
      <span />
    </div>
  );
}

function Section({ name, list, sectionKey, children }: { name: string; list: Sprint[]; sectionKey: string; children: (s: Sprint) => React.ReactNode }) {
  const isMobile = useIsMobile();
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? !(sectionKey === "completed" && isMobile);
  const id = `sprints-sec-${sectionKey}`;
  return (
    <section aria-label={`${name} sprints`}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOverride(!open)}
        className="mt-3 flex h-9 w-full items-center gap-2 rounded-[7px] px-2 text-left text-[13px] font-semibold text-fg transition-colors hover:bg-hover max-[760px]:h-11"
      >
        <ChevronRight size={12} aria-hidden className={cn("flex-none text-fg-3 transition-transform duration-200 ease-out", open && "rotate-90")} />
        {name}
        <span className="font-mono text-[11px] font-medium text-fg-3">{list.length}</span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div id={id} initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }} className="flex flex-col gap-0.5 pt-1">
            {list.length ? (
              list.map(children)
            ) : (
              <div className="flex h-11 items-center gap-2 px-3 text-[12.5px] text-fg-3">
                <StatusGlyph kind="backlog" /> None
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

function SprintRow({ sprint: s, onOpen, action, menu }: { sprint: Sprint; onOpen: (id: string) => void; action: React.ReactNode; menu: React.ReactNode }) {
  const w = sprintWhen(s);
  const total = s.progress.points;
  const pct = total ? Math.round((s.progress.donePoints / total) * 100) : s.progress.percent;
  const range = dateRange(s.startDate, s.endDate);
  const whenCls = w.tone === "warn" ? "text-warn" : w.tone === "danger" ? "text-danger" : w.tone === "muted" ? "text-fg-3" : "text-fg-2";
  const isActive = s.state === "active";
  return (
    <div
      className={cn(
        SPRINT_GRID,
        "relative min-h-[60px] rounded-[10px] border border-transparent px-3 transition-colors hover:border-line hover:bg-surface",
        isActive && "border-line-2 bg-surface hover:border-line-2",
        "max-[760px]:mb-2 max-[760px]:grid-cols-[minmax(0,1fr)_auto] max-[760px]:gap-y-1 max-[760px]:border-line max-[760px]:bg-surface max-[760px]:pb-3",
      )}
    >
      <button
        type="button"
        onClick={() => onOpen(s.id)}
        aria-label={`${s.name}, ${range}, ${pct} percent. Open board`}
        className="flex min-w-0 items-center gap-2.5 self-stretch rounded-md py-2.5 text-left after:absolute after:inset-0 after:rounded-[10px] after:content-[''] max-[760px]:col-start-1"
      >
        <span className="flex size-4 flex-none items-center justify-center">
          {isActive ? <RefreshCcw size={14} className="text-accent-t" aria-hidden /> : <StatusGlyph kind={s.state === "planned" ? "backlog" : "done"} />}
        </span>
        <span className="flex min-w-0 flex-col gap-[3px]">
          <b className="truncate text-[13.5px] font-semibold">{s.name}</b>
          <span className="truncate text-[12px] text-fg-3">{s.goal || "No goal"}</span>
          <span className="hidden gap-2 font-mono text-[11.5px] max-[760px]:flex">
            <span className="text-fg-3">{range}</span>
            <span className={whenCls}>{w.text}</span>
          </span>
        </span>
      </button>
      <span className="font-mono text-[11.5px] text-fg-3 max-[1100px]:hidden">{range}</span>
      <span className={cn("font-mono text-[11.5px] max-[760px]:hidden", whenCls)}>{w.text}</span>
      <span className="flex min-w-0 items-center gap-2 max-[760px]:col-span-2 max-[760px]:row-start-2">
        <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-[3px] border border-line bg-raised">
          <span className="block h-full origin-left rounded-[3px] bg-ok transition-transform duration-700 ease-out" style={{ transform: `scaleX(${pct / 100})` }} />
        </span>
        <span className="w-[34px] text-right font-mono text-[11.5px] text-fg-2">{pct}%</span>
      </span>
      <span className="font-mono text-[11.5px] text-fg-3 max-[760px]:col-start-2 max-[760px]:row-start-1 max-[760px]:self-center">
        <b className="font-semibold text-fg">{s.progress.donePoints}</b>/{total}
      </span>
      <span className="relative z-[1] flex items-center justify-end gap-1 max-[760px]:col-span-2 max-[760px]:justify-start empty:max-[760px]:hidden">
        {action}
        {menu}
      </span>
    </div>
  );
}

function RowMenu({ sprint, onDialog }: { sprint: Sprint; onDialog: (d: DialogState) => void }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button variant="ghost" size="sm" icon aria-label={`More actions for ${sprint.name}`} className="max-[760px]:size-11">
          <MoreHorizontal size={14} aria-hidden />
        </Button>
      </MenuTrigger>
      <MenuContent align="end" width={180}>
        <MenuItem onSelect={() => onDialog({ kind: "edit", sprint })}>Edit sprint</MenuItem>
        {sprint.state === "planned" && (
          <MenuItem danger onSelect={() => onDialog({ kind: "delete", sprint })}>
            Delete sprint
          </MenuItem>
        )}
      </MenuContent>
    </Menu>
  );
}
