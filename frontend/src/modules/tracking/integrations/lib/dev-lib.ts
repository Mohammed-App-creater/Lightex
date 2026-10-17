import type { CheckState, DevPullRequest, Integration, IntegrationErrorCode, Provider, TaskDevSummary } from "@/lib/api/types";
import { ago, shortDate } from "@/lib/utils/dates";

/*
 * Board 37 helpers shared by the settings page, the task panel, the board chip and the mock.
 * Pure: no React, no API.
 */

export const PROVIDER_NAME: Record<Provider, "GitHub" | "GitLab"> = { github: "GitHub", gitlab: "GitLab" };
/** "Pull requests" / "Merge requests" (the provider tile chips). */
export const PR_NOUN: Record<Provider, { long: string; short: string; one: string }> = {
  github: { long: "Pull requests", short: "PRs", one: "PR" },
  gitlab: { long: "Merge requests", short: "MRs", one: "MR" },
};

/** Hue for an author who isn't a Lightex member (§9.7): (sum of char codes × 37) mod 360. */
export function hashHue(login: string): number {
  let sum = 0;
  for (const ch of login) sum += ch.codePointAt(0)!;
  return (sum * 37) % 360;
}

/** Aggregate of a PR's checks (§7.2): any failing → failing; else any running → running; else passing; none → null. */
export function aggregateChecks(states: readonly CheckState[]): CheckState | null {
  if (!states.length) return null;
  if (states.includes("failing")) return "failing";
  if (states.includes("running")) return "running";
  return "passing";
}

/** Check duration: "2m 14s", "48s", "1m". */
export function formatDuration(sec: number | null): string {
  if (sec === null || sec < 0) return "";
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return s ? `${m}m ${String(s).padStart(2, "0")}s` : `${m}m`;
}

/** Header count: "4 PRs · 2 branches" ("MRs" when every PR is GitLab). */
export function devCountLabel(prs: { provider: Provider }[], branches: number, commits = 0): string {
  const parts: string[] = [];
  if (prs.length) {
    const gl = prs.every((p) => p.provider === "gitlab");
    const noun = gl ? PR_NOUN.gitlab : PR_NOUN.github;
    parts.push(`${prs.length} ${prs.length === 1 ? noun.one : noun.short}`);
  }
  if (branches) parts.push(`${branches} ${branches === 1 ? "branch" : "branches"}`);
  if (!parts.length && commits) parts.push(`${commits} ${commits === 1 ? "commit" : "commits"}`);
  return parts.join(" · ");
}

