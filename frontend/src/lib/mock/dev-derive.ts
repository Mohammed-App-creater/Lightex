import type { DevItem, DevPullRequest, TaskDevSummary } from "@/lib/api/types";
import type { DevLinkRec, MockDB, RepositoryRec } from "./db-types";

/*
 * Board 37 derivations shared by derive.ts (Task.dev, Project.devEnabled) and handlers/integrations.ts.
 * No imports from handlers, so derive.ts can use it without a cycle.
 */

const HEADLINE_MERGED_DAYS = 14;

/** §6.4: the repository applies to the project (all projects, or listed). */
export function repoApplies(r: Pick<RepositoryRec, "allProjects" | "projectIds">, projectId: string) {
  return r.allProjects || r.projectIds.includes(projectId);
}

/** Tracked repositories of active integrations that apply to the project. */
export function activeReposFor(db: MockDB, projectId: string): RepositoryRec[] {
  const p = db.projects.find((x) => x.id === projectId);
  if (!p) return [];
  const active = new Set((db.integrations ?? []).filter((i) => i.workspaceId === p.workspaceId && i.status === "active").map((i) => i.id));
  return (db.repositories ?? []).filter((r) => active.has(r.integrationId) && repoApplies(r, projectId)).sort((a, b) => a.fullPath.localeCompare(b.fullPath));
}

export function devEnabledOf(db: MockDB, projectId: string): boolean {
  return activeReposFor(db, projectId).length > 0;
}

/** The wire item with `repository` resolved from the link's current repository row (null after a disconnect). */
export function linkItem(db: MockDB, l: DevLinkRec): DevItem {
  const repo = l.repositoryId ? (db.repositories ?? []).find((r) => r.id === l.repositoryId) : undefined;
  return { ...l.item, repository: repo ? { id: repo.id, fullPath: repo.fullPath } : null } as DevItem;
}

/** Visible (not suppressed) links of a task. */
export function visibleLinks(db: MockDB, taskId: string): DevLinkRec[] {
  return (db.devLinks ?? []).filter((l) => l.taskId === taskId && !l.suppressed);
}

/** §5.6 ordering: open/draft by updatedAt desc, then merged by mergedAt desc, then closed. */
export function orderPrs(prs: DevPullRequest[]): DevPullRequest[] {
  const rank = (p: DevPullRequest) => (p.state === "open" || p.state === "draft" ? 0 : p.state === "merged" ? 1 : 2);
  const at = (p: DevPullRequest) => (p.state === "merged" ? (p.mergedAt ?? p.updatedAt) : p.updatedAt);
  return [...prs].sort((a, b) => rank(a) - rank(b) || at(b).localeCompare(at(a)));
}

/** §5.7 Task.dev: null without visible links. */
export function devSummaryOf(db: MockDB, taskId: string, now = Date.now()): TaskDevSummary | null {
  const links = visibleLinks(db, taskId);
  if (!links.length) return null;
  const prs = links.map((l) => l.item).filter((i): i is DevPullRequest => i.kind === "pull_request");
  const branches = links.filter((l) => l.item.kind === "branch" && l.item.state === "active").length;
  const commits = links.filter((l) => l.item.kind === "commit").length;
  const openish = prs.filter((p) => p.state === "open" || p.state === "draft").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const cutoff = now - HEADLINE_MERGED_DAYS * 86_400_000;
  const merged = prs
    .filter((p) => p.state === "merged" && p.mergedAt && new Date(p.mergedAt).getTime() >= cutoff)
    .sort((a, b) => (b.mergedAt ?? "").localeCompare(a.mergedAt ?? ""));
  const h = openish[0] ?? merged[0] ?? null;
  return {
    pr: h
      ? {
          provider: h.provider,
          number: h.number,
          ref: h.ref,
          state: h.state,
          checks: h.checks?.state ?? null,
          checksPassed: h.checks?.passed ?? 0,
          checksTotal: h.checks?.total ?? 0,
          approvals: h.approvals,
          baseBranch: h.baseBranch,
          mergedAt: h.mergedAt,
        }
      : null,
    prCount: prs.length,
    branchCount: branches,
    commitCount: commits,
  };
}
