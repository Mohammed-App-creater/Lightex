"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, Clock, Lock, MessageSquare, RotateCcw, SquareCheck, Trash2, TriangleAlert, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Avatar, ProjectBadge } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/choice";
import { Skeleton } from "@/components/ui/feedback";
import { Modal } from "@/components/ui/modal";
import { Tabs } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toast";
import { useProjects } from "@/features/workspace/queries";
import { api } from "@/lib/api/endpoints";
import { errorMessage, isForbidden } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import type { TrashItem, TrashList, TrashRef } from "@/lib/api/types";
import { useCurrentWorkspace } from "@/lib/permissions/can";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils/cn";
import {
  agoLabel,
  countByKind,
  daysLeft,
  filterByTab,
  itemLabel,
  itemSub,
  leftLabel,
  pruneSelection,
  purgeWarning,
  refKey,
  refOf,
  restoredMessage,
  RETENTION_DAYS,
  selectionState,
  WARN_DAYS,
  type TrashTab,
} from "./lib";

const TAB_LABEL: Record<TrashTab, string> = { all: "All", task: "Tasks", comment: "Comments", project: "Projects" };
const TYPE_NAME: Record<Exclude<TrashTab, "all">, string> = { task: "tasks", comment: "comments", project: "projects" };
const GRID = "grid grid-cols-[44px_minmax(0,1fr)_150px_140px_76px_112px_116px] items-center";
const ease = [0.16, 1, 0.3, 1] as const;

/**
 * Workspace Trash (board 29). Lists what the user may restore (see handlers/trash.ts for the
 * permission mapping), with restore (+ undo) and delete-forever, single or bulk.
 */
