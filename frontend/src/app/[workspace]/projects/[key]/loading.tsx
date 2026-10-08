import { SkeletonRows } from "@/components/ui/feedback";

/**
 * Shown inside the project shell while a view (board, list, backlog…) is still loading on
 * navigation. Without it the tab click gives no feedback until the server answers.
 */
export default function ProjectViewLoading() {
  return (
    <div className="px-8 py-6 max-[760px]:px-3 max-[760px]:py-4">
      <SkeletonRows rows={6} label="Loading view" />
    </div>
  );
}
