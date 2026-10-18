"use client";

import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { ArrowDown, ArrowUp, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { SalesListQuery, SalesOpportunity, SalesPipelineColumn } from "@/api/types";
import { cn } from "@/lib/utils/cn";
import { useCan } from "@/platform/roles/can";
import { useTeams } from "@/platform/teams/queries";
import { Avatar } from "@/ui/avatar";
import { Button } from "@/ui/button";
import { Segmented } from "@/ui/choice";
import { EmptyState, ErrorState, Skeleton, SkeletonRows } from "@/ui/feedback";
import { Input } from "@/ui/input";
import { Select } from "@/ui/select";
import { pageItems, useMoveOpportunity, useOpportunities, usePipeline, useProducts, useSlug } from "../api";
import { formatMoney } from "../shared/money";
import { salesRoutes } from "../shared/routes";
import { SalesGate, SalesPageFrame } from "../shared/sales-page";
import { useSalesScope } from "../shared/scope";
import { ProbabilityBadge, StagePill } from "../shared/stage-pill";
import { UserPicker } from "../shared/user-picker";
import { LostDialog, OpportunityFormDialog, WonDialog } from "../opportunities/opp-dialogs";
import { OppCard, OppFlags, type CardAction } from "./opp-card";
import { formatDay, useUrlState } from "./url-state";

/*
 * Pipeline board (docs/sales/api.md §10.6): one column per open stage with count / value / weighted totals, cards
 * dragged between stages through `useMoveOpportunity` (optimistic, 409 handled there), per-column "load more", filters
 * in the URL, Won / Lost from the card menu, and a sortable list view (`?view=list`).
 */

type Filters = NonNullable<SalesListQuery<"sales_pipeline_retrieve">["filter"]>;

function usePipelineFilters() {
  const url = useUrlState();
  const filter: Filters = {};
  const owner = url.get("owner");
  const team = url.get("team");
  const product = url.get("product");
  const from = url.get("from");
  const to = url.get("to");
  if (owner) filter.owner = owner;
  if (team) filter.team = team;
  if (product) filter.product = product;
  if (from) filter.expectedCloseFrom = from;
  if (to) filter.expectedCloseTo = to;
  return { url, filter, owner, team, product, from, to };
}

export function PipelineScreen() {
  return (
    <SalesGate permission="sales.opportunity.view" name="Pipeline">
      <Pipeline />
    </SalesGate>
  );
}

function Pipeline() {
  const router = useRouter();
  const ws = useSlug();
  const f = usePipelineFilters();
  const view = f.url.get("view") === "list" ? "list" : "board";
  const canCreate = useCan("sales.opportunity.create");
  const [creating, setCreating] = useState(false);
  const [action, setAction] = useState<{ kind: CardAction; opp: SalesOpportunity } | null>(null);
  const onAction = (kind: CardAction, opp: SalesOpportunity) => setAction({ kind, opp });
  return (
    <SalesPageFrame
      title="Pipeline"
      actions={
        <>
          <Segmented
            label="View"
            value={view}
            onChange={(v) => f.url.set({ view: v === "list" ? "list" : null })}
            options={[
              { value: "board", label: "Board" },
              { value: "list", label: "List" },
            ]}
          />
          {canCreate && (
            <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
              <Plus size={14} aria-hidden /> New opportunity
            </Button>
          )}
        </>
      }
    >
      <FilterBar f={f} />
      {view === "board" ? <Board filter={f.filter} onAction={onAction} /> : <ListView filter={f.filter} />}
      {creating && <OpportunityFormDialog onClose={() => setCreating(false)} onCreated={(o) => router.push(salesRoutes.opportunity(ws, o.id))} />}
      {action?.kind === "won" && <WonDialog opp={action.opp} onClose={() => setAction(null)} />}
      {action?.kind === "lost" && <LostDialog opp={action.opp} onClose={() => setAction(null)} />}
    </SalesPageFrame>
  );
}

function FilterBar({ f }: { f: ReturnType<typeof usePipelineFilters> }) {
  const ws = useSlug();
  const { beyondOwn } = useSalesScope("sales.opportunity.view");
  const teams = useTeams(ws).data ?? [];
  const products = (useProducts().data ?? []).filter((p) => p.isActive);
  const any = f.owner || f.team || f.product || f.from || f.to;
  return (
    <div className="flex flex-wrap items-end gap-2">
      {beyondOwn && <UserPicker label="Owner" noneLabel="Any owner" value={f.owner || null} onChange={(v) => f.url.set({ owner: v })} className="w-44" />}
      {beyondOwn && teams.length > 0 && (
        <Select
          label="Team"
          hideLabel
          className="w-40"
          value={f.team}
          onChange={(v) => f.url.set({ team: v })}
          options={[{ value: "", label: "Any team" }, ...teams.map((t) => ({ value: t.id, label: t.name }))]}
        />
      )}
      <Select
        label="Product"
        hideLabel
        className="w-40"
        value={f.product}
        onChange={(v) => f.url.set({ product: v })}
        options={[{ value: "", label: "Any product" }, ...products.map((p) => ({ value: p.id, label: p.name }))]}
      />
      <label className="flex items-center gap-1.5 text-[12px] text-fg-2">
        Close from
        <Input type="date" aria-label="Expected close from" value={f.from} onChange={(e) => f.url.set({ from: e.target.value })} className="w-36" />
      </label>
      <label className="flex items-center gap-1.5 text-[12px] text-fg-2">
        to
        <Input type="date" aria-label="Expected close to" value={f.to} onChange={(e) => f.url.set({ to: e.target.value })} className="w-36" />
      </label>
      {any && (
        <Button size="sm" variant="ghost" onClick={() => f.url.set({ owner: null, team: null, product: null, from: null, to: null })}>
          Clear
        </Button>
      )}
    </div>
  );
}

/* ── Board ── */

function Board({ filter, onAction }: { filter: Filters; onAction: (a: CardAction, o: SalesOpportunity) => void }) {
  const q = usePipeline({ filter });
  const move = useMoveOpportunity();
  const canMovePerm = useCan("sales.opportunity.move");
  const [active, setActive] = useState<SalesOpportunity | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor));
  if (q.isPending)
    return (
      <div className="flex gap-3 overflow-hidden" aria-busy="true" aria-label="Loading pipeline">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-72 w-72 flex-none rounded-lg" />
        ))}
      </div>
    );
  if (q.isError) return <ErrorState title="Couldn’t load the pipeline" onRetry={() => q.refetch()} retrying={q.isFetching} />;
  const board = q.data;
  if (board.stages.length === 0) return <EmptyState illustration="tasks" title="No open stages" body="Add pipeline stages in sales settings." />;
  const onStart = (e: DragStartEvent) => setActive((e.active.data.current as { opp: SalesOpportunity }).opp);
  const onEnd = (e: DragEndEvent) => {
    setActive(null);
    const opp = (e.active.data.current as { opp: SalesOpportunity } | undefined)?.opp;
    const to = e.over?.id;
    if (opp && typeof to === "string" && to !== opp.stageId) move.mutate({ opp, stageId: to });
  };
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 text-[13px] text-fg-2">
        <span className="font-medium text-fg">{board.count}</span> open deals · {formatMoney(board.value)} · weighted{" "}
        <span className="font-medium text-fg">{formatMoney(board.weightedValue)}</span>
        {board.leadCount != null && <> · {board.leadCount} open leads</>}
      </p>
      <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragStart={onStart} onDragEnd={onEnd} onDragCancel={() => setActive(null)}>
        <div className="-mx-6 flex snap-x gap-3 overflow-x-auto px-6 pb-3 max-[760px]:-mx-4 max-[760px]:px-4" role="list" aria-label="Pipeline stages">
          {board.stages.map((col) => (
            <Column key={col.stage.id} col={col} filter={filter} canMove={canMovePerm} activeId={active?.id ?? null} onAction={onAction} />
          ))}
        </div>
        <DragOverlay>{active && <OppCard opp={active} overlay />}</DragOverlay>
      </DndContext>
    </div>
  );
}

