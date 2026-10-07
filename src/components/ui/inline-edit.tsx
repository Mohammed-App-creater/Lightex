"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils/cn";

/**
 * Inline edit (board 03): click the text, Enter saves, Esc cancels, blur saves.
 * Read-only users get a plain heading instead (no fake affordance).
 */
export function InlineEditText({
  value,
  onSave,
  label,
  canEdit,
  maxLength = 200,
  className,
  inputClassName,
  as: As = "h2",
  placeholder,
  allowEmpty = false,
}: {
  value: string;
  onSave: (next: string) => void;
  label: string;
  canEdit: boolean;
  maxLength?: number;
  className?: string;
  inputClassName?: string;
  as?: "h1" | "h2" | "h3" | "span";
  placeholder?: string;
  allowEmpty?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const input = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [editing]);

  const commit = () => {
    setEditing(false);
    if (cancelled.current) {
      cancelled.current = false;
      setDraft(value);
      return;
    }
    const next = draft.trim().slice(0, maxLength);
    if (!allowEmpty && !next) {
      setDraft(value);
      return;
    }
    if (next !== value) onSave(next);
  };

  if (!canEdit) {
    return <As className={cn("m-0", className)}>{value || placeholder}</As>;
  }

  if (editing) {
    return (
      <input
        ref={input}
        aria-label={label}
        value={draft}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            input.current?.blur();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            cancelled.current = true;
            input.current?.blur();
          }
        }}
        className={cn(
          "-ml-2 w-full rounded-sm border border-accent bg-surface px-[7px] py-[3px] text-fg shadow-[0_0_0_3px_var(--ring)] outline-none",
          className,
          inputClassName,
        )}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        setDraft(value);
        setEditing(true);
      }}
      aria-label={`${label}: ${value}. Click to edit`}
      className={cn(
        "-ml-2 block w-full cursor-text rounded-sm border border-transparent px-2 py-1 text-left",
        "transition-colors duration-[var(--dur-fast)] ease-out hover:bg-hover",
        !value && "text-fg-3",
        className,
      )}
    >
      {value || placeholder}
    </button>
  );
}
