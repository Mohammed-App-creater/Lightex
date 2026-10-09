import type { HttpMethod } from "@/lib/api/transport";
import type { MockDB } from "./db-types";
import { publishAccess, publishProject, publishTask } from "./realtime";

/*
 * Board 33: project-level realtime events for the planning and settings routes, from one table
 * instead of a publish() call in each handler (the backend gets the same mapping from its audit hook,
 * spec §6.2). The project is resolved *before* the handler runs (a DELETE removes the record) and
 * the event is published only after the handler succeeded.
 */

type Params = Record<string, string>;
type Rule = {
  methods: HttpMethod[];
  pattern: string;
  project: (p: Params, db: MockDB) => string | null | undefined;
  publish: (db: MockDB, actorId: string | null, projectId: string, p: Params, body: unknown) => void;
};

const area = (a: string) => (db: MockDB, actor: string | null, pid: string) => publishProject(db, actor, pid, [a]);
const byId = (list: keyof MockDB, key = "id") => (p: Params, db: MockDB) =>
  ((db[list] as { id: string; projectId: string }[] | undefined) ?? []).find((x) => x.id === p[key])?.projectId;
const param = (p: Params) => p.id;
const W: HttpMethod[] = ["POST", "PATCH", "PUT", "DELETE"];

/** A task's time or dependencies changed: its version doesn't move, so `version: null` (always refetch). */
const taskTouch = (field: string) => (db: MockDB, actor: string | null, _pid: string, p: Params) => {
  const t = db.tasks.find((x) => x.id === p.id);
  if (t) publishTask(db, actor, { ...t, version: null as unknown as number }, "updated", [field]);
};

const RULES: Rule[] = [
  { methods: ["PATCH"], pattern: "/projects/:id", project: param, publish: area("settings") },
  { methods: ["POST"], pattern: "/projects/:id/archive", project: param, publish: area("settings") },
  { methods: ["POST"], pattern: "/projects/:id/unarchive", project: param, publish: area("settings") },
  { methods: ["POST"], pattern: "/projects/:id/statuses", project: param, publish: area("statuses") },
  { methods: ["PATCH", "DELETE"], pattern: "/projects/:id/statuses/:statusId", project: param, publish: area("statuses") },
  { methods: ["POST"], pattern: "/projects/:id/labels", project: param, publish: area("labels") },
  { methods: ["PATCH", "DELETE"], pattern: "/projects/:id/labels/:labelId", project: param, publish: area("labels") },
  {
    methods: ["POST"],
    pattern: "/projects/:id/members",
    project: param,
    publish: (db, actor, pid, _p, body) => publishAccess(db, actor, String((body as { userId?: string })?.userId ?? ""), pid),
  },
  { methods: ["PATCH", "DELETE"], pattern: "/projects/:id/members/:userId", project: param, publish: (db, actor, pid, p) => publishAccess(db, actor, p.userId!, pid) },
  { methods: ["POST"], pattern: "/projects/:id/objectives", project: param, publish: area("objectives") },
  { methods: ["PATCH", "DELETE"], pattern: "/objectives/:id", project: byId("objectives"), publish: area("objectives") },
  { methods: ["POST"], pattern: "/objectives/:id/tasks", project: byId("objectives"), publish: area("objectives") },
  { methods: ["DELETE"], pattern: "/objectives/:id/tasks/:taskId", project: byId("objectives"), publish: area("objectives") },
  { methods: ["POST"], pattern: "/projects/:id/milestones", project: param, publish: area("milestones") },
  { methods: ["PATCH", "DELETE"], pattern: "/milestones/:id", project: byId("milestones"), publish: area("milestones") },
  { methods: ["POST"], pattern: "/projects/:id/epics", project: param, publish: area("epics") },
  { methods: ["PATCH", "DELETE"], pattern: "/epics/:id", project: byId("epics"), publish: area("epics") },
  { methods: ["POST"], pattern: "/projects/:id/sprints", project: param, publish: area("sprints") },
  { methods: ["PATCH", "DELETE"], pattern: "/sprints/:id", project: byId("sprints"), publish: area("sprints") },
  { methods: ["POST"], pattern: "/sprints/:id/start", project: byId("sprints"), publish: area("sprints") },
  { methods: ["POST"], pattern: "/sprints/:id/complete", project: byId("sprints"), publish: area("sprints") },
  { methods: ["POST"], pattern: "/projects/:id/custom-fields", project: param, publish: area("custom_fields") },
  { methods: ["PUT"], pattern: "/projects/:id/custom-fields/order", project: param, publish: area("custom_fields") },
  { methods: ["PATCH", "DELETE"], pattern: "/custom-fields/:fieldId", project: byId("customFields", "fieldId"), publish: area("custom_fields") },
  { methods: ["POST"], pattern: "/tasks/:id/dependencies", project: byId("tasks"), publish: taskTouch("dependencies") },
  { methods: ["DELETE"], pattern: "/tasks/:id/dependencies/:dependencyId", project: byId("tasks"), publish: taskTouch("dependencies") },
  { methods: ["POST"], pattern: "/tasks/:id/time-entries", project: byId("tasks"), publish: taskTouch("loggedMinutes") },
];

/** Call before the handler; the returned function publishes after it succeeded (or does nothing). */
export function prepareRoutePublish(method: HttpMethod, pattern: string, params: Params, body: unknown, db: MockDB, actorId: string | null) {
  if (!W.includes(method)) return null;
  const rule = RULES.find((r) => r.pattern === pattern && r.methods.includes(method));
  if (!rule) return null;
  const projectId = rule.project(params, db);
  if (!projectId) return null;
  return () => rule.publish(db, actorId, projectId, params, body);
}
