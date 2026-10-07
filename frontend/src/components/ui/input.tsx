"use client";

import {
  cloneElement,
  forwardRef,
  isValidElement,
  useId,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import { cn } from "@/lib/utils/cn";

const control =
  "w-full rounded-sm border border-control bg-surface text-fg text-[13px] leading-5 transition-[border-color,box-shadow] duration-[var(--dur-fast)] ease-out " +
  "placeholder:text-fg-3 hover:border-fg-3 focus:border-accent focus:shadow-[0_0_0_3px_var(--ring)] focus:outline-none " +
  "disabled:cursor-not-allowed disabled:border-line disabled:bg-raised disabled:text-fg-3 " +
  "read-only:bg-raised read-only:text-fg-2 read-only:hover:border-control " +
  "aria-[invalid=true]:border-danger aria-[invalid=true]:focus:shadow-[0_0_0_3px_var(--danger-s)]";

export type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  inputSize?: "sm" | "md" | "lg";
  mono?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { inputSize = "md", mono, leading, trailing, className, ...props },
  ref,
) {
  const h =
    inputSize === "sm" ? "h-7" : inputSize === "lg" ? "h-10 max-[1023px]:h-11" : "h-8 max-[1023px]:h-11";
  const input = (
    <input
      ref={ref}
      className={cn(control, h, "px-2.5", mono && "font-mono", leading && "pl-8", trailing && "pr-10", className)}
      {...props}
    />
  );
  if (!leading && !trailing) return input;
  return (
    <span className="relative block">
      {leading && (
        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-3">{leading}</span>
      )}
      {input}
      {trailing && <span className="absolute right-2 top-1/2 -translate-y-1/2">{trailing}</span>}
    </span>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return <textarea ref={ref} className={cn(control, "min-h-20 px-2.5 py-2", className)} {...props} />;
  },
);

/**
 * Label + control + hint/error. Wires id, aria-describedby and aria-invalid onto the child.
 * Error copy follows the design: 12px danger text under the control, role=alert.
 */
export function Field({
  label,
  hint,
  error,
  children,
  className,
  labelAction,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: ReactElement<Record<string, unknown>>;
  className?: string;
  labelAction?: ReactNode;
}) {
  const id = useId();
  const childId = (children.props.id as string | undefined) ?? id;
  const descId = `${childId}-desc`;
  const control = isValidElement(children)
    ? cloneElement(children, {
        id: childId,
        "aria-invalid": error ? true : undefined,
        "aria-describedby": error || hint ? descId : undefined,
      })
    : children;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={childId} className="text-meta font-medium text-fg-2">
          {label}
        </label>
        {labelAction}
      </div>
      {control}
      {error ? (
        <span id={descId} role="alert" className="text-meta text-danger">
          {error}
        </span>
      ) : hint ? (
        <span id={descId} className="text-meta text-fg-3">
          {hint}
        </span>
      ) : null}
    </div>
  );
}