export function TrashScreen() {
  const ws = useCurrentWorkspace()!;
  const qc = useQueryClient();
  const key = qk.trash(ws.slug);
  const q = useQuery({ queryKey: key, queryFn: () => api.trash.list(ws.slug), retry: (n, e) => !isForbidden(e) && n < 2 });
  const [tab, setTab] = useState<TrashTab>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selecting, setSelecting] = useState(false);
  const [confirm, setConfirm] = useState<TrashItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState("");

  const items = useMemo(() => q.data?.data ?? [], [q.data]);
  const kinds = q.data?.kinds ?? ["task", "comment"];
  const tabs: TrashTab[] = ["all", ...kinds];
  const activeTab: TrashTab = tabs.includes(tab) ? tab : "all";
  const counts = countByKind(items);
  const visible = filterByTab(items, activeTab);
  const sel = pruneSelection(selected, visible);
  const selItems = visible.filter((i) => sel.has(refKey(i)));
  const allState = selectionState(visible, sel);

  useEffect(() => {
    if (!sel.size) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !confirm && !(e.target as HTMLElement | null)?.closest?.("[role=dialog],[role=alertdialog],[role=menu]")) {
        setSelected(new Set());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sel.size, confirm]);

  const drop = (refs: TrashRef[]) => {
    const keys = new Set(refs.map(refKey));
    qc.setQueryData<TrashList>(key, (old) => (old ? { ...old, data: old.data.filter((i) => !keys.has(refKey(i))) } : old));
    setSelected((s) => new Set([...s].filter((k) => !keys.has(k))));
  };

  /** Everything a restore / undo can change outside the Trash. */
  const refreshAround = (list: TrashItem[]) => {
    void qc.invalidateQueries({ queryKey: qk.projects(ws.slug) });
    void qc.invalidateQueries({ queryKey: qk.directory(ws.slug) });
    void qc.invalidateQueries({ queryKey: qk.myTasks(ws.slug) });
    for (const it of list) {
      if (it.kind === "project") {
        void qc.invalidateQueries({ queryKey: qk.project(ws.slug, it.key ?? "") });
        void qc.invalidateQueries({ queryKey: qk.scope(it.id) });
      } else if (it.project) {
        void qc.invalidateQueries({ queryKey: qk.scope(it.project.id) });
        void qc.invalidateQueries({ queryKey: qk.project(ws.slug, it.project.key) });
      }
      if (it.kind === "comment") void qc.invalidateQueries({ queryKey: ["t"] });
      if (it.kind === "task" && it.key) void qc.invalidateQueries({ queryKey: qk.task(ws.slug, it.key) });
    }
  };

  const undoRestore = async (list: TrashItem[]) => {
    try {
      for (const it of list) {
        if (it.kind === "task") await api.tasks.remove(it.id);
        else if (it.kind === "comment") await api.comments.remove(it.id);
        else await api.projects.remove(it.id, it.key ?? "");
      }
      setLive("Undone");
    } catch (e) {
      toast.error("Couldn’t undo", { body: errorMessage(e) });
    } finally {
      void qc.invalidateQueries({ queryKey: key });
      refreshAround(list);
    }
  };

  const restore = async (list: TrashItem[]) => {
    if (!list.length) return;
    const prev = qc.getQueryData<TrashList>(key);
    const refs = list.map(refOf);
    drop(refs);
    try {
      await api.trash.restore(ws.slug, refs);
      const msg = restoredMessage(list);
      setLive(msg);
      toast.success(msg, { action: { label: "Undo", key: "Z", onClick: () => void undoRestore(list) } });
      refreshAround(list);
    } catch (e) {
      if (prev) qc.setQueryData(key, prev);
      toast.error(list.length > 1 ? "Couldn’t restore items" : "Couldn’t restore", { body: errorMessage(e) });
    } finally {
      void qc.invalidateQueries({ queryKey: key });
    }
  };

  const purge = async () => {
    if (!confirm || busy) return;
    setBusy(true);
    const refs = confirm.map(refOf);
    try {
      await api.trash.purge(ws.slug, refs);
      drop(refs);
      const msg = refs.length === 1 ? "Deleted forever" : `Deleted ${refs.length} items forever`;
      setLive(msg);
      toast.info(msg);
      setConfirm(null);
    } catch (e) {
      toast.error("Couldn’t delete", { body: errorMessage(e) });
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: key });
    }
  };

  const toggle = (it: TrashItem) =>
    setSelected((s) => {
      const n = new Set(s);
      const k = refKey(it);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const toggleAll = () => setSelected(allState === "all" ? new Set() : new Set(visible.map(refKey)));

  const denied = q.isError && isForbidden(q.error);
  const ready = q.isSuccess;
  const bulkOn = ready && sel.size > 0;

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-bg">
      {/* Top bar */}
      <div className="flex h-[52px] flex-none items-center gap-2.5 border-b border-line px-4 max-[760px]:pl-3 max-[760px]:pr-1.5">
        <h1 className="m-0 flex items-center gap-2 text-[15px] font-semibold">
          <Trash2 size={16} strokeWidth={1.5} aria-hidden className="text-fg-3" />
          Trash
          {ready && items.length > 0 && <span className="font-mono text-[11px] font-medium text-fg-3">{items.length}</span>}
        </h1>
        {ready && q.data.scope === "own" && (
          <span className="inline-flex h-[22px] items-center rounded-[6px] border border-line bg-raised px-2 font-mono text-[11.5px] font-medium text-fg-2">Only yours</span>
        )}
        <span className="flex-1" />
        {!denied && (
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap font-mono text-[11.5px] font-medium text-fg-3 max-[760px]:hidden">
            <Clock size={13} aria-hidden /> Auto-deleted after {q.data?.retentionDays ?? RETENTION_DAYS} days
          </span>
        )}
        {ready && items.length > 0 && (
          <button
            type="button"
            aria-pressed={selecting}
            onClick={() => {
              setSelecting((v) => !v);
              if (selecting) setSelected(new Set());
            }}
            className="hidden h-11 rounded-md px-2.5 text-[14px] font-medium text-accent-t hover:bg-accent-s max-[760px]:inline-flex max-[760px]:items-center"
          >
            {selecting ? "Done" : "Select"}
          </button>
        )}
      </div>

      {denied ? (
        <Denied />
      ) : q.isError ? (
        <StateBlock
          fill
          tone="danger"
          icon={<TriangleAlert size={18} aria-hidden />}
          title="Couldn’t load Trash"
          meta={errorMessage(q.error)}
          role="alert"
          action={
            <Button variant="secondary" size="sm" loading={q.isFetching} onClick={() => void q.refetch()}>
              Retry
            </Button>
          }
        />
      ) : (
        <>
          {/* Type filter: tabs (wide), chips (phone) */}
          <div className="flex-none border-b border-line px-6 max-[760px]:hidden">
            <Tabs
              idBase="trash"
              label="Filter by type"
              value={activeTab}
              onChange={(t) => setTab(t)}
              className="border-b-0 [&_[role=tab]]:h-[42px]"
              items={tabs.map((t) => ({ value: t, label: TAB_LABEL[t], count: ready ? counts[t] : undefined }))}
            />
          </div>
          <div role="group" aria-label="Filter by type" className="hidden flex-none gap-1.5 overflow-x-auto border-b border-line px-3 py-2.5 [scrollbar-width:none] max-[760px]:flex">
            {tabs.map((t) => (
              <button
                key={t}
                type="button"
                aria-pressed={activeTab === t}
                onClick={() => setTab(t)}
                className="inline-flex h-[34px] flex-none items-center gap-1.5 rounded-full border border-line-2 px-3 text-[13px] font-medium text-fg-2 transition-colors aria-pressed:border-transparent aria-pressed:bg-accent-s aria-pressed:text-accent-t"
              >
                {TAB_LABEL[t]}
                {ready && <span className="font-mono text-[11px] opacity-75">{counts[t]}</span>}
              </button>
            ))}
          </div>

          <div
            id="trash-panel-list"
            role="tabpanel"
            aria-labelledby={`trash-tab-${activeTab}`}
            aria-busy={q.isPending || undefined}
            className="relative min-h-0 flex-1 overflow-auto [scrollbar-color:var(--line-2)_transparent] [scrollbar-width:thin]"
          >
            {q.isPending ? (
              <LoadingRows />
            ) : visible.length === 0 ? (
              <StateBlock
                tone={items.length === 0 ? "ok" : undefined}
                icon={items.length === 0 ? <CircleCheck size={18} aria-hidden /> : <Trash2 size={18} aria-hidden />}
                title={items.length === 0 ? "Trash is empty" : `No deleted ${TYPE_NAME[activeTab as Exclude<TrashTab, "all">]}`}
                meta={items.length === 0 ? `Deleted items stay ${q.data.retentionDays} days` : `${items.length} in other types`}
                action={
                  items.length > 0 && activeTab !== "all" ? (
                    <Button variant="secondary" size="sm" onClick={() => setTab("all")}>
                      Show all
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <>
                <TrashTable items={visible} selected={sel} allState={allState} onToggle={toggle} onToggleAll={toggleAll} onRestore={(it) => void restore([it])} onDelete={(it) => setConfirm([it])} />
                <TrashCards
                  items={visible}
                  selected={sel}
                  selecting={selecting}
                  retention={q.data.retentionDays}
                  onToggle={toggle}
                  onRestore={(it) => void restore([it])}
                  onDelete={(it) => setConfirm([it])}
                />
              </>
            )}
          </div>

          <AnimatePresence>
            {bulkOn && (
              <motion.div
                key="bulk"
                role="toolbar"
                aria-label="Bulk actions"
                initial={{ opacity: 0, y: 24 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 24, transition: { duration: 0.15 } }}
                transition={{ duration: 0.25, ease }}
                className="absolute bottom-4 left-1/2 z-20 flex h-[46px] -translate-x-1/2 items-center gap-1 rounded-lg border border-line-2 bg-raised pl-2 pr-1.5 shadow-modal max-[760px]:bottom-6 max-[760px]:left-3 max-[760px]:right-3 max-[760px]:h-14 max-[760px]:translate-x-0 max-[760px]:justify-between"
              >
                <span className="mr-1 inline-flex h-8 items-center gap-2 rounded-md bg-accent-s pl-2.5 pr-1.5 text-[12.5px] font-semibold text-accent-t">
                  <b className="font-mono">{sel.size}</b>selected
                  <button type="button" aria-label="Clear selection" onClick={() => setSelected(new Set())} className="inline-flex size-[22px] items-center justify-center rounded-[5px] hover:bg-accent-s max-[760px]:size-9">
                    <X size={12} strokeWidth={1.8} aria-hidden />
                  </button>
                </span>
                <span className="flex gap-1">
                  <Button variant="secondary" size="sm" className="max-[760px]:h-11" onClick={() => void restore(selItems)}>
                    <RotateCcw size={13} aria-hidden /> Restore
                  </Button>
                  <Button variant="danger-ghost" size="sm" className="max-[760px]:h-11" onClick={() => setConfirm(selItems)}>
                    Delete forever
                  </Button>
                </span>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}

      <span className="sr-only" role="status" aria-live="polite">
        {live}
      </span>

      <Modal
        open={Boolean(confirm)}
        onOpenChange={(o) => !o && !busy && setConfirm(null)}
        role="alertdialog"
        width={420}
        title={confirm && confirm.length > 1 ? `Delete ${confirm.length} items forever?` : "Delete forever?"}
        footer={
          <>
            <Button variant="ghost" disabled={busy} onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button variant="danger" autoFocus loading={busy} onClick={() => void purge()}>
              Delete forever
            </Button>
          </>
        }
      >
        {confirm && (
          <>
            <div className="flex flex-col gap-1">
              {confirm.slice(0, 3).map((it) => (
                <div key={refKey(it)} className="flex h-9 min-w-0 items-center gap-2.5 rounded-md border border-line bg-bg px-2.5">
                  <KindIcon item={it} small />
                  <span className="min-w-0 flex-1 truncate font-medium">{it.kind === "comment" ? `“${it.title}”` : itemLabel(it)}</span>
                </div>
              ))}
              {confirm.length > 3 && <span className="pl-1 font-mono text-[11px] text-fg-3">+{confirm.length - 3} more</span>}
            </div>
            <div className="flex items-center gap-2.5 rounded-md border border-[color-mix(in_srgb,var(--danger)_35%,transparent)] bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] px-3 py-2 text-[12.5px]">
              <TriangleAlert size={14} aria-hidden className="flex-none text-danger" />
              {purgeWarning(confirm)}
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}

/* ───────────────────────── Pieces ───────────────────────── */

function KindIcon({ item, small }: { item: TrashItem; small?: boolean }) {
  if (item.kind === "project") return <ProjectBadge code={item.key ?? "?"} hue={item.hue ?? 255} size={small ? 18 : 24} />;
  const Icon = item.kind === "comment" ? MessageSquare : SquareCheck;
  if (small) return <Icon size={14} strokeWidth={1.5} aria-hidden className="flex-none text-fg-3" />;
  return (
    <span aria-hidden className="inline-flex size-[26px] flex-none items-center justify-center rounded-[7px] border border-line bg-raised text-fg-2">
      <Icon size={14} strokeWidth={1.5} />
    </span>
  );
}

function Title({ item, className }: { item: TrashItem; className?: string }) {
  return (
    <span className={cn("truncate font-medium", className)}>
      {item.kind === "task" && <span className="mr-2 font-mono text-[11.5px] font-medium text-fg-3">{item.key}</span>}
      {item.kind === "comment" ? `“${item.title}”` : item.title}
    </span>
  );
}

function Left({ item }: { item: TrashItem }) {
  const d = daysLeft(item.purgeAt);
  const warn = d <= WARN_DAYS;
  return (
    <span className={cn("inline-flex items-center gap-[5px] whitespace-nowrap font-mono text-[11.5px] font-medium", warn ? "text-warn" : "text-fg-3")}>
      {warn && <Clock size={12} strokeWidth={1.6} aria-hidden />}
      {leftLabel(d)}
    </span>
  );
}

function rowMotion(i: number) {
  return {
    initial: { opacity: 0, y: 4 },
    animate: { opacity: 1, y: 0, transition: { duration: 0.18, ease, delay: Math.min(i, 8) * 0.015 } },
    exit: { opacity: 0, x: -12, transition: { duration: 0.2, ease } },
  };
}

function TrashTable({
  items,
  selected,
  allState,
  onToggle,
  onToggleAll,
  onRestore,
  onDelete,
}: {
  items: TrashItem[];
  selected: Set<string>;
  allState: "none" | "some" | "all";
  onToggle: (it: TrashItem) => void;
  onToggleAll: () => void;
  onRestore: (it: TrashItem) => void;
  onDelete: (it: TrashItem) => void;
}) {
  return (
    <div role="table" aria-label="Deleted items" className="min-w-[760px] pb-[88px] max-[760px]:hidden">
      <div role="row" className={cn(GRID, "sticky top-0 z-[3] h-[34px] border-b border-line bg-bg font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-fg-3")}>
        <span role="columnheader" className="flex justify-center">
          <Checkbox aria-label="Select all" checked={allState === "all"} indeterminate={allState === "some"} onChange={onToggleAll} />
        </span>
        {["Item", "Project", "Deleted by", "When", "Removal"].map((h) => (
          <span key={h} role="columnheader" className="px-2">
            {h}
          </span>
        ))}
        <span role="columnheader">
          <span className="sr-only">Actions</span>
        </span>
      </div>
      <AnimatePresence initial={false}>
        {items.map((it, i) => {
          const on = selected.has(refKey(it));
          const label = itemLabel(it);
          return (
            <motion.div
              key={refKey(it)}
              role="row"
              {...rowMotion(i)}
              className={cn(
                GRID,
                "relative h-[52px] border-b border-line transition-colors duration-100 hover:bg-surface focus-within:bg-surface",
                on && "bg-accent-s before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-accent hover:bg-accent-s",
              )}
            >
              <span role="cell" className="flex justify-center">
                <Checkbox aria-label={`Select ${label}`} checked={on} onChange={() => onToggle(it)} />
              </span>
              <span role="cell" className="flex min-w-0 items-center gap-2 px-2">
                <KindIcon item={it} />
                <span className="flex min-w-0 flex-col gap-1">
                  <Title item={it} />
                  <span className="truncate font-mono text-[11px] font-medium text-fg-3">{itemSub(it)}</span>
                </span>
              </span>
              <span role="cell" className="flex min-w-0 items-center gap-2 px-2">
                {it.project ? (
                  <>
                    <ProjectBadge code={it.project.key} hue={it.project.hue} size={18} />
                    <span className="truncate text-[12.5px] text-fg-2">{it.project.name}</span>
                  </>
                ) : (
                  <span className="text-[12.5px] text-fg-3">Workspace</span>
                )}
              </span>
              <span role="cell" className="flex min-w-0 items-center gap-2 px-2">
                {it.deletedBy ? (
                  <>
                    <Avatar name={it.deletedBy.name} hue={it.deletedBy.hue} size={20} ring={false} decorative />
                    <span className="truncate text-[12.5px] text-fg-2">{it.deletedBy.name}</span>
                  </>
                ) : (
                  <span className="text-[12.5px] text-fg-3">Unknown</span>
                )}
              </span>
              <span role="cell" className="truncate px-2 text-[12.5px] text-fg-2">
                <time dateTime={it.deletedAt} title={new Date(it.deletedAt).toLocaleString()}>
                  {agoLabel(it.deletedAt)}
                </time>
              </span>
              <span role="cell" className="px-2">
                <Left item={it} />
              </span>
              <span role="cell" className="flex items-center justify-end gap-0.5 pr-3">
                <Button variant="ghost" size="sm" aria-label={`Restore ${label}`} onClick={() => onRestore(it)}>
                  <RotateCcw size={13} aria-hidden /> Restore
                </Button>
                <Button variant="ghost" icon size="sm" aria-label={`Delete forever: ${label}`} tooltip="Delete forever" className="hover:text-danger" onClick={() => onDelete(it)}>
                  <Trash2 size={14} aria-hidden />
                </Button>
              </span>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

function TrashCards({
  items,
  selected,
  selecting,
  retention,
  onToggle,
  onRestore,
  onDelete,
}: {
  items: TrashItem[];
  selected: Set<string>;
  selecting: boolean;
  retention: number;
  onToggle: (it: TrashItem) => void;
  onRestore: (it: TrashItem) => void;
  onDelete: (it: TrashItem) => void;
}) {
  return (
    <div role="list" aria-label="Deleted items" className="hidden flex-col gap-2 px-3 pb-[110px] pt-2.5 max-[760px]:flex">
      <div className="inline-flex items-center gap-1.5 px-0.5 pb-1 font-mono text-[11.5px] font-medium text-fg-3">
        <Clock size={13} aria-hidden /> Auto-deleted after {retention} days
      </div>
      <AnimatePresence initial={false}>
        {items.map((it, i) => {
          const on = selected.has(refKey(it));
          const label = itemLabel(it);
          return (
            <motion.div
              key={refKey(it)}
              role="listitem"
              {...rowMotion(i)}
              className={cn("flex flex-col gap-2.5 overflow-hidden rounded-lg border border-line bg-surface p-3", on && "border-accent bg-accent-s")}
            >
              <div className="flex min-w-0 items-start gap-2.5">
                {selecting && (
                  <span className="-ml-1 -mt-0.5 inline-flex size-7 flex-none items-center justify-center">
                    <Checkbox aria-label={`Select ${label}`} checked={on} onChange={() => onToggle(it)} />
                  </span>
                )}
                <KindIcon item={it} />
                <span className="flex min-w-0 flex-1 flex-col gap-[5px]">
                  <span className="line-clamp-2 text-[14px] font-medium leading-5">
                    {it.kind === "task" && <span className="mr-1.5 font-mono text-[12px] font-medium text-fg-3">{it.key}</span>}
                    {it.kind === "comment" ? `“${it.title}”` : it.title}
                  </span>
                  <span className="text-[12.5px] text-fg-3">
                    {it.deletedBy?.name ?? "Unknown"} · {agoLabel(it.deletedAt)}
                  </span>
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <Left item={it} />
                <span className="flex-1" />
                {!selecting && (
                  <>
                    <Button variant="secondary" size="sm" className="h-9" aria-label={`Restore ${label}`} onClick={() => onRestore(it)}>
                      Restore
                    </Button>
                    <Button variant="ghost" icon size="sm" aria-label={`Delete forever: ${label}`} className="size-11 hover:text-danger" onClick={() => onDelete(it)}>
                      <Trash2 size={16} aria-hidden />
                    </Button>
                  </>
                )}
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

function LoadingRows() {
  const rows = [
    [62, 34, 92, 64, 72],
    [48, 28, 70, 58, 80],
    [70, 40, 84, 70, 66],
    [55, 30, 64, 52, 76],
    [66, 26, 90, 60, 70],
    [44, 36, 76, 66, 80],
  ];
  return (
    <div role="status" aria-label="Loading Trash">
      <div className="min-w-[760px] max-[760px]:hidden">
        <div className={cn(GRID, "h-[34px] border-b border-line font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-fg-3")}>
          <span />
          {["Item", "Project", "Deleted by", "When", "Removal"].map((h) => (
            <span key={h} className="px-2">
              {h}
            </span>
          ))}
          <span />
        </div>
        {rows.map((r, i) => (
          <div key={i} className={cn(GRID, "h-[52px] border-b border-line")}>
            <span className="flex justify-center">
              <Skeleton className="size-4 rounded-xs" />
            </span>
            <span className="flex items-center gap-2 px-2">
              <Skeleton className="size-[26px] rounded-[7px]" />
              <span className="flex flex-1 flex-col gap-[7px]">
                <Skeleton style={{ width: `${r[0]}%` }} />
                <Skeleton className="h-[7px]" style={{ width: `${r[1]}%` }} />
              </span>
            </span>
            <span className="flex items-center gap-2 px-2">
              <Skeleton className="size-[18px]" />
              <Skeleton style={{ width: r[2] }} />
            </span>
            <span className="flex items-center gap-2 px-2">
              <Skeleton className="size-5 rounded-full" />
              <Skeleton style={{ width: r[3] }} />
            </span>
            <span className="px-2">
              <Skeleton className="w-11" />
            </span>
            <span className="px-2">
              <Skeleton style={{ width: r[4] }} />
            </span>
            <span className="flex justify-end pr-3">
              <Skeleton className="h-[26px] w-[62px] rounded-sm" />
            </span>
          </div>
        ))}
      </div>
      <div className="hidden flex-col gap-2 px-3 pt-2.5 max-[760px]:flex">
        {rows.slice(0, 4).map((r, i) => (
          <div key={i} className="flex flex-col gap-2.5 rounded-lg border border-line bg-surface p-3">
            <div className="flex items-start gap-2.5">
              <Skeleton className="size-[26px] rounded-[7px]" />
              <span className="flex flex-1 flex-col gap-2">
                <Skeleton style={{ width: `${r[0]}%` }} />
                <Skeleton className="h-[7px]" style={{ width: `${r[1]}%` }} />
              </span>
            </div>
            <div className="flex items-center">
              <Skeleton style={{ width: r[4] }} />
              <span className="flex-1" />
              <Skeleton className="h-9 w-[76px] rounded-md" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StateBlock({
  icon,
  title,
  meta,
  action,
  tone,
  fill,
  role,
}: {
  icon: ReactNode;
  title: string;
  meta?: ReactNode;
  action?: ReactNode;
  tone?: "danger" | "ok";
  fill?: boolean;
  role?: "alert" | "region";
}) {
  return (
    <div
      role={role}
      aria-label={role === "region" ? title : undefined}
      className={cn("flex flex-col items-center justify-center gap-2.5 px-5 py-14 text-center animate-[fade-in_200ms_var(--ease)]", fill && "flex-1")}
    >
      <span
        className={cn(
          "inline-flex size-11 items-center justify-center rounded-lg border border-line bg-raised text-fg-2",
          tone === "danger" && "text-danger",
          tone === "ok" && "text-ok",
        )}
      >
        {icon}
      </span>
      <h2 className="m-0 mt-1 text-[15px] font-semibold">{title}</h2>
      {meta && <span className="font-mono text-[11px] text-fg-3">{meta}</span>}
      {action && <div className="mt-1.5 flex gap-2">{action}</div>}
    </div>
  );
}

/** Viewer state (board 29 "No access to Trash"). */
function Denied() {
  const ws = useCurrentWorkspace()!;
  const projects = useProjects(ws.slug);
  const first = projects.data?.[0];
  return (
    <StateBlock
      fill
      role="region"
      icon={<Lock size={18} aria-hidden />}
      title="No access to Trash"
      meta="Viewers can’t restore items · members and admins only"
      action={
        <Button variant="secondary" size="sm" asChild>
          <Link href={first ? routes.project(ws.slug, first.key) : routes.home(ws.slug)}>{first ? "Back to project" : "Back home"}</Link>
        </Button>
      }
    />
  );
}

