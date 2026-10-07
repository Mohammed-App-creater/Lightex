"use client";

import { ErrorScreen } from "@/components/shell/edge-screens";

/** Errors inside the shell keep the sidebar; only the content area is replaced. */
export default function WorkspaceError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorScreen bare error={error} onRetry={reset} />;
}
