/*
 * "Who changed this, just now?" (spec §7.8, last paragraph). applyEvent records the actor of
 * another person's change per scope; use-live-flash reads it when the refetch it caused lands, to
 * flash the changed rows and raise "Updated just now by Riley · Burndown" (at most one per 4 s).
 *
 * Scopes: `p:<projectId>` (project data: dashboard widgets) and `t:<taskId>` (the open task).
 */

export type RemoteMark = { actorId: string; at: number; fields: string[] };

const MARK_TTL_MS = 10_000;
const marks = new Map<string, RemoteMark>();

export const remoteMarks = {
  set(scope: string, mark: Omit<RemoteMark, "at">, now = Date.now()) {
    marks.set(scope, { ...mark, at: now });
  },
  /** The mark when it is fresher than `since` (the data's previous update) and not expired. */
  get(scope: string, since = 0, now = Date.now()): RemoteMark | null {
    const m = marks.get(scope);
    if (!m || now - m.at > MARK_TTL_MS || m.at < since - 1000) return null;
    return m;
  },
  clear() {
    marks.clear();
  },
};

let lastToastAt = 0;
/** "Updated just now" toasts: at most one every 4 s across the tab. */
export function claimLiveToast(now = Date.now()) {
  if (now - lastToastAt < 4000) return false;
  lastToastAt = now;
  return true;
}
