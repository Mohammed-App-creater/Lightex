import type { EpicWrite } from "@/lib/api/types";
import { isDoneStatus } from "@/lib/domain/progress";
import { nowISO, uid } from "../db";
import type { EpicRec, MilestoneRec, ObjectiveRec, SprintRec } from "../db-types";
import { statusesOf, toEpic, toMilestone, toObjective, toSprint } from "../derive";
import { logActivity, notify } from "./common";
import { memberProject } from "./projects";
import { fail, invalid, projectById, requireProject, route, str, type Ctx } from "../router";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function bodyOf<T>(ctx: Ctx) {
  return (ctx.body ?? {}) as Partial<T>;
}

function find<T extends { id: string; projectId: string }>(list: T[], id: string, what: string) {
  const item = list.find((x) => x.id === id);
  if (!item) fail(404, "not_found", `${what} not found.`);
  return item;
}

export function registerPlanning() {
  /* objectives */
  route("GET", "/projects/:id/objectives", (ctx) => {
    const p = memberProject(ctx, ctx.params.id!);
    return ctx.db.objectives.filter((o) => o.projectId === p.id).map((o) => toObjective(ctx.db, o));
  });
  route("POST", "/projects/:id/objectives", (ctx) => {
    const p = projectById(ctx, ctx.params.id!);
    requireProject(ctx, p.id, "objective.manage");
    const b = bodyOf<ObjectiveRec>(ctx);
    const fields: Record<string, string> = {};
    if (!b.title?.trim()) fields.title = "Add a title";
    if (!b.dueDate || !DATE_RE.test(b.dueDate)) fields.dueDate = "Pick a date";
    if (Object.keys(fields).length) invalid(fields);
    const o: ObjectiveRec = {
      id: uid("ob"),
      projectId: p.id,
      title: b.title!.trim().slice(0, 120),
      description: (b.description ?? "").slice(0, 1000),
      ownerId: b.ownerId ?? ctx.userId,
      quarter: b.quarter ?? "Q4",
      dueDate: b.dueDate!,
      status: "active",
      createdAt: nowISO(),
    };
    ctx.db.objectives.push(o);
    return toObjective(ctx.db, o);
  });
  route("PATCH", "/objectives/:id", (ctx) => {
    const o = find(ctx.db.objectives, ctx.params.id!, "Objective");
    requireProject(ctx, o.projectId, "objective.manage");
    const b = bodyOf<ObjectiveRec>(ctx);
    if (b.title !== undefined) {
      if (!b.title.trim()) invalid({ title: "Add a title" });
      o.title = b.title.trim().slice(0, 120);
    }
    if (b.description !== undefined) o.description = b.description.slice(0, 1000);
    if (b.ownerId !== undefined) o.ownerId = b.ownerId;
    if (b.dueDate !== undefined) {
      if (!b.dueDate || !DATE_RE.test(b.dueDate)) invalid({ dueDate: "Pick a date" });
      o.dueDate = b.dueDate;
    }
    if (b.status !== undefined) o.status = b.status;
    return toObjective(ctx.db, o);
  });
  route("DELETE", "/objectives/:id", (ctx) => {
    const o = find(ctx.db.objectives, ctx.params.id!, "Objective");
    requireProject(ctx, o.projectId, "objective.manage");
    ctx.db.objectives = ctx.db.objectives.filter((x) => x.id !== o.id);
    ctx.db.tasks.forEach((t) => (t.objectiveIds = t.objectiveIds.filter((x) => x !== o.id)));
    return undefined;
  });
  route("POST", "/objectives/:id/tasks", (ctx) => {
    const o = find(ctx.db.objectives, ctx.params.id!, "Objective");
    requireProject(ctx, o.projectId, "objective.manage");
    const ids = ((ctx.body as { taskIds?: string[] })?.taskIds ?? []).slice(0, 200);
    for (const id of ids) {
      const t = ctx.db.tasks.find((x) => x.id === id && x.projectId === o.projectId);
      if (t && !t.objectiveIds.includes(o.id)) {
        t.objectiveIds.push(o.id);
        t.version += 1;
        logActivity(ctx.db, ctx.userId, "linked_objective", o.projectId, t, { objective: o.title });
      }
    }
    return toObjective(ctx.db, o);
  });
  route("DELETE", "/objectives/:id/tasks/:taskId", (ctx) => {
    const o = find(ctx.db.objectives, ctx.params.id!, "Objective");
    requireProject(ctx, o.projectId, "objective.manage");
    const t = ctx.db.tasks.find((x) => x.id === ctx.params.taskId);
    if (t) {
      t.objectiveIds = t.objectiveIds.filter((x) => x !== o.id);
      t.version += 1;
    }
    return toObjective(ctx.db, o);
  });

  /* milestones */
  route("GET", "/projects/:id/milestones", (ctx) => {
    const p = memberProject(ctx, ctx.params.id!);
    return ctx.db.milestones
      .filter((m) => m.projectId === p.id)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
      .map((m) => toMilestone(ctx.db, m));
  });
  route("POST", "/projects/:id/milestones", (ctx) => {
    const p = projectById(ctx, ctx.params.id!);
    requireProject(ctx, p.id, "milestone.manage");
    const b = bodyOf<MilestoneRec & { taskIds: string[] }>(ctx);
    const fields: Record<string, string> = {};
    if (!b.name?.trim()) fields.name = "Add a title";
    if (!b.dueDate || !DATE_RE.test(b.dueDate)) fields.dueDate = "Pick a date";
    if (Object.keys(fields).length) invalid(fields);
    const today = new Date().toISOString().slice(0, 10);
    const m: MilestoneRec = {
      id: uid("ms"),
      projectId: p.id,
      name: b.name!.trim().slice(0, 120),
      description: (b.description ?? "").slice(0, 1000),
      ownerId: b.ownerId ?? ctx.userId,
      startDate: b.startDate && DATE_RE.test(b.startDate) ? b.startDate : b.dueDate! < today ? b.dueDate! : today,
      dueDate: b.dueDate!,
      completedAt: null,
    };
    ctx.db.milestones.push(m);
    linkMilestoneTasks(ctx, m, b.taskIds);
    return toMilestone(ctx.db, m);
  });
  route("PATCH", "/milestones/:id", (ctx) => {
    const m = find(ctx.db.milestones, ctx.params.id!, "Milestone");
    requireProject(ctx, m.projectId, "milestone.manage");
    const b = bodyOf<MilestoneRec & { taskIds: string[]; completed: boolean }>(ctx);
    if (b.name !== undefined) {
      if (!b.name.trim()) invalid({ name: "Add a title" });
      m.name = b.name.trim().slice(0, 120);
    }
    if (b.description !== undefined) m.description = b.description.slice(0, 1000);
    if (b.ownerId !== undefined) m.ownerId = b.ownerId;
    if (b.dueDate !== undefined) {
      if (!DATE_RE.test(b.dueDate)) invalid({ dueDate: "Pick a date" });
      m.dueDate = b.dueDate;
      if (m.startDate > m.dueDate) m.startDate = m.dueDate;
    }
    if (b.completed !== undefined) m.completedAt = b.completed ? nowISO() : null;
    if (b.taskIds) linkMilestoneTasks(ctx, m, b.taskIds);
    return toMilestone(ctx.db, m);
  });
  route("DELETE", "/milestones/:id", (ctx) => {
    const m = find(ctx.db.milestones, ctx.params.id!, "Milestone");
    requireProject(ctx, m.projectId, "milestone.manage");
    ctx.db.milestones = ctx.db.milestones.filter((x) => x.id !== m.id);
    ctx.db.tasks.forEach((t) => t.milestoneId === m.id && (t.milestoneId = null));
    return undefined;
  });

  /* epics */
  route("GET", "/projects/:id/epics", (ctx) => {
    const p = memberProject(ctx, ctx.params.id!);
    return ctx.db.epics.filter((e) => e.projectId === p.id).map((e) => toEpic(ctx.db, e));
  });
  route("POST", "/projects/:id/epics", (ctx) => {
    const p = projectById(ctx, ctx.params.id!);
    requireProject(ctx, p.id, "epic.manage");
    const b = bodyOf<EpicWrite>(ctx);
    if (!b.name?.trim()) invalid({ name: "Name the epic" });
    checkEpicFields(ctx, p.id, b, null);
    const e: EpicRec = {
      id: uid("ep"),
      projectId: p.id,
      name: b.name!.trim().slice(0, 80),
      description: (b.description ?? "").slice(0, 600),
      hue: typeof b.hue === "number" ? b.hue : Math.floor(Math.random() * 360),
      ownerId: b.ownerId ?? ctx.userId ?? null,
      milestoneId: b.milestoneId ?? null,
      archivedAt: null,
    };
    ctx.db.epics.push(e);
    return toEpic(ctx.db, e);
  });
  route("PATCH", "/epics/:id", (ctx) => {
    const e = find(ctx.db.epics, ctx.params.id!, "Epic");
    requireProject(ctx, e.projectId, "epic.manage");
    const b = bodyOf<EpicWrite>(ctx);
    if (b.name !== undefined) {
      if (!b.name.trim()) invalid({ name: "Name the epic" });
      e.name = b.name.trim().slice(0, 80);
    }
    checkEpicFields(ctx, e.projectId, b, e.id);
    if (b.description !== undefined) e.description = b.description.slice(0, 600);
    if (typeof b.hue === "number") e.hue = b.hue;
    if (b.ownerId !== undefined) e.ownerId = b.ownerId;
    if (b.milestoneId !== undefined) e.milestoneId = b.milestoneId;
    if (b.archived !== undefined) e.archivedAt = b.archived ? (e.archivedAt ?? nowISO()) : null;
    return toEpic(ctx.db, e);
  });
  route("DELETE", "/epics/:id", (ctx) => {
    const e = find(ctx.db.epics, ctx.params.id!, "Epic");
    requireProject(ctx, e.projectId, "epic.manage");
    ctx.db.epics = ctx.db.epics.filter((x) => x.id !== e.id);
    ctx.db.tasks.forEach((t) => t.epicId === e.id && (t.epicId = null));
    return undefined;
  });

  /* sprints */
  route("GET", "/projects/:id/sprints", (ctx) => {
    const p = memberProject(ctx, ctx.params.id!);
    return ctx.db.sprints
      .filter((s) => s.projectId === p.id)
      .sort((a, b) => a.number - b.number)
      .map((s) => toSprint(ctx.db, s));
  });
  route("POST", "/projects/:id/sprints", (ctx) => {
    const p = projectById(ctx, ctx.params.id!);
    requireProject(ctx, p.id, "sprint.manage");
    const b = bodyOf<SprintRec>(ctx);
    const existing = ctx.db.sprints.filter((s) => s.projectId === p.id);
    const number = existing.reduce((a, s) => Math.max(a, s.number), 0) + 1;
    const last = existing.sort((a, z) => z.endDate.localeCompare(a.endDate))[0];
    const start = b.startDate && DATE_RE.test(b.startDate) ? b.startDate : last ? addDays(last.endDate, 1) : new Date().toISOString().slice(0, 10);
    const end = b.endDate && DATE_RE.test(b.endDate) ? b.endDate : addDays(start, 13);
    if (end < start) invalid({ endDate: "End must be after start" });
    const s: SprintRec = {
      id: uid("sp"),
      projectId: p.id,
      name: b.name?.trim() || `Sprint ${number}`,
      number,
      goal: (b.goal ?? "").slice(0, 200),
      startDate: start,
      endDate: end,
      state: "planned",
      completedAt: null,
    };
    ctx.db.sprints.push(s);
    return toSprint(ctx.db, s);
  });
  route("PATCH", "/sprints/:id", (ctx) => {
    const s = find(ctx.db.sprints, ctx.params.id!, "Sprint");
    requireProject(ctx, s.projectId, "sprint.manage");
    const b = bodyOf<SprintRec>(ctx);
    if (b.name !== undefined) s.name = b.name.trim().slice(0, 60) || s.name;
    if (b.goal !== undefined) s.goal = b.goal.slice(0, 200);
    if (b.startDate !== undefined && DATE_RE.test(b.startDate)) s.startDate = b.startDate;
    if (b.endDate !== undefined && DATE_RE.test(b.endDate)) s.endDate = b.endDate;
    if (s.endDate < s.startDate) invalid({ endDate: "End must be after start" });
    return toSprint(ctx.db, s);
  });
  route("DELETE", "/sprints/:id", (ctx) => {
    const s = find(ctx.db.sprints, ctx.params.id!, "Sprint");
    requireProject(ctx, s.projectId, "sprint.manage");
    if (s.state !== "planned") fail(409, "sprint_not_planned", "Only planned sprints can be deleted.");
    ctx.db.tasks.forEach((t) => t.sprintId === s.id && (t.sprintId = null));
    ctx.db.sprints = ctx.db.sprints.filter((x) => x.id !== s.id);
    return undefined;
  });
  route("POST", "/sprints/:id/start", (ctx) => {
    const s = find(ctx.db.sprints, ctx.params.id!, "Sprint");
    requireProject(ctx, s.projectId, "sprint.manage");
    if (ctx.db.sprints.some((x) => x.projectId === s.projectId && x.state === "active"))
      fail(409, "sprint_active", "Complete the active sprint first.");
    if (!ctx.db.tasks.some((t) => t.sprintId === s.id && !t.deletedAt))
      fail(409, "sprint_empty", "Add tasks to the sprint before starting it.");
    const b = bodyOf<SprintRec>(ctx);
    if (b.startDate && DATE_RE.test(b.startDate)) s.startDate = b.startDate;
    if (b.endDate && DATE_RE.test(b.endDate)) s.endDate = b.endDate;
    if (b.goal !== undefined) s.goal = b.goal;
    s.state = "active";
    logActivity(ctx.db, ctx.userId, "sprint_started", s.projectId, null, { sprint: s.name });
    ctx.db.projectMembers
      .filter((m) => m.projectId === s.projectId)
      .forEach((m) => notify(ctx.db, m.userId, "sprint", ctx.userId, null, s.projectId, { sprintName: s.name }));
    return toSprint(ctx.db, s);
  });
  route("POST", "/sprints/:id/complete", (ctx) => {
    const s = find(ctx.db.sprints, ctx.params.id!, "Sprint");
    requireProject(ctx, s.projectId, "sprint.manage");
    if (s.state !== "active") fail(409, "sprint_not_active", "Only the active sprint can be completed.");
    const target = str(ctx.body, "moveOpenTasksTo") ?? "backlog";
    const statuses = statusesOf(ctx.db, s.projectId);
    const targetSprint = target === "backlog" ? null : ctx.db.sprints.find((x) => x.id === target && x.projectId === s.projectId && x.state === "planned");
    if (target !== "backlog" && !targetSprint) invalid({ moveOpenTasksTo: "Pick a planned sprint or the backlog" });
    let moved = 0;
    ctx.db.tasks
      .filter((t) => t.sprintId === s.id && !t.deletedAt && !isDoneStatus(t.statusId, statuses) && statuses.find((x) => x.id === t.statusId)?.glyph !== "canceled")
      .forEach((t) => {
        t.sprintId = targetSprint?.id ?? null;
        t.version += 1;
        moved += 1;
      });
    s.state = "completed";
    s.completedAt = nowISO();
    logActivity(ctx.db, ctx.userId, "sprint_completed", s.projectId, null, { sprint: s.name, moved });
    return toSprint(ctx.db, s);
  });
}

