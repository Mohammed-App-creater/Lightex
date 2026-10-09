import { Suspense } from "react";
import { AppLoader } from "@/components/brand/app-loader";
import { WorkspaceShell } from "@/components/shell/app-shell";
import { RealtimeProvider } from "@/lib/realtime/provider";

export default async function WorkspaceLayout({ children, params }: LayoutProps<"/[workspace]">) {
  const { workspace } = await params;
  return (
    <Suspense fallback={<AppLoader />}>
      <WorkspaceShell slug={workspace}>
        {/* Board 33 (v2): the workspace's realtime stream (leader tab) and this tab's presence heartbeat. */}
        <RealtimeProvider slug={workspace}>{children}</RealtimeProvider>
      </WorkspaceShell>
    </Suspense>
  );
}
