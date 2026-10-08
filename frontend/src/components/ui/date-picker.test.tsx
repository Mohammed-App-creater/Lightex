import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./button";
import { DateChip, DatePicker } from "./date-picker";

function Harness({ initial = "2026-10-08", onChange = () => {}, min, max }: { initial?: string | null; onChange?: (v: string | null) => void; min?: string; max?: string }) {
  const [v, setV] = useState<string | null>(initial);
  return (
    <DatePicker
      aria-label="Due"
      value={v}
      min={min}
      max={max}
      clearable
      onChange={(x) => {
        setV(x);
        onChange(x);
      }}
      quick={(pick) => <DateChip onClick={() => pick("2026-12-25")}>Xmas</DateChip>}
    />
  );
}

describe("DatePicker", () => {
  it("shows the short date on the trigger and opens a month grid focused on the value", async () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: /^Due:/ });
    expect(trigger).toHaveTextContent("Oct 8");
    await userEvent.click(trigger);
    expect(screen.getByRole("grid", { name: "October 2026" })).toBeInTheDocument();
    const day = screen.getByRole("button", { name: "Thursday, October 8, 2026" });
    expect(day).toHaveFocus();
    expect(day.closest("[role=gridcell]")).toHaveAttribute("aria-selected", "true");
  });

  it("moves with the arrow keys and picks with Enter, emitting ISO dates", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: /^Due:/ }));
    await userEvent.keyboard("{ArrowRight}{ArrowDown}");
    expect(screen.getByRole("button", { name: "Friday, October 16, 2026" })).toHaveFocus();
    await userEvent.keyboard("{PageDown}");
    expect(screen.getByRole("grid", { name: "November 2026" })).toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    expect(onChange).toHaveBeenLastCalledWith("2026-11-16");
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
  });

  it("closes on Escape, supports quick chips and clear", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: /^Due:/ }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^Due:/ }));
    await userEvent.click(screen.getByRole("button", { name: "Xmas" }));
    expect(onChange).toHaveBeenLastCalledWith("2026-12-25");
    await userEvent.click(screen.getByRole("button", { name: "Clear date" }));
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(screen.getByRole("button", { name: /^Due:/ })).toHaveTextContent("Pick a date");
  });

  it("disables days outside min/max", async () => {
    render(<Harness min="2026-10-05" max="2026-10-20" />);
    await userEvent.click(screen.getByRole("button", { name: /^Due:/ }));
    expect(screen.getByRole("button", { name: "Sunday, October 4, 2026" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Wednesday, October 21, 2026" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next month" })).toBeDisabled();
  });
});

describe("Button loading", () => {
  it("is aria-disabled and busy, and ignores clicks", async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    const btn = screen.getByRole("button", { name: /Save/ });
    expect(btn).toHaveAttribute("aria-disabled", "true");
    expect(btn).toHaveAttribute("aria-busy", "true");
    await userEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("renders the spinner inside an asChild element", () => {
    render(
      <Button asChild loading>
        <a href="https://example.com/x">Open</a>
      </Button>,
    );
    const link = screen.getByRole("link", { name: /Open/ });
    expect(link.querySelector(".animate-spin")).not.toBeNull();
    expect(link).toHaveAttribute("aria-disabled", "true");
  });
});
