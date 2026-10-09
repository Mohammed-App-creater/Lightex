import { describe, expect, it } from "vitest";
import type { CustomField, Task } from "@/lib/api/types";
import { sortTasks, type Ctx } from "@/features/list/list-model";
import { cardChip, cfSortValue, displayValue, fieldNameError, optionsError, validateValue, visibleRows } from "./field-lib";

const f = (over: Partial<CustomField>): CustomField => ({ id: "f", projectId: "p", name: "F", type: "text", required: false, position: 0, options: [], taskCount: 0, createdAt: "", ...over });
const browser = f({
  id: "browser",
  name: "Browser",
  type: "select",
  position: 1,
  options: [
    { id: "chrome", name: "Chrome", color: "var(--low)", position: 0 },
    { id: "safari", name: "Safari", color: "var(--accent-t)", position: 1 },
  ],
});
const env = f({ id: "env", name: "Env", type: "select", position: 0, options: [{ id: "prod", name: "Prod", color: "var(--danger)", position: 0 }] });
const owner = f({ id: "owner", name: "QA owner", type: "user", position: 2 });
const found = f({ id: "found", name: "Found in", type: "text", required: true, position: 3 });
const accounts = f({ id: "accounts", name: "Accounts", type: "number", position: 4 });
const signoff = f({ id: "signoff", name: "QA sign-off", type: "date", position: 5 });
const members = new Map([["u1", { id: "u1", name: "Riley Chen", hue: 150 }]]);

describe("custom-field display", () => {
  it("renders each type, with fallbacks for dangling values", () => {
    expect(displayValue(browser, "safari", members)).toEqual({ text: "Safari", color: "var(--accent-t)" });
    expect(displayValue(browser, "gone", members)).toEqual({ text: "Removed option", muted: true });
    expect(displayValue(owner, "u1", members)?.text).toBe("Riley Chen");
    expect(displayValue(owner, "u9", members)).toEqual({ text: "Former member", muted: true });
    expect(displayValue(accounts, 1240, members)?.text).toBe("1,240");
    expect(displayValue(signoff, "2026-10-09", members, "2026-10-09")?.text).toMatch(/^Oct 9.* · today$/);
    expect(displayValue(signoff, "2026-10-09", members, "2026-10-08")?.text).not.toMatch(/today/);
    expect(displayValue(found, "v2.3.1", members)?.text).toBe("v2.3.1");
    expect(displayValue(found, undefined, members)).toBeNull();
  });

  it("validates with the server's messages, clamping numbers and cutting text", () => {
    expect(validateValue(found, "  ")).toEqual({ ok: false, error: "This field is required" });
    expect(validateValue(signoff, null)).toEqual({ ok: true, value: null });
    expect(validateValue(found, "x".repeat(130))).toEqual({ ok: true, value: "x".repeat(120) });
    expect(validateValue(accounts, "abc")).toEqual({ ok: false, error: "Enter a number from 0 to 1,000,000,000" });
    expect(validateValue(accounts, -5)).toEqual({ ok: true, value: 0 });
    expect(validateValue(accounts, 2e10)).toEqual({ ok: true, value: 1_000_000_000 });
    expect(validateValue(accounts, "12.346")).toEqual({ ok: true, value: 12.35 });
    expect(validateValue(browser, "nope")).toEqual({ ok: false, error: "Pick one of the options" });
    expect(validateValue(signoff, "10/09")).toEqual({ ok: false, error: "Pick a date" });
    expect(validateValue(owner, "u9", (id) => id === "u1")).toEqual({ ok: false, error: "Pick someone on this project" });
  });

  it("picks the first select field by position that has a value for the card chip", () => {
    const fields = [browser, env];
    expect(cardChip({ customFields: { browser: "safari", env: "prod" } }, fields)).toEqual({ field: "Env", option: "Prod", color: "var(--danger)" });
    expect(cardChip({ customFields: { browser: "safari" } }, fields)).toEqual({ field: "Browser", option: "Safari", color: "var(--accent-t)" });
    expect(cardChip({ customFields: { env: "gone" } }, fields)).toBeNull();
    expect(cardChip({ customFields: {} }, fields)).toBeNull();
  });

  it("shows rows with a value, required rows and revealed rows", () => {
    const rows = visibleRows([accounts, found, browser, signoff], { customFields: { browser: "chrome" } }, new Set(["signoff"]));
    expect(rows.map((r) => r.id)).toEqual(["browser", "found", "signoff"]);
  });

  it("checks names and options for the dialog", () => {
    expect(fieldNameError(" ", [])).toBe("Name is required");
    expect(fieldNameError("x".repeat(41), [])).toBe("Up to 40 characters");
    expect(fieldNameError("browser", [browser])).toBe("A field with this name exists");
    expect(fieldNameError("Browser", [browser], "browser")).toBeNull();
    expect(optionsError([{ name: " " }])).toBe("Add at least one option");
    expect(optionsError([{ name: "A" }, { name: "a" }])).toBe("Options must be unique");
    expect(optionsError([{ name: "A" }, { name: "" }])).toBeNull();
  });

  it("sorts list columns by custom field, empty values last", () => {
    const t = (n: number, cf: Task["customFields"]) => ({ id: `t${n}`, number: n, customFields: cf }) as Task;
    const tasks = [t(1, {}), t(2, { accounts: 50 }), t(3, { accounts: 7 }), t(4, { browser: "safari" }), t(5, { browser: "chrome" })];
    const ctx = { statuses: [], users: new Map(), sprints: [], milestones: [], epics: [], labels: new Map(), meId: "u", today: "", weekEnd: "", fields: [accounts, browser] } as Ctx;
    expect(sortTasks(tasks, { col: "cf.accounts", dir: "asc" }, ctx).map((x) => x.number)).toEqual([3, 2, 1, 4, 5]);
    expect(sortTasks(tasks, { col: "cf.browser", dir: "asc" }, ctx).map((x) => x.number)).toEqual([5, 4, 1, 2, 3]);
    expect(cfSortValue(t(9, { owner: "u1" }), owner, members)).toBe("riley chen");
  });
});
