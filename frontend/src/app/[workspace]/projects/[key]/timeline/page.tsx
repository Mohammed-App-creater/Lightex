import { Suspense } from "react";
import { TimelineScreen } from "@/modules/tracking/schedule/timeline-screen";

/** Board 32 (v2): timeline project view. */
export default function TimelinePage() {
  return (
    <Suspense>
      <TimelineScreen />
    </Suspense>
  );
}
