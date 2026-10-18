"use client";

import { useParams } from "next/navigation";
import { ReportScreen } from "@/modules/sales/reports/report-screen";

export default function Page() {
  const { key } = useParams<{ key: string }>();
  return <ReportScreen reportKey={decodeURIComponent(key)} />;
}
