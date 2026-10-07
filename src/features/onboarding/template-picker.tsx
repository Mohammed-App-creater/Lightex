"use client";

import type { CSSProperties } from "react";
import type { ProjectTemplate } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";

export const TEMPLATES: { value: ProjectTemplate; label: string }[] = [
  { value: "kanban", label: "Kanban" },
  { value: "scrum", label: "Scrum" },
  { value: "bugs", label: "Bug tracking" },
];

function Art({ kind, on }: { kind: ProjectTemplate; on: boolean }) {
  const bar: CSSProperties = on ? { background: "var(--accent-t)", opacity: 0.55 } : { background: "var(--line-2)" };
  return (
    <span
      aria-hidden
      className="flex h-[46px] flex-none gap-1 overflow-hidden rounded-sm border border-line bg-bg p-1.5 max-[760px]:h-10 max-[760px]:w-16"
    >
      {kind === "kanban" &&
        [0, 1, 2].map((i) => (
          <span key={i} className="flex flex-1 flex-col gap-[3px]">
            <span className="h-2 rounded-[2px]" style={bar} />
            <span className="h-2 rounded-[2px]" style={bar} />
          </span>
        ))}
      {kind === "scrum" && (
        <span className="flex flex-1 flex-col justify-center gap-[5px]">
          <span className="h-1.5 w-[70%] rounded-[2px]" style={bar} />
          <span className="ml-[10%] h-1.5 w-[90%] rounded-[2px]" style={bar} />
          <span className="ml-[30%] h-1.5 w-[55%] rounded-[2px]" style={bar} />
        </span>
      )}
      {kind === "bugs" && (
        <span className="flex flex-1 flex-col justify-center gap-[3px]">
          {[90, 75, 85, 60].map((w) => (
            <span key={w} className="h-[5px] rounded-[2px]" style={{ ...bar, width: `${w}%` }} />
          ))}
        </span>
      )}
    </span>
  );
}

/** Template cards (board 23 §3.3): a radiogroup of three cards with hidden radios. */
export function TemplatePicker({
  value,
  onChange,
  name,
  locked,
}: {
  value: ProjectTemplate;
  onChange: (v: ProjectTemplate) => void;
  name: string;
  locked?: boolean;
}) {
  return (
    <div role="radiogroup" aria-labelledby={`${name}-label`} className="flex flex-col gap-1.5">
      <span id={`${name}-label`} className="text-[12.5px] font-medium text-fg-2">
        Template
      </span>
      <div className="grid grid-cols-3 gap-2.5 max-[760px]:grid-cols-1">
        {TEMPLATES.map((t) => {
          const on = t.value === value;
          return (
            <label
              key={t.value}
              className={cn(
                "flex cursor-pointer flex-col gap-2.5 rounded-[10px] border bg-surface p-2.5 transition-[border-color,background-color] duration-[var(--dur-fast)]",
                "has-[:focus-visible]:shadow-[var(--focus-ring)] max-[760px]:flex-row max-[760px]:items-center",
                on ? "border-accent bg-accent-s" : "border-line-2 hover:border-control",
                locked && !on && "cursor-default opacity-60 hover:border-line-2",
              )}
            >
              <input
                type="radio"
                name={name}
                value={t.value}
                checked={on}
                disabled={locked && !on}
                onChange={() => onChange(t.value)}
                className="sr-only"
              />
              <Art kind={t.value} on={on} />
              <span className="text-[12.5px] font-medium text-fg">{t.label}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
