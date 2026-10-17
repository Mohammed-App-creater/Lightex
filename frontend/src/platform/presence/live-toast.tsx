"use client";

import { toast } from "@/components/ui/toast";
import type { User } from "@/lib/api/types";
import { firstName } from "./presence-lib";
import { LiveAvatar } from "./presence-stack";

/**
 * "Updated just now by Riley · Burndown" (spec §1.5): the live-ringed avatar, the message and a
 * mono key (a widget name on dashboards, "PRJ-42 · Due" in the task panel). One toast id, so a new
 * one replaces the last; callers throttle with claimLiveToast() (one per 4 s).
 */
export function liveUpdateToast(person: Pick<User, "name" | "hue">, what: string) {
  toast({
    id: "live-update",
    tone: "info",
    duration: 3800,
    icon: <LiveAvatar person={person} />,
    title: (
      <span>
        Updated just now by {firstName(person.name)} <span className="ml-1 font-mono text-[11.5px] font-medium text-fg-3">{what}</span>
      </span>
    ),
  });
}
