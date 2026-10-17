import type { Team, TeamDetail, TeamMember } from "@/api/types";
import { nowISO, uid } from "../db";
import type { MockDB, TeamMemberRec, TeamRec } from "../db-types";
import { wsMembership } from "../derive";
import { fail, invalid, requireUser, requireWs, route, str, wsBySlug, type Ctx } from "../router";
import { audit } from "./workspaces";

/*
 * Platform Stage 4 (docs/platform/stage4-contract.md §1): flat teams. Reads are open to any workspace member; writes
 * need core.teams.manage and are audited (core.team.*). A team from another workspace is a 404. Team members must be
 * active workspace members; removing someone from the workspace drops their memberships (handlers/workspaces.ts).
 */

const NAME_MAX = 60;
const DESCRIPTION_MAX = 280;

const live = (db: MockDB, workspaceId: string) => db.teams.filter((t) => t.workspaceId === workspaceId && !t.deletedAt);
const membersOf = (db: MockDB, teamId: string) => db.teamMembers.filter((m) => m.teamId === teamId);

export function toTeam(db: MockDB, t: TeamRec): Team {
  const members = membersOf(db, t.id);
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    memberCount: members.length,
    leadIds: members.filter((m) => m.isLead).map((m) => m.userId),
    createdAt: t.createdAt,
  };
}

