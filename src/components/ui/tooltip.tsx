"use client";

import * as RT from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";
import { Shortcut } from "./kbd";

export const TooltipProvider = ({ children }: { children: ReactNode }) => (
  // Design: 200ms delay; moving between triggers shows instantly.
  <RT.Provider delayDuration={200} skipDelayDuration={300}>
    {children}
  </RT.Provider>
);

type TooltipProps = {
  content: ReactNode;
  /** Shortcut keys shown after the label, e.g. ["⌘", "K"]. */
  keys?: string[];
  sequence?: boolean;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  children: ReactNode;
  /** Force-open (used for disabled reasons in the gallery). */
  open?: boolean;
  className?: string;
};

export function Tooltip({
  content,
  keys,
  sequence,
  side = "top",
  align = "center",
  children,
  open,
  className,
}: TooltipProps) {
  return (
    <RT.Root open={open}>
      <RT.Trigger asChild>{children}</RT.Trigger>
      <RT.Portal>
        <RT.Content
          side={side}
          align={align}
          sideOffset={8}
          collisionPadding={8}
          className={cn(
            "z-[80] flex items-center gap-2 whitespace-nowrap rounded-sm border border-line-2 bg-raised px-2 py-[5px]",
            "text-meta font-medium text-fg shadow-pop",
            "data-[state=delayed-open]:animate-[tip-in_150ms_var(--ease)] data-[state=instant-open]:animate-[tip-in_150ms_var(--ease)]",
            className,
          )}
        >
          {content}
          {keys && <Shortcut keys={keys} sequence={sequence} />}
        </RT.Content>
      </RT.Portal>
    </RT.Root>
  );
}
