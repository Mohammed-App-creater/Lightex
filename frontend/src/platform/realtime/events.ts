import type { ID, ISODateTime, PresenceLocation, PresencePerson } from "@/api/types";

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
  | "time"
  /** Board 37: automation rules, or which repositories apply to the project (devEnabled). */
  | "development";

export type HelloEvent = RealtimeEnvelope<
  "hello",
  { connectionId: string; serverTime: ISODateTime; heartbeatSec: number; maxLifetimeSec: number; projects: ID[]; replayed: number }
>;
export type ResetEvent = RealtimeEnvelope<"reset", { reason: "unknown_cursor" | "gap" | "slow_consumer" | "broker_restart" }>;
export type ReconnectReason = "lifetime" | "token_expiry" | "access_changed" | "shutdown";
export type ReconnectEvent = RealtimeEnvelope<"reconnect", { reason: ReconnectReason; retryMs: number }>;
export type TaskChangedEvent = RealtimeEnvelope<
  "tracking.task.changed",
  { taskId: ID; key: string; op: TaskOp; version: number | null; fields: string[] }
>;
export type TasksBulkChangedEvent = RealtimeEnvelope<"tracking.tasks.bulk_changed", { taskIds: ID[] | null; op: TaskOp }>;
/**
 * Platform Stage 2: collab events are core's, on a generic target (`targetType` "tracking.task", `targetId` the
 * record id). The envelope's projectId is set when the target belongs to a project; without one the event goes to
 * the whole workspace. `attachmentId` is sent with created / deleted.
 */
export type CommentOp = "created" | "updated" | "deleted" | "restored" | "purged";
export type AttachmentOp = "created" | "changed" | "deleted";
export type CommentEvent = RealtimeEnvelope<`core.comment.${CommentOp}`, { targetType: string; targetId: ID; commentId: ID }>;
export type AttachmentEvent = RealtimeEnvelope<`core.attachment.${AttachmentOp}`, { targetType: string; targetId: ID; attachmentId?: ID }>;
export const COMMENT_EVENT_TYPES = ["created", "updated", "deleted", "restored", "purged"].map((op) => `core.comment.${op}`) as CommentEvent["type"][];
export const ATTACHMENT_EVENT_TYPES = ["created", "changed", "deleted"].map((op) => `core.attachment.${op}`) as AttachmentEvent["type"][];
export type ProjectChangedEvent = RealtimeEnvelope<"tracking.project.changed", { areas: ProjectArea[] }>;
export type DashboardChangedEvent = RealtimeEnvelope<
  "tracking.dashboard.changed",
  { dashboardId: ID; op: "created" | "updated" | "layout" | "deleted"; version: number | null }
>;
export type InboxChangedEvent = RealtimeEnvelope<"core.inbox.changed", { unread: number }>;
export type AccessChangedEvent = RealtimeEnvelope<"core.access.changed", { projectId: ID | null }>;
export type PresenceUpdatedEvent = RealtimeEnvelope<
  "core.presence.updated",
  { location: PresenceLocation; people: PresencePerson[]; at: ISODateTime }
>;
/** Board 37: a workspace connection changed. Delivered to every member of the workspace (projectId null). */
export type IntegrationChangedEvent = RealtimeEnvelope<
  "tracking.integration.changed",
  { integrationId: ID; op: "connected" | "updated" | "synced" | "error" | "disconnected" }
>;
/**
 * Board 38: one of my notification channels changed (Telegram linked / disconnected / blocked, SMS STOP, push
 * expired). User-targeted (only the owner receives it), durable.
 */
export type ChannelsChangedEvent = RealtimeEnvelope<
  "core.channels.changed",
  { channel: "telegram" | "sms" | "push"; op: "linked" | "disconnected" | "status" }
>;
/**
 * Platform Stage 5: a module was switched on or off in the workspace. Delivered to every member (projectId null),
 * durable. The client refetches the workspace (enabledModules, my_permissions) and the module list.
 */
export type ModuleChangedEvent = RealtimeEnvelope<"core.module.changed", { module: string; enabled: boolean }>;
/** Reserved for board 40; not emitted in this release (useImportJob keeps polling). */
export type ImportProgressEvent = RealtimeEnvelope<"tracking.import.progress", { jobId: ID; status: string; progress: unknown }>;

export type RealtimeEvent =
  | HelloEvent
  | ResetEvent
  | ReconnectEvent
  | TaskChangedEvent
  | TasksBulkChangedEvent
  | CommentEvent
  | AttachmentEvent
  | ProjectChangedEvent
  | DashboardChangedEvent
  | InboxChangedEvent
  | AccessChangedEvent
  | PresenceUpdatedEvent
  | IntegrationChangedEvent
  | ChannelsChangedEvent
  | ModuleChangedEvent
  | ImportProgressEvent;

export type RealtimeEventType = RealtimeEvent["type"];

export const DURABLE_TYPES: readonly RealtimeEventType[] = [
  "tracking.task.changed",
  "tracking.tasks.bulk_changed",
  ...COMMENT_EVENT_TYPES,
  ...ATTACHMENT_EVENT_TYPES,
  "tracking.project.changed",
  "tracking.dashboard.changed",
  "core.inbox.changed",
  "core.access.changed",
  "tracking.integration.changed",
  "core.channels.changed",
  "core.module.changed",
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
