"use client";

import * as Popover from "@radix-ui/react-popover";
import { Eye } from "lucide-react";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Avatar } from "@/components/ui/avatar";
import type { User } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";
import { colorName, ITEM_COLORS } from "./project-lib";

/** 12px colour dot (board 28 .wf-dot). */
export function ColorDot({ color, className }: { color: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-3 flex-none rounded-full shadow-[0_0_0_1px_color-mix(in_srgb,var(--text-3)_35%,transparent)]", className)}
      style={{ background: color }}
    />
  );
}

/**
 * Colour picker popover (board 28 .ps-pop/.ps-cgrid): a 5×2 radiogroup of palette tokens.
 * Arrow keys move between swatches; Enter/Space picks.
 */
export function ColorPicker({
  value,
  onChange,
  label,
  align = "end",
  fallback = "var(--text-3)",
}: {
  value: string | null | undefined;
  /** Dot colour while no colour is set (e.g. the status glyph's default). */
  fallback?: string;
  onChange: (token: string) => void;
  /** Accessible name of the trigger, e.g. "Color for In review". */
  label: string;
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const grid = useRef<HTMLDivElement>(null);
  const current = value ?? fallback;
  const onKey = (e: KeyboardEvent) => {
    const items = Array.from(grid.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "ArrowDown" ? 5 : e.key === "ArrowUp" ? -5 : 0;
    if (!step) return;
    e.preventDefault();
    items[(i + step + items.length) % items.length]?.focus();
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={`${label}: ${colorName(value)}`}
          className="inline-flex size-7 flex-none items-center justify-center rounded-sm text-fg-3 hover:bg-raised data-[state=open]:bg-raised max-[760px]:size-10"
        >
          <ColorDot color={current} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align={align}
          sideOffset={6}
          collisionPadding={8}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (grid.current?.querySelector<HTMLElement>("[aria-checked=true]") ?? grid.current?.querySelector<HTMLElement>("button"))?.focus();
          }}
          className="z-[70] rounded-[10px] border border-line-2 bg-raised p-2 shadow-pop data-[state=open]:animate-[fade-in_150ms_var(--ease)]"
        >
          <div
            ref={grid}
            role="radiogroup"
            aria-label={label}
            onKeyDown={onKey}
            className="grid grid-cols-[repeat(5,22px)] gap-2 max-[760px]:grid-cols-[repeat(5,32px)] max-[760px]:gap-2.5"
          >
            {ITEM_COLORS.map((c) => {
              const on = c.token === value;
              return (
                <button
                  key={c.token}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={c.name}
                  tabIndex={on ? 0 : -1}
                  onClick={() => {
                    setOpen(false);
                    if (!on) onChange(c.token);
                  }}
                  className={cn(
                    "size-[22px] rounded-full transition-transform duration-150 ease-spring hover:scale-110 max-[760px]:size-8",
                    on && "shadow-[0_0_0_2px_var(--raised),0_0_0_3.5px_var(--text)]",
                  )}
                  style={{ background: c.token }}
                />
              );
            })}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** "View only · Role" note with the people who can change it (board 28 .st-note). */
export function ReadOnlyNote({
  role,
  reason,
  admins,
}: {
  role: string;
  reason: string;
  admins: Pick<User, "id" | "name" | "hue">[];
}) {
  return (
    <div role="note" className="mb-5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-md border border-line bg-raised px-3 py-2.5 text-[12.5px] text-fg-2">
      <Eye size={14} aria-hidden className="flex-none text-fg-3" />
      <span className="min-w-0 flex-1">
        <span className="font-medium text-fg">View only · {role}</span>
        <span className="text-fg-3"> — {reason}</span>
      </span>
      {admins.length > 0 && (
        <span className="inline-flex items-center gap-1.5">
          <span className="font-mono text-[11px] text-fg-3">Admins</span>
          <span className="flex">
            {admins.slice(0, 3).map((a, i) => (
              <Avatar key={a.id} name={a.name} hue={a.hue} size={20} className={cn(i > 0 && "-ml-2")} />
            ))}
          </span>
        </span>
      )}
    </div>
  );
}

/** Panel header (board 28 .ps-ph): 15px title, mono count, trailing actions. */
export function PanelHeader({ title, count, children }: { title: string; count?: number; children?: ReactNode }) {
  return (
    <div className="mb-3.5 flex min-h-8 items-center gap-2.5">
      <h2 className="m-0 text-[15px] font-semibold tracking-[-0.01em]">{title}</h2>
      {count !== undefined && <span className="font-mono text-[11px] font-medium text-fg-3">{count}</span>}
      <span className="flex-1" />
      {children}
    </div>
  );
}

/** Mono fact chips used in confirm dialogs (board 28 .st-chips). */
export function FactChips({ items }: { items: ReactNode[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((it, i) => (
        <span key={i} className="inline-flex h-[22px] items-center rounded-[6px] border border-line bg-raised px-2 font-mono text-[11.5px] font-medium text-fg-2">
          {it}
        </span>
      ))}
    </div>
  );
}

/** Label pill (board 28 .lb-pill): tinted with the label colour. */
export function LabelPill({ name, color, className }: { name: string; color: string; className?: string }) {
  return (
    <span
      className={cn("inline-flex h-[22px] max-w-full items-center gap-1.5 truncate rounded-[6px] border px-2 text-[12.5px] font-medium text-fg", className)}
      style={{
        background: `color-mix(in srgb, ${color} 14%, transparent)`,
        borderColor: `color-mix(in srgb, ${color} 32%, transparent)`,
      }}
    >
      <span aria-hidden className="size-[7px] flex-none rounded-full" style={{ background: color }} />
      <span className="truncate">{name}</span>
    </span>
  );
}
