"use client";

import * as DM from "@radix-ui/react-dropdown-menu";
import { Check, ChevronRight } from "lucide-react";
import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";
import { Shortcut } from "./kbd";

/*
 * Dropdown menu (board 05). 240px, 4px padding, radius 8, --raised, e2 shadow.
 * Permission rule: items the user cannot use are NOT rendered ("Delete is absent, not greyed out").
 */

export const Menu = DM.Root;
export const MenuTrigger = DM.Trigger;
export const MenuGroup = DM.Group;
export const MenuRadioGroup = DM.RadioGroup;
export const MenuSub = DM.Sub;

const contentClass =
  "z-[70] min-w-[200px] rounded-md border border-line-2 bg-raised p-1 text-fg shadow-pop outline-none " +
  "origin-[var(--radix-dropdown-menu-content-transform-origin)] data-[state=open]:animate-[menu-in_180ms_var(--ease)]";

export const MenuContent = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof DM.Content> & { width?: number }>(
  function MenuContent({ className, sideOffset = 6, width, style, ...props }, ref) {
    return (
      <DM.Portal>
        <DM.Content
          ref={ref}
          sideOffset={sideOffset}
          collisionPadding={8}
          className={cn(contentClass, className)}
          style={{ width, ...style }}
          {...props}
        />
      </DM.Portal>
    );
  },
);

const itemClass =
  "relative flex h-[30px] w-full cursor-pointer select-none items-center gap-2.5 rounded-sm px-2 text-[13px] font-medium leading-none outline-none " +
  "data-[highlighted]:bg-hover data-[disabled]:cursor-not-allowed data-[disabled]:text-fg-3 max-[1023px]:h-11";

export const MenuItem = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof DM.Item> & {
    icon?: ReactNode;
    keys?: string[];
    danger?: boolean;
    meta?: ReactNode;
  }
>(function MenuItem({ className, icon, keys, danger, meta, children, ...props }, ref) {
  return (
    <DM.Item ref={ref} className={cn(itemClass, danger && "text-danger", className)} {...props}>
      {icon && <span className="flex size-4 items-center justify-center text-fg-2">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {meta && <span className="font-mono text-[11px] text-fg-3">{meta}</span>}
      {keys && <Shortcut keys={keys} />}
    </DM.Item>
  );
});

export const MenuCheckboxItem = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof DM.CheckboxItem> & { icon?: ReactNode }
>(function MenuCheckboxItem({ className, icon, children, ...props }, ref) {
  return (
    <DM.CheckboxItem ref={ref} className={cn(itemClass, "group", className)} {...props}>
      <span
        aria-hidden
        className="flex size-3.5 flex-none items-center justify-center rounded-xs border-[1.5px] border-control group-data-[state=checked]:border-accent group-data-[state=checked]:bg-accent"
      >
        <DM.ItemIndicator>
          <Check size={10} strokeWidth={3} className="text-white" />
        </DM.ItemIndicator>
      </span>
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </DM.CheckboxItem>
  );
});

export const MenuRadioItem = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof DM.RadioItem> & { icon?: ReactNode; meta?: ReactNode; keys?: string[] }
>(function MenuRadioItem({ className, icon, meta, keys, children, ...props }, ref) {
  return (
    <DM.RadioItem ref={ref} className={cn(itemClass, "data-[state=checked]:bg-accent-s", className)} {...props}>
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {meta && <span className="font-mono text-[11px] text-fg-3">{meta}</span>}
      {keys && <Shortcut keys={keys} />}
      <DM.ItemIndicator>
        <Check size={14} strokeWidth={1.8} className="text-accent-t" />
      </DM.ItemIndicator>
    </DM.RadioItem>
  );
});

export function MenuLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <DM.Label
      className={cn(
        "px-2 pb-1 pt-1.5 font-mono text-[11px] font-medium uppercase leading-none tracking-[0.06em] text-fg-3",
        className,
      )}
    >
      {children}
    </DM.Label>
  );
}

export function MenuSeparator() {
  return <DM.Separator className="-mx-1 my-1 h-px bg-line" />;
}

export function MenuSubTrigger({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <DM.SubTrigger className={cn(itemClass, "data-[state=open]:bg-hover")}>
      {icon}
      <span className="flex-1">{children}</span>
      <ChevronRight size={14} className="text-fg-3" aria-hidden />
    </DM.SubTrigger>
  );
}

export const MenuSubContent = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof DM.SubContent>>(
  function MenuSubContent({ className, ...props }, ref) {
    return (
      <DM.Portal>
        <DM.SubContent ref={ref} sideOffset={6} collisionPadding={8} className={cn(contentClass, className)} {...props} />
      </DM.Portal>
    );
  },
);
