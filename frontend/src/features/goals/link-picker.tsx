"use client";

import { motion } from "motion/react";
import { Search } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/choice";
import { StatusGlyph } from "@/components/ui/glyphs";
import { Kbd } from "@/components/ui/kbd";
import type { Objective, Status, Task } from "@/lib/api/types";
import { matchTask } from "./helpers";

/**
 * Inline "Link tasks" picker (board 16 .g-pick): search by key/title, checkbox list, toggling
 * links/unlinks immediately. Esc or Done closes; focus returns to the opener.
 */
export function LinkPicker({
  objective,
  tasks,
  statuses,
  onToggle,
  onClose,
}: {
  objective: Objective;
  tasks: Task[];
  statuses: Status[];
  onToggle: (taskId: string, link: boolean) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const glyphOf = useMemo(() => new Map(statuses.map((s) => [s.id, s.glyph])), [statuses]);
  const shown = useMemo(() => tasks.filter((t) => matchTask(t, q)).sort((a, b) => a.number - b.number), [tasks, q]);
  const linked = new Set(objective.taskIds);

  // Click outside closes.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (ref.current && !ref.current.contains(target) && !(target as HTMLElement).closest?.("[data-link-trigger]")) onClose();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [onClose]);

  return (
    <motion.div
      ref={ref}
      role="dialog"
      aria-labelledby={titleId}
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          e.preventDefault();
          onClose();
        }
      }}
      className="w-full max-w-[440px] overflow-hidden rounded-[10px] border border-line-2 bg-raised shadow-pop"
    >
      <span id={titleId} className="sr-only">
        Link tasks to {objective.title}
      </span>
      <div className="border-b border-line p-2">
        <label className="relative block">
          <span className="sr-only">Search tasks</span>
          <Search size={14} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-3" />
          <input
            autoFocus
            value={q}
            maxLength={60}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search tasks…"
            className="h-8 w-full rounded-[7px] border border-line-2 bg-bg pl-[30px] pr-2.5 text-[13px] text-fg placeholder:text-fg-3 transition-[border-color,box-shadow] duration-[var(--dur-fast)] focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-s)] focus:outline-none max-[760px]:h-11"
          />
        </label>
      </div>
      <div className="max-h-[206px] overflow-y-auto p-1">
        {shown.length === 0 && <p className="m-0 px-2 py-2.5 text-[13px] text-fg-3">No tasks match</p>}
        {shown.map((t) => (
          <label
            key={t.id}
            className="flex min-h-8 cursor-pointer items-center gap-[9px] rounded-sm px-2 text-[13px] hover:bg-hover max-[760px]:min-h-11"
          >
            <Checkbox checked={linked.has(t.id)} onChange={(e) => onToggle(t.id, e.target.checked)} />
            <StatusGlyph kind={glyphOf.get(t.statusId) ?? "todo"} />
            <span className="flex-none font-mono text-[11.5px] font-medium text-fg-3">{t.key}</span>
            <span className="min-w-0 flex-1 truncate">{t.title}</span>
          </label>
        ))}
      </div>
      <div className="flex items-center gap-2 border-t border-line py-1.5 pl-3 pr-1.5 font-mono text-[11px] font-medium text-fg-3">
        <span className="flex-1" aria-live="polite">
          {objective.taskIds.length} linked
        </span>
        <Kbd className="max-[760px]:hidden">Esc</Kbd>
        <Button size="sm" onClick={onClose}>
          Done
        </Button>
      </div>
    </motion.div>
  );
}
