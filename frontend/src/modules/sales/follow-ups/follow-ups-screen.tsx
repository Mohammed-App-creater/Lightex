"use client";

import { CalendarCheck, CalendarClock, Check, MoreHorizontal, Plus, Trash2, UserRound, X } from "lucide-react";
import { useState } from "react";
import type { SalesFollowUp } from "@/api/types";
import { useCan } from "@/platform/roles/can";
import { useTeams } from "@/platform/teams/queries";
import { Avatar } from "@/ui/avatar";
import { Button } from "@/ui/button";
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/feedback";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/ui/menu";
import { ConfirmDialog } from "@/ui/modal";
import { Select } from "@/ui/select";
import { Tabs } from "@/ui/tabs";
import { toast } from "@/ui/toast";
import { addDaysISO, shortDate, todayISO } from "@/lib/utils/dates";
import { cn } from "@/lib/utils/cn";
import { useUrlState } from "../activities/url-state";
import { pageItems, useDeleteFollowUp, useFollowUps, useSlug, useUpdateFollowUp } from "../api";
import { EntityLink, kindOfTarget } from "../shared/entity-link";
import { QuickActionsMenu, useQuickActions } from "../shared/quick-actions";
import { SalesGate, SalesPageFrame } from "../shared/sales-page";
import { useSalesScope } from "../shared/scope";
import { UserPicker } from "../shared/user-picker";
import { CompleteFollowUpDialog, ReassignDialog, RescheduleDialog } from "./follow-up-dialogs";

type Bucket = "overdue" | "today" | "upcoming" | "all";
const BUCKETS: Bucket[] = ["overdue", "today", "upcoming", "all"];
const ANY = "__any";

/** Follow-ups workspace (`/[ws]/sales/follow-ups`): Overdue / Today / Upcoming / All, grouped by due date. */
export function FollowUpsScreen() {
  return (
    <SalesGate permission="sales.followup.view" name="Follow-ups">
      <FollowUps />
    </SalesGate>
  );
}

/** "Today", "Tomorrow", "Overdue · Oct 14", "Mon, Oct 20". */
function dayLabel(iso: string) {
  const t = todayISO();
  if (iso === t) return "Today";
  if (iso === addDaysISO(t, 1)) return "Tomorrow";
  if (iso < t) return `Overdue · ${shortDate(iso)}`;
  const wd = new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { weekday: "short" });
  return `${wd}, ${shortDate(iso)}`;
}

type Action = { kind: "complete" | "reschedule" | "reassign" | "cancel" | "delete"; f: SalesFollowUp } | null;

