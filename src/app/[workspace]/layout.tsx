import { Suspense } from "react";
import { AppLoader } from "@/components/brand/app-loader";
import { WorkspaceShell } from "@/components/shell/app-shell";

export default async function WorkspaceLayout({ children, params }: LayoutProps<"/[workspace]">) {
  const { workspace } = await params;
  return (
    <Suspense fallback={<AppLoader />}>
      <WorkspaceShell slug={workspace}>{children}</WorkspaceShell>
    </Suspense>
  );
}
