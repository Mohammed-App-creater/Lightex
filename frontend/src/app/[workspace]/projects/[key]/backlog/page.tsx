import { Suspense } from "react";
import { BacklogScreen } from "@/features/sprints/backlog-screen";

export default function BacklogPage() {
  return (
    <Suspense>
      <BacklogScreen />
    </Suspense>
  );
}
