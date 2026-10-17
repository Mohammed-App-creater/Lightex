"use client";

import { Search } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Avatar, UnassignedAvatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/choice";
import { StatusGlyph, type GlyphKind } from "@/components/ui/glyphs";
import { Sheet } from "@/components/ui/modal";
import { matchTask } from "@/features/goals/helpers";
import type { Task, User } from "@/lib/api/types";
import { useIsMobile } from "@/lib/hooks/use-media-query";
import { cn } from "@/lib/utils/cn";

/**
 * "Add tasks" picker (board 27 .ep-pick): search tasks without an epic, multi-select, add in one
 * bulk call. Anchored popover on desktop, bottom sheet on mobile. Esc closes; ⌘↵ adds.
 */
export function AddTasksPicker({
  epicName,
  pool,
  glyphOf,
  people,
  onAdd,
  onClose,
}: {
  epicName: string;
  pool: Task[];
  glyphOf: (statusId: string) => GlyphKind;
  people: Map<string, Pick<User, "name" | "hue">>;
  onAdd: (ids: string[]) => void;
  onClose: () => void;
}) {
  const isMobile = useIsMobile();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const ref = useRef<HTMLDivElement>(null);
  const items = useMemo(() => pool.filter((t) => matchTask(t, q)).sort((a, b) => b.priority - a.priority || a.number - b.number), [pool, q]);
  const selected = pool.filter((t) => sel.has(t.id)).map((t) => t.id);
  const add = () => selected.length && onAdd(selected);

  useEffect(() => {
    if (isMobile) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      if (ref.current && !ref.current.contains(target) && !target.closest?.("[data-add-tasks-trigger]")) onClose();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [isMobile, onClose]);

  const body: ReactNode = (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          e.preventDefault();
          onClose();
        }
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          add();
        }
      }}
    >
      <div className="flex h-11 flex-none items-center gap-2 border-b border-line px-3">
        <Search size={14} className="flex-none text-fg-3" aria-hidden />
        <input
          autoFocus
          type="search"
          value={q}
          maxLength={80}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search tasks without an epic…"
          aria-label="Search tasks"
          autoComplete="off"
          className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-3"
        />
      </div>
      <div role="listbox" aria-multiselectable="true" aria-label="Tasks without an epic" className="min-h-0 flex-1 overflow-y-auto p-1 min-[761px]:max-h-[300px]">
        {items.map((t) => {
          const on = sel.has(t.id);
          const a = t.assigneeId ? people.get(t.assigneeId) : undefined;
          return (
            <label
              key={t.id}
              role="option"
              aria-selected={on}
              className={cn("flex min-h-9 cursor-pointer items-center gap-2.5 rounded-sm px-2 text-[13px] hover:bg-hover max-[760px]:min-h-11", on && "bg-accent-s hover:bg-accent-s")}
            >
              <Checkbox
                checked={on}
                aria-label={`${t.key} ${t.title}`}
                onChange={() =>
                  setSel((s) => {
                    const n = new Set(s);
                    if (n.has(t.id)) n.delete(t.id);
                    else n.add(t.id);
                    return n;
                  })
                }
              />
              <StatusGlyph kind={glyphOf(t.statusId)} />
              <span className="flex-none font-mono text-[11.5px] font-medium text-fg-3">{t.key}</span>
              <span className="min-w-0 flex-1 truncate">{t.title}</span>
              {a ? <Avatar name={a.name} hue={a.hue} size={20} ring={false} decorative /> : <UnassignedAvatar size={20} />}
            </label>
          );
        })}
        {items.length === 0 && <p className="m-0 px-3 py-4 text-[12.5px] text-fg-3">{pool.length ? `No match for “${q.trim()}”` : "Every task has an epic"}</p>}
      </div>
      <div className="flex flex-none items-center gap-2 border-t border-line px-3 py-2.5">
        <span className="font-mono text-[11.5px] text-fg-3">{selected.length} selected</span>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={onClose} className="max-[760px]:h-11">
          Cancel
        </Button>
        <Button
          size="sm"
          variant="primary"
          kbd={isMobile ? undefined : "⌘↵"}
          disabledReason={selected.length ? undefined : "Select at least one task"}
          onClick={add}
          className="max-[760px]:h-11"
        >
          {selected.length ? `Add ${selected.length} ${selected.length === 1 ? "task" : "tasks"}` : "Add tasks"}
        </Button>
      </div>
    </div>
  );

  if (isMobile) {
    return (
      <Sheet open onOpenChange={(o) => !o && onClose()} title={`Add tasks to ${epicName}`} height="80dvh">
        {body}
      </Sheet>
    );
  }
  return (
    <motion.div
      ref={ref}
      role="dialog"
      aria-label={`Add tasks to ${epicName}`}
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      className="absolute right-4 top-[56px] z-30 flex max-h-[420px] w-[420px] flex-col overflow-hidden rounded-[10px] border border-line-2 bg-raised shadow-pop"
    >
      {body}
    </motion.div>
  );
}
