import type { ActivityVerb, NotificationEvent, NotificationType } from "@/lib/api/types";
import { nowISO, uid } from "../db";
import type { MockDB, TaskRec } from "../db-types";
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

/** Preference row per type; access requests have none (they can't be switched off). */
const EVENT_FOR: Record<NotificationType, NotificationEvent | null> = {
  assigned: "assigned",
  mention: "mentioned",
  status: "status_change",
  comment: "comment",
  due: "due_soon",
  sprint: "sprint_started",
  access: null,
  import: null,
};

/** Creates an in-app notification when the recipient's preferences allow it. Never notifies the actor. */
export function notify(
  db: MockDB,
  recipientId: string,
  type: NotificationType,
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
    actorId,
    projectId,
    projectName: project.name,
    taskId: task?.id ?? null,
    taskKey: task?.key ?? null,
    taskTitle: task?.title ?? null,
    payload,
    createdAt: nowISO(),
    readAt: null,
  });
  // Board 33: inbox.changed to the recipient with the new unread count.
  publishInbox(db, recipientId, project.workspaceId);
}
