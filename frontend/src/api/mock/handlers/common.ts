import type { ActivityVerb, NotificationEvent, NotificationKind } from "@/api/types";
import { notificationEventType } from "../derive";
import { nowISO, uid } from "../db";
import type { MockDB, ProjectRec, TaskRec } from "../db-types";
import { publishInbox } from "../realtime";
import { fanOut } from "../channels-dispatch";

export function logActivity(
  db: MockDB,
  actorId: string | null,
  verb: ActivityVerb,
  projectId: string,
  task: TaskRec | null,
  data: Record<string, string | number | null> = {},
) {
  db.activity.unshift({
    id: uid("act"),
    actorId,
    verb,
    projectId,
    taskId: task?.id ?? null,
    taskKey: task?.key ?? null,
    taskTitle: task?.title ?? null,
    data,
    createdAt: nowISO(),
  });
  if (db.activity.length > 500) db.activity.length = 500;
}

/**
 * Platform Stage 2: a notification names its target (describe(): title and link). Task notifications target the task,
 * project-only ones (sprint, access, import) the project. Links are app-relative here (the server sends absolute URLs).
 */
export function notificationTarget(db: MockDB, task: Pick<TaskRec, "id" | "key" | "title"> | null, project: ProjectRec) {
  const slug = db.workspaces.find((w) => w.id === project.workspaceId)?.slug ?? "";
  return task
    ? { targetType: "tracking.task", targetId: task.id, title: task.title, link: `/${slug}/tasks/${task.key}` }
    : { targetType: "tracking.project", targetId: project.id, title: project.name, link: `/${slug}/projects/${project.key}/board` };
}

/** Preference row per type; access requests have none (they can't be switched off). */
const EVENT_FOR: Record<NotificationKind, NotificationEvent | null> = {
  assigned: "tracking.task.assigned",
  mention: "core.comment.mentioned",
  status: "tracking.task.status_changed",
  comment: "core.comment.created",
  due: "tracking.task.due_soon",
  sprint: "tracking.sprint.started",
  access: null,
  import: null,
};

/** Creates an in-app notification when the recipient's preferences allow it. Never notifies the actor. */
export function notify(
  db: MockDB,
  recipientId: string,
  type: NotificationKind,
  actorId: string | null,
  task: TaskRec | null,
  projectId: string,
  payload: Record<string, string> = {},
) {
  if (recipientId === actorId) return;
  const prefs = db.prefs.find((p) => p.userId === recipientId)?.prefs;
  const event = EVENT_FOR[type];
  const project = db.projects.find((p) => p.id === projectId)!;
  const id = uid("n");
  const inApp = !(prefs && event && !prefs.events[event]?.in_app);
  // Board 38: Telegram / SMS / Push fan out even when in-app is off (access and import never do).
  if (event) {
    fanOut(db, recipientId, event, { workspaceId: project.workspaceId, notificationId: inApp ? id : null, taskKey: task?.key ?? null, urgent: task?.priority === 4 });
  }
  if (!inApp) return;
  db.notifications.unshift({
    id,
    recipientId,
    type,
    eventType: notificationEventType(type),
    actorId,
    projectId,
    projectName: project.name,
    taskId: task?.id ?? null,
    taskKey: task?.key ?? null,
    taskTitle: task?.title ?? null,
    payload,
    createdAt: nowISO(),
    readAt: null,
    ...notificationTarget(db, task, project),
  });
  // Board 33: inbox.changed to the recipient with the new unread count.
  publishInbox(db, recipientId, project.workspaceId);
}
