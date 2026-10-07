"use client";

import { Suspense } from "react";
import { MembersScreen } from "@/features/members/members-screen";

export default function Page() {
  return (
    <Suspense fallback={null}>
      <MembersScreen />
    </Suspense>
  );
}
