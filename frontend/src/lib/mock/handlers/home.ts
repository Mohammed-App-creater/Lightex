import { nowISO, uid } from "../db";
import { wsPermissions } from "../derive";
import { fail, requireUser, route, wsBySlug } from "../router";

/*
 * Board 24 "Not on any project": a member without project.create asks the workspace admins to be
 * added to a project. One pending request per user per workspace.
 */
export function registerHome() {
  route("GET", "/workspaces/:slug/access-requests/mine", (ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    const userId = requireUser(ctx);
    const request = (ctx.db.wsAccessRequests ?? []).find((r) => r.workspaceId === ws.id && r.userId === userId) ?? null;
    return { request };
  });

  route("POST", "/workspaces/:slug/access-requests", (ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    const userId = requireUser(ctx);
    // Mirrors the UI: people who can create projects don't need to ask.
    if (wsPermissions(ctx.db, userId, ws.id).includes("project.create")) {
      fail(409, "conflict", "You can create projects yourself.");
    }
    const list = (ctx.db.wsAccessRequests ??= []);
    const existing = list.find((r) => r.workspaceId === ws.id && r.userId === userId);
    if (existing) return existing;
    const req = { id: uid("war"), workspaceId: ws.id, userId, createdAt: nowISO() };
    list.push(req);
    return req;
  });

  route("DELETE", "/workspaces/:slug/access-requests/mine", (ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    const userId = requireUser(ctx);
    ctx.db.wsAccessRequests = (ctx.db.wsAccessRequests ?? []).filter((r) => !(r.workspaceId === ws.id && r.userId === userId));
    return null;
  });
}
