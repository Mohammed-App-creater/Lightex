"use client";

import { Check, ChevronRight, Copy } from "lucide-react";
import { useState } from "react";
import { Avatar, hueFrom } from "@/components/ui/avatar";
import { PriorityIcon, StatusGlyph, glyphLabel, priorityMeta, type GlyphKind, type PriorityLevel } from "@/components/ui/glyphs";
import { toast } from "@/components/ui/toast";
import type { AuditChange, AuditEntry, User } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";
import { ACTION_META, AUDIT_ICON, ENTITY_META, auditTime, describe, isWordDiff, wordDiff } from "./lib";

/* Shared rendering pieces for the audit table (desktop) and cards (mobile), board 31. */

export type PeopleIndex = Map<string, Pick<User, "id" | "name" | "hue">>;

export function Path16({ d, size = 13, color, className, label }: { d: string; size?: number; color?: string; className?: string; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke={color ?? "currentColor"}
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("flex-none", className)}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <path d={d} />
    </svg>
  );
}

export function actorLabel(e: AuditEntry, people: PeopleIndex) {
  return people.get(e.actorId)?.name ?? e.actorName ?? "Unknown";
}

/** Member avatar, or a square mono tile for integrations (ci-bot, Automation). */
export function ActorAvatar({ name, hue, integration, size = 20 }: { name: string; hue?: number; integration?: boolean; size?: 20 | 24 | 26 }) {
  if (!integration) return <Avatar name={name} hue={hue} size={size === 26 ? 24 : size} decorative ring={false} />;
  return (
    <span
      aria-hidden
      className="inline-flex flex-none items-center justify-center rounded-[5px] font-mono text-[8.5px] font-semibold text-fg"
      style={{ width: size, height: size, background: `oklch(var(--av-l) var(--av-c) ${hue ?? hueFrom(name)})` }}
    >
      {name.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase()}
    </span>
  );
}

export function EntityCell({ e }: { e: AuditEntry }) {
  const { entity } = describe(e);
  const meta = ENTITY_META[entity];
  return (
    <>
      <Path16 d={meta.icon} color="var(--text-3)" label={meta.label} />
      {e.entityKey && <span className="flex-none font-mono text-[12px] font-medium text-fg">{e.entityKey}</span>}
      <span className="min-w-0 truncate text-fg-2">{e.target}</span>
    </>
  );
}

export function ActionLabel({ e }: { e: AuditEntry }) {
  const meta = ACTION_META[describe(e).kind];
  return (
    <span className="inline-flex min-w-0 items-center gap-[7px] font-medium">
      <Path16 d={meta.icon} color={meta.color} />
      <span className="truncate">{meta.label}</span>
    </span>
  );
}

/* ───────── values + diff ───────── */

function valueText(c: AuditChange, v: AuditChange["before"], people: PeopleIndex) {
  if (v === null || v === "") return "—";
  if (c.kind === "status") return glyphLabel[v as GlyphKind] ?? String(v);
  if (c.kind === "priority") return priorityMeta[Number(v) as PriorityLevel]?.label ?? String(v);
  if (c.kind === "person") return people.get(String(v))?.name ?? String(v);
  return String(v);
}

function Value({ c, side, people, compact }: { c: AuditChange; side: "before" | "after"; people: PeopleIndex; compact?: boolean }) {
  const v = c[side];
  const none = v === null || v === "";
  const text = valueText(c, v, people);
  return (
    <div
      aria-label={`${side === "before" ? "Before" : "After"}: ${text}`}
      className={cn(
        "flex min-w-0 items-start gap-[7px] px-2.5 py-2 leading-5",
        !compact && "border-l border-line",
        compact && "rounded-[6px] px-2 py-1.5",
        none ? "text-fg-3" : side === "before" ? "bg-danger-s text-fg-2" : "bg-ok-s",
      )}
    >
      {!none && c.kind === "status" && <StatusGlyph kind={v as GlyphKind} className="mt-[3px]" />}
      {!none && c.kind === "priority" && <PriorityIcon level={Number(v) as PriorityLevel} bars className="mt-[4px]" />}
      {!none && c.kind === "person" && (
        <Avatar name={text} hue={people.get(String(v))?.hue} size={20} decorative ring={false} className="-my-px" />
      )}
      <span aria-hidden className={cn("min-w-0 [overflow-wrap:anywhere]", !none && side === "before" && "line-through decoration-danger")}>
        {text}
      </span>
    </div>
  );
}

