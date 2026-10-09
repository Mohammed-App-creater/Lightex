"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowUp, ArrowUpRight, Ban, ChevronRight, Columns3, Copy, Filter, Layers, MoreHorizontal, Plus, Tag, Trash2, UserRound, X, MoveRight } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { Avatar, UnassignedAvatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/choice";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/feedback";
import { PriorityIcon, StatusGlyph, priorityMeta, type PriorityLevel } from "@/components/ui/glyphs";
import { Kbd } from "@/components/ui/kbd";
import {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import { shell } from "@/components/shell/shell-state";
import { TopBarActions } from "@/components/shell/top-bar";
import { useMe } from "@/features/auth/session";
import { epicSwatch } from "@/features/epics/epic-model";
import { applyFilters, completeRules } from "@/features/filters/filter-model";
import { ProjectFilterBar } from "@/features/filters/project-filter-bar";
import { useFilterOptions, useUrlFilters } from "@/features/filters/use-filters";
import { useEpics, useLabels, useMilestones, useProjectMembers, useSprints, useStatuses } from "@/features/projects/queries";
import { blockedTitle } from "@/features/dependencies/blocked-badge";
import { displayValue } from "@/features/fields/field-lib";
import { useCustomFields } from "@/features/fields/queries";
import { useCreateTask, useDeleteTask, useUpdateTask } from "@/features/tasks/mutations";
import { rememberOrigin, triggerSpark } from "@/features/tasks/task-origin";
import { useSparking } from "@/features/tasks/task-bits";
import { api } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/errors";
import { patchTasks, restore, snapshotTasks } from "@/lib/api/optimistic";
import { qk } from "@/lib/api/query-keys";
import type { Label, Status, Task, TaskPatch, User } from "@/lib/api/types";
import { useIsMobile } from "@/lib/hooks/use-media-query";
import { useHotkeys } from "@/lib/hooks/use-hotkeys";
import { can, canEditTask, useCurrentProject, useCurrentWorkspace } from "@/lib/permissions/can";
import { pushUrl, routes, withTaskParam } from "@/lib/routes";
import { cn } from "@/lib/utils/cn";
import { addDaysISO, dueTone, shortDate, todayISO } from "@/lib/utils/dates";
import { COLUMNS, cfColumn, clampWidth, groupTasks, isCfColumn, labelSlots, sortTasks, type ColumnDef, type ColumnId, type Ctx, type Group, type GroupBy, type SortState } from "./list-model";

type Row = { kind: "group"; group: Group } | { kind: "task"; task: Task; groupId: string } | { kind: "empty"; group: Group };

const PREFS_KEY = (id: string) => `lightex-list-${id}`;

/** `cf`: custom-field columns the user turned on (board 39: hidden by default). */
type Prefs = { widths: Record<ColumnId, number>; hidden: ColumnId[]; groupBy: GroupBy; cf: string[] };
const widthOf = (widths: Record<ColumnId, number>, c: ColumnDef) => widths[c.id] ?? c.width;

function loadPrefs(projectId: string): Prefs {
  const base: Prefs = { widths: Object.fromEntries(COLUMNS.map((c) => [c.id, c.width])) as Record<ColumnId, number>, hidden: [], groupBy: "status", cf: [] };
  try {
    const raw = typeof window !== "undefined" ? localStorage.getItem(PREFS_KEY(projectId)) : null;
    return raw ? { ...base, ...(JSON.parse(raw) as Partial<Prefs>) } : base;
  } catch {
    return base;
  }
}

export function ListScreen() {
  const project = useCurrentProject()!;
  const ws = useCurrentWorkspace()!;
  const me = useMe();
  const pathname = usePathname();
  const search = useSearchParams();
  // Field · operator · value filters live in the URL (?f=…); a legacy ?epic= link becomes "Epic is …" (board 30).
  const { rules, setRules, viewId } = useUrlFilters();
  const filterOpts = useFilterOptions(project.id);
  const mobile = useIsMobile();
  const qc = useQueryClient();

  const tasksQ = useQuery({ queryKey: qk.taskList(project.id), queryFn: () => api.tasks.list(project.id, { limit: 500 }), select: (r) => r.data.filter((t) => !t.deletedAt) });
  const { data: statuses = [] } = useStatuses(project.id);
  const { data: members = [] } = useProjectMembers(project.id);
  const { data: labels = [] } = useLabels(project.id);
  const { data: sprints = [] } = useSprints(project.id);
  const { data: milestones = [] } = useMilestones(project.id);
  const { data: epics = [] } = useEpics(project.id);
  const { data: fields = [] } = useCustomFields(project.id);

  const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs(project.id));
  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY(project.id), JSON.stringify(prefs));
    } catch {
      /* private mode */
    }
  }, [prefs, project.id]);
  const [sort, setSort] = useState<SortState>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const perms = project.my_permissions;
  const canCreate = can("task.create", perms);
  const canBulk = can("task.edit_any", perms) || can("task.move", perms) || can("task.delete", perms);
  const update = useUpdateTask();

  const ctx: Ctx = useMemo(() => {
    const t = todayISO();
    return {
      statuses,
      users: new Map(members.map((m) => [m.userId, m.user])),
      sprints,
      milestones,
      epics,
      labels: new Map(labels.map((l) => [l.id, l])),
      meId: me.id,
      today: t,
      weekEnd: addDaysISO(t, 7),
      fields,
    };
  }, [statuses, members, sprints, milestones, epics, labels, me.id, fields]);

  const visibleCols: ColumnDef[] = [
    ...COLUMNS.filter((c) => c.id === "title" || !prefs.hidden.includes(c.id)),
    ...fields.filter((f) => prefs.cf.includes(f.id)).map(cfColumn),
  ];
  const totalCols = COLUMNS.length + fields.length;
  const selW = canBulk ? 36 : 14;
  const template = `${selW}px ${visibleCols.map((c) => `${widthOf(prefs.widths, c)}px`).join(" ")} minmax(0,1fr)`;
  const minWidth = selW + visibleCols.reduce((a, c) => a + widthOf(prefs.widths, c), 0) + 120;

  const filtered = useMemo(() => applyFilters(tasksQ.data ?? [], rules, filterOpts.ctx), [tasksQ.data, rules, filterOpts.ctx]);
  const groups = useMemo(() => groupTasks(filtered, prefs.groupBy, ctx).map((g) => ({ ...g, tasks: sortTasks(g.tasks, sort, ctx) })), [filtered, prefs.groupBy, ctx, sort]);
  const rows = useMemo(() => {
    const out: Row[] = [];
    for (const g of groups) {
      out.push({ kind: "group", group: g });
      if (collapsed.has(`${prefs.groupBy}:${g.id}`)) continue;
      if (!g.tasks.length) out.push({ kind: "empty", group: g });
      for (const t of g.tasks) out.push({ kind: "task", task: t, groupId: g.id });
    }
    return out;
  }, [groups, collapsed, prefs.groupBy]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.kind === "empty" ? 40 : 36),
    overscan: 12,
  });

  const openTask = useCallback(
    (t: Task, el?: Element | null) => {
      if (el) rememberOrigin(t.key, el);
      pushUrl(withTaskParam(pathname, search.toString(), t.key));
    },
    [pathname, search],
  );

  const patch = useCallback(
    (t: Task, p: TaskPatch) => {
      if (p.statusId) {
        const s = statuses.find((x) => x.id === p.statusId);
        if (s?.glyph === "done" && t.statusId !== s.id) triggerSpark(t.id);
      }
      update.mutate({ task: t, patch: p, statuses });
    },
    [update, statuses],
  );

  const addToGroup = (g: Group) => {
    const d: Parameters<typeof shell.openCreateTask>[0] = { projectId: project.id };
    if (prefs.groupBy === "status") d.statusId = g.id;
    if (prefs.groupBy === "sprint") d.sprintId = g.id === "none" ? null : g.id;
    shell.openCreateTask(d);
  };

  /* bulk */
  const bulk = useMutation({
    mutationFn: (body: { ids: string[]; patch?: TaskPatch; delete?: boolean }) => api.tasks.bulk(project.id, body),
    onMutate: async (body) => {
      const snap = await snapshotTasks(qc, project.id);
      patchTasks(qc, (t) => (body.ids.includes(t.id) ? (body.delete ? null : ({ ...t, ...body.patch, labelIds: body.patch?.labelIds ? [...new Set([...t.labelIds, ...body.patch.labelIds])] : t.labelIds } as Task)) : t), project.id);
      return { snap };
    },
    onError: (e, _b, ctx2) => {
      if (ctx2) restore(qc, ctx2.snap);
      toast.error("Couldn’t update those tasks", { body: `${errorMessage(e)} Reverted.` });
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.scope(project.id) }),
  });
  const selectedIds = [...selected];
  const n = selectedIds.length;
  const plural = (k: number) => (k === 1 ? "1 task" : `${k} tasks`);
  const bulkDelete = () => {
    const ids = selectedIds;
    bulk.mutate(
      { ids, delete: true },
      {
        onSuccess: () => {
          setSelected(new Set());
          toast({
            tone: "info",
            title: `Deleted ${plural(ids.length)}`,
            action: {
              label: "Undo",
              key: "Z",
              onClick: async () => {
                await api.tasks.bulk(project.id, { ids, restore: true }).catch((e) => toast.error("Couldn’t restore", { body: errorMessage(e) }));
                void qc.invalidateQueries({ queryKey: qk.scope(project.id) });
              },
            },
          });
        },
      },
    );
  };

  useHotkeys({
    escape: () => setSelected(new Set()),
  });

  const sortBy = (col: ColumnId) => setSort((s) => (s?.col === col ? { col, dir: s.dir === "asc" ? "desc" : "asc" } : { col, dir: "asc" }));

  /* ───── toolbar ───── */
  const toolbar = (
    <ProjectFilterBar
      slug={ws.slug}
      project={project}
      layout="list"
      rules={rules}
      setRules={setRules}
      viewId={viewId}
      opts={filterOpts}
      count={tasksQ.isPending ? null : filtered.length}
      className="px-4 max-[760px]:px-3"
      trailing={
        <>
      <Menu>
        <MenuTrigger asChild>
          <Button size="sm" variant="ghost">
            <Layers size={13} aria-hidden />
            <span className="text-fg-3">Group</span>
            {({ status: "Status", epic: "Epic", sprint: "Sprint", assignee: "Assignee" } as const)[prefs.groupBy]}
          </Button>
        </MenuTrigger>
        <MenuContent align="end" width={180}>
          <MenuRadioGroup value={prefs.groupBy} onValueChange={(v) => setPrefs((p) => ({ ...p, groupBy: v as GroupBy }))}>
            <MenuRadioItem value="status">Status</MenuRadioItem>
            <MenuRadioItem value="epic">Epic</MenuRadioItem>
            <MenuRadioItem value="sprint">Sprint</MenuRadioItem>
            <MenuRadioItem value="assignee">Assignee</MenuRadioItem>
          </MenuRadioGroup>
        </MenuContent>
      </Menu>
      <Menu>
        <MenuTrigger asChild>
          <Button size="sm" variant="ghost" className="max-[760px]:hidden">
            <Columns3 size={13} aria-hidden /> Columns
            <span className="font-mono text-[11px] text-fg-3">
              {visibleCols.length}/{totalCols}
            </span>
          </Button>
        </MenuTrigger>
        <MenuContent align="end" width={196}>
          {COLUMNS.filter((c) => c.id !== "title").map((c) => (
            <MenuCheckboxItem
              key={c.id}
              checked={!prefs.hidden.includes(c.id)}
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={(on) => setPrefs((p) => ({ ...p, hidden: on ? p.hidden.filter((x) => x !== c.id) : [...p.hidden, c.id] }))}
            >
              {c.label}
            </MenuCheckboxItem>
          ))}
          {fields.length > 0 && (
            <>
              <MenuSeparator />
              <MenuLabel>Custom fields</MenuLabel>
              {fields.map((f) => (
                <MenuCheckboxItem
                  key={f.id}
                  checked={prefs.cf.includes(f.id)}
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={(on) => setPrefs((p) => ({ ...p, cf: on ? [...p.cf.filter((x) => x !== f.id), f.id] : p.cf.filter((x) => x !== f.id) }))}
                >
                  {f.name}
                </MenuCheckboxItem>
              ))}
            </>
          )}
          <MenuSeparator />
          <MenuItem onSelect={() => setPrefs((p) => ({ ...p, widths: Object.fromEntries(COLUMNS.map((c) => [c.id, c.width])) as Record<ColumnId, number> }))}>Reset widths</MenuItem>
        </MenuContent>
      </Menu>
        </>
      }
    />
  );

  const createButton = canCreate && (
    <TopBarActions>
      <Button size="sm" variant="primary" kbd="C" onClick={() => shell.openCreateTask({ projectId: project.id, statusId: prefs.groupBy === "status" ? statuses.find((s) => s.glyph === "todo")?.id : undefined })}>
        <Plus size={14} aria-hidden /> New task
      </Button>
    </TopBarActions>
  );

  if (tasksQ.isPending) return (
    <div className="flex min-h-0 flex-1 flex-col">
      {toolbar}
      <ListSkeleton template={template} selW={selW} cols={visibleCols.map((c) => c.id)} />
    </div>
  );
  if (tasksQ.isError) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {toolbar}
        <div className="p-5">
          <ErrorState title="Couldn’t load tasks" body={`${errorMessage(tasksQ.error)}`} refId={(tasksQ.error as { ref?: string }).ref} onRetry={() => void tasksQ.refetch()} />
        </div>
      </div>
    );
  }

  if (mobile) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {createButton}
        {toolbar}
        <MobileList groups={groups} groupBy={prefs.groupBy} setGroupBy={(g) => setPrefs((p) => ({ ...p, groupBy: g }))} ctx={ctx} onOpen={openTask} />
      </div>
    );
  }

  const noMatch = filtered.length === 0 && completeRules(rules).length > 0;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" onKeyDown={(e) => e.key === "Escape" && selected.size && setSelected(new Set())}>
      {createButton}
      {toolbar}
      {noMatch ? (
        <div className="flex flex-1 items-start justify-center py-16">
          <EmptyState align="center" icon={<Filter size={20} aria-hidden />} title="No tasks match" body="Nothing in this project matches the current filters." actions={<Button kbd="⇧F" onClick={() => setRules([])}>Clear filters</Button>} />
        </div>
      ) : (tasksQ.data ?? []).length === 0 ? (
        <div className="flex flex-1 items-start justify-center py-16">
          <EmptyState
            align="center"
            icon={<Plus size={20} aria-hidden />}
            title="No tasks yet"
            body="Create the first task for this project."
            actions={canCreate ? <Button variant="primary" kbd="C" onClick={() => shell.openCreateTask({ projectId: project.id })}>New task</Button> : undefined}
          />
        </div>
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
          <div role="table" aria-label="Tasks" aria-rowcount={filtered.length + 1} className={cn("pb-[72px]", selected.size > 0 && "selecting")} style={{ minWidth }}>
            <HeaderRow template={template} cols={visibleCols} widths={prefs.widths} sort={sort} onSort={sortBy} onResize={(id, w) => setPrefs((p) => ({ ...p, widths: { ...p.widths, [id]: clampWidth(id, w) } }))} />
            <div role="rowgroup" className="relative" style={{ height: virtual.getTotalSize() }}>
              {virtual.getVirtualItems().map((vi) => {
                const r = rows[vi.index]!;
                const style: CSSProperties = { position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${vi.start}px)`, height: vi.size };
                if (r.kind === "group") {
                  const key = `${prefs.groupBy}:${r.group.id}`;
                  const ids = r.group.tasks.map((t) => t.id);
                  const sel = ids.filter((id) => selected.has(id)).length;
                  return (
                    <GroupHeader
                      key={`g-${r.group.id}`}
                      style={style}
                      group={r.group}
                      groupBy={prefs.groupBy}
                      selW={selW}
                      open={!collapsed.has(key)}
                      onToggle={() => setCollapsed((s) => {
                        const nx = new Set(s);
                        if (nx.has(key)) nx.delete(key);
                        else nx.add(key);
                        return nx;
                      })}
                      canBulk={canBulk}
                      checked={ids.length > 0 && sel === ids.length}
                      mixed={sel > 0 && sel < ids.length}
                      onCheck={() => setSelected((s) => {
                        const nx = new Set(s);
                        if (sel === ids.length) ids.forEach((id) => nx.delete(id));
                        else ids.forEach((id) => nx.add(id));
                        return nx;
                      })}
                      canAdd={canCreate && (prefs.groupBy === "status" || prefs.groupBy === "sprint")}
                      onAdd={() => addToGroup(r.group)}
                    />
                  );
                }
                if (r.kind === "empty") {
                  return (
                    <div key={`e-${r.group.id}`} style={style} className="flex items-center gap-3 border-b border-line text-[12.5px] text-fg-3">
                      <span style={{ width: selW }} />
                      <span className="pl-2.5">No tasks</span>
                      {canCreate && (prefs.groupBy === "status" || prefs.groupBy === "sprint") && (
                        <button type="button" onClick={() => addToGroup(r.group)} className="text-accent-t hover:underline">
                          + Add task
                        </button>
                      )}
                    </div>
                  );
                }
                return (
                  <TaskRow
                    key={r.task.id}
                    style={style}
                    task={r.task}
                    template={template}
                    cols={visibleCols.map((c) => c.id)}
                    widths={prefs.widths}
                    ctx={ctx}
                    selected={selected.has(r.task.id)}
                    canBulk={canBulk}
                    canEdit={canEditTask(r.task, perms, me.id)}
                    canStatus={canEditTask(r.task, perms, me.id) || can("task.move", perms)}
                    canAssign={canEditTask(r.task, perms, me.id) && can("task.assign", perms)}
                    canDelete={can("task.delete", perms)}
                    canCreate={canCreate}
                    onSelect={(on) => setSelected((s) => {
                      const nx = new Set(s);
                      if (on) nx.add(r.task.id);
                      else nx.delete(r.task.id);
                      return nx;
                    })}
                    onPatch={patch}
                    onOpen={openTask}
                    wsSlug={ws.slug}
                  />
                );
              })}
            </div>
          </div>
        </div>
      )}
      <BulkBar
        count={n}
        members={members.map((m) => m.user)}
        statuses={statuses}
        labels={labels}
        canAssign={can("task.assign", perms)}
        // Mirrors the server's patch rule: a status-only change needs task.move (or edit rights); any other field needs edit rights.
        canMove={can("task.move", perms) || can("task.edit_any", perms)}
        canLabel={can("task.edit_any", perms)}
        canDelete={can("task.delete", perms)}
        onClear={() => setSelected(new Set())}
        onAssign={(u) => bulk.mutate({ ids: selectedIds, patch: { assigneeId: u?.id ?? null } }, { onSuccess: () => toast.success(`Assigned ${plural(n)} to ${u?.name.split(" ")[0] ?? "nobody"}`) })}
        onMove={(s) => {
          if (s.glyph === "done") selectedIds.forEach(triggerSpark);
          bulk.mutate({ ids: selectedIds, patch: { statusId: s.id } }, { onSuccess: () => toast.success(`Moved ${plural(n)} to ${s.name}`) });
        }}
        onLabel={(l) => bulk.mutate({ ids: selectedIds, patch: { labelIds: [l.id] } }, { onSuccess: () => toast.success(`Labeled ${plural(n)} ${l.name}`) })}
        onDelete={bulkDelete}
      />
    </div>
  );
}

/* ───────── header ───────── */

function HeaderRow({
  template,
  cols,
  widths,
  sort,
  onSort,
  onResize,
}: {
  template: string;
  cols: ColumnDef[];
  widths: Record<ColumnId, number>;
  sort: SortState;
  onSort: (c: ColumnId) => void;
  onResize: (c: ColumnId, w: number) => void;
}) {
  return (
    <div role="row" className="sticky top-0 z-[5] grid h-[34px] items-center border-b border-line bg-bg text-fg-3" style={{ gridTemplateColumns: template }}>
      <span role="columnheader" aria-label="Select" />
      {cols.map((c) => {
        const active = sort?.col === c.id;
        return (
          <div key={c.id} role="columnheader" aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : "none"} className="group/h relative px-1">
            <button
              type="button"
              aria-label={`Sort by ${c.label}`}
              onClick={() => onSort(c.id)}
              className={cn("inline-flex h-[26px] items-center gap-1 rounded-[5px] px-1.5 text-[11.5px] font-medium hover:bg-hover hover:text-fg", active && "text-fg")}
            >
              {c.label}
              <ArrowUp
                size={11}
                strokeWidth={1.8}
                aria-hidden
                className={cn("opacity-0 transition-[opacity,transform] duration-150 group-hover/h:opacity-50", active && "text-accent-t opacity-100 group-hover/h:opacity-100", active && sort!.dir === "desc" && "rotate-180")}
              />
            </button>
            <Resizer col={c} width={widthOf(widths, c)} onResize={onResize} />
          </div>
        );
      })}
      <span />
    </div>
  );
}

function Resizer({ col, width, onResize }: { col: ColumnDef; width: number; onResize: (c: ColumnId, w: number) => void }) {
  const start = useRef<{ x: number; w: number } | null>(null);
  const [on, setOn] = useState(false);
  const { id, label } = col;
  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label} column`}
      aria-valuenow={width}
      aria-valuemin={col.min}
      aria-valuemax={480}
      tabIndex={0}
      onPointerDown={(e: PointerEvent<HTMLSpanElement>) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, w: width };
        setOn(true);
      }}
      onPointerMove={(e) => start.current && onResize(id, start.current.w + e.clientX - start.current.x)}
      onPointerUp={() => {
        start.current = null;
        setOn(false);
      }}
      onKeyDown={(e: KeyboardEvent) => {
        const step = e.shiftKey ? 32 : 8;
        if (e.key === "ArrowRight") onResize(id, width + step);
        else if (e.key === "ArrowLeft") onResize(id, width - step);
        else if (e.key === "Home") onResize(id, col.width);
        else return;
        e.preventDefault();
      }}
      className={cn(
        "absolute -right-[5px] bottom-[5px] top-[5px] z-[2] w-2.5 cursor-col-resize touch-none outline-none",
        "after:absolute after:bottom-0 after:left-1/2 after:top-0 after:w-px after:bg-line after:content-[''] group-hover/h:after:bg-line-2",
        "hover:after:w-0.5 hover:after:bg-accent focus-visible:after:w-0.5 focus-visible:after:bg-accent",
        on && "after:w-0.5 after:bg-accent",
      )}
    />
  );
}

