import type { ID, ISODateTime, PresenceLocation, PresencePerson } from "@/lib/api/types";

/*
 * Realtime protocol version 1 (docs/v2/33-dashboards-presence.md §2.4). Every SSE `data:` line is
 * one envelope. Events are invalidation hints (ids, keys, versions, field names), never records.
 * Clients must ignore unknown types and unknown fields: adding either is non-breaking.
 */

export type RealtimeStatus = "connecting" | "live" | "polling" | "off";

export interface RealtimeEnvelope<T extends string = string, D = unknown> {
  v: 1;
  type: T;
  /** Durable events only; the same as the SSE `id:` line. */
  id?: string;
  /** Workspace id. */
  ws?: ID;
  projectId?: ID | null;
  /** Who caused it (null = system). */
  actorId?: ID | null;
  at?: ISODateTime;
  data: D;
}

export type TaskOp = "created" | "updated" | "moved" | "deleted" | "restored";
export type ProjectArea =
  | "settings"
  | "statuses"
  | "labels"
  | "members"
  | "sprints"
  | "epics"
  | "objectives"
  | "milestones"
  | "custom_fields"
  | "dependencies"
  | "time";

export type HelloEvent = RealtimeEnvelope<
  "hello",
  { connectionId: string; serverTime: ISODateTime; heartbeatSec: number; maxLifetimeSec: number; projects: ID[]; replayed: number }
>;
export type ResetEvent = RealtimeEnvelope<"reset", { reason: "unknown_cursor" | "gap" | "slow_consumer" | "broker_restart" }>;
export type ReconnectReason = "lifetime" | "token_expiry" | "access_changed" | "shutdown";
export type ReconnectEvent = RealtimeEnvelope<"reconnect", { reason: ReconnectReason; retryMs: number }>;
export type TaskChangedEvent = RealtimeEnvelope<
  "task.changed",
  { taskId: ID; key: string; op: TaskOp; version: number | null; fields: string[] }
>;
export type TasksBulkChangedEvent = RealtimeEnvelope<"tasks.bulk_changed", { taskIds: ID[] | null; op: TaskOp }>;
export type CommentChangedEvent = RealtimeEnvelope<
  "comment.changed",
  { taskId: ID; key: string; commentId: ID; op: "created" | "updated" | "deleted" }
>;
export type AttachmentChangedEvent = RealtimeEnvelope<"attachment.changed", { taskId: ID; key: string; op: "created" | "deleted" }>;
export type ProjectChangedEvent = RealtimeEnvelope<"project.changed", { areas: ProjectArea[] }>;
export type DashboardChangedEvent = RealtimeEnvelope<
  "dashboard.changed",
  { dashboardId: ID; op: "created" | "updated" | "layout" | "deleted"; version: number | null }
>;
export type InboxChangedEvent = RealtimeEnvelope<"inbox.changed", { unread: number }>;
export type AccessChangedEvent = RealtimeEnvelope<"access.changed", { projectId: ID | null }>;
export type PresenceUpdatedEvent = RealtimeEnvelope<
  "presence.updated",
  { location: PresenceLocation; people: PresencePerson[]; at: ISODateTime }
>;
/** Reserved for board 40; not emitted in this release (useImportJob keeps polling). */
export type ImportProgressEvent = RealtimeEnvelope<"import.progress", { jobId: ID; status: string; progress: unknown }>;

export type RealtimeEvent =
  | HelloEvent
  | ResetEvent
  | ReconnectEvent
  | TaskChangedEvent
  | TasksBulkChangedEvent
  | CommentChangedEvent
  | AttachmentChangedEvent
  | ProjectChangedEvent
  | DashboardChangedEvent
  | InboxChangedEvent
  | AccessChangedEvent
  | PresenceUpdatedEvent
  | ImportProgressEvent;

export type RealtimeEventType = RealtimeEvent["type"];

export const DURABLE_TYPES: readonly RealtimeEventType[] = [
  "task.changed",
  "tasks.bulk_changed",
  "comment.changed",
  "attachment.changed",
  "project.changed",
  "dashboard.changed",
  "inbox.changed",
  "access.changed",
];

/** Parses one `data:` payload. Returns null for anything that isn't a v1 envelope (ignored, never thrown). */
export function parseEnvelope(data: string): RealtimeEnvelope | null {
  try {
    const v = JSON.parse(data) as Partial<RealtimeEnvelope>;
    if (!v || typeof v !== "object" || v.v !== 1 || typeof v.type !== "string") return null;
    return { ...v, data: v.data ?? {} } as RealtimeEnvelope;
  } catch {
    return null;
  }
}
