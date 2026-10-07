"use client";

import { Suspense } from "react";
import { ReportsScreen } from "@/features/reports/reports-screen";

export default function Page() {
  return (
    <Suspense fallback={null}>
      <ReportsScreen />
    </Suspense>
  );
}
