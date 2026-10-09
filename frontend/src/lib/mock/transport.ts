import { ApiError } from "@/lib/api/errors";
import { parseQueryString, buildQueryString, type RequestOptions, type Transport } from "@/lib/api/transport";
import { getDB, mockSession, persist } from "./db";
import { mockControls } from "./controls";
import { registerAuth } from "./handlers/auth";
import { registerNotifications } from "./handlers/notifications";
import { registerPlanning } from "./handlers/planning";
import { registerProjects } from "./handlers/projects";
import { registerReports } from "./handlers/reports";
import { mockUploads, registerTasks } from "./handlers/tasks";
import { registerWorkspaces } from "./handlers/workspaces";
import { registerViews } from "./handlers/views";
import { registerHome } from "./handlers/home";
import { registerTrash } from "./handlers/trash";
import { registerExtensions } from "./handlers/extensions";
import { match } from "./router";
import { startTeammates } from "./teammates";

let registered = false;
function ensureRoutes() {
  if (registered) return;
  registered = true;
  registerAuth();
  registerWorkspaces();
  registerProjects();
  registerPlanning();
  registerTasks();
  registerReports();
  registerNotifications();
  registerViews();
  registerHome();
  registerTrash();
  registerExtensions();
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(id);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });

function refId() {
  const hex = () => Math.floor(Math.random() * 0x10000).toString(16).toUpperCase().padStart(4, "0");
  return `${hex()}-${hex()}`;
}

/**
 * In-browser backend. Same request shape as HttpTransport; routes live in ./handlers.
 * Adds 100–400ms latency and occasional 503s (NEXT_PUBLIC_MOCK_ERROR_RATE, default 3%).
 */
export class MockTransport implements Transport {
  constructor() {
    ensureRoutes();
    if (typeof window !== "undefined") startTeammates();
  }

  async request<T>({ method, path, query, body, signal }: RequestOptions): Promise<T> {
    const c = mockControls.get();
    await sleep(c.latencyMin + Math.random() * Math.max(0, c.latencyMax - c.latencyMin), signal);
    const label = `${method} ${path}`;
    if (c.offline) {
      throw new ApiError({ code: "network_error", message: "You're offline or the server can't be reached.", status: 0, request: label });
    }
    const isAuth = path.startsWith("/auth/") || path.startsWith("/invites/");
    if (!isAuth && Math.random() < c.errorRate) {
      throw new ApiError({
        code: "server_error",
        message: "The server had a hiccup. Your changes are safe.",
        status: 503,
        ref: refId(),
        request: label,
      });
    }
    const found = match(method, path);
    if (!found) throw new ApiError({ code: "not_found", message: `No mock route for ${label}`, status: 404, request: label });
    const db = getDB();
    const userId = mockSession.get();
    if (!found.route.anonymous && (!userId || !db.users.some((u) => u.id === userId))) {
      throw new ApiError({ code: "unauthorized", message: "Your session has expired.", status: 401, request: label });
    }
    // Round-trip the query through the wire format so filters behave exactly like live mode.
    const parsedQuery = parseQueryString(buildQueryString(query).slice(1));
    try {
      const result = await found.route.handler({
        params: found.params,
        query: parsedQuery,
        body: body === undefined ? undefined : structuredClone(body),
        userId,
        db,
      });
      if (method !== "GET") persist();
      return (result === undefined ? undefined : structuredClone(result)) as T;
    } catch (e) {
      if (e instanceof ApiError) {
        e.request = label;
        if (e.status >= 500) e.ref ??= refId();
      }
      throw e;
    }
  }
}

/** Simulates the PUT to a signed upload URL, with progress. */
export async function mockUpload(url: string, file: Blob, onProgress: (pct: number) => void, signal?: AbortSignal) {
  const id = url.replace("mock-upload://", "");
  const rec = mockUploads.get(id);
  if (!rec) throw new ApiError({ code: "upload_expired", message: "The upload link expired. Try again.", status: 403 });
  let pct = 0;
  while (pct < 100) {
    await sleep(120 + Math.random() * 60, signal);
    pct = Math.min(100, pct + 6 + Math.random() * 12 + (file.size < 200_000 ? 30 : 0));
    onProgress(Math.round(pct));
  }
  rec.blob = file;
}
