"use client";

import * as Popover from "@radix-ui/react-popover";
import { X } from "lucide-react";
import { useState } from "react";
import type { ISODate, Task } from "@/lib/api/types";
import { CalendarChip } from "./calendar-chip";
import type { CalCtx } from "./calendar-month";
import { fmtDow } from "./schedule-lib";

/*
 * "+N more" (design .cl-pop) on Radix Popover (§8 #17): role=dialog titled "Wed Oct 7", close button
 * focused first, Esc / outside click close and return focus. Chips inside are draggable too.
 */
export function MorePopover({ day, tasks, more, ctx }: { day: ISODate; tasks: Task[]; more: number; ctx: CalCtx }) {
  const [open, setOpen] = useState(false);
  const title = fmtDow(day);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-haspopup="dialog"
          className="h-5 flex-none self-start rounded-[5px] px-1.5 text-[11.5px] font-medium text-fg-2 hover:bg-hover hover:text-fg data-[state=open]:bg-hover data-[state=open]:text-fg max-[760px]:h-8"
        >
          +{more} more
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          role="dialog"
          aria-label={title}
          side="bottom"
          align="start"
          sideOffset={-22}
          collisionPadding={12}
          className="z-[60] flex w-[248px] flex-col gap-1 rounded-[10px] border border-line-2 bg-raised p-1.5 shadow-pop outline-none data-[state=open]:animate-[menu-in_150ms_var(--ease)]"
        >
          <div className="flex items-center justify-between py-0.5 pl-1.5 pr-0.5 text-[12.5px] font-semibold">
            <span>{title}</span>
            <Popover.Close asChild>
              <button type="button" aria-label="Close" autoFocus className="inline-flex size-7 items-center justify-center rounded-[6px] text-fg-2 hover:bg-hover hover:text-fg">
                <X size={12} aria-hidden />
              </button>
            </Popover.Close>
          </div>
          {tasks.map((t) => (
            <CalendarChip key={t.id} {...ctx.chipProps(t, day)} avatar onDrop={(d) => {
              setOpen(false);
              ctx.drop(t, d);
            }} />
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
