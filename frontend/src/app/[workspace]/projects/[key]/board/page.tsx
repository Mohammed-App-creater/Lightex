import { Suspense } from "react";
import { BoardScreen } from "@/modules/tracking/board/board-screen";

export default function BoardPage() {
  return (
    <Suspense>
      <BoardScreen />
    </Suspense>
  );
}
