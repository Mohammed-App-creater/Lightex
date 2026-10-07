"use client";

import { Shortcut } from "@/components/ui/kbd";
import { Modal } from "@/components/ui/modal";
import { shell, useShell } from "./shell-state";

/** One source of truth for the shortcut sheet (also used by tooltips and the palette). */
export const SHORTCUT_GROUPS: { title: string; items: { label: string; keys: string[]; sequence?: boolean }[] }[] = [
  {
    title: "General",
    items: [
      { label: "Search and commands", keys: ["⌘", "K"] },
      { label: "New task", keys: ["C"] },
      { label: "Toggle sidebar", keys: ["⌘", "B"] },
      { label: "Collapse sidebar", keys: ["["] },
      { label: "Switch theme", keys: ["⌘", "⇧", "L"] },
      { label: "Keyboard shortcuts", keys: ["?"] },
    ],
  },
  {
    title: "Go to",
    items: [
      { label: "Board", keys: ["G", "B"], sequence: true },
      { label: "List", keys: ["G", "L"], sequence: true },
      { label: "Sprints", keys: ["G", "S"], sequence: true },
      { label: "Backlog", keys: ["G", "K"], sequence: true },
      { label: "Objectives", keys: ["G", "O"], sequence: true },
      { label: "Milestones", keys: ["G", "M"], sequence: true },
      { label: "Inbox", keys: ["G", "I"], sequence: true },
      { label: "My tasks", keys: ["G", "T"], sequence: true },
      { label: "Profile", keys: ["G", "P"], sequence: true },
    ],
  },
  {
    title: "Task",
    items: [
      { label: "Set status", keys: ["1–6"] },
      { label: "Mark done", keys: ["⌘", "⇧", "D"] },
      { label: "Expand to full page", keys: ["⌘", "⇧", "F"] },
      { label: "Copy link", keys: ["⌘", "L"] },
      { label: "Send comment", keys: ["⌘", "↵"] },
      { label: "Close panel", keys: ["Esc"] },
    ],
  },
];

export function ShortcutsDialog() {
  const { shortcuts } = useShell();
  return (
    <Modal open={shortcuts} onOpenChange={shell.setShortcuts} title="Keyboard shortcuts" width={640}>
      <div className="grid gap-6 sm:grid-cols-2">
        {SHORTCUT_GROUPS.map((g) => (
          <section key={g.title} className="flex flex-col gap-1">
            <h3 className="eyebrow m-0 pb-1.5">{g.title}</h3>
            <ul className="m-0 flex list-none flex-col p-0">
              {g.items.map((it) => (
                <li key={it.label} className="flex h-8 items-center justify-between gap-3 border-b border-line text-[13px] last:border-0">
                  <span className="text-fg-2">{it.label}</span>
                  <Shortcut keys={it.keys} sequence={it.sequence} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Modal>
  );
}
