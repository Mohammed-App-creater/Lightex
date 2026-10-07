"use client";

import { forwardRef, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils/cn";
import { addChips, CHIP_HUES, isEmail, splitDraft } from "./logic";

/**
 * Chip input (board 23 §3.4). Comma / whitespace / semicolon commit tokens, Enter commits the
 * draft (or lets the form submit when the draft is empty), blur commits, Backspace on an empty
 * draft removes the last chip. Duplicates ignored; max 20 chips.
 */
export const EmailChips = forwardRef<
  HTMLInputElement,
  {
    id: string;
    chips: string[];
    draft: string;
    onChange: (next: { chips: string[]; draft: string }) => void;
    invalid?: boolean;
    describedBy?: string;
    readOnly?: boolean;
  }
>(function EmailChips({ id, chips, draft, onChange, invalid, describedBy, readOnly }, ref) {
  const commit = (text: string, all: boolean) => {
    const { tokens, draft: rest } = splitDraft(text, all);
    onChange({ chips: addChips(chips, tokens), draft: rest });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && draft.trim()) {
      e.preventDefault();
      commit(draft, true);
    } else if (e.key === "Backspace" && !draft && chips.length) {
      e.preventDefault();
      onChange({ chips: chips.slice(0, -1), draft });
    }
  };

  return (
    <div
      className={cn(
        "flex min-h-10 flex-wrap items-center gap-1.5 rounded-[7px] border border-line-2 bg-surface px-1.5 py-[5px]",
        "transition-[border-color,box-shadow] duration-[var(--dur-fast)] focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--accent-s)]",
        invalid && "border-danger focus-within:border-danger",
        "max-[760px]:min-h-11",
      )}
    >
      <ul aria-label="Invitees" className="contents">
        {chips.map((c, i) => {
          const ok = isEmail(c);
          return (
            <li
              key={c}
              className={cn(
                "inline-flex h-[26px] max-w-full items-center gap-1.5 rounded-[13px] border pl-1 pr-[3px] text-[12.5px] font-medium",
                "animate-[checkpop_160ms_var(--spring)]",
                ok ? "border-line-2 bg-raised text-fg" : "border-danger bg-danger-s text-danger",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "flex size-[18px] flex-none items-center justify-center rounded-full text-[8px] font-semibold",
                  ok ? "text-fg" : "bg-danger text-bg",
                )}
                style={ok ? { background: `oklch(var(--av-l) var(--av-c) ${CHIP_HUES[i % CHIP_HUES.length]})` } : undefined}
              >
                {ok ? c[0]!.toUpperCase() : "!"}
              </span>
              <span className="min-w-0 truncate">
                {c}
                {!ok && <span className="sr-only"> (not a valid email)</span>}
              </span>
              {!readOnly && (
                <button
                  type="button"
                  aria-label={`Remove ${c}`}
                  onClick={() => onChange({ chips: chips.filter((x) => x !== c), draft })}
                  className="flex size-[18px] flex-none items-center justify-center rounded-full text-fg-3 hover:bg-hover hover:text-fg"
                >
                  <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden>
                    <path d="M1 1l6 6M7 1L1 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  </svg>
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <input
        ref={ref}
        id={id}
        type="text"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        inputMode="email"
        readOnly={readOnly}
        value={draft}
        placeholder={chips.length ? undefined : "jordan@team.dev, sam@team.dev"}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onChange={(e) => {
          const v = e.target.value;
          if (/[\s,;]/.test(v)) commit(v, false);
          else onChange({ chips, draft: v.slice(0, 80) });
        }}
        onKeyDown={onKeyDown}
        onBlur={() => draft.trim() && commit(draft, true)}
        className="h-[26px] min-w-[140px] flex-1 border-0 bg-transparent px-1 text-[13.5px] text-fg outline-none placeholder:text-fg-3 focus-visible:shadow-none max-[760px]:text-[16px]"
      />
    </div>
  );
});
