"use client";

import { forwardRef, useEffect, useRef, type InputHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

/* Native inputs styled per board 03 (.cb / .tg / .rd in globals.css). */

type ChoiceProps = InputHTMLAttributes<HTMLInputElement> & { label?: ReactNode };

export const Checkbox = forwardRef<HTMLInputElement, ChoiceProps & { indeterminate?: boolean }>(
  function Checkbox({ label, className, indeterminate, ...props }, ref) {
    const inner = useRef<HTMLInputElement | null>(null);
    useEffect(() => {
      if (inner.current) inner.current.indeterminate = Boolean(indeterminate);
    }, [indeterminate]);
    const input = (
      <input
        ref={(el) => {
          inner.current = el;
          if (typeof ref === "function") ref(el);
          else if (ref) ref.current = el;
        }}
        type="checkbox"
        aria-checked={indeterminate ? "mixed" : undefined}
        className={cn("cb", className)}
        {...props}
      />
    );
    if (!label) return input;
    return (
      <label className="flex cursor-pointer items-center gap-2.5 text-ui">
        {input}
        {label}
      </label>
    );
  },
);

export const Switch = forwardRef<HTMLInputElement, ChoiceProps>(function Switch(
  { label, className, ...props },
  ref,
) {
  const input = <input ref={ref} type="checkbox" role="switch" className={cn("tg", className)} {...props} />;
  if (!label) return input;
  return (
    <label className="flex cursor-pointer items-center justify-between gap-2.5 text-ui">
      <span>{label}</span>
      {input}
    </label>
  );
});

export const Radio = forwardRef<HTMLInputElement, ChoiceProps>(function Radio({ label, className, ...props }, ref) {
  const input = <input ref={ref} type="radio" className={cn("rd", className)} {...props} />;
  if (!label) return input;
  return (
    <label className="flex cursor-pointer items-center gap-2 text-ui">
      {input}
      {label}
    </label>
  );
});

/** Segmented control (board 03 .seg). Single choice; uses aria-pressed like the design. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  size = "md",
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode }[];
  label: string;
  size?: "md" | "lg";
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn("inline-flex gap-0.5 rounded-md border border-line bg-raised p-[3px]", className)}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-sm px-3 font-medium text-fg-2 transition-[background-color,color] duration-[var(--dur-fast)] ease-out hover:text-fg",
            size === "lg" ? "h-7 text-[12.5px] max-[1023px]:h-11" : "h-[26px] text-[12px]",
            "aria-pressed:bg-hover aria-pressed:text-fg aria-pressed:shadow-[inset_0_0_0_1px_var(--line-2)]",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
