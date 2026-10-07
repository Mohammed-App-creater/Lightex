"use client";

import { AnimatePresence, motion } from "motion/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { SidePanel } from "@/components/ui/side-panel";
import { useIsMobile, usePrefersReducedMotion } from "@/lib/hooks/use-media-query";
import { useCurrentWorkspace } from "@/lib/permissions/can";
import { routes, withTaskParam } from "@/lib/routes";
import { TaskDetailView } from "./task-detail";
import { taskOrigin } from "./task-origin";

const PANEL_W = 520;

/**
 * Opens the task side panel for ?task=KEY on any project view (board 09 §3.3–3.4).
 * Opening from a card morphs the card frame into the panel (250ms), then the panel mounts and
 * its content fades in. Below 760px the panel is a bottom sheet.
 */
export function TaskPanelHost() {
  const search = useSearchParams();
  const key = search.get("task")?.toUpperCase() ?? null;
  return <Host taskKey={key} search={search.toString()} />;
}

function Host({ taskKey, search }: { taskKey: string | null; search: string }) {
  const ws = useCurrentWorkspace()!;
  const router = useRouter();
  const pathname = usePathname();
  const reduced = usePrefersReducedMotion();
  const mobile = useIsMobile();
  const origin = useSyncExternalStore(taskOrigin.subscribe, taskOrigin.get, () => null);
  const [ghostFor, setGhostFor] = useState<string | null>(null);
  const [shownKey, setShownKey] = useState<string | null>(taskKey);
  const [skipEnter, setSkipEnter] = useState(false);

  // Decide, when the key changes, whether to morph from a card or swap in place.
  if (taskKey !== shownKey) {
    const morph = Boolean(taskKey && !shownKey && origin?.key === taskKey && !reduced && !mobile);
    setShownKey(taskKey);
    setGhostFor(morph ? taskKey : null);
    setSkipEnter(morph || Boolean(taskKey && shownKey));
  }

  useEffect(() => {
    if (!ghostFor) return;
    const id = setTimeout(() => {
      setGhostFor(null);
      taskOrigin.set(null);
    }, 260);
    return () => clearTimeout(id);
  }, [ghostFor]);

  const close = useCallback(() => {
    router.push(withTaskParam(pathname, search, null), { scroll: false });
  }, [router, pathname, search]);

  const toggleFull = useCallback(() => {
    if (taskKey) router.push(routes.task(ws.slug, taskKey));
  }, [router, taskKey, ws.slug]);

  const ghostRect = ghostFor && origin?.key === ghostFor ? origin.rect : null;

  return (
    <>
      {ghostRect && <MorphGhost rect={ghostRect} />}
      <AnimatePresence>
        {taskKey && !ghostFor && (
          <SidePanel key="task-panel" open onClose={close} label={`Task ${taskKey}`} width={PANEL_W} animateIn={!skipEnter}>
            <TaskDetailView key={taskKey} taskKey={taskKey} mode={mobile ? "sheet" : "panel"} onClose={close} onToggleFull={toggleFull} />
          </SidePanel>
        )}
      </AnimatePresence>
    </>
  );
}

/** The card frame growing into the panel. Transform + opacity only (no layout animation). */
function MorphGhost({ rect }: { rect: DOMRect }) {
  const vw = typeof window === "undefined" ? 1440 : window.innerWidth;
  const vh = typeof window === "undefined" ? 900 : window.innerHeight;
  const pw = Math.min(PANEL_W, vw);
  const px = vw - pw;
  return (
    <motion.div
      aria-hidden
      className="pointer-events-none fixed left-0 top-0 z-[45] origin-top-left rounded-none border border-accent bg-surface"
      style={{ width: pw, height: vh, x: px }}
      initial={{ x: rect.left, y: rect.top, scaleX: rect.width / pw, scaleY: rect.height / vh, opacity: 1 }}
      animate={{ x: px, y: 0, scaleX: 1, scaleY: 1, opacity: 1 }}
      transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
    />
  );
}
