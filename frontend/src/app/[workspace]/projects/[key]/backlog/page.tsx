import { Suspense } from "react";
import { BacklogScreen } from "@/modules/tracking/sprints/backlog-screen";

export default function BacklogPage() {
  return (
    <Suspense>
      <BacklogScreen />
    </Suspense>
  );
}
