import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { Notification, NotificationType } from "@/api/types";
import { trackingServices } from "@/modules/tracking/services";

/*
 * Non-UI module contributions (platform Stage 2), the frontend side of the backend's target and event type
 * registries. Platform code (realtime, notifications) asks here instead of importing a module. Kept apart from
 * the UI registry (`./index.ts`) so pure code and its tests don't load screens.
 */

export type TargetContext = { qc: QueryClient; slug: string; projectId: string | null | undefined };

/** A target type ("tracking.task") that comments and attachments can hang off. */
export interface TargetDefinition {
  label: string;
  /** Queries beyond the target's own comments / attachments that a collab change touches (detail, activity). */
  related?: (targetId: string, ctx: TargetContext) => QueryKey[];
}

export interface ModuleServices {
  targets?: Record<string, TargetDefinition>;
  /** Line text for module-owned notification types (lead in bold, then the rest). */
  notificationText?: Partial<Record<NotificationType, (n: Notification) => { lead: string; rest: string }>>;
}

const SERVICES: readonly ModuleServices[] = [trackingServices];

export function targetDefinition(targetType: string): TargetDefinition | undefined {
  for (const s of SERVICES) {
    const t = s.targets?.[targetType];
    if (t) return t;
  }
  return undefined;
}

export function notificationText(n: Notification): { lead: string; rest: string } | null {
  for (const s of SERVICES) {
    const f = s.notificationText?.[n.type];
    if (f) return f(n);
  }
  return null;
}
