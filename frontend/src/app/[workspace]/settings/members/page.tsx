"use client";

import { Suspense } from "react";
import { MembersScreen } from "@/platform/members/members-screen";

export default function Page() {
  return (
    <Suspense fallback={null}>
      <MembersScreen />
    </Suspense>
  );
}
