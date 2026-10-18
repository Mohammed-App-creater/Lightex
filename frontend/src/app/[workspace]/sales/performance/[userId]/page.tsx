"use client";

import { useParams } from "next/navigation";
import { PerformanceUserScreen } from "@/modules/sales/performance/performance-user-screen";

export default function Page() {
  const { userId } = useParams<{ userId: string }>();
  return <PerformanceUserScreen userId={decodeURIComponent(userId)} />;
}