function WordDiff({ c, compact }: { c: AuditChange; compact?: boolean }) {
  const segs = wordDiff(String(c.before), String(c.after));
  return (
    <div
      aria-label={`Changed from: ${c.before} to: ${c.after}`}
      className={cn(
        "whitespace-pre-wrap px-2.5 py-2 leading-[21px] [overflow-wrap:anywhere]",
        compact ? "rounded-[6px] bg-bg px-2 py-1.5" : "col-span-2 border-l border-line",
      )}
    >
      {segs.map((s, i) => (
        <span
          key={i}
          aria-hidden
          className={cn(
            s.op === "del" && "rounded-[3px] bg-danger-s py-px text-danger line-through",
            s.op === "ins" && "rounded-[3px] bg-ok-s py-px text-ok",
          )}
        >
          {s.text}
        </span>
      ))}
    </div>
  );
}

function CopyRequestId({ id }: { id: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={`Copy request id ${id}`}
      title="Copy"
      onClick={(ev) => {
        ev.stopPropagation();
        void navigator.clipboard?.writeText(id).catch(() => undefined);
        setDone(true);
        toast.success(`Copied ${id}`, { id: "audit-copy" });
        setTimeout(() => setDone(false), 1400);
      }}
      className="inline-flex size-[22px] items-center justify-center rounded-[6px] text-fg-3 hover:bg-hover hover:text-fg max-[760px]:size-9"
    >
      {done ? <Check size={12} className="text-ok" aria-hidden /> : <Copy size={12} aria-hidden />}
    </button>
  );
}

/** Expanded row (desktop): Field · Before · After grid plus source / request id / timestamp meta. */
export function DiffPanel({ e, people, id }: { e: AuditEntry; people: PeopleIndex; id: string }) {
  const changes = e.changes ?? [];
  const api = e.source === "api";
  return (
    <div id={id} className="mb-3 ml-9 mr-3 mt-0.5 overflow-hidden rounded-[10px] border border-line bg-bg animate-[fade-in_180ms_var(--ease)] max-[760px]:ml-3">
      {changes.length > 0 ? (
        <div role="table" aria-label="Changes">
          <div role="row" className="grid h-7 grid-cols-[128px_minmax(0,1fr)_minmax(0,1fr)] items-center border-b border-line font-mono text-[10.5px] font-medium uppercase tracking-[0.07em] text-fg-3 max-[760px]:grid-cols-[92px_minmax(0,1fr)_minmax(0,1fr)]">
            <span role="columnheader" className="px-2.5">Field</span>
            <span role="columnheader" className="px-2.5">Before</span>
            <span role="columnheader" className="px-2.5">After</span>
          </div>
          <div role="rowgroup" className="divide-y divide-line">
          {changes.map((c, i) => (
            <div key={i} role="row" className="grid grid-cols-[128px_minmax(0,1fr)_minmax(0,1fr)] text-[13px] max-[760px]:grid-cols-[92px_minmax(0,1fr)_minmax(0,1fr)]">
              <span role="rowheader" className="px-2.5 py-2 text-[12.5px] font-medium leading-5 text-fg-3">{c.field}</span>
              {isWordDiff(c) ? (
                <div role="cell" className="contents">
                  <WordDiff c={c} />
                </div>
              ) : (
                <>
                  <div role="cell" className="contents">
                    <Value c={c} side="before" people={people} />
                  </div>
                  <div role="cell" className="contents">
                    <Value c={c} side="after" people={people} />
                  </div>
                </>
              )}
            </div>
          ))}
          </div>
        </div>
      ) : (
        <p className="m-0 px-2.5 py-2.5 text-[12.5px] text-fg-3">No field-level changes were recorded for this event.</p>
      )}
      <div className="flex flex-wrap items-center gap-2 border-t border-line bg-surface px-2.5 py-[7px] text-[12px] text-fg-3">
        <Path16 d={api ? AUDIT_ICON.code : AUDIT_ICON.globe} />
        <span>via {api ? "API" : "web"}</span>
        {e.requestId && (
          <>
            <span aria-hidden className="size-[3px] rounded-full bg-line-2" />
            <code className="font-mono text-[11.5px] text-fg-2">{e.requestId}</code>
            <CopyRequestId id={e.requestId} />
          </>
        )}
        <span aria-hidden className="size-[3px] rounded-full bg-line-2" />
        <code className="font-mono text-[11.5px] text-fg-2">{auditTime(e.createdAt).full}</code>
      </div>
    </div>
  );
}

