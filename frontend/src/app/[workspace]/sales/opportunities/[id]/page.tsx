"use client";

import { useParams } from "next/navigation";
import { OpportunityScreen } from "@/modules/sales/opportunities/opportunity-screen";

export default function Page() {
  const { id } = useParams<{ id: string }>();
  return <OpportunityScreen id={decodeURIComponent(id)} />;
}
