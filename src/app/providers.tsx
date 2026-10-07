"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import { ThemeProvider } from "next-themes";
import { useState, type ReactNode } from "react";
import { Toaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SessionProvider } from "@/features/auth/session";
import { makeQueryClient } from "@/lib/api/query-client";

/** Theme names: "dark" = Deep navy (default), "black" = Near-black, "light". Plus "system". */
export const THEMES = ["dark", "black", "light"] as const;
export type ThemeName = (typeof THEMES)[number] | "system";

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(makeQueryClient);
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
            </TooltipProvider>
          </MotionConfig>
        </ThemeProvider>
      </SessionProvider>
    </QueryClientProvider>
  );
}
