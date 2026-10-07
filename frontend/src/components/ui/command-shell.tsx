"use client";

import * as D from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { ChevronLeft, Search, X } from "lucide-react";
import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";
import { Kbd } from "./kbd";

/*
 * Command palette shell (board 05 + 22). Scrim with 8px blur; dialog 560px (narrow) or 780px
 * (wide with preview); 52px input row; 36px rows; footer with key hints. Full-screen on mobile.
 * Filtering/scopes are owned by the caller (shouldFilter={false}).
 */

export function CommandShell({
  open,
  onOpenChange,
  children,
  wide,
  label = "Search and commands",
  value,
  onValueChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  wide?: boolean;
  label?: string;
  /** Controlled active item (cmdk value). */
  value?: string;
  onValueChange?: (v: string) => void;
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-[70] bg-scrim backdrop-blur-[8px] data-[state=open]:animate-[fade-in_150ms_var(--ease)] max-[760px]:hidden" />
        <D.Content
          aria-label={label}
          aria-describedby={undefined}
          className={cn(
            "fixed left-1/2 top-[72px] z-[71] flex max-h-[calc(100dvh-96px)] w-[calc(100%-48px)] -translate-x-1/2 flex-col overflow-hidden",
            "origin-top rounded-lg border border-line-2 bg-surface shadow-modal outline-none",
            "data-[state=open]:animate-[modal-in_150ms_var(--ease)]",
            "max-[760px]:inset-0 max-[760px]:top-0 max-[760px]:max-h-none max-[760px]:w-full max-[760px]:translate-x-0 max-[760px]:rounded-none max-[760px]:border-0 max-[760px]:shadow-none max-[760px]:data-[state=open]:animate-none",
            wide ? "max-w-[780px]" : "max-w-[560px]",
          )}
        >
          <D.Title className="sr-only">{label}</D.Title>
          <Command
            shouldFilter={false}
            loop
            label={label}
            value={value}
            onValueChange={onValueChange}
            className="flex min-h-0 flex-1 flex-col"
          >
            {children}
          </Command>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

export const CommandInput = forwardRef<
  HTMLInputElement,
  ComponentPropsWithoutRef<typeof Command.Input> & { chip?: ReactNode; onBack?: () => void }
>(function CommandInput({ className, chip, onBack, ...props }, ref) {
  return (
    <div className="flex h-[52px] flex-none items-center gap-2.5 border-b border-line px-3.5 text-fg-3 transition-shadow duration-[var(--dur-fast)] focus-within:shadow-[inset_0_-1px_0_var(--accent)] max-[760px]:h-14 max-[760px]:px-2">
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          aria-label="Close search"
          className="hidden size-9 items-center justify-center rounded-md text-fg-2 hover:bg-hover max-[760px]:inline-flex"
        >
          <ChevronLeft size={16} aria-hidden />
        </button>
      ) : null}
      <Search size={16} strokeWidth={1.5} aria-hidden className="max-[760px]:hidden" />
      {chip}
      <Command.Input
        ref={ref}
        maxLength={120}
        className={cn(
          "h-full min-w-0 flex-1 border-0 bg-transparent text-[15px] text-fg outline-none placeholder:text-fg-3 focus-visible:shadow-none",
          className,
        )}
        {...props}
      />
      <span className="max-[760px]:hidden">
        <Kbd>Esc</Kbd>
      </span>
    </div>
  );
});

/** Scope chip shown after a > # @ prefix. */
export function CommandScopeChip({ symbol, label, onClear }: { symbol: string; label: string; onClear: () => void }) {
  return (
    <span className="inline-flex h-6 flex-none animate-[menu-in_180ms_var(--spring)] items-center gap-1.5 rounded-sm bg-accent-s pl-2 pr-[3px] text-[12px] font-medium text-accent-t">
      <b className="font-mono text-[12px] font-semibold">{symbol}</b>
      {label}
      <button
        type="button"
        onClick={onClear}
        aria-label={`Clear ${label} scope`}
        className="inline-flex size-[18px] items-center justify-center rounded-xs hover:bg-accent-s"
      >
        <X size={9} strokeWidth={2.5} aria-hidden />
      </button>
    </span>
  );
}

export const CommandList = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof Command.List>>(
  function CommandList({ className, ...props }, ref) {
    return (
      <Command.List
        ref={ref}
        className={cn("max-h-[460px] min-h-0 flex-1 overflow-auto px-1.5 pb-2 pt-1 max-[760px]:max-h-none", className)}
        {...props}
      />
    );
  },
);

export function CommandGroup({ heading, count, children }: { heading: string; count?: number; children: ReactNode }) {
  return (
    <Command.Group
      heading={
        <span className="flex items-center gap-2">
          {heading}
          {count !== undefined && count > 1 && <span className="tracking-normal opacity-80">{count}</span>}
        </span>
      }
      className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1.5 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:leading-none [&_[cmdk-group-heading]]:tracking-[0.06em] [&_[cmdk-group-heading]]:text-fg-3"
    >
      {children}
    </Command.Group>
  );
}

export const CommandItem = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof Command.Item>>(
  function CommandItem({ className, ...props }, ref) {
    return (
      <Command.Item
        ref={ref}
        className={cn(
          "group flex h-9 cursor-pointer select-none items-center gap-2.5 rounded-[7px] px-2 text-[13px] font-medium text-fg outline-none",
          "transition-[background-color] duration-[80ms] ease-out data-[selected=true]:bg-accent-s max-[760px]:h-11",
          className,
        )}
        {...props}
      />
    );
  },
);

export function CommandFooter({ verb = "Open" }: { verb?: "Open" | "Run" }) {
  return (
    <div className="flex h-[38px] flex-none items-center gap-3.5 whitespace-nowrap border-t border-line px-3.5 text-[12px] text-fg-3 max-[760px]:hidden">
      <span className="flex items-center gap-1">
        <Kbd>↑</Kbd>
        <Kbd>↓</Kbd> Move
      </span>
      <span className="flex items-center gap-1">
        <Kbd>↵</Kbd> {verb}
      </span>
      <span className="flex items-center gap-1">
        <Kbd>Tab</Kbd> Section
      </span>
      <span className="ml-auto">
        <b className="ml-1.5 font-mono text-[12px] font-semibold text-accent-t">&gt;</b> commands
        <b className="ml-1.5 font-mono text-[12px] font-semibold text-accent-t">#</b> projects
        <b className="ml-1.5 font-mono text-[12px] font-semibold text-accent-t">@</b> people
      </span>
    </div>
  );
}

export const CommandEmpty = Command.Empty;
export const CommandLoading = Command.Loading;
