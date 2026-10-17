import { Suspense } from "react";
import { CalendarScreen } from "@/modules/tracking/schedule/calendar-screen";

/** Board 32 (v2): calendar project view. */
export default function CalendarPage() {
  return (
    <Suspense>
      <CalendarScreen />
    </Suspense>
  );
}
