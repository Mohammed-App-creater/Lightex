"use client";

import Link from "next/link";
import { cn } from "@/lib/utils/cn";
import { useSlug } from "../api/queries";
import { salesRoutes } from "./routes";

export type SalesEntityKind = "company" | "contact" | "lead" | "opportunity";

export function salesEntityHref(ws: string, kind: SalesEntityKind, id: string) {
  if (kind === "company") return salesRoutes.company(ws, id);
  if (kind === "contact") return salesRoutes.contact(ws, id);
  if (kind === "lead") return salesRoutes.lead(ws, id);
  return salesRoutes.opportunity(ws, id);
}

/** Maps a follow-up / activity `targetType` (`sales.company`…) to a link kind. */
export const kindOfTarget = (targetType: string): SalesEntityKind | null => {
  const k = targetType.replace(/^sales\./, "");
  return k === "company" || k === "contact" || k === "lead" || k === "opportunity" ? k : null;
};

/** A link to a company, contact, lead or opportunity. Renders plain text when the id is missing. */
export function EntityLink({ kind, id, name, className }: { kind: SalesEntityKind; id: string | null | undefined; name: string; className?: string }) {
  const ws = useSlug();
  if (!id) return <span className={cn("truncate", className)}>{name}</span>;
  return (
    <Link href={salesEntityHref(ws, kind, id)} className={cn("truncate text-fg underline-offset-2 hover:underline", className)}>
      {name}
    </Link>
  );
}
