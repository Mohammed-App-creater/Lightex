import { Suspense } from "react";
import { DashboardsIndex } from "@/features/dashboards/dashboards-index";

/** Board 33 (v2): opens the last dashboard you opened here, else the first one, else "No dashboards yet". */
export default function DashboardsPage() {
  return (
    <Suspense>
      <DashboardsIndex />
    </Suspense>
  );
}