export type ChipVariant = "failing" | "open" | "draft" | "merged" | "closed";
export const CHIP_LABEL: Record<ChipVariant, string> = { failing: "Failing", open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" };

function checksPhrase(pr: NonNullable<TaskDevSummary["pr"]>): string | null {
  if (!pr.checks) return null;
  if (pr.checks === "failing") return `${pr.checksTotal - pr.checksPassed} of ${pr.checksTotal} checks failing`;
  if (pr.checks === "running") return "checks running";
  return "checks passing";
}

/** The board / list chip (§9.5): variant, tooltip and aria-label. */
export function prChip(pr: NonNullable<TaskDevSummary["pr"]>) {
  const open = pr.state === "open" || pr.state === "draft";
  const variant: ChipVariant = open && pr.checks === "failing" ? "failing" : pr.state;
  const parts: string[] = [pr.ref];
  if (pr.state === "merged") {
    parts.push(`merged into ${pr.baseBranch}`);
    if (pr.mergedAt) parts.push(shortDate(pr.mergedAt));
  } else {
    if (pr.state === "draft") parts.push("draft");
    const c = checksPhrase(pr);
    if (c) parts.push(c);
    if (pr.approvals) parts.push(`${pr.approvals} ${pr.approvals === 1 ? "review" : "reviews"}`);
  }
  const noun = pr.provider === "gitlab" ? "Merge request" : "Pull request";
  const aria = `${noun} ${pr.ref}, ${pr.state}${open && pr.checks ? `, checks ${pr.checks}` : ""}`;
  return { variant, label: CHIP_LABEL[variant], tooltip: parts.join(" · "), aria };
}

/** PR / MR state pill (task panel). */
export const PR_STATE_LABEL: Record<DevPullRequest["state"], string> = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" };
export const CHECK_LABEL: Record<CheckState, string> = { passing: "Passing", failing: "Failing", running: "Running" };

/** "Checks Failing, 1 of 3 passing" (the design's aria-label on the checks button). */
export function checksAria(c: NonNullable<DevPullRequest["checks"]>) {
  return `Checks ${CHECK_LABEL[c.state]}, ${c.passed} of ${c.total} passing`;
}

/* ───────── connect flow (§5.3, §9.6) ───────── */

export const CONNECT_STORAGE_KEY = "lightex-int-connect";

export type ConnectFragment =
  | { kind: "confirm"; attempt: string; token: string }
  | { kind: "error"; code: string }
  | { kind: "mock"; provider: Provider; attempt: string };

const TOKENISH = /^[A-Za-z0-9_-]{1,200}$/;

/**
 * Parses `location.hash`: `#connect=<attempt>.<token>`, `#connect_error=<code>` or (mock only)
 * `#mock-authorize=<provider>.<attempt>`. A malformed connect fragment is `state_invalid`; anything
 * else is null (not ours).
 */
export function parseConnectFragment(hash: string): ConnectFragment | null {
  const h = hash.startsWith("#") ? hash.slice(1) : hash;
  const eq = h.indexOf("=");
  if (eq < 0) return null;
  const name = h.slice(0, eq);
  const value = decodeURIComponent(h.slice(eq + 1));
  if (name === "connect") {
    const dot = value.indexOf(".");
    const attempt = dot > 0 ? value.slice(0, dot) : "";
    const token = dot > 0 ? value.slice(dot + 1) : "";
    if (!TOKENISH.test(attempt) || !TOKENISH.test(token)) return { kind: "error", code: "state_invalid" };
    return { kind: "confirm", attempt, token };
  }
  if (name === "connect_error") return { kind: "error", code: /^[a-z_]{1,40}$/.test(value) ? value : "state_invalid" };
  if (name === "mock-authorize") {
    const [provider, attempt] = value.split(".");
    if ((provider === "github" || provider === "gitlab") && attempt && TOKENISH.test(attempt)) return { kind: "mock", provider, attempt };
    return null;
  }
  return null;
}

/** §5.3 failure copy. `tone: "info"` for cancellations (no error tone). */
export function connectErrorCopy(code: string, provider: Provider | null = null): { text: string; tone: "info" | "error" } {
  const name = provider ? PROVIDER_NAME[provider] : code.startsWith("gitlab") ? "GitLab" : "GitHub";
  switch (code) {
    case "github_cancelled":
    case "gitlab_cancelled":
      return { text: "Connection cancelled.", tone: "info" };
    case "github_requested":
      return { text: "Installation requested. An owner of the GitHub organization has to approve it; then connect again.", tone: "info" };
    case "installation_in_use":
      return { text: "This GitHub account is already connected to another Lightex workspace.", tone: "error" };
    case "account_mismatch":
      return { text: "Reconnect with the same account that was connected before.", tone: "error" };
    case "insufficient_scope":
      return { text: "Lightex needs the api scope (GitLab) or the requested permissions (GitHub).", tone: "error" };
    case "provider_failed":
      return { text: `${name} didn’t respond. Try again in a minute.`, tone: "error" };
    case "state_invalid":
    default:
      return { text: "That connection link expired. Try again.", tone: "error" };
  }
}

/* ───────── status copy (§9.7) ───────── */

export const ERROR_BADGE: Record<IntegrationErrorCode, string> = {
  token_expired: "Token expired",
  token_revoked: "Access revoked",
  installation_suspended: "Suspended on GitHub",
  installation_removed: "Uninstalled on GitHub",
  insufficient_scope: "Missing permissions",
  unreachable: "Can’t reach GitLab",
  webhook_failing: "Webhooks failing",
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "4 repos · last sync 2m", "expired 3d ago · 4 repos paused", "token expires in 5d" … */
export function integrationMeta(i: Pick<Integration, "status" | "error" | "lastSyncedAt" | "syncing" | "tokenExpiresAt" | "repositories">, now = Date.now()): string {
  const n = i.repositories.length;
  const repos = plural(n, "repo");
  if (i.error) {
    const since = i.error.since;
    const rel = ago(since, now);
    const day = shortDate(since);
    switch (i.error.code) {
      case "token_expired":
        return `expired ${rel === "just now" ? "just now" : `${rel} ago`} · ${repos} paused`;
      case "token_revoked":
        return `revoked ${rel === "just now" ? "just now" : `${rel} ago`} · ${repos} paused`;
      case "installation_suspended":
      case "installation_removed":
        return `since ${day} · ${repos} paused`;
      case "insufficient_scope":
        return "Reconnect to grant access";
      case "unreachable":
        return `since ${rel} · retrying`;
      case "webhook_failing":
        return `last delivery ${rel === "just now" ? "just now" : `${rel} ago`}`;
    }
  }
  const last = i.syncing ? "…" : i.lastSyncedAt ? ago(i.lastSyncedAt, now) : "never";
  const parts = [repos, `last sync ${last}`];
  if (i.tokenExpiresAt) {
    const days = Math.ceil((new Date(i.tokenExpiresAt).getTime() - now) / 86_400_000);
    if (days >= 0 && days < 7) parts.push(`token expires in ${days}d`);
  }
  return parts.join(" · ");
}
