"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import { ThemeProvider } from "next-themes";
import { useEffect, useState, type ReactNode } from "react";
import { Toaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SessionProvider } from "@/features/auth/session";
import { ServiceWorkerBridge } from "@/features/notifications/channels/sw-bridge";
import { makeQueryClient } from "@/lib/api/query-client";
import { devToolsEnabled } from "@/lib/env";

/** Theme names: "dark" = Deep navy (default), "black" = Near-black, "light". Plus "system". */
export const THEMES = ["dark", "black", "light"] as const;
export type ThemeName = (typeof THEMES)[number] | "system";

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(makeQueryClient);
  useEffect(() => {
    // Dev/test hook: lets the Playwright smoke test and the console inspect the cache.
    if (devToolsEnabled) (window as unknown as { __lightexQC: unknown }).__lightexQC = queryClient;
  }, [queryClient]);
  return (
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <ThemeProvider
          attribute="data-theme"
          themes={[...THEMES]}
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
          storageKey="lightex-theme"
        >
          {/* "user": respect prefers-reduced-motion — transform/layout animations are skipped. */}
          <MotionConfig reducedMotion="user">
            <TooltipProvider>
              {children}
              <Toaster />
              {/* Board 38: notification clicks from public/sw.js navigate here. */}
              <ServiceWorkerBridge />
            </TooltipProvider>
          </MotionConfig>
        </ThemeProvider>
      </SessionProvider>
    </QueryClientProvider>
  );
}
