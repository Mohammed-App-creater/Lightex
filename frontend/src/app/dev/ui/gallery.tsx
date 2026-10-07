"use client";

import { Calendar, Filter, Flag, MoreHorizontal, Plus, Search, Target, Zap } from "lucide-react";
import { useState, type ReactNode } from "react";
import { AppIcon, LogoMark, Wordmark } from "@/components/brand/logo";
import { BrandGallery } from "./brand-gallery";
import { Avatar, AvatarStack, ProjectBadge, UnassignedAvatar } from "@/components/ui/avatar";
import { CopyKey, EntityChip, LabelChip, PriorityBadge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel, StatTile } from "@/components/ui/card";
import { Checkbox, Radio, Segmented, Switch } from "@/components/ui/choice";
import {
  CommandFooter,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShell,
} from "@/components/ui/command-shell";
import {
  CountUp,
  EmptyState,
  ErrorState,
  ProgressBar,
  ProgressRing,
  Skeleton,
  SkeletonRows,
} from "@/components/ui/feedback";
import { PriorityIcon, StatusGlyph, glyphLabel, type GlyphKind, type PriorityLevel } from "@/components/ui/glyphs";
import { InlineEditText } from "@/components/ui/inline-edit";
import { Field, Input } from "@/components/ui/input";
import { Shortcut } from "@/components/ui/kbd";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { ConfirmDialog } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import { SidePanel } from "@/components/ui/side-panel";
import { FilterPills, TabPanel, Tabs } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";

const GLYPHS: GlyphKind[] = ["backlog", "todo", "progress", "review", "done", "canceled"];
const PRIORITIES: PriorityLevel[] = [4, 3, 2, 1, 0];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-5 rounded-lg border border-line bg-surface p-6">
      <span className="eyebrow">{title}</span>
      {children}
    </section>
  );
}

