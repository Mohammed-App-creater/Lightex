"use client";

import type { ReactNode } from "react";
import { QuickActionsFab, QuickActionsProvider } from "./quick-actions";

export function SalesLayout({ children }: { children: ReactNode }) {
  return (
    <QuickActionsProvider>
      {children}
      <QuickActionsFab />
    </QuickActionsProvider>
  );
}
