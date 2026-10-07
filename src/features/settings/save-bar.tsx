"use client";

import { AlertCircle, Check } from "lucide-react";
import { AnimatePresence, motion, useAnimate } from "motion/react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useHotkeys } from "@/lib/hooks/use-hotkeys";
import { cn } from "@/lib/utils/cn";

export type SaveState = "idle" | "dirty" | "invalid" | "pending" | "saving" | "error" | "saved";

/**
 * Sticky save bar (board 20 B.7 / board 18 unsaved bar). Sits at the bottom of the settings
 * scroll area. ⌘S / Ctrl+S saves while dirty or after an error. `shake` re-runs the shake
 * animation whenever it changes (a guarded navigation was attempted).
 */
export function SaveBar({
  state,
  onSave,
  onDiscard,
  count,
  shake = 0,
  className,
}: {
  state: SaveState;
  onSave: () => void;
  onDiscard: () => void;
  count?: number;
  shake?: number;
  className?: string;
}) {
  const [scope, animate] = useAnimate();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!scope.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    void animate(scope.current, { x: [0, -7, 6, -4, 2, 0] }, { duration: 0.36, ease: [0.16, 1, 0.3, 1] });
  }, [shake, animate, scope]);

  useHotkeys(
    {
      "mod+s": () => {
        if (state === "dirty" || state === "error") onSave();
      },
    },
    state !== "idle",
  );

  return (
    <div className={cn("pointer-events-none sticky bottom-4 z-[6] mt-6 flex justify-center", className)}>
      <AnimatePresence>
        {state !== "idle" && (
          <motion.div
            key="bar"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12, transition: { duration: 0.15 } }}
            transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
          >
            <div
              ref={scope}
              role="region"
              aria-label="Unsaved changes"
              className={cn(
                "pointer-events-auto flex h-11 max-w-[calc(100vw-32px)] items-center gap-2 whitespace-nowrap rounded-[10px] border border-line-2 bg-raised pl-3.5 pr-1.5 shadow-pop",
                state === "error" && "border-danger",
                state === "saved" && "pr-3.5",
              )}
            >
              <span role="status" className="mr-2 inline-flex items-center gap-2 text-[13px] font-medium">
                {state === "dirty" && (
                  <>
                    <span aria-hidden className="size-[7px] rounded-full bg-warn" />
                    Unsaved changes
                    {count !== undefined && <span className="font-mono text-[11px] text-fg-3">{count}</span>}
                  </>
                )}
                {state === "invalid" && <span className="text-danger">Fix errors to save</span>}
                {state === "pending" && (
                  <>
                    <Spinner /> Checking URL
                  </>
                )}
                {state === "saving" && (
                  <>
                    <Spinner /> Saving
                  </>
                )}
                {state === "error" && (
                  <span className="inline-flex items-center gap-2 text-danger">
                    <AlertCircle size={14} aria-hidden /> Couldn’t save
                  </span>
                )}
                {state === "saved" && (
                  <>
                    <Check size={14} className="text-ok" aria-hidden /> Saved
                  </>
                )}
              </span>
              {(state === "dirty" || state === "invalid" || state === "error") && (
                <Button variant="ghost" size="md" onClick={onDiscard}>
                  Discard
                </Button>
              )}
              {state === "dirty" && (
                <Button variant="primary" onClick={onSave} kbd="⌘S" className="[&_.kbd]:max-[760px]:hidden">
                  Save
                </Button>
              )}
              {state === "error" && (
                <Button variant="primary" onClick={onSave}>
                  Retry
                </Button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
