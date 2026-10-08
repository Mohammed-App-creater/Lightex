"use client";

import * as D from "@radix-ui/react-dialog";
import { ArrowRight, Search, X } from "lucide-react";
import { Fragment, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/choice";
import { useIsMac } from "@/lib/hooks/use-platform";
import { shell, useShell } from "./shell-state";

/*
 * Shortcut sheet (board 34), opened with "?". Specs: "G>B" = G then B, "⌘+K" = together,
 * "J|K" = either. Keep in sync with the real bindings: global-hotkeys.tsx, task-detail.tsx
 * (panel keys), filter-bar.tsx (F / ⇧F), inbox.tsx, attachment-viewer.tsx, pinned-views.tsx.
 */
export const SHORTCUT_GROUPS: { title: string; items: { label: string; spec: string }[] }[] = [
  {
    title: "Navigation",
    items: [
      { label: "Search and commands", spec: "⌘+K" },
      { label: "Go to board", spec: "G>B" },
      { label: "Go to list", spec: "G>L" },
      { label: "Go to backlog", spec: "G>K" },
      { label: "Go to sprints", spec: "G>S" },
      { label: "Go to objectives", spec: "G>O" },
      { label: "Go to milestones", spec: "G>M" },
      { label: "Go to reports", spec: "G>R" },
      { label: "Go to inbox", spec: "G>I" },
      { label: "Go to my tasks", spec: "G>T" },
      { label: "Go to home", spec: "G>H" },
      { label: "Go to profile", spec: "G>P" },
      { label: "Settings", spec: "⌘+," },
    ],
  },
  {
    title: "Tasks",
    items: [
      { label: "Create task", spec: "C" },
      { label: "Create (in New task)", spec: "⌘+↵" },
      { label: "Set status (task panel)", spec: "1–6" },
      { label: "Mark done", spec: "⌘+⇧+D" },
      { label: "Expand to full page", spec: "⌘+⇧+F" },
      { label: "Copy link (task panel)", spec: "⌘+L" },
      { label: "Duplicate", spec: "⌘+D" },
      { label: "Send comment", spec: "⌘+↵" },
    ],
  },
  {
    title: "Board and list",
    items: [
      { label: "Open filters", spec: "F" },
      { label: "Clear filters", spec: "⇧+F" },
      { label: "Open card", spec: "O" },
      { label: "Pick up or drop card", spec: "Space" },
      { label: "Move picked-up card", spec: "←|→" },
      { label: "Reorder pinned view", spec: "⌥+↑|↓" },
    ],
  },
  {
    title: "Inbox",
    items: [
      { label: "Next / previous", spec: "J|K" },
      { label: "Mark read or unread", spec: "E" },
      { label: "Mark all read", spec: "⇧+E" },
    ],
  },
  {
    title: "Attachments",
    items: [
      { label: "Previous / next file", spec: "←|→" },
      { label: "Zoom in / out", spec: "+|−" },
      { label: "Fit to screen", spec: "0" },
    ],
  },
  {
    title: "Global",
    items: [
      { label: "Toggle sidebar", spec: "⌘+B|[" },
      { label: "Switch theme", spec: "⌘+⇧+L" },
      { label: "Keyboard shortcuts", spec: "?" },
      { label: "Close or cancel", spec: "Esc" },
    ],
  },
];

type Part = { kind: "key"; t: string } | { kind: "then" } | { kind: "or" };
const WIN: Record<string, string> = { "⌘": "Ctrl", "⌥": "Alt", "⇧": "Shift", "↵": "Enter" };
const SPOKEN: Record<string, string> = { "⌘": "Command", "⌥": "Option", "⇧": "Shift", "↵": "Enter", "←": "Left", "→": "Right", "↑": "Up", "↓": "Down", "?": "Question mark", "[": "Left bracket", "−": "Minus", "+": "Plus" };

/** Parses a spec into keycaps for the given platform plus a spoken label for screen readers. */
export function parseSpec(spec: string, win: boolean) {
  const parts: Part[] = [];
  const spoken: string[] = [];
  spec.split(">").forEach((seq, si) => {
    if (si > 0) {
      parts.push({ kind: "then" });
      spoken.push("then");
    }
    seq.split("|").forEach((alt, ai) => {
      if (ai > 0) {
        parts.push({ kind: "or" });
        spoken.push("or");
      }
      const keys = alt === "+" ? ["+"] : alt.split("+");
      keys.forEach((k) => {
        const t = win && WIN[k] ? WIN[k]! : k;
        parts.push({ kind: "key", t });
        spoken.push(win && WIN[k] ? WIN[k]! : SPOKEN[k] ?? k);
      });
    });
  });
  return { parts, spoken: spoken.join(" ") };
}

export function filterShortcuts(q: string, win: boolean) {
  const query = q.trim().toLowerCase();
  return SHORTCUT_GROUPS.map((g) => ({
    title: g.title,
    rows: g.items
      .map((it) => ({ ...it, ...parseSpec(it.spec, win) }))
      .filter((r) => !query || r.label.toLowerCase().includes(query) || g.title.toLowerCase().includes(query) || r.parts.some((p) => p.kind === "key" && p.t.toLowerCase() === query)),
  })).filter((g) => g.rows.length);
}

export function ShortcutsDialog() {
  const { shortcuts } = useShell();
  return (
    <D.Root open={shortcuts} onOpenChange={shell.setShortcuts}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-[60] bg-scrim backdrop-blur-[6px] data-[state=open]:animate-[fade-in_180ms_var(--ease)]" />
        <D.Content
          aria-describedby={undefined}
          data-keys="always"
          className="fixed left-1/2 top-[min(10vh,88px)] z-[61] flex max-h-[calc(100dvh-min(10vh,88px)-16px)] w-[700px] max-w-[calc(100%-32px)] -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-line-2 bg-surface shadow-modal outline-none data-[state=open]:animate-[modal-in_180ms_var(--ease)] max-[760px]:top-4 max-[760px]:max-h-[calc(100dvh-32px)]"
        >
          {shortcuts && <Sheet />}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

function Sheet() {
  const isMac = useIsMac();
  const [plat, setPlat] = useState<"mac" | "win">(isMac ? "mac" : "win");
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const win = plat === "win";
  const groups = filterShortcuts(q, win);

  return (
    <>
      <div className="flex flex-none items-center gap-3 border-b border-line py-3.5 pl-5 pr-3 max-[760px]:flex-wrap max-[760px]:pl-4">
        <D.Title className="m-0 flex-1 text-[16px] font-semibold tracking-[-0.01em]">Keyboard shortcuts</D.Title>
        <div className="relative flex max-[760px]:order-3 max-[760px]:w-full">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-3" aria-hidden />
          <input
            ref={input}
            autoFocus
            type="text"
            aria-label="Filter shortcuts"
            placeholder="Filter shortcuts"
            maxLength={40}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="h-[30px] w-[220px] rounded-[7px] border border-line-2 bg-bg pl-[30px] pr-2.5 text-[13px] text-fg outline-none placeholder:text-fg-3 focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-s)] max-[760px]:h-11 max-[760px]:w-full"
          />
        </div>
        <D.Close asChild>
          <Button variant="ghost" size="sm" icon aria-label="Close (Esc)" className="max-[760px]:size-11">
            <X size={14} aria-hidden />
          </Button>
        </D.Close>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {groups.length ? (
          <div className="grid grid-cols-2 items-start gap-x-8 gap-y-5 px-5 pb-5 pt-[18px] max-[760px]:grid-cols-1 max-[760px]:px-4">
            {groups.map((g) => (
              <section key={g.title} aria-label={g.title}>
                <h3 className="m-0 mb-1.5 font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-fg-3">{g.title}</h3>
                <ul className="m-0 list-none p-0">
                  {g.rows.map((r) => (
                    <li key={`${r.label}-${r.spec}`} className="flex h-[30px] items-center justify-between gap-3 border-b border-line text-[13px] last:border-b-0">
                      <span className="min-w-0 truncate text-fg-2">{r.label}</span>
                      <span className="flex flex-none items-center gap-1" aria-label={r.spoken}>
                        {r.parts.map((p, i) => (
                          <Fragment key={i}>
                            {p.kind === "key" ? (
                              <kbd aria-hidden className="kbd !h-[22px] !min-w-[22px] !px-1.5 !text-[12px]">
                                {p.t}
                              </kbd>
                            ) : p.kind === "then" ? (
                              <ArrowRight size={12} className="text-fg-3" aria-hidden />
                            ) : (
                              <span aria-hidden className="px-px font-mono text-[11px] text-fg-3">
                                /
                              </span>
                            )}
                          </Fragment>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 px-5 pb-12 pt-10 text-fg-2">
            <span className="font-semibold text-fg">No shortcuts match “{q.trim()}”</span>
            <Button
              size="sm"
              variant="ghost"
              className="text-accent-t"
              onClick={() => {
                setQ("");
                input.current?.focus();
              }}
            >
              Clear filter
            </Button>
          </div>
        )}
      </div>
      <div className="flex flex-none items-center gap-3.5 border-t border-line px-5 py-2.5 text-[12px] text-fg-3 max-[760px]:px-4">
        <span className="flex items-center gap-1 max-[420px]:hidden">
          <kbd className="kbd">G</kbd>
          <ArrowRight size={12} aria-hidden />
          <kbd className="kbd">B</kbd> then
        </span>
        <span className="flex items-center gap-1 max-[420px]:hidden">
          <kbd className="kbd">{win ? "Ctrl" : "⌘"}</kbd>
          <kbd className="kbd">K</kbd> together
        </span>
        <span className="flex-1" />
        <Segmented
          label="Key labels"
          value={plat}
          onChange={setPlat}
          options={[
            { value: "mac", label: "Mac" },
            { value: "win", label: "Windows" },
          ]}
        />
      </div>
    </>
  );
}
