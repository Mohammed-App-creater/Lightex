"use client";

import * as DM from "@radix-ui/react-dropdown-menu";
import { Check } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import { StatusGlyph } from "@/components/ui/glyphs";
import { Kbd } from "@/components/ui/kbd";
import { Menu, MenuContent, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { Sheet } from "@/components/ui/modal";
import { useSparking } from "@/features/tasks/task-bits";
import type { Status, Task } from "@/lib/api/types";
import { useIsMobile } from "@/lib/hooks/use-media-query";
import { cn } from "@/lib/utils/cn";

/** Digit 1–9 → index into the project's statuses (board 25 "1–6 status keys"). */
export function statusForDigit(key: string, statuses: Status[]) {
  if (!/^[1-9]$/.test(key)) return null;
  return statuses[Number(key) - 1] ?? null;
}

/**
 * Inline status control (board 25 "Inline status"): the row's glyph opens a menu of the project's
 * statuses, numbered; 1–N picks. Below 760px it is a bottom sheet with 48px rows.
 * Without permission the glyph is static (no control rendered).
 */
export function StatusPicker({
  task,
  status,
  statuses,
  canChange,
  onPick,
  className,
}: {
  task: Task;
  status: Status | undefined;
  statuses: Status[];
  canChange: boolean;
  onPick: (s: Status) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const mobile = useIsMobile();
  const spark = useSparking(task.id);
  const glyph = <StatusGlyph kind={status?.glyph ?? "todo"} spark={spark} />;
  const label = `${task.key} status: ${status?.name ?? "Unknown"}`;
  const box = "relative z-[2] inline-flex size-7 flex-none items-center justify-center rounded-[7px] max-[760px]:size-11";

  if (!canChange || !statuses.length) {
    return (
      <span className={cn(box, className)} role="img" aria-label={label} title={status?.name}>
        {glyph}
      </span>
    );
  }

  const pick = (s: Status) => {
    setOpen(false);
    onPick(s);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const s = statusForDigit(e.key, statuses);
    if (s && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      pick(s);
    }
  };
  const trigger = (
    <button
      type="button"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={label}
      title={status?.name}
      onClick={mobile ? () => setOpen(true) : undefined}
      className={cn(box, "cursor-pointer transition-colors duration-[120ms] hover:bg-hover aria-expanded:bg-hover", className)}
    >
      {glyph}
    </button>
  );

  if (mobile) {
    return (
      <>
        {trigger}
        <Sheet open={open} onOpenChange={setOpen} title={`Change status of ${task.key}`} height="auto">
          <div className="flex flex-col px-2 pb-8 pt-1" role="menu" aria-label="Change status" onKeyDown={onKeyDown}>
            <div className="px-2 pb-1.5 pt-1 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-fg-3">{task.key}</div>
            {statuses.map((s, i) => (
              <button
                key={s.id}
                type="button"
                role="menuitemradio"
                aria-checked={s.id === status?.id}
                autoFocus={i === 0}
                onClick={() => pick(s)}
                className={cn("flex h-12 items-center gap-2.5 rounded-sm px-2 text-left text-[14px] font-medium hover:bg-hover", s.id === status?.id && "bg-accent-s")}
              >
                <StatusGlyph kind={s.glyph} />
                <span className="flex-1">{s.name}</span>
                {s.id === status?.id && <Check size={14} strokeWidth={1.8} className="text-accent-t" aria-hidden />}
                {i < 9 && <Kbd>{String(i + 1)}</Kbd>}
              </button>
            ))}
          </div>
        </Sheet>
      </>
    );
  }

  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger asChild>{trigger}</MenuTrigger>
      <MenuContent align="start" width={212} aria-label="Change status" onKeyDown={onKeyDown}>
        <MenuLabel>{task.key}</MenuLabel>
        <DM.RadioGroup value={status?.id ?? ""}>
          {statuses.map((s, i) => (
            <DM.RadioItem
              key={s.id}
              value={s.id}
              onSelect={() => pick(s)}
              className="relative flex h-8 w-full cursor-pointer select-none items-center gap-2.5 rounded-sm px-2 text-[13px] font-medium leading-none outline-none data-[highlighted]:bg-hover data-[state=checked]:bg-accent-s"
            >
              <StatusGlyph kind={s.glyph} />
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
              <DM.ItemIndicator>
                <Check size={14} strokeWidth={1.8} className="text-accent-t" aria-hidden />
              </DM.ItemIndicator>
              {i < 9 && <Kbd>{String(i + 1)}</Kbd>}
            </DM.RadioItem>
          ))}
        </DM.RadioGroup>
      </MenuContent>
    </Menu>
  );
}