/** Mobile card (390): actor + time, action + entity; tap to expand stacked before/after. */
export function EventCard({ e, people, open, onToggle }: { e: AuditEntry; people: PeopleIndex; open: boolean; onToggle: () => void }) {
  const name = actorLabel(e, people);
  const xid = `audit-m-${e.id}`;
  return (
    <div className="flex-none overflow-hidden rounded-[10px] border border-line bg-surface">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={xid}
        onClick={onToggle}
        className="flex w-full flex-col gap-[7px] px-3 py-[11px] text-left"
      >
        <span className="flex min-w-0 items-center gap-2">
          <ActorAvatar name={name} hue={people.get(e.actorId)?.hue} integration={e.actorKind === "integration"} />
          <span className="min-w-0 flex-1 truncate font-semibold">{name}</span>
          <span className="font-mono text-[11.5px] text-fg-3">{auditTime(e.createdAt).cell}</span>
        </span>
        <span className="flex min-w-0 items-center gap-2 text-[13px]">
          <span className="flex flex-none">
            <ActionLabel e={e} />
          </span>
          {e.entityKey && <span className="flex-none font-mono text-[12px] font-medium">{e.entityKey}</span>}
          <span className="min-w-0 truncate text-fg-2">{e.target}</span>
        </span>
      </button>
      {open && (
        <div id={xid} className="flex flex-col gap-1.5 px-3 pb-3 animate-[fade-in_180ms_var(--ease)]">
          {(e.changes ?? []).map((c, i) => (
            <div key={i} className="flex flex-col gap-1.5">
              <span className="mt-1 font-mono text-[10.5px] font-medium uppercase tracking-[0.06em] text-fg-3">{c.field}</span>
              {isWordDiff(c) ? (
                <WordDiff c={c} compact />
              ) : (
                <>
                  <Value c={c} side="before" people={people} compact />
                  <Value c={c} side="after" people={people} compact />
                </>
              )}
            </div>
          ))}
          <span className="mt-1 flex items-center gap-1 font-mono text-[11.5px] text-fg-3">
            via {e.source === "api" ? "API" : e.source === "import" ? "import" : "web"}
            {e.requestId ? ` · ${e.requestId}` : ""}
            {e.requestId && <CopyRequestId id={e.requestId} />}
          </span>
        </div>
      )}
    </div>
  );
}

export function RowChevron({ open, controls, label, onClick }: { open: boolean; controls: string; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      aria-label={`Show changes for ${label}`}
      onClick={(ev) => {
        ev.stopPropagation();
        onClick();
      }}
      className="ml-0.5 inline-flex size-6 items-center justify-center rounded-[5px] text-fg-3 transition-colors duration-[var(--dur-fast)] hover:bg-hover hover:text-fg"
    >
      <ChevronRight
        size={12}
        strokeWidth={1.8}
        aria-hidden
        className={cn("transition-transform duration-[220ms] ease-out", open && "rotate-90 text-accent-t")}
      />
    </button>
  );
}