/* ───────── group header ───────── */

function GroupHeader({
  style,
  group,
  groupBy,
  selW,
  open,
  onToggle,
  canBulk,
  checked,
  mixed,
  onCheck,
  canAdd,
  onAdd,
}: {
  style: CSSProperties;
  group: Group;
  groupBy: GroupBy;
  selW: number;
  open: boolean;
  onToggle: () => void;
  canBulk: boolean;
  checked: boolean;
  mixed: boolean;
  onCheck: () => void;
  canAdd: boolean;
  onAdd: () => void;
}) {
  let glyph: ReactNode = null;
  if (groupBy === "status" && group.glyph) glyph = <StatusGlyph kind={group.glyph} />;
  else if (groupBy === "epic") glyph = <span aria-hidden className="size-2.5 rounded-[3px]" style={{ background: group.hue !== undefined ? epicSwatch(group.hue) : "var(--line-2)" }} />;
  else if (groupBy === "assignee") glyph = group.user ? <Avatar name={group.user.name} hue={group.user.hue} size={20} decorative /> : <UnassignedAvatar size={20} />;
  return (
    <div role="row" style={style} className="group/gh z-[3] flex items-center gap-1.5 border-b border-line bg-surface pr-2.5">
      <span className="flex items-center justify-center" style={{ width: selW }}>
        {canBulk && group.tasks.length > 0 && (
          <Checkbox
            checked={checked}
            indeterminate={mixed}
            onChange={onCheck}
            aria-label={`Select all in ${group.name}`}
            className={cn("opacity-0 focus-visible:opacity-100 group-hover/gh:opacity-100 [.selecting_&]:opacity-100", (checked || mixed) && "opacity-100")}
          />
        )}
      </span>
      <button type="button" aria-expanded={open} onClick={onToggle} className="-ml-1 flex h-7 items-center gap-2 rounded-sm pl-1 pr-2 text-[13px] font-semibold hover:bg-hover">
        <ChevronRight size={12} aria-hidden className={cn("text-fg-3 transition-transform duration-200", open && "rotate-90")} />
        {glyph}
        {group.name}
        <span className="font-mono text-[11px] font-medium text-fg-3">{group.tasks.length}</span>
      </button>
      {group.meta && <span className="font-mono text-[11px] text-fg-3">{group.meta}</span>}
      <span className="flex-1" />
      {canAdd && (
        <button type="button" aria-label={`Add task to ${group.name}`} onClick={onAdd} className="flex size-[26px] items-center justify-center rounded-sm text-fg-3 hover:bg-hover hover:text-fg">
          <Plus size={13} aria-hidden />
        </button>
      )}
    </div>
  );
}