function linkMilestoneTasks(ctx: Ctx, m: MilestoneRec, taskIds: string[] | undefined) {
  if (!taskIds) return;
  ctx.db.tasks
    .filter((t) => t.projectId === m.projectId)
    .forEach((t) => {
      const want = taskIds.includes(t.id);
      if (want && t.milestoneId !== m.id) {
        t.milestoneId = m.id;
        t.version += 1;
      } else if (!want && t.milestoneId === m.id) {
        t.milestoneId = null;
        t.version += 1;
      }
    });
}

function addDays(iso: string, days: number) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Board 27: epic names are unique per project; owner must be a project member; milestone must be in the project. */
function checkEpicFields(ctx: Ctx, projectId: string, b: EpicWrite, selfId: string | null) {
  const fields: Record<string, string> = {};
  const name = b.name?.trim().toLowerCase();
  if (name && ctx.db.epics.some((x) => x.projectId === projectId && x.id !== selfId && x.name.trim().toLowerCase() === name))
    fields.name = "An epic with this name exists";
  if (b.ownerId && !ctx.db.projectMembers.some((m) => m.projectId === projectId && m.userId === b.ownerId)) fields.ownerId = "Pick a project member";
  if (b.milestoneId && !ctx.db.milestones.some((m) => m.projectId === projectId && m.id === b.milestoneId)) fields.milestoneId = "Pick a milestone in this project";
  if (b.hue !== undefined && (typeof b.hue !== "number" || b.hue < 0 || b.hue > 360)) fields.hue = "Pick a color";
  if (Object.keys(fields).length) invalid(fields);
}
