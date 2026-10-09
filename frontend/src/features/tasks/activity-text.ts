import type { ActivityEntry } from "@/lib/api/types";

/*
 * Plain-text form of an activity entry. Kept free of React and Tiptap so the project overview
 * and activity feed can import it without pulling the comment editor into their chunks.
 */

const VERB: Record<ActivityEntry["verb"], (a: ActivityEntry) => string> = {
  created: () => "created the task",
  status_changed: (a) => `moved this to ${a.data.to ?? "a new status"}`,
  assigned: (a) => `assigned ${a.data.assignee ?? "someone"}`,
  commented: () => "commented",
  linked_objective: (a) => `linked ${a.data.objective ?? "an objective"}`,
  updated: () => "updated the task",
  deleted: () => "deleted the task",
  restored: () => "restored the task",
  sprint_started: (a) => `started ${a.data.sprint ?? "the sprint"}`,
  sprint_completed: (a) => `completed ${a.data.sprint ?? "the sprint"}`,
  attached: (a) => `attached ${a.data.file ?? "a file"}`,
  member_added: (a) => `added ${a.data.member ?? "a member"}`,
  dependency_added: (a) =>
    a.data.relation === "blocks" ? `marked this as blocking ${a.data.otherKey ?? "a task"}` : `marked this blocked by ${a.data.otherKey ?? "a task"}`,
  dependency_removed: (a) => `removed the dependency on ${a.data.otherKey ?? "a task"}`,
  // Board 40: the task feed (task.imported) vs the project / workspace feeds (project.import_completed).
  imported: (a) => {
    const from = a.data.fileName ? ` from ${a.data.fileName}` : "";
    if (a.taskId) return `imported this task${from}`;
    const n = Number(a.data.imported ?? 0);
    return `imported ${n} ${n === 1 ? "task" : "tasks"}${from}`;
  },
  // Board 37 (§8.2): the actor is the member, or `actorName` ("GitHub") for integration rows.
  dev_linked: (a) => `linked ${prNoun(a)} ${a.data.ref ?? ""}`.trimEnd(),
  dev_branch_created: (a) => `created branch ${a.data.branch ?? ""}`.trimEnd(),
  dev_pr_merged: (a) => `· ${prNoun(a)} ${a.data.ref ?? ""} merged`,
};

const prNoun = (a: ActivityEntry) => (a.data.provider === "gitlab" ? "MR" : "PR");

/** Who did it: the member's name, the integration's name ("GitHub"), or "Lightex" for other system rows. */
export function activityActorName(a: Pick<ActivityEntry, "actorKind" | "actorName">, memberName: string | null | undefined) {
  if (a.actorKind === "integration") return a.actorName ?? "Integration";
  return memberName ?? a.actorName ?? "Lightex";
}

export function activityText(a: ActivityEntry, subject?: string) {
  const text = VERB[a.verb]?.(a) ?? a.verb;
  // In a project/workspace feed, name the task instead of "this" / "the task".
  return subject ? text.replace("moved this", `moved ${subject}`).replace("the task", subject) : text;
}
