import type { PresenceLocation, PresencePerson, PresenceRoster } from "@/lib/api/types";
import { mergeRoster, peopleAtLocation, replaceLocation } from "@/lib/realtime/roster";

/*
 * Presence labels and selections (spec §1.5). Pure; unit-tested. Rosters include the caller: the
 * UI places "you" last and never shows your own typing, editing or flags.
 */

export { mergeRoster, replaceLocation };

export const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/** People at a location: others (by arrival) and me. */
export function peopleAt(roster: Pick<PresenceRoster, "locations"> | undefined, loc: PresenceLocation | null, meId: string) {
  const all = peopleAtLocation(roster, loc);
  return { others: all.filter((p) => p.user.id !== meId), me: all.find((p) => p.user.id === meId) ?? null };
}

/** Others first (by arrival), you last. */
export function othersFirst(people: readonly PresencePerson[], meId: string) {
  return [...people.filter((p) => p.user.id !== meId), ...people.filter((p) => p.user.id === meId)];
}

/** "Jordan is here" · "Jordan and Riley are here" · "Jordan and 2 others are here". */
export function groupLabel(people: readonly Pick<PresencePerson, "user">[]): string {
  const names = people.map((p) => firstName(p.user.name));
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]} is here`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are here`;
  return `${names[0]} and ${names.length - 1} others are here`;
}

/** "Sam is typing" · "Sam and Riley are typing" · "3 people are typing" (never you). */
export function typingLabel(people: readonly PresencePerson[], meId: string): string {
  const t = people.filter((p) => p.typing && p.user.id !== meId);
  if (t.length === 0) return "";
  if (t.length === 1) return `${firstName(t[0]!.user.name)} is typing`;
  if (t.length === 2) return `${firstName(t[0]!.user.name)} and ${firstName(t[1]!.user.name)} are typing`;
  return `${t.length} people are typing`;
}

/** Fields that never show as "editing" (typing a comment has its own row). */
const NOT_EDITING = new Set(["comment"]);

/** Others editing (earliest first), excluding comment typing. */
export function editors(people: readonly PresencePerson[], meId: string) {
  return people
    .filter((p) => p.user.id !== meId && p.state === "editing" && !NOT_EDITING.has(p.field ?? ""))
    .sort((a, b) => a.since.localeCompare(b.since));
}

/** "Jordan is editing" · "Jordan and 1 other are editing" · "Jordan and 2 others are editing" (+ suffix). */
export function editingLabel(people: readonly PresencePerson[], meId: string, suffix = ""): string {
  const e = editors(people, meId);
  if (!e.length) return "";
  const first = firstName(e[0]!.user.name);
  const tail = suffix ? ` ${suffix}` : "";
  if (e.length === 1) return `${first} is editing${tail}`;
  const n = e.length - 1;
  return `${first} and ${n} other${n === 1 ? "" : "s"} are editing${tail}`;
}

/** Field names as both the §1.5 short form and the §3.4 Task field name → one canonical key. */
const ALIAS: Record<string, string> = {
  status: "statusId",
  assignee: "assigneeId",
  sprint: "sprintId",
  epic: "epicId",
  milestone: "milestoneId",
  labelIds: "labels",
  due: "dueDate",
  start: "startDate",
};
export const canonicalField = (f: string) => (f.startsWith("customFields.") ? `cf.${f.slice(13)}` : ALIAS[f] ?? f);

/** Field → the earliest other person editing it, for one task (§1.5 field flags). */
export function fieldFlags(roster: Pick<PresenceRoster, "locations"> | undefined, taskId: string, meId: string): Map<string, PresencePerson> {
  const out = new Map<string, PresencePerson>();
  for (const p of editors(peopleAtLocation(roster, { kind: "task", id: taskId }), meId)) {
    const key = canonicalField(p.field ?? "");
    if (key && !out.has(key)) out.set(key, p);
  }
  return out;
}

const NONE: readonly PresencePerson[] = [];

/** Task id → others with that task open (board cards). */
export function taskViewers(roster: Pick<PresenceRoster, "locations"> | undefined, meId: string): Map<string, readonly PresencePerson[]> {
  const out = new Map<string, readonly PresencePerson[]>();
  for (const l of roster?.locations ?? []) {
    if (l.location.kind !== "task") continue;
    const others = l.people.filter((p) => p.user.id !== meId);
    if (others.length) out.set(l.location.id, others);
  }
  return out;
}
export const NO_PEOPLE = NONE;

/** Avatar title / label: "Jordan Lee, viewing" · "Jordan Lee, editing the layout" · "Alex Kim, you". */
export function personLabel(p: PresencePerson, opts: { me?: boolean; editingWhat?: string } = {}) {
  if (opts.me) return `${p.user.name}, you`;
  if (p.state === "editing" && !NOT_EDITING.has(p.field ?? "")) return `${p.user.name}, editing${opts.editingWhat ? ` ${opts.editingWhat}` : ""}`;
  return `${p.user.name}, viewing`;
}
