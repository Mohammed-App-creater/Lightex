import { describe, expect, it } from "vitest";
import type { CheckState, Integration, TaskDevSummary } from "@/lib/api/types";
import { BRANCH_ERRORS, suggestBranch, validateBranch } from "./branch-name";
import { aggregateChecks, checksAria, connectErrorCopy, devCountLabel, formatDuration, hashHue, integrationMeta, parseConnectFragment, prChip } from "./dev-lib";
import vectors from "./dev-vectors.json";
import { findKeys, highlightKeys } from "./key-match";

/* Board 37 §12.2 unit tests: the shared vectors (§12.3) and the pure helpers. */

describe("shared vectors (§12.3)", () => {
  it.each(vectors.keys.map((v) => [v.texts.join(" | "), v] as const))("findKeys %s", (_n, v) => {
    expect(findKeys(v.texts, v.prefixes)).toEqual(v.expected);
  });

  it.each(vectors.suggestBranch.map((v) => [v.title, v] as const))("suggestBranch %s", (_n, v) => {
    expect(suggestBranch(v.key, v.title, v.prefix)).toBe(v.expected);
  });

  it("validateBranch: invalid and valid names", () => {
    for (const n of vectors.validateBranch.invalid) expect(validateBranch(n), JSON.stringify(n)).not.toBeNull();
    for (const n of vectors.validateBranch.valid) expect(validateBranch(n), n).toBeNull();
  });

  it("aggregateChecks: failing > running > passing, none → null", () => {
    for (const v of vectors.checks) expect(aggregateChecks(v.states as CheckState[])).toBe(v.expected);
  });

  it("hashHue = (sum of char codes × 37) mod 360", () => {
    for (const v of vectors.hashHue) expect(hashHue(v.login)).toBe(v.expected);
  });
});

describe("key matching (§6)", () => {
  it("is case-insensitive and upper-cases the prefix", () => {
    expect(findKeys("Prj-7 and pRj-8", ["PRJ"])).toEqual(["PRJ-7", "PRJ-8"]);
  });
  it("caps before filtering, so 10 junk candidates crowd out later keys (step order of §6.2)", () => {
    const junk = Array.from({ length: 10 }, (_, i) => `AB-${i + 1}`).join(" ");
    expect(findKeys(`${junk} PRJ-1`, ["PRJ"])).toEqual([]);
  });
  it("highlightKeys marks only the workspace's keys, as parts", () => {
    expect(highlightKeys("fix(board): debounce reflow (PRJ-42) UTF-8", ["PRJ"])).toEqual([
      { text: "fix(board): debounce reflow (", key: false },
      { text: "PRJ-42", key: true },
      { text: ") UTF-8", key: false },
    ]);
    expect(highlightKeys("prj-42-fix-reflow", ["PRJ"])).toEqual([
      { text: "prj-42", key: true },
      { text: "-fix-reflow", key: false },
    ]);
    expect(highlightKeys("nothing here", ["PRJ"])).toEqual([{ text: "nothing here", key: false }]);
  });
});

