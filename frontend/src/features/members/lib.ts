import type { Permission, PermissionGroup, PermissionInfo, Role, RoleScope, WorkspaceMember } from "@/lib/api/types";
import { PERMISSION_GROUP_ORDER } from "@/lib/permissions/catalogue";

/* ───────────────────────── Invite email chips (board 18 A.6) ───────────────────────── */

export const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/i;
export const MAX_CHIPS = 20;
export const MAX_CHIP_LEN = 120;
const SEPARATORS = /[\s,;]+/;

export type ChipState = "ok" | "bad" | "dup";
export type EmailChip = { email: string; state: ChipState };

export const normalizeEmail = (raw: string) => raw.trim().toLowerCase().slice(0, MAX_CHIP_LEN);

/** Every complete token in a pasted / typed string. */
export function splitEmails(text: string): string[] {
  return text.split(SEPARATORS).map(normalizeEmail).filter(Boolean);
}

/**
 * Typing a space, comma or semicolon turns everything before it into chips; the text after the
 * last separator stays in the input.
 */
export function consumeTyping(text: string): { chips: string[]; rest: string } {
  if (!SEPARATORS.test(text)) return { chips: [], rest: text };
  const parts = text.split(SEPARATORS);
  const rest = parts.pop() ?? "";
  return { chips: parts.map(normalizeEmail).filter(Boolean), rest };
}

/** Appends chips, ignoring duplicates within the box and stopping at the 20-chip limit. */
export function addChips(existing: string[], incoming: string[]): string[] {
  const out = [...existing];
  for (const e of incoming) {
    if (out.length >= MAX_CHIPS) break;
    if (!out.includes(e)) out.push(e);
  }
  return out;
}

/** ok / bad (invalid) / dup (already a member or invited). */
export function classifyChips(emails: string[], known: Iterable<string>): EmailChip[] {
  const set = new Set([...known].map((e) => e.toLowerCase()));
  return emails.map((email) => ({
    email,
    state: !EMAIL_RE.test(email) ? "bad" : set.has(email) ? "dup" : "ok",
  }));
}

export function inviteMessage(chips: EmailChip[], workspaceName: string): { tone: "error" | "note"; text: string } | null {
  const bad = chips.filter((c) => c.state === "bad");
  if (bad.length === 1) return { tone: "error", text: `“${bad[0]!.email}” isn’t a valid email` };
  if (bad.length > 1) return { tone: "error", text: `${bad.length} invalid emails` };
  const dup = chips.filter((c) => c.state === "dup");
  if (dup.length) return { tone: "note", text: `${dup.map((c) => c.email).join(", ")} already in ${workspaceName} · skipped` };
  return null;
}

export function inviteHint(chips: EmailChip[]): string {
  if (chips.some((c) => c.state === "bad")) return "Fix invalid emails to send";
  if (!chips.some((c) => c.state === "ok")) return "Enter or comma adds an email";
  return "";
}

export function sendLabel(validCount: number) {
  return validCount > 1 ? `Send ${validCount} invites` : "Send invite";
}

/* ───────────────────────── Roles ───────────────────────── */

/**
 * The workspace Owner role. The API has no `assignable` flag, so it is recognised by its grant:
 * the only system workspace role that can delete the workspace. Never by name.
 */
export function isOwnerRole(role: Pick<Role, "scope" | "isSystem" | "permissions">) {
  return role.scope === "workspace" && role.isSystem && role.permissions.includes("workspace.delete");
}

export function rolesFor(roles: Role[], scope: RoleScope) {
  return roles.filter((r) => r.scope === scope);
}

/** Roles that can be picked in a role menu / invite: everything in the scope except Owner. */
export function assignableRoles(roles: Role[], scope: RoleScope) {
  return rolesFor(roles, scope).filter((r) => !isOwnerRole(r));
}

/** Default pick for invites / new project members: the least-privileged system role (Member). */
export function defaultRole(roles: Role[], scope: RoleScope): Role | undefined {
  const sys = assignableRoles(roles, scope).filter((r) => r.isSystem);
  // Viewer-like roles hold only "*.view"; the default is the smallest role that can do work.
  const working = sys.filter((r) => r.permissions.some((p) => !p.endsWith(".view")));
  const pool = scope === "project" && working.length ? working : sys;
  return [...pool].sort((a, b) => a.permissions.length - b.permissions.length)[0];
}

