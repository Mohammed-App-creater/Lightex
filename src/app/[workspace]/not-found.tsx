"use client";

import { NotFoundScreen } from "@/components/shell/edge-screens";
import { useCurrentWorkspace } from "@/lib/permissions/can";
import { routes } from "@/lib/routes";

export default function WorkspaceNotFound() {
  const ws = useCurrentWorkspace();
  return <NotFoundScreen bare home={ws ? routes.home(ws.slug) : "/"} />;
}
