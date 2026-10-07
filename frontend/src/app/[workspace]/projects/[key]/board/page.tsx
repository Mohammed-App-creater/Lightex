import { Suspense } from "react";
import { BoardScreen } from "@/features/board/board-screen";

export default function BoardPage() {
  return (
    <Suspense>
      <BoardScreen />
    </Suspense>
  );
}