/** The system "Project Admin" role: the project system role that can manage members and delete. */
export function projectAdminRole(roles: Role[]): Role | undefined {
  return rolesFor(roles, "project")
    .filter((r) => r.isSystem && r.permissions.includes("project.manage_members"))
    .sort((a, b) => b.permissions.length - a.permissions.length)[0];
}

/** "Copy of QA lead", then "Copy of QA lead 2", "3"… (case-insensitive, per scope). */
export function copyName(name: string, existing: string[]) {
  return uniqueName(`Copy of ${name}`.slice(0, 40), existing);
}

export function uniqueName(base: string, existing: string[]) {
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const n = `${base} ${i}`;
    if (!taken.has(n.toLowerCase())) return n;
  }
}

export function roleNameError(name: string, others: string[]): string | null {
  const n = name.trim();
  if (!n) return "Name is required";
  if (others.some((o) => o.toLowerCase() === n.toLowerCase())) return "A role with this name exists";
  return null;
}

/* ───────────────────────── Permission matrix ───────────────────────── */

export type RoleDraft = { name: string; description: string; permissions: Permission[] };

export function diffPermissions(saved: readonly string[], draft: readonly string[]) {
  const a = new Set(saved);
  const b = new Set(draft);
  return {
    added: [...b].filter((p) => !a.has(p)),
    removed: [...a].filter((p) => !b.has(p)),
  };
}

/** Toggled permissions, +1 if the name changed, +1 if the description changed. */
export function changeCount(saved: RoleDraft, draft: RoleDraft) {
  const { added, removed } = diffPermissions(saved.permissions, draft.permissions);
  return (
    added.length +
    removed.length +
    (saved.name.trim() !== draft.name.trim() ? 1 : 0) +
    (saved.description.trim() !== draft.description.trim() ? 1 : 0)
  );
}

/** Set of keys changed since save, for the per-row "changed" dot. */
export function changedKeys(saved: readonly string[], draft: readonly string[]) {
  const { added, removed } = diffPermissions(saved, draft);
  return new Set([...added, ...removed]);
}

export function togglePermission(list: readonly Permission[], key: Permission, on: boolean): Permission[] {
  const has = list.includes(key);
  if (on && !has) return [...list, key];
  if (!on && has) return list.filter((p) => p !== key);
  return [...list];
}

export function groupCatalogue(catalogue: PermissionInfo[], scope: RoleScope) {
  const items = catalogue.filter((p) => p.scope === scope);
  return PERMISSION_GROUP_ORDER.map((group: PermissionGroup) => ({
    group,
    items: items.filter((p) => p.group === group),
  })).filter((g) => g.items.length > 0);
}

/** Permissions of a role that exist in the catalogue for its scope (for "{n} of {total}"). */
export function grantedCount(role: Pick<Role, "permissions" | "scope">, catalogue: PermissionInfo[]) {
  const keys = new Set(catalogue.filter((p) => p.scope === role.scope).map((p) => p.key));
  return role.permissions.filter((p) => keys.has(p)).length;
}

/* ───────────────────────── Members list ───────────────────────── */

export function filterMembers(members: WorkspaceMember[], q: string, roleId: string | null) {
  const needle = q.trim().toLowerCase();
  return members.filter(
    (m) =>
      (!roleId || m.roleId === roleId) &&
      (!needle || m.user.name.toLowerCase().includes(needle) || m.user.email.toLowerCase().includes(needle)),
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Now", "12m ago", "2h ago", "Yesterday", "3d ago", "Oct 5" or "—". */
export function lastActiveLabel(iso: string | null, now = Date.now()) {
  if (!iso) return "—";
  const mins = Math.round((now - new Date(iso).getTime()) / 60_000);
  if (mins < 5) return "Now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "Yesterday";
  if (d < 30) return `${d}d ago`;
  return monthDay(iso);
}

export function monthDay(iso: string) {
  const d = new Date(iso);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** Initials for an invite avatar: first two letters of the email. */
export const emailInitials = (email: string) => email.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase() || "?";
