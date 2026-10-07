import { Suspense } from "react";
import { ListScreen } from "@/features/list/list-screen";

export default function ListPage() {
  return (
    <Suspense>
      <ListScreen />
    </Suspense>
  );
}
