"use client";

import { useParams } from "next/navigation";
import { CompanyScreen } from "@/modules/sales/companies/company-screen";

export default function Page() {
  const { id } = useParams<{ id: string }>();
  return <CompanyScreen id={decodeURIComponent(id)} />;
}
