"use client";

import { MODULE_CHOICES, type ModuleChoice } from "./logic";
import { cn } from "@/lib/utils/cn";

/** "What do you need?" cards (platform Stage 3): a radiogroup of two cards with hidden radios, like the template picker. */
export function ModulePicker({
  value,
  onChange,
  name,
  locked,
}: {
  value: ModuleChoice;
  onChange: (v: ModuleChoice) => void;
  name: string;
  locked?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label="Modules" className="flex flex-col gap-2.5">
      {MODULE_CHOICES.map((c) => {
        const on = c.value === value;
        return (
          <label
            key={c.value}
            className={cn(
              "flex cursor-pointer items-start gap-3 rounded-[10px] border bg-surface p-3.5 transition-[border-color,background-color] duration-[var(--dur-fast)]",
              "has-[:focus-visible]:shadow-[var(--focus-ring)]",
              on ? "border-accent bg-accent-s" : "border-line-2 hover:border-control",
              locked && !on && "cursor-default opacity-60 hover:border-line-2",
            )}
          >
            <input
              type="radio"
              name={name}
              value={c.value}
              checked={on}
              disabled={locked && !on}
              onChange={() => onChange(c.value)}
              className="rd mt-0.5 flex-none"
            />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[13.5px] font-medium text-fg">{c.label}</span>
              <span className="text-meta text-fg-3">{c.body}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}
