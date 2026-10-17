"use client";

import { ChevronDown } from "lucide-react";
import { useId, useRef, type KeyboardEvent } from "react";
import { ProjectBadge } from "@/components/ui/avatar";
import { Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/tooltip";
import type { ImportSource, Project } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";
import { Section, SourceGlyph } from "./parts";

/* Step 1 · Source (board 40 S1): tiles radiogroup with roving focus, then the "Import into" picker. */

type TileId = "trello" | "jira" | "csv";
const TILES: { id: TileId; name: string; meta: string; disabledReason?: string }[] = [
  { id: "trello", name: "Trello", meta: "Boards · lists · cards", disabledReason: "Trello import is coming soon. Export your board as CSV with a Power-Up and use CSV." },
  { id: "jira", name: "Jira", meta: "Issues · CSV export" },
  { id: "csv", name: "CSV", meta: "Any spreadsheet export" },
];
const ENABLED: ImportSource[] = ["jira", "csv"];

export function StepSource({
  source,
  onSource,
  projects,
  target,
  onTarget,
}: {
  source: ImportSource | null;
  onSource: (s: ImportSource) => void;
  projects: Project[];
  target: Project;
  onTarget: (projectId: string) => void;
}) {
  const refs = useRef(new Map<TileId, HTMLButtonElement>());
  const reasonId = useId();
  const focusable: TileId = source ?? "jira";

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, id: TileId) => {
    const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    // The disabled tile is skipped: arrows move between the enabled ones.
    const from = ENABLED.indexOf(id as ImportSource);
    const next = ENABLED[(Math.max(0, from) + d + ENABLED.length) % ENABLED.length]!;
    onSource(next);
    refs.current.get(next)?.focus();
  };

  return (
    <>
      <Section title="Source">
        <div role="radiogroup" aria-label="Import source" className="grid grid-cols-3 gap-2.5 max-[760px]:grid-cols-1">
          {TILES.map((t) => {
            const on = source === t.id;
            const disabled = Boolean(t.disabledReason);
            const tile = (
              <button
                key={t.id}
                ref={(el) => {
                  if (el) refs.current.set(t.id, el);
                }}
                type="button"
                role="radio"
                aria-checked={on}
                aria-disabled={disabled || undefined}
                aria-describedby={disabled ? reasonId : undefined}
                tabIndex={!disabled && focusable === t.id ? 0 : -1}
                onClick={() => !disabled && onSource(t.id as ImportSource)}
                onKeyDown={(e) => onKey(e, t.id)}
                className={cn(
                  "iw-tile relative flex min-h-[118px] flex-col items-start gap-2 rounded-[10px] border border-line-2 bg-bg p-3.5 text-left text-fg outline-none",
                  "focus-visible:shadow-[0_0_0_1px_var(--accent),0_0_0_4px_var(--ring)]",
                  "max-[760px]:min-h-0 max-[760px]:flex-row max-[760px]:items-center",
                  on && "border-accent bg-accent-s shadow-[0_0_0_3px_var(--accent-s)]",
                  !on && !disabled && "hover:border-control",
                  disabled && "cursor-not-allowed opacity-60",
                )}
              >
                <span
                  className={cn(
                    "inline-flex size-[34px] flex-none items-center justify-center rounded-[9px] border border-line-2 bg-raised text-fg-2",
                    on && "border-transparent bg-surface text-accent-t",
                  )}
                >
                  <SourceGlyph source={t.id} />
                </span>
                <b className="mt-auto text-[14px] font-semibold max-[760px]:mt-0">{t.name}</b>
                <span className="font-mono text-[11px] leading-[1.3] text-fg-3 max-[760px]:hidden">{t.meta}</span>
                {disabled && (
                  <span className="absolute right-3 top-3 inline-flex h-5 items-center rounded-[5px] border border-line bg-raised px-1.5 font-mono text-[10px] font-medium text-fg-2 max-[760px]:static max-[760px]:ml-auto">
                    Coming soon
                  </span>
                )}
                {!disabled && (
                  <span
                    aria-hidden
                    className={cn(
                      "absolute right-3 top-3 size-4 rounded-full border-[1.5px] border-control transition-[border-width,border-color] duration-150 max-[760px]:static max-[760px]:ml-auto",
                      on && "border-[5px] border-accent",
                    )}
                  />
                )}
              </button>
            );
            return disabled ? (
              <Tooltip key={t.id} content={t.disabledReason}>
                {tile}
              </Tooltip>
            ) : (
              tile
            );
          })}
        </div>
        <span id={reasonId} className="sr-only">
          {TILES[0]!.disabledReason}
        </span>
      </Section>

      <Section title="Import into">
        <Menu>
          <MenuTrigger asChild>
            <button
              type="button"
              aria-label={`Import into ${target.name}`}
              className="inline-flex h-[34px] items-center gap-2 self-start rounded-[7px] border border-line-2 bg-raised px-2.5 text-[13px] font-medium text-fg outline-none hover:border-control hover:bg-hover focus-visible:shadow-[0_0_0_1px_var(--accent),0_0_0_4px_var(--ring)] data-[state=open]:border-control data-[state=open]:bg-hover max-[760px]:h-10"
            >
              <ProjectBadge code={target.key} hue={target.hue} />
              <span className="max-w-[260px] truncate">{target.name}</span>
              <ChevronDown size={12} aria-hidden className="text-fg-3" />
            </button>
          </MenuTrigger>
          <MenuContent align="start" width={300} aria-label="Target project">
            <MenuRadioGroup value={target.id} onValueChange={onTarget}>
              {projects.map((p) => (
                <MenuRadioItem key={p.id} value={p.id} icon={<ProjectBadge code={p.key} hue={p.hue} />} meta={`${p.key}-${p.nextTaskNumber}`}>
                  {p.name}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuContent>
        </Menu>
      </Section>
    </>
  );
}
