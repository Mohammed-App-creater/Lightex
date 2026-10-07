"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { AppLoader } from "@/components/brand/app-loader";
import { useSession } from "@/features/auth/session";
import { useWorkspaces } from "@/features/workspace/queries";
import { routes } from "@/lib/routes";

/** "/" → the user's first workspace, onboarding if they have none, or sign in. */
export default function RootPage() {
  const { status } = useSession();
  const router = useRouter();
  const workspaces = useWorkspaces(status === "authenticated");

  useEffect(() => {
    if (status === "anonymous") router.replace(routes.login());
    if (status === "authenticated" && workspaces.data) {
      router.replace(workspaces.data[0] ? routes.home(workspaces.data[0].slug) : routes.onboarding());
    }
  }, [status, workspaces.data, router]);

  return <AppLoader />;
}
