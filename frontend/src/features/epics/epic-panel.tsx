"use client";

import { Flag, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Select } from "@/components/ui/select";
import { SidePanel } from "@/components/ui/side-panel";
import { toast } from "@/components/ui/toast";
import { useSession } from "@/features/auth/session";
import { errorMessage, isApiError } from "@/lib/api/errors";
import type { Epic, Milestone, ProjectMember } from "@/lib/api/types";
import { useIsMobile } from "@/lib/hooks/use-media-query";
import { cn } from "@/lib/utils/cn";
import { shortDate } from "@/lib/utils/dates";
import { EPIC_PALETTE, epicSwatch, nearestPaletteHue, validateEpicName } from "./epic-model";
import { useSaveEpic } from "./queries";

/** Create / edit epic side panel (board 27): title, colour, owner, target milestone, description. */
export function EpicPanel({
  epic,
  projectId,
  epics,
  members,
  milestones,
  onClose,
  onSaved,
  onArchive,
}: {
  epic: Epic | null;
  projectId: string;
  epics: Epic[];
  members: ProjectMember[];
  milestones: Milestone[];
  onClose: () => void;
  onSaved: (e: Epic, created: boolean) => void;
  onArchive?: (e: Epic) => void;
}) {
  const isMobile = useIsMobile();
  const label = epic ? "Edit epic" : "New epic";
  return (
    <>
      {!isMobile && <div aria-hidden onClick={onClose} className="fixed inset-0 z-[39] bg-scrim backdrop-blur-[4px] animate-[fade-in_200ms_var(--ease)]" />}
      <SidePanel open onClose={onClose} label={label} width={420} className="max-[1023px]:w-[380px]">
        <PanelForm
          key={epic?.id ?? "new"}
          epic={epic}
          title={label}
          projectId={projectId}
          epics={epics}
          members={members}
          milestones={milestones}
          onClose={onClose}
          onSaved={onSaved}
          onArchive={onArchive}
        />
      </SidePanel>
    </>
  );
}

