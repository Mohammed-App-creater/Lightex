"use client";

import { ChevronDown, ChevronLeft, ChevronRight, Download, ShieldCheck } from "lucide-react";
import { forwardRef, useMemo, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { Illustration } from "@/components/brand/illustrations";
import { AvatarStack } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { EmptyState, Skeleton } from "@/components/ui/feedback";
import {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import { useRoles, useWsMembers } from "@/features/workspace/queries";
import { isApiError, isForbidden } from "@/lib/api/errors";
import type { AuditEntry } from "@/lib/api/types";
import { AUDIT_ACTION_KINDS, AUDIT_ENTITY_TYPES, AUDIT_RANGES, type AuditActionKind, type AuditEntityType } from "@/lib/audit";
import { useIsMobile } from "@/lib/hooks/use-media-query";
import { useCan, useCurrentWorkspace } from "@/lib/permissions/can";
import { cn } from "@/lib/utils/cn";
import { ActionLabel, ActorAvatar, DiffPanel, EntityCell, EventCard, Path16, RowChevron, actorLabel, type PeopleIndex } from "./audit-parts";
import { ACTION_META, AUDIT_ICON, ENTITY_META, auditTime, describe, exportFileName, toCsv, toJson, type ExportFormat } from "./lib";
import { fetchAllAudit, isDefaultFilters, useAuditLog } from "./use-audit";

/*
 * Audit log (board 31): admins only (`audit.view`). Actor / action / entity / date filters, rows
 * that expand into a field-level before → after diff (word diff for text), cursor paging, and a
 * client-side CSV · JSON export of every row matching the filters. Mobile (≤760): cards + Load more.
 */

const COLS = "grid-cols-[28px_118px_170px_160px_minmax(0,1fr)_72px] max-[1023px]:grid-cols-[28px_104px_144px_140px_minmax(0,1fr)_56px]";

export function AuditScreen() {
  const ws = useCurrentWorkspace()!;
  const allowed = useCan("audit.view");
  const log = useAuditLog(ws.slug, allowed);
  const mobile = useIsMobile();
  const members = useWsMembers(ws.slug);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [exporting, setExporting] = useState(false);

  const people: PeopleIndex = useMemo(() => {
    const m: PeopleIndex = new Map();
    for (const x of members.data ?? []) m.set(x.userId, x.user);
    return m;
  }, [members.data]);

  // Actor filter options: workspace members plus integrations seen in the log.
  const actorOptions = useMemo(() => {
    const opts: { id: string; name: string; hue?: number; integration: boolean }[] = (members.data ?? [])
      .filter((m) => m.status === "active")
      .map((m) => ({ id: m.userId, name: m.user.name, hue: m.user.hue, integration: false }));
    const seen = new Set(opts.map((o) => o.id));
    for (const e of log.all) {
      if (!seen.has(e.actorId) && e.actorKind === "integration") {
        seen.add(e.actorId);
        opts.push({ id: e.actorId, name: e.actorName ?? e.actorId, integration: true });
      }
    }
    return opts;
  }, [members.data, log.all]);

  const forbidden = !allowed || (log.query.isError && isForbidden(log.query.error));
  if (forbidden) return <AdminsOnly />;

  const { query, filters, update } = log;
  const loading = query.isPending;
  const failed = query.isError && !query.data;
  const total = log.total;
  const rows = mobile ? log.all : log.current;
  const toggle = (id: string) => setOpen((o) => ({ ...o, [id]: !o[id] }));
  const nameOf = (e: AuditEntry) => actorLabel(e, people);

  const doExport = async (fmt: ExportFormat) => {
    setExporting(true);
    const id = toast.info(`Preparing ${total ?? ""} events`.replace("  ", " "), { duration: 60_000 });
    try {
      const data = await fetchAllAudit(ws.slug, filters);
      const body = fmt === "csv" ? toCsv(data, nameOf) : toJson(data, nameOf);
      const url = URL.createObjectURL(new Blob([body], { type: fmt === "csv" ? "text/csv;charset=utf-8" : "application/json" }));
      const name = exportFileName(fmt);
      const download = () => {
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        a.click();
      };
      download();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      toast.dismiss(id);
      toast.success(`${data.length} events · ${fmt.toUpperCase()}`, {
        body: name,
        action: { label: "Download again", onClick: download },
        duration: 8000,
      });
    } catch {
      toast.dismiss(id);
      toast.error("Export failed", { body: "Your filters are unchanged. Try again." });
    } finally {
      setExporting(false);
    }
  };

  const start = log.page * log.size;
  const pageTxt = loading
    ? "—"
    : total === 0 || rows.length === 0
      ? "0 of 0"
      : `${start + 1}–${start + log.current.length}${total !== undefined ? ` of ${total}` : ""}`;
  const totalTxt = loading ? "—" : total === undefined ? `${log.all.length}+ events` : `${total} ${total === 1 ? "event" : "events"}`;
  const rangeLabel = AUDIT_RANGES.find((r) => r.id === filters.range)!.label;
  const selectedActors = actorOptions.filter((a) => filters.actors.includes(a.id));
  const emptyMeta = [
    rangeLabel,
    selectedActors.length ? selectedActors.map((a) => a.name.split(" ")[0]).join(", ") : null,
    filters.action !== "any" ? ACTION_META[filters.action].label : null,
    filters.entity !== "any" ? ENTITY_META[filters.entity].label : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <section aria-label="Audit log" className="flex h-full min-h-0 flex-col bg-bg">
      {/* Top bar */}
      <div className="flex h-[52px] flex-none items-center gap-2.5 border-b border-line pl-[18px] pr-3 max-[760px]:pl-4">
        <h1 className="m-0 flex items-center gap-[9px] whitespace-nowrap text-[14px] font-semibold">
          <ShieldCheck size={16} strokeWidth={1.4} className="text-fg-3" aria-hidden />
          Audit log
        </h1>
        <span className="truncate font-mono text-[11.5px] text-fg-3 max-[760px]:hidden">{ws.name}</span>
        <span className="flex-1" />
        {!failed && (
          <Menu>
            <MenuTrigger asChild>
              <Button size="sm" loading={exporting} aria-label={mobile ? "Export" : undefined} disabledReason={loading ? "Loading events…" : undefined}>
                <Download size={14} strokeWidth={1.5} aria-hidden />
                <span className="max-[760px]:hidden">Export</span>
                <ChevronDown size={10} strokeWidth={1.8} aria-hidden />
              </Button>
            </MenuTrigger>
            <MenuContent align="end" width={170}>
              <MenuItem icon={<Path16 d={AUDIT_ICON.file} size={14} />} meta=".csv" onSelect={() => void doExport("csv")}>
                CSV
              </MenuItem>
              <MenuItem icon={<Path16 d={AUDIT_ICON.code} size={14} />} meta=".json" onSelect={() => void doExport("json")}>
                JSON
              </MenuItem>
            </MenuContent>
          </Menu>
        )}
      </div>

      {/* Filter bar */}
      {!failed && (
        <div
          role="group"
          aria-label="Filters"
          className="flex min-h-[46px] flex-none items-center gap-1.5 overflow-x-auto border-b border-line px-3 [scrollbar-width:none] max-[760px]:py-2.5"
        >
          <Menu>
            <MenuTrigger asChild>
              <FilterButton on={selectedActors.length > 0}>
                {selectedActors.length ? (
                  <span className="flex">
                    {selectedActors.slice(0, 3).map((a, i) => (
                      <span key={a.id} className={cn("rounded-full shadow-[0_0_0_2px_var(--surface)]", i > 0 && "-ml-[5px]")}>
                        <ActorAvatar name={a.name} hue={a.hue} integration={a.integration} />
                      </span>
                    ))}
                  </span>
                ) : (
                  <Path16 d={AUDIT_ICON.user} className="text-fg-3" />
                )}
                {selectedActors.length === 0 ? "Actor" : selectedActors.length === 1 ? selectedActors[0]!.name : `${selectedActors.length} actors`}
              </FilterButton>
            </MenuTrigger>
            <MenuContent width={230} className="max-h-[340px] overflow-y-auto">
              {actorOptions.map((a) => (
                <MenuCheckboxItem
                  key={a.id}
                  checked={filters.actors.includes(a.id)}
                  onSelect={(ev) => ev.preventDefault()}
                  onCheckedChange={(on) =>
                    update({ actors: on ? [...filters.actors, a.id] : filters.actors.filter((x) => x !== a.id) })
                  }
                  icon={<ActorAvatar name={a.name} hue={a.hue} integration={a.integration} />}
                >
                  {a.name}
                  {a.integration && <span className="ml-2 font-mono text-[11px] text-fg-3">API</span>}
                </MenuCheckboxItem>
              ))}
              {filters.actors.length > 0 && (
                <>
                  <MenuSeparator />
                  <MenuItem onSelect={() => update({ actors: [] })}>Clear</MenuItem>
                </>
              )}
            </MenuContent>
          </Menu>

          <Menu>
            <MenuTrigger asChild>
              <FilterButton on={filters.action !== "any"}>
                <Path16 d={filters.action === "any" ? AUDIT_ICON.bolt : ACTION_META[filters.action].icon} className="text-fg-3" />
                {filters.action === "any" ? "Action" : ACTION_META[filters.action].label}
              </FilterButton>
            </MenuTrigger>
            <MenuContent width={210}>
              <MenuRadioGroup value={filters.action} onValueChange={(v) => update({ action: v as AuditActionKind | "any" })}>
                <MenuRadioItem value="any" icon={<Path16 d={AUDIT_ICON.any} size={14} className="text-fg-3" />}>
                  Any action
                </MenuRadioItem>
                {AUDIT_ACTION_KINDS.map((k) => (
                  <MenuRadioItem key={k} value={k} icon={<Path16 d={ACTION_META[k].icon} size={14} color={ACTION_META[k].color} />}>
                    {ACTION_META[k].label}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuContent>
          </Menu>

          <Menu>
            <MenuTrigger asChild>
              <FilterButton on={filters.entity !== "any"}>
                <Path16 d={filters.entity === "any" ? AUDIT_ICON.project : ENTITY_META[filters.entity].icon} className="text-fg-3" />
                {filters.entity === "any" ? "Entity" : ENTITY_META[filters.entity].label}
              </FilterButton>
            </MenuTrigger>
            <MenuContent width={190}>
              <MenuRadioGroup value={filters.entity} onValueChange={(v) => update({ entity: v as AuditEntityType | "any" })}>
                <MenuRadioItem value="any" icon={<Path16 d={AUDIT_ICON.any} size={14} className="text-fg-3" />}>
                  Any entity
                </MenuRadioItem>
                {AUDIT_ENTITY_TYPES.map((k) => (
                  <MenuRadioItem key={k} value={k} icon={<Path16 d={ENTITY_META[k].icon} size={14} className="text-fg-3" />}>
                    {ENTITY_META[k].label}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuContent>
          </Menu>

          <Menu>
            <MenuTrigger asChild>
              <FilterButton on={filters.range !== "30d"}>
                <Path16 d="M3 4.5h10v8.5H3zM3 7h10M5.5 3v3M10.5 3v3" className="text-fg-3" />
                {rangeLabel}
              </FilterButton>
            </MenuTrigger>
            <MenuContent width={180}>
              <MenuRadioGroup value={filters.range} onValueChange={(v) => update({ range: v as typeof filters.range })}>
                {AUDIT_RANGES.map((r) => (
                  <MenuRadioItem key={r.id} value={r.id}>
                    {r.label}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuContent>
          </Menu>

          {!isDefaultFilters(filters) && (
            <button
              type="button"
              onClick={log.reset}
              className="h-6 flex-none rounded-[5px] px-1.5 text-[12.5px] font-medium text-accent-t hover:bg-accent-s"
            >
              Reset
            </button>
          )}
          <span className="flex-1" />
          <span aria-live="polite" className="whitespace-nowrap font-mono text-[11.5px] text-fg-3">
            {totalTxt}
          </span>
        </div>
      )}

      {/* Body */}
      {failed ? (
        <LoadError error={query.error} retrying={query.isFetching} onRetry={() => void query.refetch()} />
      ) : mobile ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pb-10 pt-2.5">
          {loading ? (
            <MobileSkeleton />
          ) : rows.length === 0 ? (
            <NoMatch meta={emptyMeta} onReset={log.reset} />
          ) : (
            <>
              {rows.map((e) => (
                <EventCard key={e.id} e={e} people={people} open={!!open[e.id]} onToggle={() => toggle(e.id)} />
              ))}
              {query.hasNextPage && (
                <Button className="h-11 flex-none justify-center" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
                  Load more
                  <span className="font-mono text-[11.5px] text-fg-3">
                    {rows.length}
                    {total !== undefined ? ` of ${total}` : ""}
                  </span>
                </Button>
              )}
            </>
          )}
        </div>
      ) : (
        <>
          <div className="relative min-h-0 flex-1 overflow-auto [scrollbar-color:var(--line-2)_transparent] [scrollbar-width:thin]">
            <div role="table" aria-label="Audit events" aria-busy={loading || undefined} className="min-w-[600px]">
              <div
                role="row"
                className={cn(
                  "sticky top-0 z-[4] grid h-8 items-center border-b border-line bg-bg font-mono text-[10.5px] font-medium uppercase tracking-[0.07em] text-fg-3",
                  COLS,
                )}
              >
                <span role="columnheader" aria-label="Expand" />
                <span role="columnheader" className="px-2">Time</span>
                <span role="columnheader" className="px-2">Actor</span>
                <span role="columnheader" className="px-2">Action</span>
                <span role="columnheader" className="px-2">Entity</span>
                <span role="columnheader" className="px-2">Source</span>
              </div>
              {loading ? (
                <TableSkeleton />
              ) : rows.length === 0 ? (
                <NoMatch meta={emptyMeta} onReset={log.reset} />
              ) : (
                rows.map((e) => {
                  const isOpen = !!open[e.id];
                  const name = actorLabel(e, people);
                  const t = auditTime(e.createdAt);
                  const xid = `audit-x-${e.id}`;
                  return (
                    <div key={e.id} role="rowgroup" className={cn("border-b border-line", isOpen && "[&>[role=row]]:bg-surface")}>
                      <div
                        role="row"
                        onClick={() => toggle(e.id)}
                        className={cn("grid h-9 cursor-pointer items-center transition-colors duration-100 hover:bg-surface", COLS)}
                      >
                        <span role="cell">
                          <RowChevron
                            open={isOpen}
                            controls={xid}
                            label={`${name} ${ACTION_META[describe(e).kind].label.toLowerCase()} ${e.entityKey ?? e.target}`}
                            onClick={() => toggle(e.id)}
                          />
                        </span>
                        <Cell>
                          <span className="font-mono text-[12px] font-medium text-fg-2" title={t.full}>
                            {t.cell}
                          </span>
                        </Cell>
                        <Cell>
                          <ActorAvatar name={name} hue={people.get(e.actorId)?.hue} integration={e.actorKind === "integration"} />
                          <span className="min-w-0 truncate">{name}</span>
                        </Cell>
                        <Cell>
                          <ActionLabel e={e} />
                        </Cell>
                        <Cell>
                          <EntityCell e={e} />
                        </Cell>
                        <Cell>
                          <span className={cn("font-mono text-[11.5px] font-medium", e.source === "api" ? "text-info" : "text-fg-3")}>
                            {e.source === "api" ? "API" : e.source === "import" ? "import" : "web"}
                          </span>
                        </Cell>
                      </div>
                      {isOpen && <DiffPanel e={e} people={people} id={xid} />}
                    </div>
                  );
                })
              )}
            </div>
          </div>
          <div className="flex h-11 flex-none items-center gap-1.5 border-t border-line pl-4 pr-2.5">
            <span className="font-mono text-[11.5px] text-fg-3">Rows</span>
            <Menu>
              <MenuTrigger asChild>
                <Button variant="ghost" size="sm" aria-label={`Rows per page: ${log.size}`} className="h-[26px] gap-1 px-2 font-mono">
                  {log.size}
                  <ChevronDown size={10} strokeWidth={1.8} aria-hidden />
                </Button>
              </MenuTrigger>
              <MenuContent width={120}>
                <MenuRadioGroup value={String(log.size)} onValueChange={(v) => log.setSize(Number(v) as 25 | 50 | 100)}>
                  {[25, 50, 100].map((n) => (
                    <MenuRadioItem key={n} value={String(n)}>
                      {n}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuContent>
            </Menu>
            <span className="flex-1" />
            <span className="font-mono text-[11.5px] text-fg-2">{pageTxt}</span>
            <Button
              variant="ghost"
              size="sm"
              icon
              aria-label="Previous page"
              disabledReason={!log.hasPrev ? "You’re on the first page" : undefined}
              onClick={log.prev}
            >
              <ChevronLeft size={14} strokeWidth={1.7} aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon
              aria-label="Next page"
              loading={query.isFetchingNextPage}
              disabledReason={!log.hasNext ? "No more events" : undefined}
              onClick={() => void log.next()}
            >
              {!query.isFetchingNextPage && <ChevronRight size={14} strokeWidth={1.7} aria-hidden />}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

function Cell({ children }: { children: ReactNode }) {
  return (
    <span role="cell" className="flex min-w-0 items-center gap-[7px] overflow-hidden whitespace-nowrap px-2 text-[13px]">
      {children}
    </span>
  );
}

/** Dashed when idle, solid when a value is set (board .au-fbtn). */
const FilterButton = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<"button"> & { on: boolean }>(function FilterButton(
  { on, className, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      {...props}
      className={cn(
        "inline-flex h-[30px] flex-none items-center gap-[7px] whitespace-nowrap rounded-[7px] border border-dashed border-line-2 px-2.5 text-[12.5px] font-medium text-fg-2",
        "transition-colors duration-[var(--dur-fast)] hover:border-control hover:bg-hover hover:text-fg aria-expanded:border-control aria-expanded:bg-hover aria-expanded:text-fg",
        "max-[760px]:h-[34px] max-[760px]:rounded-[17px] max-[760px]:px-3",
        on && "border-solid bg-surface text-fg",
        className,
      )}
    >
      {children}
    </button>
  );
});

function TableSkeleton() {
  const widths = [70, 52, 84, 60, 76, 48, 66, 80, 58, 72];
  return (
    <div role="status" aria-label="Loading audit events">
      {widths.map((w, i) => (
        <div key={i} className={cn("grid h-9 items-center border-b border-line", COLS)}>
          <span />
          <span className="px-2">
            <Skeleton className="w-[76px]" />
          </span>
          <span className="flex items-center gap-[7px] px-2">
            <Skeleton className="size-5 rounded-full" />
            <Skeleton style={{ width: w }} />
          </span>
          <span className="px-2">
            <Skeleton style={{ width: 50 + ((i * 17) % 40) }} />
          </span>
          <span className="px-2">
            <Skeleton style={{ width: `${30 + ((i * 23) % 45)}%` }} />
          </span>
          <span className="px-2">
            <Skeleton className="w-7" />
          </span>
        </div>
      ))}
    </div>
  );
}

function MobileSkeleton() {
  return (
    <div role="status" aria-label="Loading audit events" className="flex flex-col gap-2">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex flex-col gap-2.5 rounded-[10px] border border-line bg-surface px-3 py-3">
          <span className="flex items-center gap-2">
            <Skeleton className="size-5 rounded-full" />
            <Skeleton className="w-24" />
            <Skeleton className="ml-auto w-16" />
          </span>
          <Skeleton style={{ width: `${50 + i * 8}%` }} />
        </div>
      ))}
    </div>
  );
}

function NoMatch({ meta, onReset }: { meta: string; onReset: () => void }) {
  return (
    <div className="flex min-h-[260px] flex-1 items-center justify-center p-6">
      <EmptyState
        align="center"
        illustration="results"
        title="No events match"
        body={<span className="font-mono text-[11.5px] text-fg-3">{meta}</span>}
        actions={<Button onClick={onReset}>Reset filters</Button>}
      />
    </div>
  );
}

function LoadError({ error, onRetry, retrying }: { error: unknown; onRetry: () => void; retrying: boolean }) {
  const meta = isApiError(error) ? [error.status || null, error.ref ? `ref ${error.ref}` : null].filter(Boolean).join(" · ") : "";
  return (
    <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-2.5 p-6 text-center">
      <Illustration name="error" />
      <h2 className="m-0 text-[15px] font-semibold">Couldn’t load the audit log</h2>
      {meta && <span className="font-mono text-[11.5px] text-fg-3">{meta}</span>}
      <Button onClick={onRetry} loading={retrying}>
        Retry
      </Button>
    </div>
  );
}

/** Reached by URL without audit.view: "Admins only" with the admins to ask (nav entry is hidden). */
function AdminsOnly() {
  const ws = useCurrentWorkspace()!;
  const roles = useRoles(ws.slug);
  const members = useWsMembers(ws.slug);
  const myRole = roles.data?.find((r) => r.id === ws.myRoleId);
  const adminRoleIds = new Set((roles.data ?? []).filter((r) => r.permissions.includes("audit.view")).map((r) => r.id));
  const admins = (members.data ?? [])
    .filter((m) => m.status === "active" && adminRoleIds.has(m.roleId))
    .map((m) => ({ id: m.userId, name: m.user.name, hue: m.user.hue }));
  return (
    <section aria-label="Audit log" className="flex h-full min-h-0 flex-col bg-bg">
      <div className="flex h-[52px] flex-none items-center gap-2.5 border-b border-line pl-[18px] pr-3">
        <h1 className="m-0 flex items-center gap-[9px] text-[14px] font-semibold">
          <ShieldCheck size={16} strokeWidth={1.4} className="text-fg-3" aria-hidden />
          Audit log
        </h1>
        <span className="font-mono text-[11.5px] text-fg-3">{ws.name}</span>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-2.5 p-6 text-center">
        <Illustration name="denied" />
        <h2 className="m-0 text-[15px] font-semibold">Admins only</h2>
        <span className="font-mono text-[11.5px] text-fg-3">
          audit.view{myRole ? ` · ${myRole.name}` : ""}
        </span>
        {admins.length > 0 && (
          <div className="mt-1 flex flex-col items-center gap-2">
            <AvatarStack people={admins} size={20} max={4} />
            <p className="m-0 max-w-[320px] text-[13px] leading-5 text-fg-2">
              Ask {admins.length === 1 ? admins[0]!.name : "a workspace admin"} if you need the audit trail.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
