"use client";

import { MotionConfig } from "motion/react";
import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";
import { Toaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";

export const THEMES = ["dark", "black", "light"] as const;
export type ThemeName = (typeof THEMES)[number] | "system";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider
      attribute="data-theme"
      themes={[...THEMES]}
      defaultTheme="dark"
      enableSystem
      disableTransitionOnChange
      storageKey="lightex-theme"
    >
      {/* "user": respect prefers-reduced-motion — transforms/layout animations are skipped. */}
      <MotionConfig reducedMotion="user">
        <TooltipProvider>
          {children}
          <Toaster />
        </TooltipProvider>
      </MotionConfig>
    </ThemeProvider>
  );
}
