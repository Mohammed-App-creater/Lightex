"use client";

import * as Popover from "@radix-ui/react-popover";
import { useQuery } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { StatusGlyph } from "@/components/ui/glyphs";
import { useStatuses } from "@/features/projects/queries";
import { api } from "@/lib/api/endpoints";
import { qk } from "@/lib/api/query-keys";
import type { Task } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";

const SHOWN = 6;

/**
 * Task picker for a dependency group (board 39 .tx-pick): combobox over the project's tasks
 * (GET /projects/:id/tasks?q=), excluding the task itself, its parent/sub-tasks and existing
 * links. Shows 6; ↑↓ move, ↵ picks, Esc closes.
 */
export function DependencyPicker({
  label,
  projectId,
  exclude,
  onPick,
}: {
  /** "Blocked by" / "Blocks". */
  label: string;
  projectId: string;
  /** Task ids that can't be picked. */
  exclude: ReadonlySet<string>;
  onPick: (task: Task) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const { data: statuses = [] } = useStatuses(projectId);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(q.trim()), 150);
    return () => clearTimeout(id);
  }, [q]);

  const search = useQuery({
    queryKey: [...qk.scope(projectId), "dep-search", debounced],
    queryFn: () => api.tasks.list(projectId, { q: debounced || undefined, limit: 20 }),
    enabled: open,
    staleTime: 10_000,
  });
  const results = (search.data?.data ?? []).filter((t) => !exclude.has(t.id) && !t.deletedAt).slice(0, SHOWN);
  const current = Math.min(active, Math.max(0, results.length - 1));

  const pick = (t: Task | undefined) => {
    if (!t) return;
    onPick(t);
    setOpen(false);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!results.length) return;
      setActive((current + (e.key === "ArrowDown" ? 1 : -1) + results.length) % results.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(results[current]);
    }
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setQ("");
          setDebounced("");
          setActive(0);
        }
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={`Add ${label} task`}
          className="inline-flex h-[22px] min-w-[22px] flex-none items-center justify-center rounded-sm border border-dashed border-line-2 px-1.5 text-fg-3 hover:border-control hover:text-fg data-[state=open]:border-control data-[state=open]:text-fg max-[760px]:size-9"
        >
          <Plus size={12} aria-hidden />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          collisionPadding={12}
          role="dialog"
          aria-label={`Add ${label}`}
          className="z-[70] w-[320px] max-w-[calc(100vw-24px)] overflow-hidden rounded-[10px] border border-line-2 bg-raised shadow-pop outline-none data-[state=open]:animate-[menu-in_150ms_var(--ease)]"
        >
          <div className="flex items-center gap-2 border-b border-line px-2.5 text-fg-3">
            <Search size={13} aria-hidden className="flex-none" />
            <input
              autoFocus
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-autocomplete="list"
              aria-controls={listId}
              aria-activedescendant={results[current] ? `${listId}-${results[current]!.id}` : undefined}
              aria-label="Search tasks"
              placeholder="Search key or title"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setActive(0);
              }}
              onKeyDown={onKey}
              className="h-9 min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-3 max-[760px]:h-11 max-[760px]:text-[15px]"
            />
            <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-xs border border-b-2 border-line-2 bg-raised px-[5px] font-mono text-[11px] text-fg-2">↵</kbd>
          </div>
          <div id={listId} role="listbox" aria-label="Tasks" className="max-h-[220px] overflow-auto p-1">
            {search.isPending ? (
              <div aria-busy="true" className="flex flex-col gap-2 px-2 py-2.5">
                <span className="skeleton h-2.5 w-[70%]" />
                <span className="skeleton h-2.5 w-[55%]" />
              </div>
            ) : search.isError ? (
              <p className="m-0 px-2 py-3.5 text-center text-[12px] text-fg-3">
                Couldn’t search.{" "}
                <button type="button" className="text-accent-t hover:underline" onClick={() => void search.refetch()}>
                  Retry
                </button>
              </p>
            ) : results.length === 0 ? (
              <p className="m-0 px-2 py-3.5 text-center text-[12px] text-fg-3">No matching tasks</p>
            ) : (
              results.map((t, i) => {
                const s = statuses.find((x) => x.id === t.statusId);
                return (
                  <div
                    key={t.id}
                    id={`${listId}-${t.id}`}
                    role="option"
                    aria-selected={i === current}
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(t)}
                    className={cn("flex h-[30px] cursor-pointer items-center gap-2.5 rounded-sm px-2 text-[13px] font-medium max-[760px]:h-11", i === current && "bg-hover")}
                  >
                    <StatusGlyph kind={s?.glyph ?? "todo"} color={s?.color ?? undefined} />
                    <span className="w-[52px] flex-none font-mono text-[11px] text-fg-3">{t.key}</span>
                    <span className="min-w-0 flex-1 truncate">{t.title}</span>
                  </div>
                );
              })
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
