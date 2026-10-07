"use client";

import { ChevronDown, GripVertical, Pencil, Pin, PinOff, Trash2, Users } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Tooltip } from "@/components/ui/tooltip";
import { toast } from "@/components/ui/toast";
import { useSession } from "@/features/auth/session";
import { useProjects } from "@/features/workspace/queries";
import type { SavedView } from "@/lib/api/types";
import { routes, useRouteInfo } from "@/lib/routes";
import { cn } from "@/lib/utils/cn";
import { withRules } from "./filter-model";
import { ViewGlyph } from "./view-icons";
import { pinnedOf, useDeleteView, useReorderViews, useUpdateView, useViews } from "./views";

/*
 * Sidebar "Pinned views" (board 30): saved views pinned by the current user. Manage mode adds
 * drag handles (pointer, or Alt+↑/↓ on the handle), rename (also double-click) and delete with Undo.
 */

const rowBase =
  "relative flex h-[30px] min-w-0 flex-1 items-center gap-2.5 rounded-[7px] px-2 text-[13px] font-medium text-fg-2 transition-colors duration-[var(--dur-fast)] ease-out hover:bg-hover hover:text-fg max-[1023px]:h-[42px]";
const iconBtn =
  "flex size-[22px] flex-none items-center justify-center rounded-[5px] text-fg-3 transition-colors hover:bg-hover hover:text-fg max-[1023px]:size-10";

export function PinnedViews({ open, onToggle, onNavigate }: { open: boolean; onToggle: () => void; onNavigate?: () => void }) {
  return (
    <Suspense fallback={<Inner open={open} onToggle={onToggle} onNavigate={onNavigate} activeId={null} />}>
      <WithParams open={open} onToggle={onToggle} onNavigate={onNavigate} />
    </Suspense>
  );
}

function WithParams(props: { open: boolean; onToggle: () => void; onNavigate?: () => void }) {
  const search = useSearchParams();
  return <Inner {...props} activeId={search.get("view")} />;
}

