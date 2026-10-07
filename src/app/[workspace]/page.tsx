"use client";

import { useCurrentWorkspace } from "@/lib/permissions/can";

/** Workspace home (built in step 5). */
export default function WorkspaceHome() {
  const ws = useCurrentWorkspace();
  return (
    <div className="mx-auto max-w-[1180px] px-8 py-7">
      <h1 className="m-0 text-h2">{ws?.name}</h1>
    </div>
  );
}
