"use client";

import { onlineManager, useMutationState } from "@tanstack/react-query";
import { RefreshCw, WifiOff } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { StatusGlyph } from "@/components/ui/glyphs";

/*
 * Offline banner (board 23 §2.6). While offline, TanStack Query pauses mutations; their
 * optimistic changes stay on screen and replay in order on reconnect. Amber = nothing failed yet.
 */
export function OfflineBanner() {
  const online = useSyncExternalStore(
    (cb) => onlineManager.subscribe(cb),
    () => onlineManager.isOnline(),
    () => true,
  );
  const queued = useMutationState({ filters: { predicate: (m) => m.state.isPaused } }).length;
  const [phase, setPhase] = useState<"hidden" | "offline" | "back">("hidden");
  const [peak, setPeak] = useState(0);
  const [prevOnline, setPrevOnline] = useState(online);

  // Derived state from props (React's "adjusting state when a prop changes" pattern).
  if (online !== prevOnline) {
    setPrevOnline(online);
    setPhase(!online ? "offline" : phase === "offline" ? "back" : phase);
  }
  if (!online && queued > peak) setPeak(queued);

  useEffect(() => {
    if (phase !== "back") return;
    const id = setTimeout(() => {
      setPhase("hidden");
      setPeak(0);
    }, 1800);
    return () => clearTimeout(id);
  }, [phase]);

  if (phase === "hidden") return null;
  if (phase === "back") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex h-10 flex-none animate-[rise-in_220ms_var(--ease)] items-center gap-2.5 border-b border-[rgba(74,222,128,.3)] bg-ok-s pl-4 pr-2.5 font-medium text-ok"
      >
        <StatusGlyph kind="done" />
        Back online
        {peak > 0 && (
          <span className="font-mono text-[11.5px] opacity-85">
            · {peak} {peak === 1 ? "change" : "changes"} synced
          </span>
        )}
      </div>
    );
  }
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex h-10 flex-none animate-[rise-in_220ms_var(--ease)] items-center gap-2.5 border-b border-[rgba(245,183,59,.3)] bg-warn-s pl-4 pr-2.5 font-medium text-warn"
    >
      <WifiOff size={15} className="animate-pulse motion-reduce:animate-none" aria-hidden />
      Offline
      <span className="font-mono text-[11.5px] opacity-85">
        · {queued} {queued === 1 ? "change" : "changes"} queued
      </span>
      <span className="flex-1" />
      <Button
        size="sm"
        variant="ghost"
        className="text-inherit hover:text-inherit"
        onClick={() => {
          if (typeof navigator !== "undefined" && navigator.onLine) onlineManager.setOnline(true);
        }}
      >
        <RefreshCw size={13} aria-hidden /> Retry now
      </Button>
    </div>
  );
}