describe("branch names (§6.3, §9.4)", () => {
  it("returns the contract's messages", () => {
    expect(validateBranch("a..b")).toBe(BRANCH_ERRORS.dots);
    expect(validateBranch("a b")).toBe(BRANCH_ERRORS.chars);
    expect(validateBranch("x".repeat(81))).toBe(BRANCH_ERRORS.length);
    expect(validateBranch("-x")).toBe(BRANCH_ERRORS.edges);
    expect(validateBranch("")).toBe(BRANCH_ERRORS.empty);
  });
  it("caps the suggestion at 80 characters without a trailing separator", () => {
    const s = suggestBranch("PRJ-1", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb ccc", "feature/");
    expect(s.length).toBeLessThanOrEqual(80);
    expect(s).not.toMatch(/[-/.]$/);
    expect(validateBranch(s)).toBeNull();
  });
});

const pr = (over: Partial<NonNullable<TaskDevSummary["pr"]>> = {}): NonNullable<TaskDevSummary["pr"]> => ({
  provider: "github",
  number: 214,
  ref: "#214",
  state: "open",
  checks: "failing",
  checksPassed: 1,
  checksTotal: 3,
  approvals: 0,
  baseBranch: "main",
  mergedAt: null,
  ...over,
});

describe("board chip text (§9.5)", () => {
  it("failing, open, merged and draft variants with the design's tooltips", () => {
    expect(prChip(pr())).toEqual({ variant: "failing", label: "Failing", tooltip: "#214 · 2 of 3 checks failing", aria: "Pull request #214, open, checks failing" });
    expect(prChip(pr({ ref: "#221", number: 221, checks: "passing", checksPassed: 3, approvals: 1 }))).toMatchObject({ variant: "open", label: "Open", tooltip: "#221 · checks passing · 1 review" });
    const merged = prChip(pr({ ref: "#187", state: "merged", checks: "passing", mergedAt: "2026-10-06T12:00:00" }));
    expect(merged.variant).toBe("merged");
    expect(merged.tooltip).toMatch(/^#187 · merged into main · Oct 6/);
    expect(merged.aria).toBe("Pull request #187, merged");
    expect(prChip(pr({ state: "draft", checks: "running" }))).toMatchObject({ variant: "draft", tooltip: "#214 · draft · checks running" });
  });
  it("names merge requests for GitLab", () => {
    expect(prChip(pr({ provider: "gitlab", ref: "!12", checks: null })).aria).toBe("Merge request !12, open");
  });
});

describe("panel labels", () => {
  it("count label: PRs, MRs when every PR is GitLab, singulars", () => {
    expect(devCountLabel([{ provider: "github" }, { provider: "github" }, { provider: "gitlab" }, { provider: "github" }], 2)).toBe("4 PRs · 2 branches");
    expect(devCountLabel([{ provider: "gitlab" }], 1)).toBe("1 MR · 1 branch");
    expect(devCountLabel([], 0, 3)).toBe("3 commits");
    expect(devCountLabel([], 0)).toBe("");
  });
  it("checks aria and durations", () => {
    expect(checksAria({ state: "failing", passed: 1, total: 3, items: [] })).toBe("Checks Failing, 1 of 3 passing");
    expect(formatDuration(134)).toBe("2m 14s");
    expect(formatDuration(48)).toBe("48s");
    expect(formatDuration(60)).toBe("1m");
    expect(formatDuration(null)).toBe("");
  });
});

describe("connect fragment (§9.6)", () => {
  it("parses confirm, error and mock fragments", () => {
    expect(parseConnectFragment("#connect=ca_1.tok-EN_9")).toEqual({ kind: "confirm", attempt: "ca_1", token: "tok-EN_9" });
    expect(parseConnectFragment("#connect_error=github_cancelled")).toEqual({ kind: "error", code: "github_cancelled" });
    expect(parseConnectFragment("#mock-authorize=gitlab.ca_7")).toEqual({ kind: "mock", provider: "gitlab", attempt: "ca_7" });
  });
  it("treats a malformed connect fragment as an expired link and ignores foreign ones", () => {
    expect(parseConnectFragment("#connect=nodot")).toEqual({ kind: "error", code: "state_invalid" });
    expect(parseConnectFragment("#connect=a.<script>")).toEqual({ kind: "error", code: "state_invalid" });
    expect(parseConnectFragment("#connect_error=Bad Code!")).toEqual({ kind: "error", code: "state_invalid" });
    expect(parseConnectFragment("#mock-authorize=bitbucket.x")).toBeNull();
    expect(parseConnectFragment("#danger-zone")).toBeNull();
    expect(parseConnectFragment("")).toBeNull();
  });
  it("maps every §5.3 code to its copy (cancellations are info)", () => {
    expect(connectErrorCopy("github_cancelled")).toEqual({ text: "Connection cancelled.", tone: "info" });
    expect(connectErrorCopy("installation_in_use").tone).toBe("error");
    expect(connectErrorCopy("provider_failed", "gitlab").text).toBe("GitLab didn’t respond. Try again in a minute.");
    expect(connectErrorCopy("state_invalid").text).toBe("That connection link expired. Try again.");
    expect(connectErrorCopy("whatever").text).toBe("That connection link expired. Try again.");
  });
});

describe("integration meta (§9.7)", () => {
  const now = new Date("2026-10-09T09:00:00Z").getTime();
  const base = { status: "active", error: null, lastSyncedAt: "2026-10-09T08:58:00Z", syncing: false, tokenExpiresAt: null, repositories: [{}, {}, {}, {}] } as unknown as Integration;
  it("connected, syncing, expiring token", () => {
    expect(integrationMeta(base, now)).toBe("4 repos · last sync 2m");
    expect(integrationMeta({ ...base, syncing: true }, now)).toBe("4 repos · last sync …");
    expect(integrationMeta({ ...base, tokenExpiresAt: "2026-10-14T09:00:00Z" }, now)).toBe("4 repos · last sync 2m · token expires in 5d");
  });
  it("error codes", () => {
    const err = (code: NonNullable<Integration["error"]>["code"]) => integrationMeta({ ...base, status: "error", error: { code, message: "", since: "2026-10-06T09:00:00Z" } }, now);
    expect(err("token_expired")).toBe("expired 3d ago · 4 repos paused");
    expect(err("token_revoked")).toBe("revoked 3d ago · 4 repos paused");
    expect(err("installation_removed")).toMatch(/^since Oct 6 · 4 repos paused$/);
    expect(err("insufficient_scope")).toBe("Reconnect to grant access");
  });
});
