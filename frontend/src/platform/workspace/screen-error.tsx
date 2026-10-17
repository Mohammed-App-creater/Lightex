"use client";

import { Button } from "@/components/ui/button";
import { isApiError } from "@/lib/api/errors";

/**
 * Full-area error for the personal screens (boards 24/25): triangle, "Couldn’t load …",
 * mono "503 · me/tasks", Retry. Retry shows the skeleton again via the caller's refetch.
 */
export function ScreenError({ title, error, resource, onRetry }: { title: string; error: unknown; resource: string; onRetry: () => void }) {
  const status = isApiError(error) ? error.status || error.code : "Error";
  return (
    <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center motion-safe:animate-[fade-in_200ms_var(--ease)]">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M12 3.5l9 16H3zM12 10v4.5M12 17.2v.1" />
      </svg>
      <h2 className="m-0 text-[15px] font-semibold">{title}</h2>
      <span className="font-mono text-[11.5px] text-fg-3">
        {status} · {resource}
      </span>
      <Button variant="secondary" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