function Row({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div className="flex flex-col gap-2.5">
      {label && <span className="text-meta font-medium text-fg-2">{label}</span>}
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

/** Every base component, rendered inside one theme scope. */
export function Gallery({ scope }: { scope: string }) {
  const [status, setStatus] = useState<GlyphKind>("progress");
  const [title, setTitle] = useState("Fix flaky board reflow on column resize");
  const [tab, setTab] = useState<"board" | "list">("board");
  const [pill, setPill] = useState<"all" | "mine" | "unassigned">("all");
  const [seg, setSeg] = useState<"sprint" | "epic">("sprint");
  const [done, setDone] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [panel, setPanel] = useState(false);
  const [palette, setPalette] = useState(false);

  return (
    <div className="flex flex-col gap-6">
      <Section title="Brand">
        <Row>
          <Wordmark size={28} />
          <Wordmark size={16} />
          <AppIcon size={32} />
          <AppIcon size={24} />
          <LogoMark className="h-8 w-10" title="Lightex mark" />
        </Row>
      </Section>

      <BrandGallery />

      <Section title="Buttons">
        <Row>
          <Button variant="primary" kbd="C">
            New task
          </Button>
          <Button variant="secondary">Add filter</Button>
          <Button variant="ghost">Cancel</Button>
          <Button variant="danger">Delete sprint</Button>
          <Button variant="danger-ghost">Delete task</Button>
        </Row>
        <Row>
          <Button variant="primary" size="sm">
            Small
          </Button>
          <Button variant="primary">Medium</Button>
          <Button variant="primary" size="lg">
            Large
          </Button>
          <Button icon aria-label="More actions" tooltip="More actions">
            <MoreHorizontal size={16} aria-hidden />
          </Button>
          <Button variant="primary" loading>
            Saving
          </Button>
        </Row>
        <Row label="Permission states">
          <Button disabledReason="Sprint 14 has 4 open tasks">Complete sprint</Button>
          <span className="text-meta text-fg-3">Disabled = visible reason · No permission = not rendered</span>
        </Row>
      </Section>

      <Section title="Inputs">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Project name">
            <Input placeholder="e.g. Platform Rebuild" />
          </Field>
          <Field label="Task key prefix" hint="2–5 letters">
            <Input mono defaultValue="PRJ" className="uppercase" />
          </Field>
          <Field label="Milestone date" error="Enter a valid date (YYYY-MM-DD).">
            <Input defaultValue="2026-13-40" />
          </Field>
          <Field label="Search">
            <Input placeholder="Search or jump…" leading={<Search size={14} aria-hidden />} />
          </Field>
        </div>
        <Row label="Inline edit: click the title, Enter saves, Esc cancels">
          <InlineEditText
            value={title}
            onSave={setTitle}
            label="Task title"
            canEdit
            className="text-[16px] font-semibold leading-6"
          />
        </Row>
        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label="Status"
            value={status}
            onChange={setStatus}
            options={GLYPHS.map((g, i) => ({
              value: g,
              label: glyphLabel[g],
              icon: <StatusGlyph kind={g} />,
              keys: [String(i + 1)],
            }))}
          />
          <Select
            label="Priority"
            value={"3"}
            onChange={() => undefined}
            options={PRIORITIES.map((p) => ({
              value: String(p),
              label: ["No priority", "Low", "Medium", "High", "Urgent"][p]!,
              icon: <PriorityIcon level={p} />,
            }))}
          />
        </div>
      </Section>

      <Section title="Badges and glyphs">
        <Row label="Status">
          {GLYPHS.map((g) => (
            <StatusBadge key={g} kind={g} name={glyphLabel[g]} />
          ))}
        </Row>
        <Row label="Priority">
          {PRIORITIES.slice(0, 4).map((p) => (
            <PriorityBadge key={p} level={p} />
          ))}
        </Row>
        <Row label="Linked entities">
          <EntityChip icon={<Zap size={14} aria-hidden />}>Auth overhaul</EntityChip>
          <EntityChip icon={<Flag size={14} aria-hidden />}>Beta launch</EntityChip>
          <EntityChip icon={<Calendar size={14} aria-hidden />}>Sprint 14</EntityChip>
          <EntityChip icon={<Target size={14} aria-hidden />}>Cut p95 latency</EntityChip>
          <LabelChip name="frontend" color="var(--low)" />
          <LabelChip name="bug" color="var(--danger)" />
        </Row>
        <Row label="Task key: click to copy">
          <CopyKey value="PRJ-42" />
        </Row>
        <Row label="Completion spark (click the ring)">
          <button
            type="button"
            aria-pressed={done}
            aria-label="Mark PRJ-42 done"
            onClick={() => setDone((d) => !d)}
            className="inline-flex size-6 items-center justify-center rounded-sm hover:bg-hover"
          >
            <StatusGlyph kind={done ? "done" : "todo"} spark={done} />
          </button>
          <span className={done ? "text-fg-3 line-through" : ""}>Fix flaky board reflow</span>
        </Row>
      </Section>

      <Section title="Avatars">
        <Row>
          <Avatar name="Alex Kim" hue={285} size={20} />
          <Avatar name="Jordan Lee" hue={200} size={24} />
          <Avatar name="Sam Patel" hue={20} size={32} />
          <Avatar name="Riley Chen" hue={150} size={40} />
          <Avatar name="Riley Chen" hue={150} size={32} presence />
          <UnassignedAvatar size={32} />
          <AvatarStack
            people={[
              { id: "a", name: "Alex Kim", hue: 285 },
              { id: "b", name: "Jordan Lee", hue: 200 },
              { id: "c", name: "Sam Patel", hue: 20 },
              { id: "d", name: "Riley Chen", hue: 150 },
              { id: "e", name: "Morgan Diaz", hue: 60 },
            ]}
          />
          <ProjectBadge code="PR" hue={255} size={22} />
          <ProjectBadge code="MO" hue={175} size={22} />
          <ProjectBadge code="IN" hue={75} size={22} />
        </Row>
      </Section>

      <Section title="Checkbox, switch, radio, segmented">
        <Row>
          <Checkbox label="Include sub-tasks" defaultChecked />
          <Checkbox label="Show completed" />
          <Checkbox label="Mixed" indeterminate readOnly />
          <Switch label="Notify on mention" defaultChecked />
        </Row>
        <Row>
          <div role="radiogroup" aria-label="Group by" className="flex items-center gap-5">
            <Radio name={`grp-${scope}`} label="Sprint" defaultChecked />
            <Radio name={`grp-${scope}`} label="Epic" />
          </div>
          <Segmented
            label="Group by"
            value={seg}
            onChange={setSeg}
            options={[
              { value: "sprint", label: "Sprint" },
              { value: "epic", label: "Epic" },
            ]}
          />
        </Row>
      </Section>

      <Section title="Keys">
        <Row>
          <Shortcut keys={["⌘", "K"]} />
          <Shortcut keys={["G", "B"]} sequence />
          <Shortcut keys={["⇧", "⌘", "P"]} />
          <Shortcut keys={["Esc"]} />
        </Row>
      </Section>

      <Section title="Tabs and pills">
        <Tabs
          label="Project view"
          idBase={`tabs-${scope}`}
          value={tab}
          onChange={setTab}
          items={[
            { value: "board", label: "Board", kbd: "1" },
            { value: "list", label: "List", kbd: "2" },
          ]}
        />
        <TabPanel idBase={`tabs-${scope}`} value={tab} className="flex h-16 gap-2">
          {tab === "board" ? (
            <>
              <span className="h-full flex-1 rounded-sm border border-line bg-raised" />
              <span className="h-[70%] flex-1 rounded-sm border border-line bg-raised" />
              <span className="h-[44%] flex-1 rounded-sm border border-line bg-raised" />
            </>
          ) : (
            <div className="flex w-full flex-col gap-1.5">
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3.5 w-[70%]" />
            </div>
          )}
        </TabPanel>
        <FilterPills
          label="Task filter"
          value={pill}
          onChange={setPill}
          items={[
            { value: "all", label: "All", count: 24 },
            { value: "mine", label: "Mine", count: 6 },
            { value: "unassigned", label: "Unassigned", count: 3 },
          ]}
        />
      </Section>

      <Section title="Tooltips and menus">
        <Row>
          <Tooltip content="New task" keys={["C"]}>
            <Button icon aria-label="New task">
              <Plus size={14} aria-hidden />
            </Button>
          </Tooltip>
          <Tooltip content="Filter" keys={["F"]}>
            <Button icon aria-label="Filter">
              <Filter size={14} aria-hidden />
            </Button>
          </Tooltip>
          <Tooltip content="Search and commands" keys={["⌘", "K"]}>
            <Button icon aria-label="Command palette" onClick={() => setPalette(true)}>
              <Search size={14} aria-hidden />
            </Button>
          </Tooltip>
          <Menu>
            <MenuTrigger asChild>
              <Button>Task actions</Button>
            </MenuTrigger>
            <MenuContent width={240} align="start">
              <MenuLabel>Task</MenuLabel>
              <MenuItem keys={["R"]}>Rename</MenuItem>
              <MenuItem keys={["A"]}>Assign to…</MenuItem>
              <MenuItem keys={["⌘", "L"]}>Copy link</MenuItem>
              <MenuSeparator />
              <MenuItem danger keys={["⌫"]}>
                Delete task
              </MenuItem>
            </MenuContent>
          </Menu>
        </Row>
      </Section>

      <Section title="Overlays and feedback">
        <Row>
          <Button
            onClick={() =>
              toast({
                title: "PRJ-42 moved to Done",
                body: "Saved instantly. Undo within 4s.",
                tone: "spark",
                action: { label: "Undo", key: "Z", onClick: () => toast.info("Undone") },
              })
            }
          >
            Complete a task
          </Button>
          <Button
            onClick={() =>
              toast({
                title: "Couldn’t save PRJ-42",
                body: "Reverted to In progress. Check your connection.",
                tone: "error",
                action: { label: "Retry", key: "R", onClick: () => undefined },
              })
            }
          >
            Simulate failure
          </Button>
          <Button onClick={() => setConfirm(true)}>Confirm dialog</Button>
          <Button onClick={() => setPanel(true)}>Side panel</Button>
          <Button onClick={() => setPalette(true)}>Command palette</Button>
        </Row>
      </Section>

      <Section title="Empty, loading, error, progress">
        <div className="grid gap-6 [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]">
          <EmptyState
            icon={<Plus size={20} aria-hidden />}
            title="No tasks yet"
            body="Create the first task for this project."
            actions={
              <Button variant="primary" kbd="C">
                New task
              </Button>
            }
          />
          <EmptyState
            icon={<Search size={20} aria-hidden />}
            title="No matching tasks"
            body="Nothing matches Status: Done and Assignee: Me."
            actions={<Button kbd="⇧F">Clear filters</Button>}
          />
          <ErrorState title="Couldn’t load tasks" body="The request timed out. Your changes are safe." refId="7f3a91" onRetry={() => undefined} />
        </div>
        <SkeletonRows rows={3} label="Loading tasks" />
        <div className="grid grid-cols-3 gap-3">
          <StatTile label="Open tasks" value={<CountUp value={24} />} />
          <StatTile label="Done this sprint" value={<CountUp value={41} />} />
          <StatTile label="Cycle time (days)" value={<CountUp value={2.4} decimals={1} />} />
        </div>
        <Row>
          <ProgressRing value={68} label="Sprint 14" showValue />
          <ProgressRing value={42} label="Beta launch" color="var(--text-2)" showValue />
          <ProgressRing value={85} label="Latency goal" color="var(--ok)" showValue />
          <ProgressRing value={65} size={30} label="Sprint 14" color="var(--accent-t)" />
        </Row>
        <div className="flex flex-col gap-3">
          <ProgressBar value={72} label="Auth overhaul" />
          <ProgressBar value={35} label="Billing v2" marker={50} color="var(--c1)" />
        </div>
      </Section>

      <Panel title="Panel" actions={<Button size="sm" variant="ghost">View all</Button>}>
        <p className="m-0 text-fg-2">Overview panels use 20px padding and 16px gap.</p>
      </Panel>

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Complete Sprint 14?"
        description="4 tasks are still open. Choose where they go."
        confirmLabel="Complete sprint"
        onConfirm={() => {
          toast.success("Sprint 14 completed");
        }}
      >
        <div role="radiogroup" aria-label="Move open tasks to" className="flex flex-col gap-2.5">
          <Radio name={`mv-${scope}`} label="Sprint 15" defaultChecked />
          <Radio name={`mv-${scope}`} label="Backlog" />
        </div>
      </ConfirmDialog>

      <SidePanel open={panel} onClose={() => setPanel(false)} label="Example panel">
        <div className="flex h-12 items-center border-b border-line px-5 text-meta text-fg-3">
          Platform Rebuild / PRJ-42
          <Button variant="ghost" icon size="sm" className="ml-auto" aria-label="Close" onClick={() => setPanel(false)}>
            ×
          </Button>
        </div>
        <div className="p-5 text-body text-fg-2">Columns jump when the sidebar collapses mid-drag.</div>
      </SidePanel>

      <CommandShell open={palette} onOpenChange={setPalette}>
        <CommandInput placeholder="Search or type > # @" onBack={() => setPalette(false)} />
        <CommandList>
          <CommandGroup heading="Navigate" count={2}>
            <CommandItem onSelect={() => setPalette(false)}>
              → <span className="flex-1">Go to Board</span>
              <Shortcut keys={["G", "B"]} />
            </CommandItem>
            <CommandItem onSelect={() => setPalette(false)}>
              → <span className="flex-1">Go to Sprints</span>
              <Shortcut keys={["G", "S"]} />
            </CommandItem>
          </CommandGroup>
        </CommandList>
        <CommandFooter verb="Run" />
      </CommandShell>
    </div>
  );
}