function FollowUps() {
  const slug = useSlug();
  const url = useUrlState();
  const quick = useQuickActions();
  const canCreate = useCan("sales.followup.create");
  const { beyondOwn } = useSalesScope("sales.followup.view");
  const raw = url.get("bucket") as Bucket;
  const bucket: Bucket = BUCKETS.includes(raw) ? raw : "today";
  const owner = url.get("owner");
  const team = url.get("team");
  const teams = useTeams(slug);

  const q = useFollowUps({ bucket, filter: { status: "pending", owner: owner || undefined, team: team || undefined }, limit: 100 });
  const counts = q.data?.pages[0]?.counts;
  const rows = pageItems(q.data);
  const groups = new Map<string, SalesFollowUp[]>();
  for (const f of rows) groups.set(f.dueDate, [...(groups.get(f.dueDate) ?? []), f]);
  const [action, setAction] = useState<Action>(null);
  const close = () => setAction(null);

  return (
    <SalesPageFrame
      title="Follow-ups"
      actions={
        <>
          <QuickActionsMenu className="max-[1023px]:hidden" />
          {canCreate && (
            <Button variant="primary" size="sm" onClick={() => quick.open("add-follow-up")} className="max-[1023px]:hidden">
              <Plus size={14} aria-hidden /> Add follow-up
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="-mx-4 max-w-[100vw] overflow-x-auto px-4 min-[761px]:mx-0 min-[761px]:px-0">
          <Tabs
            label="Follow-up buckets"
            value={bucket}
            onChange={(b) => url.set({ bucket: b === "today" ? null : b })}
            items={[
              { value: "overdue", label: "Overdue", count: counts?.overdue },
              { value: "today", label: "Today", count: counts?.today },
              { value: "upcoming", label: "Upcoming", count: counts?.upcoming },
              { value: "all", label: "All" },
            ]}
          />
        </div>
        {beyondOwn && (
          <div className="ml-auto flex flex-wrap items-center gap-2 max-[760px]:ml-0 max-[760px]:w-full">
            <UserPicker value={owner || null} onChange={(id) => url.set({ owner: id })} label="Owner" noneLabel="Anyone" />
            {(teams.data?.length ?? 0) > 0 && (
              <Select
                label="Team"
                hideLabel
                value={team || ANY}
                onChange={(v) => url.set({ team: v === ANY ? null : v })}
                options={[{ value: ANY, label: "All teams" }, ...(teams.data ?? []).map((t) => ({ value: t.id, label: t.name }))]}
                className="w-[160px]"
              />
            )}
          </div>
        )}
      </div>

      {q.isPending ? (
        <SkeletonRows rows={5} label="Loading follow-ups" />
      ) : q.isError ? (
        <ErrorState title="Couldn’t load follow-ups" onRetry={() => void q.refetch()} retrying={q.isRefetching} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<CalendarCheck size={18} />}
          title={bucket === "overdue" ? "Nothing overdue" : bucket === "today" ? "Nothing due today" : "No follow-ups"}
          body="Plan the next step on a deal, lead or company so nothing slips."
          actions={
            canCreate ? (
              <Button variant="primary" onClick={() => quick.open("add-follow-up")}>
                <Plus size={14} aria-hidden /> Add follow-up
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="flex flex-col gap-5">
          {[...groups].map(([day, list]) => (
            <section key={day} aria-label={dayLabel(day)} className="flex flex-col">
              <h2 className={cn("m-0 mb-1.5 px-1 text-meta font-semibold uppercase tracking-[0.04em]", day < todayISO() ? "text-danger" : "text-fg-3")}>
                {dayLabel(day)} <span className="font-mono font-medium text-fg-3">{list.length}</span>
              </h2>
              <ul className="m-0 flex list-none flex-col overflow-hidden rounded-lg border border-line bg-surface p-0">
                {list.map((f) => (
                  <FollowUpRow key={f.id} f={f} onAction={(kind) => setAction({ kind, f })} />
                ))}
              </ul>
            </section>
          ))}
          {q.hasNextPage && (
            <Button className="self-center" variant="secondary" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
              Load more
            </Button>
          )}
        </div>
      )}

      {action?.kind === "complete" && <CompleteFollowUpDialog followUp={action.f} onClose={close} />}
      {action?.kind === "reschedule" && <RescheduleDialog followUp={action.f} onClose={close} />}
      {action?.kind === "reassign" && <ReassignDialog followUp={action.f} onClose={close} />}
      <CancelOrDelete action={action} onClose={close} />
    </SalesPageFrame>
  );
}

function FollowUpRow({ f, onAction }: { f: SalesFollowUp; onAction: (k: NonNullable<Action>["kind"]) => void }) {
  const kind = kindOfTarget(f.targetType);
  const overdue = f.dueDate < todayISO();
  const pending = f.status === "pending";
  return (
    <li className="flex items-start gap-3 border-b border-line px-3 py-3 last:border-b-0">
      {f.canComplete && pending ? (
        <button
          type="button"
          aria-label={`Complete ${f.title}`}
          onClick={() => onAction("complete")}
          className="mt-0.5 flex size-6 flex-none items-center justify-center rounded-full border-[1.5px] border-line-2 text-transparent hover:border-ok hover:text-ok max-[1023px]:size-8"
        >
          <Check size={14} aria-hidden />
        </button>
      ) : (
        <span aria-hidden className="mt-0.5 size-6 flex-none max-[1023px]:size-8" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cn("text-[14px] font-medium leading-5", !pending && "text-fg-3 line-through")}>{f.title}</span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-meta text-fg-2">
          {kind ? <EntityLink kind={kind} id={f.targetId} name={f.target?.name ?? "Record"} /> : <span>{f.target?.name}</span>}
          {f.company && f.company.id !== f.targetId && (
            <>
              <span className="text-fg-3">·</span>
              <EntityLink kind="company" id={f.company.id} name={f.company.name} className="text-fg-2" />
            </>
          )}
          <span className={cn("text-fg-3", overdue && pending && "text-danger")}>· {shortDate(f.dueDate)}</span>
        </span>
        {f.notes && <span className="line-clamp-2 text-meta text-fg-3">{f.notes}</span>}
      </div>
      {f.owner && <Avatar name={f.owner.name} hue={f.owner.hue} size={24} className="mt-0.5 flex-none" />}
      <RowMenu f={f} onAction={onAction} />
    </li>
  );
}

function RowMenu({ f, onAction }: { f: SalesFollowUp; onAction: (k: NonNullable<Action>["kind"]) => void }) {
  const pending = f.status === "pending";
  const items = [
    pending && f.canComplete && { k: "complete" as const, label: "Complete", icon: Check },
    pending && f.canEdit && { k: "reschedule" as const, label: "Reschedule", icon: CalendarClock },
    pending && f.canReassign && { k: "reassign" as const, label: "Reassign", icon: UserRound },
    pending && f.canEdit && { k: "cancel" as const, label: "Cancel follow-up", icon: X },
    f.canDelete && { k: "delete" as const, label: "Delete", icon: Trash2 },
  ].filter(Boolean) as { k: NonNullable<Action>["kind"]; label: string; icon: typeof Check }[];
  if (!items.length) return null;
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button size="sm" variant="ghost" icon aria-label={`Actions for ${f.title}`} className="max-[1023px]:size-9">
          <MoreHorizontal size={16} aria-hidden />
        </Button>
      </MenuTrigger>
      <MenuContent align="end" width={200}>
        {items.map((it) => (
          <MenuItem key={it.k} icon={<it.icon size={14} />} danger={it.k === "delete"} onSelect={() => onAction(it.k)}>
            {it.label}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

function CancelOrDelete({ action, onClose }: { action: Action; onClose: () => void }) {
  const update = useUpdateFollowUp();
  const del = useDeleteFollowUp();
  const kind = action?.kind === "cancel" || action?.kind === "delete" ? action.kind : null;
  const f = action?.f;
  return (
    <ConfirmDialog
      open={Boolean(kind && f)}
      onOpenChange={(o) => !o && onClose()}
      title={kind === "delete" ? "Delete this follow-up?" : "Cancel this follow-up?"}
      description={f ? `“${f.title}”${kind === "delete" ? " is removed for good." : " stays in the history as cancelled."}` : undefined}
      confirmLabel={kind === "delete" ? "Delete" : "Cancel follow-up"}
      confirmVariant="danger"
      onConfirm={() => {
        if (!f) return;
        const p = kind === "delete" ? del.mutateAsync(f.id) : update.mutateAsync({ id: f.id, body: { status: "cancelled" } });
        return p.then(() => toast.success(kind === "delete" ? "Follow-up deleted" : "Follow-up cancelled")).catch(() => undefined);
      }}
    />
  );
}