function Column({
  col,
  filter,
  canMove,
  activeId,
  onAction,
}: {
  col: SalesPipelineColumn;
  filter: Filters;
  canMove: boolean;
  activeId: string | null;
  onAction: (a: CardAction, o: SalesOpportunity) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: col.stage.id, disabled: !canMove });
  // "Load more": the list endpoint continues the column (same filters, newest first); its first page covers the
  // board's cards and the next ones, so the column switches to it once asked.
  const [more, setMore] = useState(false);
  const extra = useOpportunities({ filter: { ...filter, stage: col.stage.id, status: "open" }, sort: "-updatedAt", limit: 100 }, more);
  const cards = more && extra.data ? pageItems(extra.data) : col.opportunities;
  const hasMore = more && extra.data ? extra.hasNextPage : col.nextCursor != null;
  return (
    <section
      ref={setNodeRef}
      role="listitem"
      aria-label={col.stage.name}
      className={cn(
        "flex max-h-[calc(100dvh-220px)] w-72 flex-none snap-start flex-col gap-2 rounded-lg border border-line bg-bg p-2 transition-colors max-[760px]:w-[82vw]",
        isOver && "border-accent bg-accent-s",
      )}
    >
      <header className="flex flex-col gap-0.5 px-1 pt-1">
        <div className="flex items-center gap-2">
          <h2 className="m-0 truncate text-[13px] font-semibold">{col.stage.name}</h2>
          <span className="font-mono text-[11px] text-fg-3">{col.count}</span>
          <span className="ml-auto font-mono text-[11px] text-fg-3">{col.stage.defaultProbability}%</span>
        </div>
        <p className="m-0 text-[12px] text-fg-2">
          {formatMoney(col.value, { compact: true })} · <span title="Weighted value">w {formatMoney(col.weightedValue, { compact: true })}</span>
        </p>
      </header>
      <ul className="m-0 flex min-h-16 list-none flex-col gap-2 overflow-y-auto p-0">
        {cards.map((o) => (
          <li key={o.id}>
            <DraggableCard opp={o} canMove={canMove && o.canMove} hidden={o.id === activeId} onAction={onAction} />
          </li>
        ))}
        {cards.length === 0 && <li className="px-1 py-3 text-center text-[12px] text-fg-3">No deals</li>}
      </ul>
      {hasMore && (
        <Button size="sm" variant="ghost" loading={extra.isFetching} onClick={() => (more ? extra.fetchNextPage() : setMore(true))}>
          Load more
        </Button>
      )}
    </section>
  );
}

