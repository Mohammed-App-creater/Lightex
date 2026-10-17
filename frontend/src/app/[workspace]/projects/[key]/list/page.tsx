import { Suspense } from "react";
import { ListScreen } from "@/modules/tracking/list/list-screen";

export default function ListPage() {
  return (
    <Suspense>
      <ListScreen />
    </Suspense>
  );
}
