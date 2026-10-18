"use client";

import { useParams } from "next/navigation";
import { LeadScreen } from "@/modules/sales/leads/lead-screen";

export default function Page() {
  const { id } = useParams<{ id: string }>();
  return <LeadScreen id={decodeURIComponent(id)} />;
}
