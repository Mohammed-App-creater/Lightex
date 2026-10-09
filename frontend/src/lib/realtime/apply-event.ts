import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { findTask, patchTasks } from "@/lib/api/optimistic";
import { qk } from "@/lib/api/query-keys";
import type {
  AttachmentChangedEvent,
  CommentChangedEvent,
  DashboardChangedEvent,
  InboxChangedEvent,
  IntegrationChangedEvent,
  PresenceUpdatedEvent,
  ProjectArea,
  ProjectChangedEvent,
  RealtimeEnvelope,
  TaskChangedEvent,
} from "./events";
import { remoteMarks } from "./remote";
import { replaceLocation, type CachedRoster } from "./roster";

/*
 * Event → TanStack Query cache (spec §7.8). Events are hints: they invalidate the queries that
 * could show the change, and the normal endpoints refetch (so every REST permission rule still
 * applies). Only presence and the unread count are written straight into the cache.
 *
 * - Invalidations are batched per animation frame + 150 ms (a Set of serialised keys) and always
 *   use refetchType "active": inactive queries are only marked stale.
 * - pause(projectId) (a board drag) queues that project's events until resume().
 */

export type ApplyContext = {
  slug: string;
  workspaceId?: string;
  meId: string;
  /** The task open in the panel / full page, for the "Updated just now" toast. */
  openTaskId?: () => string | null;
  /** The dashboard on screen, so a deletion by someone else can send the viewer to the index. */
  openDashboardId?: () => string | null;
  onOpenDashboardDeleted?: (id: string) => void;
};

export type Scheduler = (fn: () => void) => void;

const defaultScheduler: Scheduler = (fn) => {
  const later = () => setTimeout(fn, 150);
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(later);
  else later();
};

/** Task field (camelCase, from the audit diff) → the label in "PRJ-42 · Due". */
export const FIELD_LABEL: Record<string, string> = {
  title: "Title",
  description: "Description",
  statusId: "Status",
  assigneeId: "Assignee",
  dueDate: "Due",
  startDate: "Start",
  priority: "Priority",
  estimate: "Estimate",
  labelIds: "Labels",
  sprintId: "Sprint",
  epicId: "Epic",
  milestoneId: "Milestone",
  objectiveIds: "Objectives",
  timeEstimateMinutes: "Time estimate",
  position: "Status",
  type: "Type",
};

export function fieldLabel(field: string | undefined): string {
  if (!field) return "Updated";
  if (field.startsWith("customFields.")) return "Field";
  return FIELD_LABEL[field] ?? field;
}

let warnedUnknown = new Set<string>();

