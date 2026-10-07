import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { NotificationPreferences } from "@/lib/api/types";
import { PreferencesMatrix } from "./preferences";

const prefs: NotificationPreferences = {
  events: {
    assigned: { in_app: true, email: true },
    mentioned: { in_app: true, email: true },
    status_change: { in_app: true, email: false },
    comment: { in_app: true, email: false },
    due_soon: { in_app: true, email: true },
    sprint_started: { in_app: true, email: false },
  },
  emailDelivery: "instant",
};

describe("PreferencesMatrix", () => {
  it("has live switches for In-app and Email", async () => {
    const onToggle = vi.fn();
    render(<PreferencesMatrix prefs={prefs} onToggle={onToggle} />);
    expect(screen.getAllByRole("switch")).toHaveLength(12);
    const sw = screen.getByRole("switch", { name: "New comment, Email" });
    expect(sw).not.toBeChecked();
    await userEvent.click(sw);
    expect(onToggle).toHaveBeenCalledWith("comment", "email", true);
  });

  it("renders Telegram, SMS and Push as non-interactive coming-soon cells", async () => {
    const onToggle = vi.fn();
    render(<PreferencesMatrix prefs={prefs} onToggle={onToggle} />);
    const soon = screen.getAllByRole("img", { name: /: coming soon$/ });
    expect(soon).toHaveLength(18);
    const cell = screen.getByRole("img", { name: "Mentioned, Telegram: coming soon" });
    expect(cell.tagName).not.toBe("INPUT");
    expect(cell).not.toHaveAttribute("tabindex");
    expect(cell.querySelector("input, button")).toBeNull();
    await userEvent.click(cell);
    expect(onToggle).not.toHaveBeenCalled();
    expect(screen.getAllByText("Coming soon")).toHaveLength(3);
  });
});
