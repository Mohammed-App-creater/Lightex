"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Skeleton } from "@/components/ui/feedback";
import { can, useCurrentWorkspace } from "@/lib/permissions/can";
import { routes } from "@/lib/routes";

/** /settings → General for people who can edit the workspace, Profile for everyone else. */
export function SettingsIndex() {
  const ws = useCurrentWorkspace()!;
  const router = useRouter();
  const target = routes.settings(ws.slug, can("workspace.update", ws.my_permissions) ? "general" : "profile");
  useEffect(() => router.replace(target), [router, target]);
  return (
    <div aria-busy="true" aria-label="Loading settings" className="mx-auto flex max-w-[880px] flex-col gap-4 px-10 pt-7">
      <Skeleton className="h-5 w-[140px]" />
      <Skeleton className="h-[34px] w-full" />
    </div>
  );
}