function Inner({ open, onToggle, onNavigate, activeId }: { open: boolean; onToggle: () => void; onNavigate?: () => void; activeId: string | null }) {
  const route = useRouteInfo();
  const slug = route.workspace;
  const { user } = useSession();
  const { data: views, isPending, isError } = useViews(slug);
  const { data: projects = [] } = useProjects(slug);
  const update = useUpdateView(slug);
  const reorder = useReorderViews(slug);
  const remove = useDeleteView(slug);
  const [editing, setEditing] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
  const [drag, setDrag] = useState<{ id: string; dy: number; order: string[] } | null>(null);
  const [live, setLive] = useState("");
  const dragStart = useRef<{ y: number; from: number; step: number } | null>(null);
  const handles = useRef(new Map<string, HTMLButtonElement>());

  const pinned = pinnedOf(views ?? []);
  const order = drag?.order ?? pinned.map((v) => v.id);
  const rows = order.map((id) => pinned.find((v) => v.id === id)).filter((v): v is SavedView => Boolean(v));
  const others = (views ?? []).filter((v) => !v.pinned);

  const hrefOf = (v: SavedView) => {
    const p = projects.find((x) => x.id === v.projectId);
    return p ? `${routes.project(slug, p.key, v.layout)}${withRules("", v.filters, v.id)}` : null;
  };

  const commitRename = () => {
    const r = renaming;
    if (!r) return;
    setRenaming(null);
    const v = pinned.find((x) => x.id === r.id);
    const name = r.draft.trim().slice(0, 40);
    if (!v || !name || name === v.name) return;
    if ((views ?? []).some((x) => x.id !== v.id && x.ownerId === v.ownerId && x.name.toLowerCase() === name.toLowerCase())) {
      toast.error("A view with this name exists");
      return;
    }
    update.mutate({ id: v.id, patch: { name } });
    setLive(`Renamed to ${name}`);
  };

  const move = (v: SavedView, dir: -1 | 1) => {
    const ids = pinned.map((x) => x.id);
    const from = ids.indexOf(v.id);
    const to = from + dir;
    if (from < 0 || to < 0 || to >= ids.length) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]!);
    reorder.mutate(ids);
    setLive(`${v.name} moved to position ${to + 1} of ${ids.length}`);
    requestAnimationFrame(() => handles.current.get(v.id)?.focus());
  };

  const onHandleKey = (v: SavedView) => (e: KeyboardEvent) => {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    e.stopPropagation();
    move(v, e.key === "ArrowUp" ? -1 : 1);
  };

  const onDown = (v: SavedView) => (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.focus();
    e.currentTarget.setPointerCapture(e.pointerId);
    const row = e.currentTarget.closest<HTMLElement>("[data-pv-row]");
    const step = (row?.offsetHeight ?? 30) + 2;
    dragStart.current = { y: e.clientY, from: order.indexOf(v.id), step };
    setDrag({ id: v.id, dy: 0, order: pinned.map((x) => x.id) });
  };
  const onMove = (e: PointerEvent<HTMLButtonElement>) => {
    const s = dragStart.current;
    if (!s || !drag) return;
    const raw = e.clientY - s.y;
    const to = Math.max(0, Math.min(pinned.length - 1, s.from + Math.round(raw / s.step)));
    const next = pinned.map((x) => x.id).filter((id) => id !== drag.id);
    next.splice(to, 0, drag.id);
    setDrag({ id: drag.id, dy: raw - (to - s.from) * s.step, order: next });
  };
  const onUp = (e: PointerEvent<HTMLButtonElement>) => {
    if (!drag) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    const before = pinned.map((x) => x.id).join();
    const moved = drag.order.join() !== before;
    const pos = drag.order.indexOf(drag.id) + 1;
    if (moved) reorder.mutate(drag.order);
    dragStart.current = null;
    setDrag(null);
    if (moved) setLive(`Moved to position ${pos}`);
  };

  const del = (v: SavedView) => {
    if (v.ownerId === user?.id) {
      remove(v);
    } else {
      update.mutate({ id: v.id, patch: { pinned: false } });
      toast.info(`${v.name} unpinned`, { action: { label: "Undo", key: "Z", onClick: () => update.mutate({ id: v.id, patch: { pinned: true } }) } });
    }
  };

  return (
    <>
      <div className="mt-3.5 flex h-7 items-center gap-1 pl-2 pr-1 font-mono text-[11px] font-medium uppercase leading-none tracking-[0.07em] text-fg-3">
        <button type="button" onClick={onToggle} aria-expanded={open} className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left hover:text-fg-2">
          <ChevronDown size={10} strokeWidth={2} aria-hidden className={cn("flex-none transition-transform duration-[180ms] ease-out", !open && "-rotate-90")} />
          <span className="truncate">Pinned views</span>
        </button>
        {open && (views?.length ?? 0) > 0 &&
          (editing ? (
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setRenaming(null);
              }}
              className="h-5 rounded-[5px] bg-accent-s px-[7px] font-sans text-[11px] font-semibold normal-case tracking-normal text-accent-t max-[1023px]:h-9 max-[1023px]:px-3"
            >
              Done
            </button>
          ) : (
            <Tooltip content="Manage" side="right">
              <button type="button" aria-label="Manage pinned views" onClick={() => setEditing(true)} className={iconBtn}>
                <Pencil size={12} strokeWidth={1.6} aria-hidden />
              </button>
            </Tooltip>
          ))}
      </div>
      <div className="collapse-rows" data-open={open}>
        <div>
          <span className="sr-only" role="status" aria-live="polite">
            {live}
          </span>
          {isPending && !views ? (
            <div aria-busy="true" aria-label="Loading pinned views" className="flex flex-col gap-1.5 px-2 py-1.5">
              <span className="skeleton h-3 w-[70%]" />
              <span className="skeleton h-3 w-[55%]" />
            </div>
          ) : isError && !views ? (
            <p className="m-0 px-2 pb-2 pt-1.5 text-[12px] text-fg-3">Couldn’t load views.</p>
          ) : rows.length === 0 ? (
            <p className="m-0 px-2 pb-2 pt-1.5 text-[12px] text-fg-3">No pinned views</p>
          ) : (
            <ul role="list" className="m-0 list-none p-0">
              {rows.map((v, i) => {
                const href = hrefOf(v);
                const active = activeId === v.id;
                const isDragging = drag?.id === v.id;
                const mine = v.ownerId === user?.id;
                return (
                  <li
                    key={v.id}
                    data-pv-row
                    className={cn(
                      "relative mb-0.5 flex items-center gap-0.5 rounded-[7px] transition-[background-color,box-shadow] duration-[var(--dur-fast)]",
                      isDragging && "z-[5] bg-raised shadow-pop transition-none",
                    )}
                    style={isDragging ? { transform: `translateY(${Math.round(drag.dy)}px)` } : undefined}
                  >
                    {editing && (
                      <button
                        type="button"
                        ref={(el) => {
                          if (el) handles.current.set(v.id, el);
                          else handles.current.delete(v.id);
                        }}
                        aria-label={`Reorder ${v.name}, ${i + 1} of ${rows.length}`}
                        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                        title="Drag · Alt+↑↓"
                        onPointerDown={onDown(v)}
                        onPointerMove={onMove}
                        onPointerUp={onUp}
                        onPointerCancel={onUp}
                        onKeyDown={onHandleKey(v)}
                        className={cn("flex h-[30px] w-[18px] flex-none touch-none cursor-grab items-center justify-center rounded-[5px] text-fg-3 hover:bg-hover hover:text-fg max-[1023px]:h-[42px] max-[1023px]:w-7", isDragging && "cursor-grabbing text-accent-t")}
                      >
                        <GripVertical size={13} aria-hidden />
                      </button>
                    )}
                    {renaming?.id === v.id ? (
                      <input
                        autoFocus
                        aria-label="Rename view"
                        maxLength={40}
                        value={renaming.draft}
                        onChange={(e) => setRenaming({ id: v.id, draft: e.target.value })}
                        onBlur={commitRename}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            commitRename();
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            e.stopPropagation();
                            setRenaming(null);
                          }
                        }}
                        className="h-[30px] min-w-0 flex-1 rounded-[7px] border border-accent bg-bg px-2 text-[13px] font-medium text-fg shadow-[0_0_0_3px_var(--accent-s)] outline-none max-[1023px]:h-[42px]"
                      />
                    ) : href ? (
                      <Link
                        href={href}
                        aria-current={active ? "page" : undefined}
                        title={`${v.name} · ${v.visibility === "project" ? "Project" : "Only me"}`}
                        onClick={onNavigate}
                        onDoubleClick={(e) => {
                          if (!mine) return;
                          e.preventDefault();
                          setRenaming({ id: v.id, draft: v.name });
                        }}
                        className={cn(rowBase, active && "bg-hover text-fg")}
                      >
                        <span className="flex size-4 flex-none items-center justify-center">
                          <ViewGlyph icon={v.icon} />
                        </span>
                        <span className="min-w-0 flex-1 truncate">{v.name}</span>
                        {v.visibility === "project" && <Users size={12} strokeWidth={1.5} className="flex-none text-fg-3" aria-label="Project view" />}
                        {!editing && <span className="font-mono text-[11px] font-medium text-fg-3">{v.count}</span>}
                      </Link>
                    ) : (
                      <span className={cn(rowBase, "text-fg-3")}>
                        <ViewGlyph icon={v.icon} />
                        <span className="min-w-0 flex-1 truncate">{v.name}</span>
                      </span>
                    )}
                    {editing && renaming?.id !== v.id && (
                      <span className="flex flex-none gap-px">
                        {mine && (
                          <button type="button" aria-label={`Rename ${v.name}`} title="Rename" onClick={() => setRenaming({ id: v.id, draft: v.name })} className={iconBtn}>
                            <Pencil size={12} strokeWidth={1.6} aria-hidden />
                          </button>
                        )}
                        <button
                          type="button"
                          aria-label={mine ? `Delete ${v.name}` : `Unpin ${v.name}`}
                          title={mine ? "Delete" : "Unpin"}
                          onClick={() => del(v)}
                          className={cn(iconBtn, "hover:text-danger")}
                        >
                          {mine ? <Trash2 size={12} strokeWidth={1.6} aria-hidden /> : <PinOff size={12} strokeWidth={1.6} aria-hidden />}
                        </button>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {editing && others.length > 0 && (
            <div className="mb-1 mt-1.5 border-t border-line pt-1.5">
              <p className="m-0 px-2 pb-1 text-[11px] text-fg-3">Saved, not pinned</p>
              <ul role="list" className="m-0 list-none p-0">
                {others.map((v) => (
                  <li key={v.id} className="mb-0.5 flex items-center gap-0.5">
                    <span className={cn(rowBase, "hover:bg-transparent")}>
                      <span className="flex size-4 flex-none items-center justify-center">
                        <ViewGlyph icon={v.icon} />
                      </span>
                      <span className="min-w-0 flex-1 truncate">{v.name}</span>
                    </span>
                    <button type="button" aria-label={`Pin ${v.name}`} title="Pin" onClick={() => update.mutate({ id: v.id, patch: { pinned: true } })} className={iconBtn}>
                      <Pin size={12} strokeWidth={1.6} aria-hidden />
                    </button>
                    {v.ownerId === user?.id && (
                      <button type="button" aria-label={`Delete ${v.name}`} title="Delete" onClick={() => remove(v)} className={cn(iconBtn, "hover:text-danger")}>
                        <Trash2 size={12} strokeWidth={1.6} aria-hidden />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