/* ───────── task row ───────── */

const cellBtn =
  "flex h-7 min-w-0 flex-1 items-center gap-[7px] overflow-hidden whitespace-nowrap rounded-[5px] px-1.5 text-left text-[13px] text-fg transition-[background-color,box-shadow] duration-[var(--dur-fast)] hover:bg-hover hover:shadow-[inset_0_0_0_1px_var(--line-2)] data-[state=open]:bg-accent-s data-[state=open]:shadow-[inset_0_0_0_1px_var(--accent)]";
const cellStatic = "flex h-7 min-w-0 flex-1 items-center gap-[7px] overflow-hidden whitespace-nowrap px-1.5 text-[13px]";

const TaskRow = memo(function TaskRow({
  style,
  task,
  template,
  cols,
  widths,
  ctx,
  selected,
  canBulk,
  canEdit,
  canStatus,
  canAssign,
  canDelete,
  canCreate,
  onSelect,
  onPatch,
  onOpen,
  wsSlug,
}: {
  style: CSSProperties;
  task: Task;
  template: string;
  cols: ColumnId[];
  widths: Record<ColumnId, number>;
  ctx: Ctx;
  selected: boolean;
  canBulk: boolean;
  canEdit: boolean;
  canStatus: boolean;
  canAssign: boolean;
  canDelete: boolean;
  canCreate: boolean;
  onSelect: (on: boolean) => void;
  onPatch: (t: Task, p: TaskPatch) => void;
  onOpen: (t: Task, el?: Element | null) => void;
  wsSlug: string;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const del = useDeleteTask();
  const create = useCreateTask();
  const spark = useSparking(task.id);
  const [editingTitle, setEditingTitle] = useState(false);
  const [draft, setDraft] = useState(task.title);
  const status = ctx.statuses.find((s) => s.id === task.statusId);
  const done = status?.category === "done";
  const assignee = task.assigneeId ? ctx.users.get(task.assigneeId) : undefined;
  const sprint = ctx.sprints.find((s) => s.id === task.sprintId);
  const ms = ctx.milestones.find((m) => m.id === task.milestoneId);
  const taskLabels = task.labelIds.map((id) => ctx.labels.get(id)).filter((l): l is Label => Boolean(l));
  const tone = dueTone(task.dueDate, done);

  const cell = (id: ColumnId): ReactNode => {
    if (isCfColumn(id)) {
      const f = ctx.fields?.find((x) => `cf.${x.id}` === id);
      const shown = f ? displayValue(f, task.customFields?.[f.id], ctx.users, ctx.today) : null;
      return (
        <span className={cellStatic} title={shown?.text}>
          {shown?.color && <span aria-hidden className="size-[7px] flex-none rounded-full" style={{ background: shown.color }} />}
          {shown?.user && <Avatar name={shown.user.name} hue={shown.user.hue} size={18} decorative />}
          <span className={cn("truncate", (!shown || shown.muted) && "text-fg-3", f?.type === "number" && "font-mono text-[12px] tabular-nums")}>{shown?.text ?? "—"}</span>
        </span>
      );
    }
    switch (id) {
      case "key":
        return <span className={cn(cellStatic, "font-mono text-[12px] font-medium text-fg-3")}>{task.key}</span>;
      case "title":
        if (editingTitle) {
          return (
            <input
              autoFocus
              aria-label="Task title"
              value={draft}
              maxLength={200}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => {
                setEditingTitle(false);
                const v = draft.trim();
                if (v && v !== task.title) onPatch(task, { title: v });
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setDraft(task.title);
                  setEditingTitle(false);
                }
              }}
              className="h-7 min-w-0 flex-1 rounded-[5px] border border-accent bg-surface px-1.5 text-[13px] font-medium shadow-[0_0_0_3px_var(--accent-s)] outline-none"
            />
          );
        }
        return canEdit ? (
          <button type="button" aria-label={`Title: ${task.title}${task.isBlocked ? ", blocked" : ""}`} title={task.title} onClick={() => { setDraft(task.title); setEditingTitle(true); }} className={cellBtn}>
            {task.isBlocked && <BlockedGlyph task={task} />}
            <span className={cn("truncate font-medium", done && status?.glyph === "done" && "text-fg-3 line-through")}>{task.title}</span>
          </button>
        ) : (
          <span className={cellStatic} title={task.title}>
            {task.isBlocked && <BlockedGlyph task={task} />}
            <span className="truncate font-medium">{task.title}</span>
          </span>
        );
      case "status":
        return (
          <CellMenu enabled={canStatus} label={`Status: ${status?.name ?? ""}`} display={<><StatusGlyph kind={status?.glyph ?? "todo"} spark={spark} /><span className="truncate">{status?.name}</span></>}>
            <MenuRadioGroup value={task.statusId} onValueChange={(v) => onPatch(task, { statusId: v })}>
              {ctx.statuses.map((s, i) => (
                <MenuRadioItem key={s.id} value={s.id} icon={<StatusGlyph kind={s.glyph} />} meta={String(i + 1)}>
                  {s.name}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </CellMenu>
        );
      case "pri":
        return (
          <CellMenu
            enabled={canEdit}
            label={`Priority: ${priorityMeta[task.priority].label}`}
            display={<><PriorityIcon level={task.priority} bars />{task.priority === 0 ? <span className="text-fg-3">—</span> : <span className="truncate">{priorityMeta[task.priority].label}</span>}</>}
          >
            <MenuRadioGroup value={String(task.priority)} onValueChange={(v) => onPatch(task, { priority: Number(v) as PriorityLevel })}>
              {([4, 3, 2, 1, 0] as PriorityLevel[]).map((p) => (
                <MenuRadioItem key={p} value={String(p)} icon={<PriorityIcon level={p} bars />}>
                  {priorityMeta[p].label}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </CellMenu>
        );
      case "asg":
        return (
          <CellMenu
            enabled={canAssign}
            label={`Assignee: ${assignee?.name ?? "Unassigned"}`}
            display={assignee ? <><Avatar name={assignee.name} hue={assignee.hue} size={20} decorative /><span className="truncate">{assignee.name.split(" ")[0]}</span></> : <span className="text-fg-3">Unassigned</span>}
          >
            <MenuRadioGroup value={task.assigneeId ?? ""} onValueChange={(v) => onPatch(task, { assigneeId: v || null })}>
              {[...ctx.users.values()].map((u) => (
                <MenuRadioItem key={u.id} value={u.id} icon={<Avatar name={u.name} hue={u.hue} size={20} decorative />}>
                  {u.name}
                </MenuRadioItem>
              ))}
              <MenuRadioItem value="" icon={<UnassignedAvatar size={20} />}>
                Unassigned
              </MenuRadioItem>
            </MenuRadioGroup>
          </CellMenu>
        );
      case "sprint":
        return (
          <CellMenu enabled={canEdit} label={`Sprint: ${sprint?.name ?? "none"}`} display={sprint ? <span className="truncate">{sprint.name}</span> : <span className="text-fg-3">—</span>}>
            <MenuRadioGroup value={task.sprintId ?? ""} onValueChange={(v) => onPatch(task, { sprintId: v || null })}>
              {ctx.sprints.filter((s) => s.state !== "completed" || s.id === task.sprintId).map((s) => (
                <MenuRadioItem key={s.id} value={s.id} meta={s.state === "active" ? "Active" : undefined}>
                  {s.name}
                </MenuRadioItem>
              ))}
              <MenuRadioItem value="">No sprint</MenuRadioItem>
            </MenuRadioGroup>
          </CellMenu>
        );
      case "ms":
        return (
          <CellMenu enabled={canEdit} label={`Milestone: ${ms?.name ?? "none"}`} display={ms ? <span className="truncate">{ms.name}</span> : <span className="text-fg-3">—</span>}>
            <MenuRadioGroup value={task.milestoneId ?? ""} onValueChange={(v) => onPatch(task, { milestoneId: v || null })}>
              {ctx.milestones.map((m) => (
                <MenuRadioItem key={m.id} value={m.id} meta={shortDate(m.dueDate)}>
                  {m.name}
                </MenuRadioItem>
              ))}
              <MenuRadioItem value="">No milestone</MenuRadioItem>
            </MenuRadioGroup>
          </CellMenu>
        );
      case "due": {
        const sprintEnd = ctx.sprints.find((s) => s.state === "active")?.endDate;
        return (
          <CellMenu
            enabled={canEdit}
            label={`Due: ${task.dueDate ? shortDate(task.dueDate) : "none"}`}
            display={task.dueDate ? <span className={cn("font-mono text-[12px] font-medium", tone === "late" && "text-danger", tone === "soon" && "text-warn", tone === "muted" && "text-fg-3")}>{shortDate(task.dueDate)}</span> : <span className="text-fg-3">—</span>}
          >
            <MenuItem meta={shortDate(ctx.today)} onSelect={() => onPatch(task, { dueDate: ctx.today })}>Today</MenuItem>
            <MenuItem meta={shortDate(addDaysISO(ctx.today, 1))} onSelect={() => onPatch(task, { dueDate: addDaysISO(ctx.today, 1) })}>Tomorrow</MenuItem>
            <MenuItem meta={shortDate(addDaysISO(ctx.today, 7))} onSelect={() => onPatch(task, { dueDate: addDaysISO(ctx.today, 7) })}>Next week</MenuItem>
            {sprintEnd && <MenuItem meta={shortDate(sprintEnd)} onSelect={() => onPatch(task, { dueDate: sprintEnd })}>Sprint end</MenuItem>}
            {ctx.milestones.filter((m) => !m.completedAt).slice(0, 3).map((m) => (
              <MenuItem key={m.id} meta={shortDate(m.dueDate)} onSelect={() => onPatch(task, { dueDate: m.dueDate })}>{m.name}</MenuItem>
            ))}
            {task.dueDate && (
              <>
                <MenuSeparator />
                <MenuItem onSelect={() => onPatch(task, { dueDate: null })}>No due date</MenuItem>
              </>
            )}
          </CellMenu>
        );
      }
      case "labels": {
        const slots = labelSlots(widths.labels);
        return (
          <CellMenu
            enabled={canEdit}
            label={`Labels: ${taskLabels.map((l) => l.name).join(", ") || "none"}`}
            display={
              taskLabels.length ? (
                <>
                  {taskLabels.slice(0, slots).map((l) => (
                    <span key={l.id} className="inline-flex h-5 flex-none items-center gap-[5px] rounded-[5px] border border-line bg-raised px-[7px] text-[11.5px] font-medium text-fg-2">
                      <span aria-hidden className="size-[7px] rounded-full" style={{ background: l.color }} />
                      {l.name}
                    </span>
                  ))}
                  {taskLabels.length > slots && <span className="font-mono text-[11px] font-medium text-fg-3">+{taskLabels.length - slots}</span>}
                </>
              ) : (
                <span className="text-fg-3">—</span>
              )
            }
          >
            {[...ctx.labels.values()].map((l) => (
              <MenuCheckboxItem
                key={l.id}
                checked={task.labelIds.includes(l.id)}
                onSelect={(e) => e.preventDefault()}
                onCheckedChange={(c) => onPatch(task, { labelIds: c ? [...task.labelIds, l.id] : task.labelIds.filter((x) => x !== l.id) })}
                icon={<span className="size-[7px] rounded-full" style={{ background: l.color }} />}
              >
                {l.name}
              </MenuCheckboxItem>
            ))}
          </CellMenu>
        );
      }
    }
  };

  return (
    <div
      ref={rowRef}
      role="row"
      aria-selected={canBulk ? selected : undefined}
      style={{ ...style, gridTemplateColumns: template }}
      className={cn(
        "group/row grid items-center border-b border-line transition-colors duration-100 hover:bg-surface focus-within:bg-surface",
        selected && "bg-accent-s before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-accent before:content-[''] hover:bg-accent-s",
      )}
    >
      <span role="cell" className="flex items-center justify-center">
        {canBulk && (
          <Checkbox
            checked={selected}
            onChange={(e) => onSelect(e.target.checked)}
            aria-label={`Select ${task.key}`}
            className={cn("opacity-0 focus-visible:opacity-100 group-hover/row:opacity-100 [.selecting_&]:opacity-100", selected && "opacity-100")}
          />
        )}
      </span>
      {cols.map((c) => (
        <div key={c} role="cell" className="flex min-w-0 px-1">
          {cell(c)}
        </div>
      ))}
      <div role="cell" className="relative h-full">
        <div className="absolute right-2 top-1/2 flex -translate-y-1/2 gap-px rounded-md border border-line-2 bg-raised p-0.5 opacity-0 transition-opacity duration-[var(--dur-fast)] focus-within:opacity-100 group-hover/row:opacity-100 has-[[data-state=open]]:opacity-100">
          <IconBtn label={`Open ${task.key}`} onClick={() => onOpen(task, rowRef.current)}>
            <ArrowUpRight size={13} aria-hidden />
          </IconBtn>
          <IconBtn
            label={`Copy ${task.key}`}
            onClick={() => {
              void navigator.clipboard?.writeText(task.key).catch(() => undefined);
              toast.success(`Copied ${task.key}`);
            }}
          >
            <Copy size={12} aria-hidden />
          </IconBtn>
          <Menu>
            <MenuTrigger asChild>
              <button type="button" aria-label={`More actions for ${task.key}`} className="flex size-6 items-center justify-center rounded-sm text-fg-2 hover:bg-hover hover:text-fg">
                <MoreHorizontal size={13} aria-hidden />
              </button>
            </MenuTrigger>
            <MenuContent align="end" width={200}>
              <MenuItem
                onSelect={() => {
                  void navigator.clipboard?.writeText(`${window.location.origin}${routes.task(wsSlug, task.key)}`).catch(() => undefined);
                  toast.success(`Link to ${task.key} copied`);
                }}
              >
                Copy link
              </MenuItem>
              <MenuItem onSelect={() => window.open(routes.task(wsSlug, task.key), "_self")}>Open full page</MenuItem>
              {canCreate && (
                <MenuItem
                  disabled={create.isPending}
                  onSelect={() => {
                    if (create.isPending) return;
                    // A completed sprint can't take new tasks (the server answers 422), so the copy goes to the backlog.
                    const sprintId = sprint?.state === "completed" ? null : task.sprintId;
                    create.mutate(
                      {
                        projectId: task.projectId,
                        body: { title: `${task.title} (copy)`.slice(0, 200), statusId: task.statusId, priority: task.priority, epicId: task.epicId, sprintId, milestoneId: task.milestoneId, dueDate: task.dueDate, labelIds: task.labelIds, parentId: task.parentId },
                      },
                      {
                        onSuccess: (t) => toast({ tone: "spark", title: `Duplicated as ${t.key}` }),
                        onError: (e) => toast.error("Couldn’t duplicate", { body: errorMessage(e) }),
                      },
                    );
                  }}
                >
                  Duplicate
                </MenuItem>
              )}
              {canDelete && (
                <>
                  <MenuSeparator />
                  <MenuItem danger onSelect={() => del.mutate(task)}>
                    Delete
                  </MenuItem>
                </>
              )}
            </MenuContent>
          </Menu>
        </div>
      </div>
    </div>
  );
});

function IconBtn({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} onClick={onClick} className="flex size-6 items-center justify-center rounded-sm text-fg-2 hover:bg-hover hover:text-fg">
      {children}
    </button>
  );
}

function CellMenu({ enabled, label, display, children }: { enabled: boolean; label: string; display: ReactNode; children: ReactNode }) {
  if (!enabled) return <span className={cellStatic} aria-label={label}>{display}</span>;
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" aria-label={label} className={cellBtn}>
          {display}
        </button>
      </MenuTrigger>
      <MenuContent align="start" className="min-w-[196px] max-w-[240px]">
        {children}
      </MenuContent>
    </Menu>
  );
}

/* ───────── bulk bar ───────── */

function BulkBar({
  count,
  members,
  statuses,
  labels,
  canAssign,
  canMove,
  canLabel,
  canDelete,
  onClear,
  onAssign,
  onMove,
  onLabel,
  onDelete,
}: {
  count: number;
  members: User[];
  statuses: Status[];
  labels: Label[];
  canAssign: boolean;
  canMove: boolean;
  canLabel: boolean;
  canDelete: boolean;
  onClear: () => void;
  onAssign: (u: User | null) => void;
  onMove: (s: Status) => void;
  onLabel: (l: Label) => void;
  onDelete: () => void;
}) {
  const on = count > 0;
  return (
    <div
      role="toolbar"
      aria-label={`${count} tasks selected`}
      aria-hidden={!on}
      className={cn(
        "absolute bottom-4 left-1/2 z-20 flex h-11 items-center gap-0.5 rounded-lg border border-line-2 bg-raised pl-2 pr-1.5 shadow-modal",
        "transition-[transform,opacity] duration-[260ms] [transition-timing-function:var(--spring)]",
        on ? "visible -translate-x-1/2 translate-y-0 opacity-100" : "invisible -translate-x-1/2 translate-y-[calc(100%+28px)] opacity-0",
      )}
      onKeyDown={(e) => e.key === "Escape" && onClear()}
    >
      <span className="flex h-[30px] items-center gap-2 rounded-[7px] bg-accent-s pl-2.5 pr-1.5 text-[12.5px] font-semibold text-accent-t">
        <b className="font-mono">{count}</b> selected
        <button type="button" aria-label="Clear selection" onClick={onClear} className="flex size-5 items-center justify-center rounded-xs hover:bg-accent-s">
          <X size={11} aria-hidden />
        </button>
      </span>
      {canAssign && (
        <Menu>
          <MenuTrigger asChild>
            <Button size="sm" variant="ghost" tabIndex={on ? 0 : -1}>
              <UserRound size={13} aria-hidden /> Assign
            </Button>
          </MenuTrigger>
          <MenuContent side="top" width={200}>
            {members.map((u) => (
              <MenuItem key={u.id} icon={<Avatar name={u.name} hue={u.hue} size={20} decorative />} onSelect={() => onAssign(u)}>
                {u.name}
              </MenuItem>
            ))}
            <MenuItem icon={<UnassignedAvatar size={20} />} onSelect={() => onAssign(null)}>
              Unassigned
            </MenuItem>
          </MenuContent>
        </Menu>
      )}
      {canMove && (
        <Menu>
          <MenuTrigger asChild>
            <Button size="sm" variant="ghost" tabIndex={on ? 0 : -1}>
              <MoveRight size={13} aria-hidden /> Move
            </Button>
          </MenuTrigger>
          <MenuContent side="top" width={200}>
            {statuses.map((s) => (
              <MenuItem key={s.id} icon={<StatusGlyph kind={s.glyph} />} onSelect={() => onMove(s)}>
                {s.name}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
      )}
      {canLabel && (
        <Menu>
          <MenuTrigger asChild>
            <Button size="sm" variant="ghost" tabIndex={on ? 0 : -1}>
              <Tag size={13} aria-hidden /> Label
            </Button>
          </MenuTrigger>
          <MenuContent side="top" width={190}>
            {labels.map((l) => (
              <MenuItem key={l.id} icon={<span className="size-[7px] rounded-full" style={{ background: l.color }} />} onSelect={() => onLabel(l)}>
                {l.name}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
      )}
      {canDelete && (
        <>
          <span aria-hidden className="mx-1 h-5 w-px bg-line" />
          <Button size="sm" variant="danger-ghost" tabIndex={on ? 0 : -1} onClick={onDelete}>
            <Trash2 size={13} aria-hidden /> Delete
          </Button>
        </>
      )}
      <Kbd className="ml-1.5 mr-1">Esc</Kbd>
    </div>
  );
}

/* ───────── mobile ───────── */

function MobileList({ groups, groupBy, setGroupBy, ctx, onOpen }: { groups: Group[]; groupBy: GroupBy; setGroupBy: (g: GroupBy) => void; ctx: Ctx; onOpen: (t: Task, el?: Element | null) => void }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(["Done", "Canceled", "Backlog"]));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="group" aria-label="Group by" className="flex gap-1.5 overflow-x-auto border-b border-line px-3 py-2.5">
        {(["status", "epic", "sprint", "assignee"] as GroupBy[]).map((g) => (
          <button
            key={g}
            type="button"
            aria-pressed={groupBy === g}
            onClick={() => setGroupBy(g)}
            className="h-8 flex-none rounded-full border border-line-2 px-3 text-[13px] font-medium capitalize text-fg-2 aria-pressed:border-transparent aria-pressed:bg-accent-s aria-pressed:text-accent-t"
          >
            {g}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto pb-24">
        {groups.map((g) => {
          const open = !collapsed.has(g.name);
          return (
            <section key={g.id} aria-label={g.name}>
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setCollapsed((s) => {
                  const nx = new Set(s);
                  if (nx.has(g.name)) nx.delete(g.name);
                  else nx.add(g.name);
                  return nx;
                })}
                className="sticky top-0 z-[2] flex h-11 w-full items-center gap-[9px] border-b border-line bg-surface px-4 text-[14px] font-semibold"
              >
                <ChevronRight size={12} aria-hidden className={cn("text-fg-3 transition-transform", open && "rotate-90")} />
                {g.glyph && <StatusGlyph kind={g.glyph} />}
                <span className="truncate">{g.name}</span>
                <span className="font-mono text-[11px] text-fg-3">{g.tasks.length}</span>
              </button>
              {open &&
                (g.tasks.length ? (
                  <ul className="m-0 flex list-none flex-col gap-2 px-3 py-2.5">
                    {g.tasks.map((t) => {
                      const s = ctx.statuses.find((x) => x.id === t.statusId);
                      const a = t.assigneeId ? ctx.users.get(t.assigneeId) : undefined;
                      const tone = dueTone(t.dueDate, s?.category === "done");
                      return (
                        <li key={t.id}>
                          <button type="button" onClick={(e) => onOpen(t, e.currentTarget)} aria-label={`${t.key} ${t.title}`} className="flex w-full flex-col gap-[7px] rounded-[10px] border border-line bg-surface px-3 py-[11px] text-left active:scale-[.99]">
                            <span className="flex items-center gap-2">
                              <StatusGlyph kind={s?.glyph ?? "todo"} />
                              <span className="font-mono text-[12px] text-fg-3">{t.key}</span>
                              <span className="flex-1" />
                              {t.dueDate && <span className={cn("font-mono text-[12px]", tone === "late" ? "text-danger" : tone === "soon" ? "text-warn" : "text-fg-3")}>{shortDate(t.dueDate)}</span>}
                            </span>
                            <span className="line-clamp-2 text-[14px] font-medium leading-5">{t.title}</span>
                            <span className="flex items-center gap-2">
                              <PriorityIcon level={t.priority} bars />
                              <span className="min-w-0 flex-1 truncate text-[12px] text-fg-3">{ctx.epics.find((e) => e.id === t.epicId)?.name ?? ctx.sprints.find((x) => x.id === t.sprintId)?.name ?? "No sprint"}</span>
                              {a ? <Avatar name={a.name} hue={a.hue} size={20} decorative /> : <UnassignedAvatar size={20} />}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="m-0 px-4 py-3.5 text-[13px] text-fg-3">No tasks</p>
                ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function ListSkeleton({ template, selW, cols }: { template: string; selW: number; cols: ColumnId[] }) {
  const presets: Record<ColumnId, number[]> = { key: [72, 60, 78, 66], title: [82, 60, 92, 54, 74], status: [64, 52, 72], pri: [56, 70], asg: [60, 48, 66], sprint: [70, 58], ms: [74, 60], due: [62, 74], labels: [54, 70, 42] };
  return (
    <div aria-busy="true" aria-label="Loading tasks" className="overflow-hidden">
      {[4, 3, 3].map((count, g) => (
        <div key={g}>
          <div className="flex h-9 items-center gap-2 border-b border-line bg-surface" style={{ paddingLeft: selW + 4 }}>
            <Skeleton className="size-3.5 rounded-full" />
            <Skeleton className="h-2.5" style={{ width: [84, 56, 70][g] }} />
          </div>
          {Array.from({ length: count }, (_, i) => (
            <div key={i} className="grid h-9 items-center border-b border-line" style={{ gridTemplateColumns: template }}>
              <span />
              {cols.map((c, ci) => (
                <span key={c} className="flex items-center gap-2 px-2.5">
                  {(c === "status" || c === "asg") && <Skeleton className="size-3.5 flex-none rounded-full" />}
                  <Skeleton className="h-[9px]" style={{ width: `${(presets[c] ?? CF_PRESET)[(i + ci) % (presets[c] ?? CF_PRESET).length]}%` }} />
                </span>
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

const CF_PRESET = [58, 44, 66];

/** Board 39: "Blocked" glyph next to a list title (tooltip lists the open blockers). */
function BlockedGlyph({ task }: { task: Task }) {
  return (
    <span title={blockedTitle(task, true)} className="inline-flex flex-none text-danger">
      <Ban size={12} strokeWidth={2} aria-label="Blocked" />
    </span>
  );
}