function DraggableCard({ opp, canMove, hidden, onAction }: { opp: SalesOpportunity; canMove: boolean; hidden: boolean; onAction: (a: CardAction, o: SalesOpportunity) => void }) {
  const { setNodeRef, attributes, listeners, transform } = useDraggable({ id: opp.id, data: { opp }, disabled: !canMove });
  return (
    <div
      ref={setNodeRef}
      {...(canMove ? { ...attributes, ...listeners } : {})}
      aria-roledescription={canMove ? "Draggable deal" : undefined}
      style={{ transform: CSS.Translate.toString(transform) }}
      className={cn(canMove && "cursor-grab touch-manipulation active:cursor-grabbing")}
    >
      <OppCard opp={opp} dragging={hidden} onAction={onAction} />
    </div>
  );
}

/* ── List view ── */

type SortKey = "title" | "expectedValue" | "expectedCloseDate" | "updatedAt";
const COLS: { key: SortKey | null; label: string; className?: string }[] = [
  { key: "title", label: "Deal" },
  { key: null, label: "Stage" },
  { key: "expectedValue", label: "Value", className: "text-right" },
  { key: null, label: "Prob." },
  { key: "expectedCloseDate", label: "Close" },
  { key: null, label: "Owner" },
  { key: "updatedAt", label: "Updated" },
];

function ListView({ filter }: { filter: Filters }) {
  const url = useUrlState();
  const ws = useSlug();
  const sort = url.get("sort") || "-updatedAt";
  const q = useOpportunities({ filter: { ...filter, status: "open" }, sort: sort as never, limit: 50 });
  const items = pageItems(q.data);
  // Same column flips the direction; a new column starts A→Z for titles, largest / latest first otherwise.
  const toggle = (k: SortKey) => url.set({ sort: sort === k ? `-${k}` : sort === `-${k}` ? k : k === "title" ? k : `-${k}` });
  if (q.isPending) return <SkeletonRows rows={6} label="Loading deals" />;
  if (q.isError) return <ErrorState title="Couldn’t load deals" onRetry={() => q.refetch()} retrying={q.isFetching} />;
  if (items.length === 0) return <EmptyState illustration="results" title="No open deals" body="Try other filters, or create an opportunity." />;
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto rounded-lg border border-line max-[760px]:hidden">
        <table className="w-full min-w-[760px] border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-line bg-raised text-left text-[12px] text-fg-2">
              {COLS.map((c) => {
                const dir = c.key && (sort === c.key ? "asc" : sort === `-${c.key}` ? "desc" : null);
                return (
                  <th key={c.label} className={cn("px-3 py-2 font-medium", c.className)} aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : undefined}>
                    {c.key ? (
                      <button type="button" onClick={() => toggle(c.key!)} className="inline-flex items-center gap-1 hover:text-fg">
                        {c.label}
                        {dir === "asc" && <ArrowUp size={12} aria-hidden />}
                        {dir === "desc" && <ArrowDown size={12} aria-hidden />}
                      </button>
                    ) : (
                      c.label
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {items.map((o) => (
              <tr key={o.id} className="border-b border-line last:border-0 hover:bg-hover">
                <td className="max-w-[280px] px-3 py-2">
                  <Link href={salesRoutes.opportunity(ws, o.id)} className="block truncate font-medium text-fg hover:underline">
                    {o.title}
                  </Link>
                  <span className="block truncate text-[12px] text-fg-3">{o.company.name}</span>
                  <OppFlags opp={o} className="mt-1" />
                </td>
                <td className="px-3 py-2">
                  <StagePill stage={o.stage as { name: string; category: "open" }} />
                </td>
                <td className="tabular px-3 py-2 text-right font-mono">{formatMoney(o.expectedValue)}</td>
                <td className="px-3 py-2">
                  <ProbabilityBadge value={o.probability} overridden={o.probabilityOverride != null} />
                </td>
                <td className={cn("px-3 py-2", o.flags?.overdueClose && "text-danger")}>{formatDay(o.expectedCloseDate)}</td>
                <td className="px-3 py-2">{o.owner && <span className="inline-flex items-center gap-1.5"><Avatar name={o.owner.name} hue={o.owner.hue} size={20} decorative />{o.owner.name}</span>}</td>
                <td className="px-3 py-2 text-fg-2">{formatDay(o.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="m-0 hidden list-none flex-col gap-2 p-0 max-[760px]:flex">
        {items.map((o) => (
          <li key={o.id}>
            <OppCard opp={o} />
          </li>
        ))}
      </ul>
      {q.hasNextPage && (
        <Button variant="ghost" className="self-center" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
          Load more
        </Button>
      )}
    </div>
  );
}
