import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./button";
import { StatusGlyph, PriorityIcon } from "./glyphs";
import { InlineEditText } from "./inline-edit";
import { TooltipProvider } from "./tooltip";
import { toast, useToasts } from "./toast";
import { renderHook } from "@testing-library/react";

describe("Button", () => {
  it("renders a disabled reason as aria-disabled with a description, and ignores clicks", async () => {
    const onClick = vi.fn();
    render(
      <TooltipProvider>
        <Button disabledReason="Sprint 14 has 4 open tasks" onClick={onClick}>
          Complete sprint
        </Button>
      </TooltipProvider>,
    );
    const btn = screen.getByRole("button", { name: "Complete sprint" });
    expect(btn).toHaveAttribute("aria-disabled", "true");
    expect(btn).toHaveAccessibleDescription("Sprint 14 has 4 open tasks");
    await userEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("shows the keycap hint", () => {
    render(<Button kbd="C">New task</Button>);
    expect(screen.getByText("C").tagName).toBe("KBD");
  });
});

describe("glyphs", () => {
  it("gives the status glyph an accessible name only when labelled", () => {
    const { rerender } = render(<StatusGlyph kind="done" label="Done" />);
    expect(screen.getByRole("img", { name: "Done" })).toHaveClass("glyph-done");
    rerender(<StatusGlyph kind="done" />);
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("fills N priority bars", () => {
    const { container } = render(<PriorityIcon level={2} />);
    expect(container.querySelector(".prio")).toHaveAttribute("data-level", "2");
  });
});

describe("InlineEditText", () => {
  it("saves on Enter and cancels on Escape", async () => {
    const onSave = vi.fn();
    render(<InlineEditText value="Old title" onSave={onSave} label="Task title" canEdit />);
    await userEvent.click(screen.getByRole("button", { name: /Task title/ }));
    const input = screen.getByRole("textbox", { name: "Task title" });
    await userEvent.clear(input);
    await userEvent.type(input, "New title{Enter}");
    expect(onSave).toHaveBeenCalledWith("New title");

    onSave.mockClear();
    await userEvent.click(screen.getByRole("button", { name: /Task title/ }));
    await userEvent.type(screen.getByRole("textbox", { name: "Task title" }), " more{Escape}");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("renders a plain heading when the user cannot edit", () => {
    render(<InlineEditText value="Read only" onSave={() => undefined} label="Task title" canEdit={false} />);
    expect(screen.getByRole("heading", { name: "Read only" })).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("toast store", () => {
  it("keeps at most three toasts and replaces by id", () => {
    const { result } = renderHook(() => useToasts());
    act(() => {
      toast({ title: "a" });
      toast({ title: "b" });
      toast({ title: "c" });
      toast({ title: "d" });
    });
    expect(result.current.map((x) => x.title)).toEqual(["b", "c", "d"]);
    act(() => {
      toast({ id: "same", title: "first" });
      toast({ id: "same", title: "second" });
    });
    expect(result.current.filter((x) => x.id === "same")).toHaveLength(1);
    expect(result.current.at(-1)?.title).toBe("second");
  });
});
