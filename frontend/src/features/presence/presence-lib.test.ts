import { describe, expect, it } from "vitest";
import type { PresencePerson, PresenceRoster } from "@/lib/api/types";
import { canonicalField, editingLabel, fieldFlags, groupLabel, mergeRoster, othersFirst, peopleAt, personLabel, replaceLocation, taskViewers, typingLabel } from "./presence-lib";

const P = (id: string, name: string, over: Partial<PresencePerson> = {}): PresencePerson => ({
  user: { id, name, hue: 100, avatarUrl: null },
  state: "viewing",
  field: null,
  typing: false,
  since: "2026-10-09T09:00:00Z",
  ...over,
});
const jordan = P("u_jordan", "Jordan Lee", { since: "2026-10-09T08:58:00Z" });
const riley = P("u_riley", "Riley Chen", { since: "2026-10-09T08:59:00Z" });
const sam = P("u_sam", "Sam Patel");
const me = P("u_me", "Alex Kim");

describe("presence labels (spec §1.5)", () => {
  it("names the group", () => {
    expect(groupLabel([jordan])).toBe("Jordan is here");
    expect(groupLabel([jordan, riley])).toBe("Jordan and Riley are here");
    expect(groupLabel([jordan, riley, sam])).toBe("Jordan and 2 others are here");
  });

  it("names typists, never you", () => {
    const t = (p: PresencePerson) => ({ ...p, typing: true });
    expect(typingLabel([t(sam), t(me)], "u_me")).toBe("Sam is typing");
    expect(typingLabel([t(sam), t(riley)], "u_me")).toBe("Sam and Riley are typing");
    expect(typingLabel([t(sam), t(riley), t(jordan)], "u_me")).toBe("3 people are typing");
    expect(typingLabel([sam], "u_me")).toBe("");
  });

  it("names editors, earliest first, excluding comment typing and you", () => {
    const e = (p: PresencePerson, field: string) => ({ ...p, state: "editing" as const, field });
    expect(editingLabel([e(riley, "dueDate"), e(jordan, "description")], "u_me")).toBe("Jordan and 1 other are editing");
    expect(editingLabel([e(jordan, "layout")], "u_me", "the layout")).toBe("Jordan is editing the layout");
    expect(editingLabel([e(sam, "comment"), e(me, "title")], "u_me")).toBe("");
    expect(editingLabel([e(jordan, "a"), e(riley, "b"), e(sam, "c")], "u_me")).toBe("Jordan and 2 others are editing");
  });

  it("labels avatars", () => {
    expect(personLabel(jordan)).toBe("Jordan Lee, viewing");
    expect(personLabel({ ...jordan, state: "editing", field: "layout" }, { editingWhat: "the layout" })).toBe("Jordan Lee, editing the layout");
    expect(personLabel(me, { me: true })).toBe("Alex Kim, you");
  });
});

describe("roster selections", () => {
  const roster: PresenceRoster = {
    projectId: "p1",
    at: "2026-10-09T09:00:00Z",
    locations: [
      { location: { kind: "task", id: "t1" }, people: [me, { ...riley, state: "editing", field: "dueDate" }, { ...jordan, state: "editing", field: "dueDate" }, { ...sam, state: "editing", field: "customFields.cf_1" }] },
      { location: { kind: "board", id: "p1" }, people: [me, jordan] },
      { location: { kind: "task", id: "t2" }, people: [me] },
    ],
  };

  it("splits people at a location into others and me, you last", () => {
    expect(peopleAt(roster, { kind: "board", id: "p1" }, "u_me")).toEqual({ others: [jordan], me });
    expect(othersFirst([me, jordan], "u_me").map((p) => p.user.id)).toEqual(["u_jordan", "u_me"]);
  });

  it("flags each field with its earliest other editor; custom fields as cf.<id>", () => {
    const flags = fieldFlags(roster, "t1", "u_me");
    expect(flags.get("dueDate")?.user.id).toBe("u_jordan");
    expect(flags.get("cf.cf_1")?.user.id).toBe("u_sam");
    expect(canonicalField("status")).toBe("statusId");
    expect(canonicalField("customFields.x")).toBe("cf.x");
  });

  it("maps tasks to the others who have them open (board cards)", () => {
    const v = taskViewers(roster, "u_me");
    expect([...v.keys()]).toEqual(["t1"]);
    expect(v.get("t1")).toHaveLength(3);
  });
});

describe("roster merge (heartbeat snapshot vs presence.updated events)", () => {
  const snap = (at: string, locs: PresenceRoster["locations"]): PresenceRoster => ({ projectId: "p1", at, locations: locs });
  const board = { kind: "board" as const, id: "p1" };
  const task = { kind: "task" as const, id: "t1" };

  it("takes the first snapshot as is", () => {
    const r = mergeRoster(undefined, snap("2026-10-09T09:00:00Z", [{ location: board, people: [jordan] }]));
    expect(r.locations[0]!.people).toEqual([jordan]);
  });

  it("keeps a location written by an event after the snapshot", () => {
    let r = mergeRoster(undefined, snap("2026-10-09T09:00:00Z", [{ location: board, people: [jordan] }]));
    r = replaceLocation(r, "p1", { location: board, people: [jordan, riley], at: "2026-10-09T09:00:30Z" });
    r = replaceLocation(r, "p1", { location: task, people: [sam], at: "2026-10-09T09:00:31Z" });
    // A heartbeat snapshot taken before those events must not undo them.
    r = mergeRoster(r, snap("2026-10-09T09:00:20Z", [{ location: board, people: [jordan] }]));
    expect(r).toBe(r);
    expect(peopleAt(r, board, "u_me").others).toHaveLength(2);
    expect(peopleAt(r, task, "u_me").others).toHaveLength(1);
    // A newer snapshot wins and drops locations it doesn't list.
    r = mergeRoster(r, snap("2026-10-09T09:01:00Z", [{ location: board, people: [riley] }]));
    expect(peopleAt(r, board, "u_me").others.map((p) => p.user.id)).toEqual(["u_riley"]);
    expect(peopleAt(r, task, "u_me").others).toEqual([]);
  });

  it("ignores an event older than the snapshot for a location the snapshot says is empty", () => {
    let r = mergeRoster(undefined, snap("2026-10-09T09:00:20Z", []));
    r = replaceLocation(r, "p1", { location: task, people: [sam], at: "2026-10-09T09:00:10Z" });
    expect(r.locations).toEqual([]);
  });

  it("removes a location when its roster empties", () => {
    let r = replaceLocation(undefined, "p1", { location: task, people: [sam], at: "2026-10-09T09:00:10Z" });
    r = replaceLocation(r, "p1", { location: task, people: [], at: "2026-10-09T09:00:11Z" });
    expect(r.locations).toEqual([]);
  });
});
