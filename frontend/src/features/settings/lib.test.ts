import { describe, expect, it } from "vitest";
import {
  avatarFileError,
  confirmState,
  moveItem,
  newPasswordError,
  passwordScore,
  slugError,
  slugSegments,
  workspaceIcon,
  workspaceNameError,
} from "./lib";

describe("slug rules", () => {
  it("reports problems in the design's order", () => {
    expect(slugError("")).toBe("Required");
    expect(slugError("Platform-Team")).toBe("Lowercase only");
    expect(slugError("platform team")).toBe("Use a–z, 0–9 and hyphens");
    expect(slugError("ab")).toBe("At least 3 characters");
    expect(slugError("a".repeat(33))).toBe("Max 32 characters");
    expect(slugError("-team")).toBe("Can’t start or end with a hyphen");
    expect(slugError("team-")).toBe("Can’t start or end with a hyphen");
    expect(slugError("plat--form")).toBe("No double hyphens");
    expect(slugError("platform-team")).toBeNull();
  });
  it("marks runs of illegal characters", () => {
    expect(slugSegments("ab_c!d")).toEqual([
      { text: "ab", bad: false },
      { text: "_", bad: true },
      { text: "c", bad: false },
      { text: "!", bad: true },
      { text: "d", bad: false },
    ]);
  });
  it("validates the workspace name", () => {
    expect(workspaceNameError(" ")).toBe("Required");
    expect(workspaceNameError("x")).toBe("Use at least 2 characters");
    expect(workspaceNameError("x".repeat(41))).toBe("Max 40 characters");
    expect(workspaceNameError("x".repeat(40))).toBeNull();
    expect(workspaceNameError("Platform team")).toBeNull();
  });
});

describe("workspace icon", () => {
  it("uses two words or the first two letters", () => {
    expect(workspaceIcon("Platform team")).toBe("PT");
    expect(workspaceIcon("design")).toBe("DE");
    expect(workspaceIcon("")).toBe("?");
  });
});

describe("type-to-confirm", () => {
  it("tracks the input", () => {
    expect(confirmState("", "platform-team")).toBe("empty");
    expect(confirmState("plat", "platform-team")).toBe("prefix");
    expect(confirmState("platform-team", "platform-team")).toBe("match");
    expect(confirmState("plax", "platform-team")).toBe("mismatch");
  });
});

describe("password", () => {
  it("scores strength", () => {
    expect(passwordScore("")).toBe(0);
    expect(passwordScore("short")).toBe(1);
    expect(passwordScore("abcdefgh")).toBe(1);
    expect(passwordScore("abcdefgh1")).toBe(1);
    expect(passwordScore("Abcdefgh1")).toBe(2);
    expect(passwordScore("Abcdefgh1!")).toBe(3);
    expect(passwordScore("Abcdefghijk1!")).toBe(4);
  });
  it("validates the new password", () => {
    expect(newPasswordError("", "", true)).toBe("Required");
    expect(newPasswordError("", "", false)).toBeNull();
    expect(newPasswordError("abc", "", false)).toBe("At least 8 characters");
    expect(newPasswordError("same-pass", "same-pass", false)).toBe("Must differ from current");
  });
});

describe("avatar files", () => {
  it("accepts PNG/JPG/WebP up to 2 MB", () => {
    expect(avatarFileError({ type: "image/png", size: 1000 })).toBeNull();
    expect(avatarFileError({ type: "image/gif", size: 1000 })).toBe("PNG, JPG or WebP only");
    expect(avatarFileError({ type: "image/webp", size: 3 * 1024 * 1024 })).toBe("Max 2 MB");
  });
});

describe("moveItem", () => {
  it("reorders and ignores out-of-range moves", () => {
    expect(moveItem(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveItem(["a", "b"], 1, 2)).toEqual(["a", "b"]);
  });
});
