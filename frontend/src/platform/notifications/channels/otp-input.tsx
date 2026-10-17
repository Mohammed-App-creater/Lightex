"use client";

import { useRef } from "react";
import { cn } from "@/lib/utils/cn";
import { backspaceAt, pasteInto, typeInto } from "./otp";

/**
 * Six digit boxes (board 38 `.otp`). Box 1 has autocomplete="one-time-code" (iOS / Safari autofill), all
 * have inputmode="numeric"; ← → move; errors shake (transform only, none with reduced motion).
 */
export function OtpInput({
  code,
  onChange,
  readOnly,
  busy,
  error,
  shake,
}: {
  code: string[];
  onChange: (code: string[]) => void;
  readOnly: boolean;
  busy: boolean;
  error: boolean;
  /** Changes on every wrong code, replaying the shake. */
  shake: number;
}) {
  const boxes = useRef<(HTMLInputElement | null)[]>([]);
  const focus = (i: number) => {
    const el = boxes.current[Math.max(0, Math.min(5, i))];
    el?.focus();
    el?.select();
  };
  const apply = (edit: { code: string[]; focus: number } | null) => {
    if (!edit) return;
    onChange(edit.code);
    // At once (not after a frame), so a fast typist's next key lands in the next box.
    focus(edit.focus);
  };

  return (
    <div
      key={shake}
      role="group"
      aria-label="6-digit code"
      className={cn("grid grid-cols-6 gap-2", error && shake > 0 && "ch-shake")}
    >
      {code.map((v, i) => (
        <input
          key={i}
          ref={(el) => {
            boxes.current[i] = el;
          }}
          type="text"
          inputMode="numeric"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          aria-label={`Digit ${i + 1}`}
          aria-invalid={error || undefined}
          maxLength={i === 0 ? 6 : 2}
          autoFocus={i === 0 && !code.some(Boolean)}
          value={v}
          readOnly={readOnly}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => {
            if (!readOnly) apply(typeInto(code, i, e.currentTarget.value));
          }}
          onPaste={(e) => {
            e.preventDefault();
            if (!readOnly) apply(pasteInto(code, i, e.clipboardData.getData("text")));
          }}
          onKeyDown={(e) => {
            if (e.key === "Backspace" && !readOnly) {
              const edit = backspaceAt(code, i);
              if (edit) {
                e.preventDefault();
                apply(edit);
              }
            } else if (e.key === "ArrowLeft") {
              e.preventDefault();
              focus(i - 1);
            } else if (e.key === "ArrowRight") {
              e.preventDefault();
              focus(i + 1);
            }
          }}
          className={cn(
            "h-[50px] w-full min-w-0 rounded-lg border border-control bg-surface p-0 text-center font-mono text-[20px] font-semibold text-fg caret-accent transition-[border-color,box-shadow,background-color] focus:border-accent focus:shadow-[0_0_0_3px_var(--ring)] focus:outline-none",
            v && "border-line-2 bg-raised",
            error && "border-danger text-danger",
            busy && "opacity-55",
          )}
        />
      ))}
    </div>
  );
}
