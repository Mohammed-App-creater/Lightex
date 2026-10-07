import type { Invite } from "@/lib/api/types";
import { mockSession, nowISO, uid } from "../db";
import type { MockDB } from "../db-types";
import { toUser } from "../derive";
import { defaultPrefs } from "../seed";
import { fail, invalid, requireUser, route, str } from "../router";

const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

export function passwordProblems(pw: string) {
  const rules = [pw.length >= 8, /[A-Z]/.test(pw) && /[a-z]/.test(pw), /\d/.test(pw), /[^A-Za-z0-9]/.test(pw)];
  return { score: rules.filter(Boolean).length, longEnough: rules[0] };
}

function toInvite(db: MockDB, inv: MockDB["invites"][number]): Invite {
  const ws = db.workspaces.find((w) => w.id === inv.workspaceId)!;
  const role = db.roles.find((r) => r.id === inv.roleId)!;
  const by = db.users.find((u) => u.id === inv.invitedById)!;
  return {
    id: inv.id,
    workspaceId: ws.id,
    workspaceName: ws.name,
    email: inv.email,
    roleId: role.id,
    roleName: role.name,
    invitedBy: { id: by.id, name: by.name, hue: by.hue },
    createdAt: inv.createdAt,
    expiresAt: inv.expiresAt,
    status: new Date(inv.expiresAt) < new Date() && inv.status === "pending" ? "expired" : inv.status,
  };
}
export { toInvite };

