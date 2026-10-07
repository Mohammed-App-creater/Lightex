"use client";

import { ChevronDown } from "lucide-react";
import { useId, type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";
import { Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "./menu";

export type SelectOption<T extends string> = {
  value: T;
  label: string;
  icon?: ReactNode;
  meta?: ReactNode;
  keys?: string[];
};

/**
 * Select (board 03 .sel): 32px trigger with leading glyph, chevron, and a menu of options.
 * Built on the dropdown menu so options get roving focus, typeahead and menuitemradio semantics.
 */
export function Select<T extends string>({
  value,
  onChange,
  options,
  label,
  hideLabel,
  placeholder = "Select…",
  className,
  disabled,
  width = 240,
}: {
  value: T | null;
  onChange: (v: T) => void;
  options: SelectOption<T>[];
  label: string;
  hideLabel?: boolean;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  width?: number;
}) {
  const id = useId();
  const current = options.find((o) => o.value === value);
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <span id={id} className={cn("text-meta font-medium text-fg-2", hideLabel && "sr-only")}>
        {label}
      </span>
      <Menu>
        <MenuTrigger asChild disabled={disabled}>
          <button
            type="button"
            aria-labelledby={id}
            className={cn(
              "inline-flex h-8 w-full items-center gap-2 rounded-sm border border-control bg-surface px-2.5 text-left text-[13px] font-medium text-fg",
              "transition-[border-color] duration-[var(--dur-fast)] ease-out hover:border-fg-3 disabled:cursor-not-allowed disabled:opacity-60",
              "data-[state=open]:border-accent max-[1023px]:h-11",
            )}
          >
            {current?.icon}
            <span className={cn("min-w-0 flex-1 truncate", !current && "text-fg-3")}>
              {current?.label ?? placeholder}
            </span>
            <ChevronDown size={14} className="text-fg-3" aria-hidden />
          </button>
        </MenuTrigger>
        <MenuContent align="start" width={width}>
          <MenuRadioGroup value={value ?? ""} onValueChange={(v) => onChange(v as T)}>
            {options.map((o) => (
              <MenuRadioItem key={o.value} value={o.value} icon={o.icon} meta={o.meta} keys={o.keys}>
                {o.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuContent>
      </Menu>
    </div>
  );
}
