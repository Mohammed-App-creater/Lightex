import { describe, expect, it } from "vitest";
import { initialsOf, loginSchema, registerSchema, resetSchema, safeNext, scorePassword } from "./validation";

const firstError = (r: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }, path: string) =>
  r.error?.issues.find((i) => i.path[0] === path)?.message;

describe("scorePassword", () => {
  it("matches the design's worked examples", () => {
    expect(scorePassword("")).toBe(0);
    expect(scorePassword("beta")).toBe(1);
    expect(scorePassword("orbit")).toBe(1);
    expect(scorePassword("Sprint14")).toBe(3);
    expect(scorePassword("Beta-launch21")).toBe(4);
  });
  it("caps short passwords at Weak", () => {
    expect(scorePassword("Ab1!")).toBe(1);
  });
});

describe("schemas", () => {
  it("login copy", () => {
    const r = loginSchema.safeParse({ email: "", password: "" });
    expect(firstError(r, "email")).toBe("Enter your email");
    expect(firstError(r, "password")).toBe("Enter your password");
    expect(firstError(loginSchema.safeParse({ email: "sam@team", password: "x" }), "email")).toBe("Enter a valid email");
  });
  it("register needs a strong password and the terms", () => {
    const r = registerSchema.safeParse({ name: " ", email: "sam@team.dev", password: "beta", terms: false });
    expect(firstError(r, "name")).toBe("Enter your name");
    expect(firstError(r, "password")).toBe("Use a stronger password");
    expect(firstError(r, "terms")).toBe("Accept the terms to continue");
    expect(registerSchema.safeParse({ name: "Sam", email: "sam@team.dev", password: "Sprint14", terms: true }).success).toBe(true);
  });
  it("reset flags a mismatch", () => {
    const r = resetSchema.safeParse({ password: "Beta-launch21", confirm: "Beta-launch2" });
    expect(firstError(r, "confirm")).toBe("Passwords don’t match");
    expect(firstError(resetSchema.safeParse({ password: "Beta-launch21", confirm: "" }), "confirm")).toBe("Confirm your password");
  });
});

describe("helpers", () => {
  it("safeNext blocks open redirects", () => {
    expect(safeNext("/platform/inbox")).toBe("/platform/inbox");
    expect(safeNext("//evil.com")).toBe("/");
    expect(safeNext("https://evil.com")).toBe("/");
    expect(safeNext(null)).toBe("/");
  });
  it("initialsOf", () => {
    expect(initialsOf("Platform team")).toBe("PT");
    expect(initialsOf("Lightex")).toBe("LI");
  });
});