function toTeamMember(db: MockDB, m: TeamMemberRec): TeamMember {
  const u = db.users.find((x) => x.id === m.userId);
  return { userId: m.userId, name: u?.name ?? "", email: u?.email ?? "", avatarUrl: u?.avatarUrl ?? null, isLead: m.isLead };
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

function toDetail(db: MockDB, t: TeamRec): TeamDetail {
  return { ...toTeam(db, t), members: membersOf(db, t.id).map((m) => toTeamMember(db, m)).sort(byName) };
}

/** Tenant rule: unknown, deleted, or in a workspace the caller isn't a member of → 404. */
function teamFor(ctx: Ctx): TeamRec {
  const userId = requireUser(ctx);
  const t = ctx.db.teams.find((x) => x.id === ctx.params.id && !x.deletedAt);
  const ws = t && ctx.db.workspaces.find((w) => w.id === t.workspaceId && !w.deletedAt);
  if (!t || !ws || !wsMembership(ctx.db, userId, t.workspaceId)) fail(404, "not_found", "Team not found.");
  return t;
}

/** Name and description from a create / update body; `partial` leaves missing fields out. */
function readFields(ctx: Ctx, workspaceId: string, selfId: string | null, partial: boolean) {
  const rawName = str(ctx.body, "name");
  const rawDescription = (ctx.body as { description?: unknown } | null)?.description;
  const fields: Record<string, string> = {};
  let name: string | undefined;
  if (rawName !== undefined || !partial) {
    name = (rawName ?? "").trim();
    if (!name) fields.name = "Name is required";
    else if (name.length > NAME_MAX) fields.name = `Use ${NAME_MAX} characters or fewer`;
  }
  let description: string | undefined;
  if (rawDescription !== undefined && rawDescription !== null) {
    if (typeof rawDescription !== "string") fields.description = "Must be text";
    else if (rawDescription.trim().length > DESCRIPTION_MAX) fields.description = `Use ${DESCRIPTION_MAX} characters or fewer`;
    else description = rawDescription.trim();
  }
  if (Object.keys(fields).length) invalid(fields);
  if (name !== undefined && live(ctx.db, workspaceId).some((t) => t.id !== selfId && t.name.toLowerCase() === name!.toLowerCase())) {
    fail(409, "team_name_taken", `A team called “${name}” already exists.`, { name });
  }
  return { name, description };
}

const memberLabel = (db: MockDB, t: TeamRec, userId: string) => `${t.name}: ${db.users.find((u) => u.id === userId)?.name ?? userId}`;

export function registerTeams() {
  route("GET", "/workspaces/:slug/teams", (ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    return live(ctx.db, ws.id).sort(byName).map((t) => toTeam(ctx.db, t));
  });

  route("POST", "/workspaces/:slug/teams", (ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    requireWs(ctx, ws.id, "core.teams.manage");
    const { name, description } = readFields(ctx, ws.id, null, false);
    const team: TeamRec = { id: uid("team"), workspaceId: ws.id, name: name!, description: description ?? "", createdAt: nowISO(), deletedAt: null };
    ctx.db.teams.push(team);
    audit(ctx.db, ws.id, ctx.userId!, "core.team.created", team.name);
    return toDetail(ctx.db, team);
  });

  route("GET", "/teams/:id", (ctx) => toDetail(ctx.db, teamFor(ctx)));

  route("PATCH", "/teams/:id", (ctx) => {
    const team = teamFor(ctx);
    requireWs(ctx, team.workspaceId, "core.teams.manage");
    const { name, description } = readFields(ctx, team.workspaceId, team.id, true);
    if (name !== undefined) team.name = name;
    if (description !== undefined) team.description = description;
    audit(ctx.db, team.workspaceId, ctx.userId!, "core.team.updated", team.name);
    return toDetail(ctx.db, team);
  });

  route("DELETE", "/teams/:id", (ctx) => {
    const team = teamFor(ctx);
    requireWs(ctx, team.workspaceId, "core.teams.manage");
    // Soft delete, like the backend's base model; memberships stay with the deleted team.
    team.deletedAt = nowISO();
    audit(ctx.db, team.workspaceId, ctx.userId!, "core.team.deleted", team.name);
    return undefined;
  });

  route("GET", "/teams/:id/members", (ctx) => toDetail(ctx.db, teamFor(ctx)).members);

  route("POST", "/teams/:id/members", (ctx) => {
    const team = teamFor(ctx);
    requireWs(ctx, team.workspaceId, "core.teams.manage");
    const userId = str(ctx.body, "userId");
    const isLead = (ctx.body as { isLead?: unknown } | null)?.isLead;
    if (!userId) invalid({ userId: "Pick a workspace member" });
    if (isLead !== undefined && typeof isLead !== "boolean") invalid({ isLead: "Must be true or false" });
    if (!wsMembership(ctx.db, userId, team.workspaceId)) {
      fail(400, "not_a_workspace_member", "Only members of this workspace can join its teams.", { userId });
    }
    if (ctx.db.teamMembers.some((m) => m.teamId === team.id && m.userId === userId)) {
      fail(409, "already_a_member", "That person is already in this team.", { userId });
    }
    const rec: TeamMemberRec = { workspaceId: team.workspaceId, teamId: team.id, userId, isLead: isLead === true, addedAt: nowISO() };
    ctx.db.teamMembers.push(rec);
    audit(ctx.db, team.workspaceId, ctx.userId!, "core.team.member_added", memberLabel(ctx.db, team, userId));
    return toTeamMember(ctx.db, rec);
  });

  route("PATCH", "/teams/:id/members/:userId", (ctx) => {
    const team = teamFor(ctx);
    requireWs(ctx, team.workspaceId, "core.teams.manage");
    const rec = ctx.db.teamMembers.find((m) => m.teamId === team.id && m.userId === ctx.params.userId);
    if (!rec) fail(404, "not_found", "That person isn’t in this team.");
    const isLead = (ctx.body as { isLead?: unknown } | null)?.isLead;
    if (typeof isLead !== "boolean") invalid({ isLead: "Must be true or false" });
    rec.isLead = isLead;
    audit(ctx.db, team.workspaceId, ctx.userId!, "core.team.member_updated", memberLabel(ctx.db, team, rec.userId));
    return toTeamMember(ctx.db, rec);
  });

  route("DELETE", "/teams/:id/members/:userId", (ctx) => {
    const team = teamFor(ctx);
    requireWs(ctx, team.workspaceId, "core.teams.manage");
    const rec = ctx.db.teamMembers.find((m) => m.teamId === team.id && m.userId === ctx.params.userId);
    if (!rec) fail(404, "not_found", "That person isn’t in this team.");
    ctx.db.teamMembers = ctx.db.teamMembers.filter((m) => m !== rec);
    audit(ctx.db, team.workspaceId, ctx.userId!, "core.team.member_removed", memberLabel(ctx.db, team, rec.userId));
    return undefined;
  });
}