function PanelForm({
  epic,
  title,
  projectId,
  epics,
  members,
  milestones,
  onClose,
  onSaved,
  onArchive,
}: {
  epic: Epic | null;
  title: string;
  projectId: string;
  epics: Epic[];
  members: ProjectMember[];
  milestones: Milestone[];
  onClose: () => void;
  onSaved: (e: Epic, created: boolean) => void;
  onArchive?: (e: Epic) => void;
}) {
  const { user } = useSession();
  const save = useSaveEpic(projectId);
  const [name, setName] = useState(epic?.name ?? "");
  const [hue, setHue] = useState(epic ? nearestPaletteHue(epic.hue) : 150);
  const defaultOwner = epic ? epic.ownerId : members.some((m) => m.userId === user?.id) ? (user?.id ?? null) : (members[0]?.userId ?? null);
  const [ownerId, setOwner] = useState<string | null>(defaultOwner);
  const [milestoneId, setMilestone] = useState<string | null>(epic?.milestoneId ?? null);
  const [desc, setDesc] = useState(epic?.description ?? "");
  const [shown, setShown] = useState(false);
  const [serverErr, setServerErr] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const colorId = useId();
  const swatchRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const localErr = validateEpicName(name, epics, epic?.id ?? null);
  const err = shown ? (localErr ?? serverErr) : serverErr;
  const owner = members.find((m) => m.userId === ownerId);

  const submit = async () => {
    setShown(true);
    if (localErr) {
      titleRef.current?.focus();
      return;
    }
    try {
      const body = { name: name.trim(), hue, ownerId, milestoneId, description: desc.trim() };
      const saved = await save.mutateAsync({ id: epic?.id, body });
      toast.success(epic ? `Saved ${saved.name}` : `Created ${saved.name}`);
      onSaved(saved, !epic);
    } catch (e) {
      if (isApiError(e) && e.fieldErrors.name) setServerErr(e.fieldErrors.name);
      else toast.error(epic ? "Couldn’t save the epic" : "Couldn’t create the epic", { body: errorMessage(e) });
    }
  };

  const submitRef = useRef(submit);
  useEffect(() => {
    submitRef.current = submit;
  });
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void submitRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    const id = setTimeout(() => titleRef.current?.focus(), 60);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearTimeout(id);
    };
  }, []);

  const onSwatchKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const delta = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const n = (i + delta + EPIC_PALETTE.length) % EPIC_PALETTE.length;
    setHue(EPIC_PALETTE[n]!.hue);
    swatchRefs.current[n]?.focus();
  };

  const msOptions = [
    ...milestones
      .filter((m) => !m.completedAt || m.id === milestoneId)
      .map((m) => ({ value: m.id, label: m.name, meta: shortDate(m.dueDate), icon: <Flag size={13} className="text-fg-3" aria-hidden /> })),
    { value: "none", label: "No milestone" },
  ];

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <header className="flex h-[52px] flex-none items-center gap-2 border-b border-line pl-5 pr-2.5">
        <h2 className="m-0 flex-1 text-[15px] font-semibold">{title}</h2>
        <Kbd className="max-[760px]:hidden">Esc</Kbd>
        <Button variant="ghost" icon size="sm" aria-label="Close" onClick={onClose} className="max-[760px]:size-11">
          <X size={14} aria-hidden />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-[18px]">
        <div aria-hidden className="flex items-center gap-2.5 rounded-[10px] border border-line bg-bg px-3 py-2.5">
          <i className="size-3 flex-none rounded-[4px] transition-colors" style={{ background: epicSwatch(hue) }} />
          <span className={cn("min-w-0 flex-1 truncate text-[13.5px] font-semibold", !name.trim() && "text-fg-3")}>{name.trim() || "Untitled epic"}</span>
          {owner && <Avatar name={owner.user.name} hue={owner.user.hue} size={20} ring={false} decorative />}
        </div>
        <Field
          label={
            <>
              Title <span className="ml-1 font-mono text-[10.5px] text-fg-3">required</span>
            </>
          }
          labelAction={<span className="font-mono text-[11px] text-fg-3">{name.length}/60</span>}
          error={err}
        >
          <Input
            ref={titleRef}
            maxLength={60}
            placeholder="e.g. Search relevance"
            value={name}
            autoComplete="off"
            onChange={(e) => {
              setName(e.target.value);
              setServerErr(null);
            }}
            onBlur={() => setShown(true)}
          />
        </Field>
        <div className="flex flex-col gap-1.5">
          <span id={colorId} className="text-meta font-medium text-fg-2">
            Color
          </span>
          <div role="radiogroup" aria-labelledby={colorId} className="flex flex-wrap gap-2">
            {EPIC_PALETTE.map((p, i) => {
              const on = p.hue === hue;
              return (
                <button
                  key={p.hue}
                  ref={(el) => {
                    swatchRefs.current[i] = el;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={p.name}
                  tabIndex={on ? 0 : -1}
                  onClick={() => setHue(p.hue)}
                  onKeyDown={(e) => onSwatchKey(e, i)}
                  className="inline-flex size-8 items-center justify-center rounded-[9px] border border-line-2 bg-bg transition-[border-color,transform] duration-150 ease-out hover:-translate-y-px hover:border-control max-[760px]:size-11"
                  style={on ? { borderColor: epicSwatch(p.hue), boxShadow: `0 0 0 3px oklch(var(--ep-l) var(--ep-c) ${p.hue} / .25)` } : undefined}
                >
                  <i className={cn("size-4 rounded-[5px] transition-transform duration-150", on && "scale-[1.15]")} style={{ background: epicSwatch(p.hue) }} />
                </button>
              );
            })}
          </div>
        </div>
        <Select
          label="Owner"
          value={ownerId}
          onChange={(v) => setOwner(v)}
          placeholder="No owner"
          width={260}
          options={members.map((m) => ({
            value: m.userId,
            label: m.user.name,
            icon: <Avatar name={m.user.name} hue={m.user.hue} size={18} ring={false} decorative />,
          }))}
        />
        <Select
          label="Target milestone"
          value={milestoneId ?? "none"}
          onChange={(v) => setMilestone(v === "none" ? null : v)}
          width={260}
          options={msOptions}
        />
        <Field label="Description">
          <Textarea placeholder="What does done look like?" maxLength={600} value={desc} onChange={(e) => setDesc(e.target.value)} className="h-[96px] min-h-[96px] resize-none" />
        </Field>
      </div>
      <footer className="flex flex-none items-center gap-2 border-t border-line px-5 py-3">
        {epic && onArchive && (
          <Button variant="danger-ghost" size="sm" onClick={() => onArchive(epic)}>
            Archive
          </Button>
        )}
        <span className="flex-1" />
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="sm" loading={save.isPending} kbd="⌘↵">
          {epic ? "Save" : "Create epic"}
        </Button>
      </footer>
    </form>
  );
}
