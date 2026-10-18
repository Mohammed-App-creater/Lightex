import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { SuggestionProps } from "@tiptap/suggestion";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { User } from "@/api/types";
import { MentionList, mentionItems, type MentionItem } from "./rich-text";

/* The @all item in the comment mention picker. */

const people = [
  { id: "u_sam", name: "Sam Patel", hue: 20 },
  { id: "u_alex", name: "Alex Kim", hue: 285 },
] as User[];

afterEach(cleanup);

describe("@all mention", () => {
  it("leads the list for an empty, 'all' or 'everyone' query only", () => {
    expect(mentionItems(people, "").map((i) => i.id)).toEqual(["all", "u_sam", "u_alex"]);
    expect(mentionItems(people, "al").map((i) => i.id)).toEqual(["all", "u_alex"]);
    expect(mentionItems(people, "Every").map((i) => i.id)).toEqual(["all"]);
    expect(mentionItems(people, "sam").map((i) => i.id)).toEqual(["u_sam"]);
  });

  it("shows @all with its hint and inserts the all mention", () => {
    const command = vi.fn();
    const props = { items: mentionItems(people, ""), command, clientRect: () => new DOMRect(10, 100, 0, 16) } as unknown as SuggestionProps<MentionItem>;
    render(<MentionList {...props} />);
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveTextContent("@all");
    expect(options[0]).toHaveTextContent("Notify everyone here");
    fireEvent.mouseDown(options[0]!);
    expect(command).toHaveBeenCalledWith({ id: "all", label: "all" });
  });
});
