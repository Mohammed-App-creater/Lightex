import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { EmailChips } from "./email-chips";
import {
  addChips,
  chipsError,
  deriveKey,
  inviteCta,
  inviteSummary,
  keyError,
  sanitizeKey,
  slugify,
  splitDraft,
  workspaceNameError,
} from "./logic";

describe("workspace slug", () => {
  it("slugifies", () => {
    expect(slugify("Platform team")).toBe("platform-team");
    expect(slugify("  --Ünïcode & Co!! ")).toBe("n-code-co");
    expect(slugify("a".repeat(40))).toHaveLength(32);
  });
  it("validates", () => {
    expect(workspaceNameError("P")).toBe("Use at least 2 characters");
    expect(workspaceNameError("Admin")).toBe("lightex.app/admin is taken");
    expect(workspaceNameError("Platform team")).toBeNull();
  });
});

describe("project key", () => {
  it("derives from the name", () => {
    expect(deriveKey("Platform Rebuild")).toBe("PR");
    expect(deriveKey("Mobile")).toBe("MOB");
    expect(deriveKey("a b c d e")).toBe("ABCD");
    expect(deriveKey("2026 roadmap")).toBe("ROA");
  });
  it("sanitises and validates", () => {
    expect(sanitizeKey("pr-j12xyzq")).toBe("PRJXY");
    expect(keyError("P")).toBe("Key: 2–5 letters");
    expect(keyError("PRJ")).toBeNull();
  });
});

describe("invite chips", () => {
  it("splits drafts and keeps the trailing part", () => {
    expect(splitDraft("a@b.co, c@d.co; e")).toEqual({ tokens: ["a@b.co", "c@d.co"], draft: "e" });
    expect(splitDraft("a@b.co e@f.co", true)).toEqual({ tokens: ["a@b.co", "e@f.co"], draft: "" });
  });
  it("dedupes and caps at 20", () => {
    expect(addChips(["A@b.co"], ["a@b.co", "c@d.co"])).toEqual(["A@b.co", "c@d.co"]);
    expect(addChips([], Array.from({ length: 25 }, (_, i) => `u${i}@t.dev`))).toHaveLength(20);
  });
  it("error copy and CTA", () => {
    expect(chipsError(["a@b.co"])).toBeNull();
    expect(chipsError(["sam@team"])).toBe("“sam@team” isn’t an email");
    expect(chipsError(["x", "y"])).toBe("2 emails need fixing");
    expect(inviteCta(0)).toBe("Continue");
    expect(inviteCta(1)).toBe("Send 1 invite");
    expect(inviteCta(3)).toBe("Send 3 invites");
    expect(inviteSummary(1, "member")).toBe("1 person · Member");
    expect(inviteSummary(2, "admin")).toBe("2 people · Admin");
  });

  it("EmailChips commits on comma, removes with Backspace", async () => {
    function Harness() {
      const [s, set] = useState({ chips: [] as string[], draft: "" });
      return <EmailChips id="e" chips={s.chips} draft={s.draft} onChange={set} />;
    }
    render(<Harness />);
    const input = screen.getByRole("textbox");
    await userEvent.type(input, "jordan@team.dev,sam@team");
    expect(screen.getByRole("button", { name: "Remove jordan@team.dev" })).toBeInTheDocument();
    await userEvent.type(input, "{Enter}");
    expect(screen.getByText("(not a valid email)", { exact: false })).toBeInTheDocument();
    await userEvent.type(input, "{Backspace}");
    expect(screen.queryByRole("button", { name: "Remove sam@team" })).toBeNull();
  });
});
