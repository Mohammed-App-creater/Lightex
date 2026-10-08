import { Skeleton, SkeletonRows } from "@/components/ui/feedback";

/**
 * Shown inside the workspace shell while a page (home, inbox, my tasks, a project…) is still
 * loading on navigation, so the click is acknowledged at once instead of appearing stuck.
 */
export default function WorkspacePageLoading() {
  return (
    <div className="flex flex-col gap-5 px-8 py-6 max-[760px]:px-3 max-[760px]:py-4" aria-busy="true" aria-label="Loading page">
      <Skeleton className="h-7 w-56 max-w-full" />
      <SkeletonRows rows={6} label="Loading page" />
    </div>
  );
}