export function registerAuth() {
  route(
    "POST",
    "/auth/login",
    ({ db, body }) => {
      const email = (str(body, "email") ?? "").trim().toLowerCase();
      const password = str(body, "password") ?? "";
      const user = db.users.find((u) => u.email.toLowerCase() === email);
      if (!user || user.password !== password) {
        fail(401, "invalid_credentials", "Email or password is incorrect.");
      }
      mockSession.set(user.id);
      return { accessToken: "mock-access-token", user: toUser(user) };
    },
    { anonymous: true },
  );

  route(
    "POST",
    "/auth/register",
    ({ db, body }) => {
      const name = (str(body, "name") ?? "").trim();
      const email = (str(body, "email") ?? "").trim().toLowerCase();
      const password = str(body, "password") ?? "";
      const fields: Record<string, string> = {};
      if (name.length < 2) fields.name = "Enter your name";
      if (!EMAIL_RE.test(email)) fields.email = "Enter a valid email";
      else if (db.users.some((u) => u.email.toLowerCase() === email))
        fields.email = "An account with this email already exists";
      if (passwordProblems(password).score < 3 || password.length < 8) fields.password = "Choose a stronger password";
      if (Object.keys(fields).length) invalid(fields);
      const user = { id: uid("u"), name, email, hue: Math.floor(Math.random() * 360), avatarUrl: null, createdAt: nowISO(), password };
      db.users.push(user);
      db.prefs.push({ userId: user.id, prefs: defaultPrefs() });
      mockSession.set(user.id);
      return { accessToken: "mock-access-token", user: toUser(user) };
    },
    { anonymous: true },
  );

  route(
    "POST",
    "/auth/refresh",
    ({ db }) => {
      const id = mockSession.get();
      if (!id || !db.users.some((u) => u.id === id)) fail(401, "unauthorized", "Not signed in.");
      return { accessToken: "mock-access-token" };
    },
    { anonymous: true },
  );

  route(
    "POST",
    "/auth/logout",
    () => {
      mockSession.set(null);
      return undefined;
    },
    { anonymous: true },
  );

  route(
    "POST",
    "/auth/forgot-password",
    ({ db, body }) => {
      const email = (str(body, "email") ?? "").trim().toLowerCase();
      const user = db.users.find((u) => u.email.toLowerCase() === email);
      if (user) {
        db.resetTokens.push({ token: `reset-${user.id}`, userId: user.id, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
      }
      return undefined; // always 204: no account enumeration
    },
    { anonymous: true },
  );

  route(
    "POST",
    "/auth/reset-password",
    ({ db, body }) => {
      const token = str(body, "token") ?? "";
      const password = str(body, "password") ?? "";
      const rec = db.resetTokens.find((t) => t.token === token);
      if (!rec || new Date(rec.expiresAt) < new Date()) fail(400, "invalid_token", "This reset link has expired. Request a new one.");
      if (password.length < 8 || passwordProblems(password).score < 3) invalid({ password: "Choose a stronger password" });
      const user = db.users.find((u) => u.id === rec.userId)!;
      user.password = password;
      db.resetTokens = db.resetTokens.filter((t) => t.userId !== user.id);
      return undefined;
    },
    { anonymous: true },
  );

  route("GET", "/auth/me", (ctx) => {
    const id = requireUser(ctx);
    const u = ctx.db.users.find((x) => x.id === id);
    if (!u) fail(401, "unauthorized", "Not signed in.");
    return toUser(u);
  });

  route("PATCH", "/auth/me", (ctx) => {
    const id = requireUser(ctx);
    const u = ctx.db.users.find((x) => x.id === id)!;
    const name = str(ctx.body, "name");
    if (name !== undefined) {
      if (name.trim().length < 2) invalid({ name: "Name must be at least 2 characters" });
      u.name = name.trim().slice(0, 60);
    }
    const avatarUrl = (ctx.body as { avatarUrl?: string | null })?.avatarUrl;
    if (avatarUrl !== undefined) u.avatarUrl = avatarUrl;
    return toUser(u);
  });

  route("PUT", "/auth/me/password", (ctx) => {
    const id = requireUser(ctx);
    const u = ctx.db.users.find((x) => x.id === id)!;
    const current = str(ctx.body, "currentPassword") ?? "";
    const next = str(ctx.body, "newPassword") ?? "";
    if (current !== u.password) invalid({ currentPassword: "Current password is incorrect" });
    if (next.length < 8 || passwordProblems(next).score < 3) invalid({ newPassword: "Choose a stronger password" });
    u.password = next;
    return undefined;
  });

  route(
    "GET",
    "/invites/:token",
    ({ db, params }) => {
      const inv = db.invites.find((i) => i.token === params.token);
      if (!inv) fail(404, "not_found", "This invite link isn’t valid.");
      return toInvite(db, inv);
    },
    { anonymous: true },
  );

  route(
    "POST",
    "/invites/:token/accept",
    ({ db, params, body }) => {
      const inv = db.invites.find((i) => i.token === params.token);
      if (!inv) fail(404, "not_found", "This invite link isn’t valid.");
      const view = toInvite(db, inv);
      if (view.status !== "pending") fail(410, "invite_unavailable", "This invite has expired or was revoked.");
      let user = db.users.find((u) => u.email.toLowerCase() === inv.email.toLowerCase());
      if (!user) {
        const name = (str(body, "name") ?? "").trim();
        const password = str(body, "password") ?? "";
        const fields: Record<string, string> = {};
        if (name.length < 2) fields.name = "Enter your name";
        if (password.length < 8 || passwordProblems(password).score < 3) fields.password = "Choose a stronger password";
        if (Object.keys(fields).length) invalid(fields);
        user = { id: uid("u"), name, email: inv.email, hue: Math.floor(Math.random() * 360), avatarUrl: null, createdAt: nowISO(), password };
        db.users.push(user);
        db.prefs.push({ userId: user.id, prefs: defaultPrefs() });
      }
      if (!db.wsMembers.some((m) => m.userId === user.id && m.workspaceId === inv.workspaceId)) {
        db.wsMembers.push({ workspaceId: inv.workspaceId, userId: user.id, roleId: inv.roleId, status: "active", joinedAt: nowISO(), lastActiveAt: nowISO() });
      }
      inv.status = "accepted";
      mockSession.set(user.id);
      const ws = db.workspaces.find((w) => w.id === inv.workspaceId)!;
      return { accessToken: "mock-access-token", user: toUser(user), workspaceSlug: ws.slug };
    },
    { anonymous: true },
  );
}
