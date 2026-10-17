"use client";

import { NotFoundScreen } from "@/platform/shell/edge-screens";
import { useCurrentWorkspace } from "@/platform/roles/can";
import { routes } from "@/lib/routes";

export default function WorkspaceNotFound() {
  const ws = useCurrentWorkspace();
  return <NotFoundScreen bare home={ws ? routes.home(ws.slug) : "/"} />;
}
