import { isApiError } from "@/api/errors";
import type { TeamDetail, WorkspaceMember } from "@/api/types";

/* Platform Stage 4: pure helpers for Settings → Teams. */

export const TEAM_NAME_MAX = 60;
export const TEAM_DESCRIPTION_MAX = 280;

/** Client-side name check; the server also answers 409 team_name_taken (case-insensitive). */
export function teamNameError(name: string, others: readonly string[]): string | null {
  const n = name.trim();
  if (!n) return "Name is required";
  if (n.length > TEAM_NAME_MAX) return `Use ${TEAM_NAME_MAX} characters or fewer`;
  if (others.some((o) => o.toLowerCase() === n.toLowerCase())) return "A team with this name already exists";
  return null;
}

/** The field error a failed create / rename maps to, or null for a toast. */
export function teamFieldError(e: unknown): { field: "name" | "description"; message: string } | null {
  if (!isApiError(e)) return null;
  if (e.code === "team_name_taken") return { field: "name", message: "A team with this name already exists" };
  if (e.fieldErrors.name) return { field: "name", message: e.fieldErrors.name };
  if (e.fieldErrors.description) return { field: "description", message: e.fieldErrors.description };
  return null;
}

/** Active workspace members who aren't in the team yet, by name. */
export function addableMembers(members: readonly WorkspaceMember[], team: Pick<TeamDetail, "members"> | undefined): WorkspaceMember[] {
  const inTeam = new Set(team?.members.map((m) => m.userId));
  return members.filter((m) => m.status === "active" && !inTeam.has(m.userId)).sort((a, b) => a.user.name.localeCompare(b.user.name));
}

/** Toast copy for a failed member write. */
export function memberErrorText(e: unknown): string | null {
  if (!isApiError(e)) return null;
  if (e.code === "not_a_workspace_member") return "Only members of this workspace can join its teams.";
  if (e.code === "already_a_member") return "That person is already in this team.";
  return null;
}

export const countLabel = (n: number) => (n === 1 ? "1 member" : `${n} members`);
