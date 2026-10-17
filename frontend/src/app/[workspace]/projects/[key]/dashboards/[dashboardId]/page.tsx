import { Suspense } from "react";
import { DashboardScreen } from "@/modules/tracking/dashboards/dashboard-screen";

/** Board 33 (v2): one project dashboard. */
export default function DashboardPage() {
  return (
    <Suspense>
      <DashboardScreen />
    </Suspense>
  );
}