export function createEventApplier(qc: QueryClient, ctx: ApplyContext, schedule: Scheduler = defaultScheduler) {
  const pending = new Map<string, QueryKey>();
  let scheduled = false;
  const paused = new Map<string, number>();
  const queued = new Map<string, RealtimeEnvelope[]>();

  const flush = () => {
    scheduled = false;
    const keys = [...pending.values()];
    pending.clear();
    for (const queryKey of keys) void qc.invalidateQueries({ queryKey, refetchType: "active" });
  };

  const invalidate = (...keys: QueryKey[]) => {
    for (const k of keys) pending.set(JSON.stringify(k), k);
    if (!scheduled) {
      scheduled = true;
      schedule(flush);
    }
  };

  const isRemote = (ev: RealtimeEnvelope) => !!ev.actorId && ev.actorId !== ctx.meId;

  function onTask(ev: TaskChangedEvent) {
    const pid = ev.projectId;
    const d = ev.data;
    if (!pid) return;
    if (d.op !== "created" && d.op !== "deleted" && d.version != null) {
      const hit = findTask(qc, d.taskId, pid);
      // Own echo or already fresh everywhere: a cheap no-op.
      if (hit && hit.minVersion >= d.version) return;
    }
    // Board 37: linked PRs / branches / commits changed (version null): the Development section refetches.
    if (d.fields?.includes("development")) invalidate(qk.development(d.taskId));
    if (d.op === "deleted") patchTasks(qc, (t) => (t.id === d.taskId ? null : t), pid);
    if (isRemote(ev)) {
      remoteMarks.set(`p:${pid}`, { actorId: ev.actorId!, fields: d.fields });
      if (ctx.openTaskId?.() === d.taskId) remoteMarks.set(`t:${d.taskId}`, { actorId: ev.actorId!, fields: d.fields });
    }
    invalidate(
      qk.task(ctx.slug, d.key),
      ["p", pid, "board"],
      qk.taskList(pid),
      qk.backlog(pid),
      qk.schedules(pid),
      qk.unscheduled(pid),
      qk.summary(pid),
      qk.activity(pid),
      ["p", pid, "reports"],
      qk.views(ctx.slug),
      qk.myTasks(ctx.slug),
      qk.sprints(pid),
    );
  }

  function onProject(ev: ProjectChangedEvent) {
    const pid = ev.projectId;
    if (!pid) return;
    const by: Record<ProjectArea, QueryKey[]> = {
      settings: [["project", ctx.slug], qk.projects(ctx.slug)],
      statuses: [qk.statuses(pid), ["p", pid, "board"]],
      labels: [qk.labels(pid)],
      members: [qk.members(pid), ["project", ctx.slug]],
      sprints: [qk.sprints(pid), ["p", pid, "board"], qk.backlog(pid), ["p", pid, "reports"]],
      epics: [qk.epics(pid), qk.reports(pid, "progress")],
      objectives: [qk.objectives(pid), qk.reports(pid, "progress")],
      milestones: [qk.milestones(pid), qk.reports(pid, "progress")],
      custom_fields: [qk.customFields(pid)],
      dependencies: [["t"], ["p", pid, "board"], qk.taskList(pid), qk.schedules(pid)],
      time: [["t"], ["workspace", ctx.slug, "timesheet"], ["p", pid, "reports"]],
      development: [qk.devRules(pid), qk.projects(ctx.slug), ["project", ctx.slug]],
    };
    if (isRemote(ev)) remoteMarks.set(`p:${pid}`, { actorId: ev.actorId!, fields: [] });
    for (const area of ev.data.areas ?? []) {
      const keys = by[area];
      if (keys) invalidate(...keys);
    }
  }

  function onDashboard(ev: DashboardChangedEvent) {
    const d = ev.data;
    if (ev.projectId) invalidate(qk.dashboards(ev.projectId));
    if (d.op === "deleted") {
      qc.removeQueries({ queryKey: qk.dashboard(d.dashboardId) });
      if (isRemote(ev) && ctx.openDashboardId?.() === d.dashboardId) ctx.onOpenDashboardDeleted?.(d.dashboardId);
      return;
    }
    const cached = qc.getQueryData<{ version: number }>(qk.dashboard(d.dashboardId));
    if (cached && d.version != null && cached.version >= d.version) return;
    // The edit-mode draft is screen state, never this cache: invalidating can't touch it.
    invalidate(qk.dashboard(d.dashboardId));
  }

  function onInbox(ev: InboxChangedEvent) {
    const count = { count: ev.data.unread };
    if (ctx.workspaceId) qc.setQueryData(qk.unread(ctx.workspaceId), count);
    qc.setQueryData(qk.unread(), count);
    invalidate(["notifications"]);
  }

  function onPresence(ev: PresenceUpdatedEvent) {
    const pid = ev.projectId;
    if (!pid) return;
    qc.setQueryData<CachedRoster>(qk.presence(ctx.slug, pid), (r) => replaceLocation(r, pid, ev.data));
  }

  function handle(ev: RealtimeEnvelope) {
    switch (ev.type) {
      case "hello":
      case "reset":
      case "reconnect":
        return; // control events: the loop handles them
      case "task.changed":
        return onTask(ev as TaskChangedEvent);
      case "tasks.bulk_changed":
        if (ev.projectId) {
          if (isRemote(ev)) remoteMarks.set(`p:${ev.projectId}`, { actorId: ev.actorId!, fields: [] });
          invalidate(qk.scope(ev.projectId), qk.views(ctx.slug), ["task", ctx.slug], qk.myTasks(ctx.slug));
        }
        return;
      case "comment.changed": {
        const d = (ev as CommentChangedEvent).data;
        invalidate(qk.comments(d.taskId), qk.taskActivity(d.taskId), qk.task(ctx.slug, d.key));
        if (ev.projectId) invalidate(qk.activity(ev.projectId));
        return;
      }
      case "attachment.changed": {
        const d = (ev as AttachmentChangedEvent).data;
        invalidate(qk.attachments(d.taskId), qk.task(ctx.slug, d.key));
        return;
      }
      case "project.changed":
        return onProject(ev as ProjectChangedEvent);
      case "dashboard.changed":
        return onDashboard(ev as DashboardChangedEvent);
      case "inbox.changed":
        return onInbox(ev as InboxChangedEvent);
      case "access.changed":
        invalidate(qk.workspace(ctx.slug), qk.projects(ctx.slug), ["project", ctx.slug], qk.me());
        return;
      case "presence.updated":
        return onPresence(ev as PresenceUpdatedEvent);
      case "integration.changed":
        // Board 37: the settings page, devEnabled on projects, and every open Development section.
        invalidate(qk.integrations(ctx.slug), qk.projects(ctx.slug), ["project", ctx.slug], ["t"], ["integration", (ev as IntegrationChangedEvent).data.integrationId]);
        return;
      case "channels.changed":
        // Board 38: the channel rows / matrix columns, and an open Telegram dialog polls its link at once.
        invalidate(qk.channels(), ["notification-channels", "telegram-link"]);
        return;
      case "import.progress":
        return; // reserved (board 40 keeps polling)
      default:
        if (process.env.NODE_ENV !== "production" && !warnedUnknown.has(ev.type)) {
          warnedUnknown.add(ev.type);
          console.info(`[realtime] ignoring unknown event type "${ev.type}"`);
        }
    }
  }

  return {
    apply(ev: RealtimeEnvelope) {
      const pid = ev.projectId;
      if (pid && (paused.get(pid) ?? 0) > 0 && ev.type !== "presence.updated") {
        queued.set(pid, [...(queued.get(pid) ?? []), ev]);
        return;
      }
      handle(ev);
    },
    /** hello after connecting / polling, and reset: every active query of the workspace, once. */
    invalidateAll() {
      invalidate(["p"], ["task"], ["t"], ["dashboard"], ["notifications"], ["presence"], ["workspace", ctx.slug], ["project", ctx.slug]);
    },
    pause(projectId: string) {
      paused.set(projectId, (paused.get(projectId) ?? 0) + 1);
    },
    resume(projectId: string) {
      const n = (paused.get(projectId) ?? 0) - 1;
      if (n > 0) {
        paused.set(projectId, n);
        return;
      }
      paused.delete(projectId);
      const list = queued.get(projectId) ?? [];
      queued.delete(projectId);
      list.forEach(handle);
    },
    /** For tests: run the pending batch now. */
    flushNow: flush,
  };
}

export type EventApplier = ReturnType<typeof createEventApplier>;

/** Tests only. */
export function __resetUnknownWarnings() {
  warnedUnknown = new Set();
}
