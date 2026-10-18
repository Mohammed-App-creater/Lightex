"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { isApiError } from "@/api/errors";
import { DialogClose, DialogShell } from "@/ui/modal";
import { cn } from "@/lib/utils/cn";

/*
 * Sales form dialogs: a centred dialog on desktop, a full-height sheet below 760px (mobile-first quick logging).
 * The footer stays pinned; the body scrolls.
 */
export function FormDialog({
  open = true,
  onOpenChange,
  title,
  onSubmit,
  footer,
  children,
  width = 520,
  className,
}: {
  open?: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  onSubmit: () => void;
  footer: ReactNode;
  children: ReactNode;
  width?: number;
  className?: string;
}) {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit();
  };
  return (
    <DialogShell open={open} onOpenChange={onOpenChange} title={title} width={width} className={cn("h-auto max-[760px]:h-dvh", className)}>
      <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-none items-center gap-2 border-b border-line px-5 py-3.5">
          <h2 className="m-0 min-w-0 flex-1 truncate text-[15px] font-semibold leading-6">{title}</h2>
          <DialogClose />
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">{children}</div>
        <div className="flex flex-none flex-wrap justify-end gap-2 border-t border-line px-5 py-3 pb-[calc(12px+env(safe-area-inset-bottom))]">
          {footer}
        </div>
      </form>
    </DialogShell>
  );
}

/** 422 `validation_failed` field messages of the last error (forms show them on the fields). */
export const fieldErrorsOf = (e: unknown): Record<string, string> => (isApiError(e) && e.code === "validation_failed" ? e.fieldErrors : {});

/** The value after it stopped changing for `ms` (search boxes, the duplicate check). */
export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** `YYYY-MM-DDTHH:MM` for a datetime-local input, in local time. */
export function localDateTime(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
