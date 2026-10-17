"use client";

import { useEffect, useState } from "react";
import { apiMode } from "@/lib/env";
import { cn } from "@/lib/utils/cn";
import { LogoMark, Wordmark } from "./logo";

/*
 * App loading (board 23 §2.7, logo §7; timings re-checked against board 35 "Loading", 820ms):
 *   0ms    straight stroke  clip-path inset 100% → 0   ease-out 260ms
 *   140ms  bolt             (14,−18) 1.15 0 → 0 1 1   spring   320ms
 *   300ms  flash ring       0.4 → 1.8 · 0 → .7 → 0     ease-out 460ms
 *   460ms  x                scale 1.08 → 1             ease-out 260ms
 *   520ms  "Lighte"         10px → 0 · 0 → 1           ease-out 300ms
 *   1200+  bolt hold        opacity 1 → .55 → 1 loop   ease-in-out 1200ms (while still loading)
 *   reduced motion: one 150ms linear fade, no strike/flash/loop.
 * Then a 140×2 indeterminate track; a text label appears only after 2s. In live mode a second
 * label after 8s explains that an idle API host is waking up (free-tier cold start, up to ~1 min).
 * `variant="splash"` is the icon tile (board 35 "Splash · holds until ready").
 */
export function AppLoader({
  className,
  label = "Loading Lightex",
  variant = "wordmark",
}: {
  className?: string;
  label?: string;
  variant?: "wordmark" | "splash";
}) {
  const [stage, setStage] = useState<0 | 1 | 2>(0);
  useEffect(() => {
    const slow = setTimeout(() => setStage(1), 2000);
    const cold = setTimeout(() => setStage(2), 8000);
    return () => {
      clearTimeout(slow);
      clearTimeout(cold);
    };
  }, []);
  const slow = stage >= 1;
  const message = stage === 2 && apiMode === "live" ? "Waking up the server… the first visit after a quiet spell can take up to a minute." : "Still loading…";
  return (
    <div
      role="status"
      aria-label={label}
      className={cn("flex min-h-dvh flex-col items-center justify-center gap-7 bg-bg", className)}
    >
      <div className="lx-play">
        {variant === "splash" ? (
          <SplashIcon />
        ) : (
          <Wordmark
            size={48}
            wordClassName="lx-word"
            markParts={{ bar: "lx-bar", bolt: "lx-bolt lx-hold", flash: "lx-flash", whole: "lx-x" }}
          />
        )}
      </div>
      <div className="lx-track relative h-0.5 w-[140px] overflow-hidden rounded-full bg-line">
        <span className="lx-track-bar absolute inset-y-0 w-2/5 rounded-full bg-accent" />
      </div>
      <p className={cn("m-0 min-h-4 max-w-[320px] px-4 text-center text-meta text-fg-3 transition-opacity duration-300", slow ? "opacity-100" : "opacity-0")}>
        {slow ? message : ""}
      </p>
    </div>
  );
}

/** 96px app-icon tile: pops in (300ms spring), stroke + bolt strike, flash, then the bolt holds. */
function SplashIcon() {
  return (
    <span
      aria-hidden
      className="lx-icon-in relative flex size-24 items-center justify-center rounded-[21px] border border-[#2B3A5E] bg-[#0F1830]"
    >
      <LogoMark
        cut="icon"
        bar="#EAF0FF"
        bolt="#3B7BFF"
        style={{ width: 61, height: 52 }}
        parts={{ bar: "lx-bar", bolt: "lx-bolt lx-hold", flash: "lx-flash" }}
      />
    </span>
  );
}
