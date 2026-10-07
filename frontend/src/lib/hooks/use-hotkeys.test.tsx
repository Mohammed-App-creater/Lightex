import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useHotkeys, type HotkeyMap } from "./use-hotkeys";

function Harness({ map }: { map: HotkeyMap }) {
  useHotkeys(map);
  return <input aria-label="field" />;
}

describe("useHotkeys", () => {
  it("fires single keys, chords and G-then-B sequences", () => {
    const c = vi.fn();
    const gb = vi.fn();
    const k = vi.fn();
    render(<Harness map={{ c, "g b": gb, "mod+k": k }} />);
    fireEvent.keyDown(window, { key: "c" });
    expect(c).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "g" });
    fireEvent.keyDown(window, { key: "b" });
    expect(gb).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true, metaKey: true });
    expect(k).toHaveBeenCalledTimes(1);
  });

  it("ignores plain keys while typing", () => {
    const c = vi.fn();
    const { getByLabelText } = render(<Harness map={{ c }} />);
    fireEvent.keyDown(getByLabelText("field"), { key: "c" });
    expect(c).not.toHaveBeenCalled();
  });
});
