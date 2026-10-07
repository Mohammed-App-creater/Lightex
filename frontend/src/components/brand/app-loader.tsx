"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils/cn";
import { Wordmark } from "./logo";

/**
 * App loading (board 23 §2.7, logo §7): bar draws, bolt strikes, cyan flash, x settles,
 * "Lighte" slides in, then a 140×2 indeterminate track. Text label appears only after 2s.
 */
export function AppLoader({ className, label = "Loading Lightex" }: { className?: string; label?: string }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setSlow(true), 2000);
    return () => clearTimeout(id);
  }, []);
  return (
    <div
      role="status"
      aria-label={label}
      className={cn("flex min-h-dvh flex-col items-center justify-center gap-7 bg-bg", className)}
    >
      <div className="lx-play">
        <Wordmark
          size={48}
          wordClassName="lx-word"
          markParts={{ bar: "lx-bar", bolt: "lx-bolt", flash: "lx-flash", whole: "lx-x" }}
        />
      </div>
      <div className="lx-track relative h-0.5 w-[140px] overflow-hidden rounded-full bg-line">
        <span className="lx-track-bar absolute inset-y-0 w-2/5 rounded-full bg-accent" />
      </div>
      <p className={cn("m-0 h-4 text-meta text-fg-3 transition-opacity duration-300", slow ? "opacity-100" : "opacity-0")}>
        {slow ? "Still loading…" : ""}
      </p>
    </div>
  );
}
