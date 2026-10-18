import type { ReactNode } from "react";
import { SalesLayout } from "@/modules/sales/shared/sales-layout";

/** Every `/sales/*` page: the quick-actions provider and the mobile FAB. */
export default function Layout({ children }: { children: ReactNode }) {
  return <SalesLayout>{children}</SalesLayout>;
}
