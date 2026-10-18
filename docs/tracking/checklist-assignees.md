# Task checklists and multiple assignees

Contract for two task features, shared by the backend (`backend/modules/tracking/tasks/`) and the frontend.
`docs/openapi.yaml` is the source of truth for shapes; this page records the behaviour.

## 1. Multiple assignees

A task has 0–10 assignees. `assigneeIds: string[]` **replaces** the single `assigneeId` everywhere
(`Task`, `TaskDetail`, the dependency task summary, and every write).

| Rule | Behaviour |
|---|---|
| Order | Ids come back in the order last sent. A person added later goes last. |
| Write | `POST …/tasks`, `PATCH /tracking/tasks/{ref}` and `POST …/tasks/bulk` `patch` take `assigneeIds` and **replace** the set. `[]` or `null` unassigns everyone. Duplicates are dropped. |
| Validation | 422 `assigneeIds`: "Send a list of ids" · "Assign up to 10 people" · "Assign people on this project". Sending the old `assigneeId` on PATCH or bulk is 422 "This field can’t be changed here". |
| Permission | Create: assigning anyone other than yourself needs `tracking.task.assign` (403 "You can’t assign tasks to others."). Update and bulk: changing the set needs `tracking.task.assign` (403 "You can’t reassign tasks."). A reorder alone is not a change. |
| Edit own | `tracking.task.edit_own` covers tasks you reported **or are one of the assignees of**. |
| Filters | `filter[assignee]=<id>|me|none` (list, project and workspace task lists, `/me/tasks`) matches a task when **any** assignee matches; `none` = nobody assigned. Saved-view `assignee` rules follow the same rules (`is`, `not`, `any`, `empty`). |
| Notifications | `tracking.task.assigned` fires once per **newly added** person (payload `{taskId, assigneeId}`). Status changes go to every assignee and the reporter. Due-soon reminders go to every assignee. Comment subscribers are the reporter and every assignee. |
| Audit and activity | One `tracking.task.assigned` row per change, with one `Assignee` `person` change per person added (`before: null`) or removed (`after: null`). `data.assignee` is the new names joined with ", " (or "nobody"); `data.assigneeCount` is how many. |
| Realtime | `tracking.task.changed` with `fields: ["assigneeIds"]`. |
| Workload report | A task with several assignees counts in full for each of them. Unassigned = no assignees. |
| Import | Unchanged: the CSV assignee column maps to one person, who becomes the only assignee. |

Migration `tasks.0002` copies each existing `assignee` into the new `TaskAssignee` table before it drops the
column (reversible: going back keeps the first assignee).

## 2. Checklist (to-do list)

Every task has an ordered checklist of up to 100 items.

```ts
ChecklistItem {
  id: string; taskId: string;
  text: string;            // 1–500 characters, trimmed
  done: boolean;
  position: string;        // base-62 fractional index, same scheme as Task.position
  doneAt: string | null; doneById: string | null;
  createdAt: string; createdById: string | null;
}
```

- `Task` (list and detail) gains `checklistCount` and `checklistDoneCount`. `TaskDetail` gains `checklist:
  ChecklistItem[]` in position order.

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/tracking/tasks/{taskId}/checklist` | `{text, position?}` (omitted or null → last) | 201 `ChecklistItem` |
| PATCH | `/tracking/tasks/{taskId}/checklist/{itemId}` | any of `{text, done, position}` | 200 `ChecklistItem` |
| DELETE | `/tracking/tasks/{taskId}/checklist/{itemId}` | — | 204 |

- **Permission:** the task edit rule (`tracking.task.edit_any`, or `edit_own` as reporter or assignee), else 403
  "You can only edit tasks you reported or are assigned." (`details.permission` `tracking.task.edit_any`).
- **Errors:** 422 `text` "Write what needs doing" · "Up to 500 characters"; 422 `position` "Invalid position";
  422 `done` "Send true or false"; 422 on unknown keys; 409 `checklist_limit` at 100 items; 409 `task_deleted` on a
  deleted task; 404 for an unknown item or one on another task.
- **Version:** checklist writes do **not** bump the task's `version` (no 409 for someone editing the task meanwhile).
- **Done:** `done: true` stamps `doneAt` / `doneById`; `false` clears them.
- **Audit:** `tracking.task.checklist_updated`, `data {op, text}` with op `added | checked | unchecked | renamed |
  moved | removed`. Audit only: not in the activity feeds.
- **Realtime:** `tracking.task.changed` `{fields: ["checklist"], version: null}`.
