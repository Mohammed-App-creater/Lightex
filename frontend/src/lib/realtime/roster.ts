import type { ID, ISODateTime, PresenceLocation, PresencePerson, PresenceRoster } from "@/lib/api/types";

/*
 * Presence roster cache maths (spec §5.3, §7.8). The cache holds one PresenceRoster per project
 * (qk.presence). Two writers feed it:
 * - `presence.updated` events: one location's full roster with its own `at` (replaceLocation);
 * - the heartbeat PUT / P3 GET: the whole project snapshot (mergeRoster).
 * Each location remembers the `at` it was last written with, so an older snapshot never
 * overwrites a newer one.
 */

export type CachedLocation = { location: PresenceLocation; people: PresencePerson[]; at?: ISODateTime };
export type CachedRoster = Omit<PresenceRoster, "locations"> & {
  locations: CachedLocation[];
  /** `at` of the last whole-project snapshot merged in (heartbeat / P3). */
  snapshotAt?: ISODateTime;
};

const sameLoc = (a: PresenceLocation, b: PresenceLocation) => a.kind === b.kind && a.id === b.id;
const newer = (a: ISODateTime | undefined, b: ISODateTime | undefined) => (a ?? "") > (b ?? "");

/** Applies one `presence.updated`. Ignores a snapshot older than the location's current one. */
export function replaceLocation(
  r: CachedRoster | undefined,
  projectId: ID,
  u: { location: PresenceLocation; people: PresencePerson[]; at: ISODateTime },
): CachedRoster {
  const base: CachedRoster = r ?? { projectId, at: u.at, locations: [] };
  const i = base.locations.findIndex((l) => sameLoc(l.location, u.location));
  const current = i >= 0 ? base.locations[i] : undefined;
  if (current && newer(current.at ?? base.snapshotAt, u.at)) return base;
  // An event older than the last snapshot, for a location that snapshot doesn't list: it had emptied by then.
  if (!current && newer(base.snapshotAt, u.at)) return base;
  const next = base.locations.filter((_, j) => j !== i);
  if (u.people.length) next.push({ location: u.location, people: u.people, at: u.at });
  return { ...base, at: newer(u.at, base.at) ? u.at : base.at, locations: next };
}

/** Merges a whole-project snapshot (heartbeat or P3). Locations written after it are kept. */
export function mergeRoster(old: CachedRoster | undefined, incoming: PresenceRoster): CachedRoster {
  if (!old || old.projectId !== incoming.projectId) {
    return { ...incoming, snapshotAt: incoming.at, locations: incoming.locations.map((l) => ({ ...l, at: incoming.at })) };
  }
  if (newer(old.snapshotAt, incoming.at)) return old; // an older snapshot than the one we merged last
  const out: CachedLocation[] = [];
  const seen: CachedLocation[] = [];
  for (const l of incoming.locations) {
    const mine = old.locations.find((o) => sameLoc(o.location, l.location));
    if (mine && newer(mine.at, incoming.at)) out.push(mine);
    else out.push({ ...l, at: incoming.at });
    seen.push(l);
  }
  // Locations the snapshot doesn't list (it says they're empty) survive only when written after it.
  for (const o of old.locations) {
    if (seen.some((s) => sameLoc(s.location, o.location))) continue;
    if (newer(o.at, incoming.at)) out.push(o);
  }
  return { projectId: incoming.projectId, at: newer(old.at, incoming.at) ? old.at : incoming.at, snapshotAt: incoming.at, locations: out };
}

export function peopleAtLocation(r: Pick<PresenceRoster, "locations"> | undefined, loc: PresenceLocation | null): PresencePerson[] {
  if (!r || !loc) return [];
  return r.locations.find((l) => sameLoc(l.location, loc))?.people ?? [];
}
