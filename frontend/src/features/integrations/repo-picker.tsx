"use client";

import { Search } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/choice";
import { ErrorState, Skeleton } from "@/components/ui/feedback";
import { DialogClose, DialogShell } from "@/components/ui/modal";
import { Tooltip } from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/api/errors";
import type { AvailableRepository, Integration } from "@/lib/api/types";
import { ago } from "@/lib/utils/dates";
import { ProviderLogo } from "./icons";
import { PROVIDER_NAME } from "./lib/dev-lib";
import { useAvailableRepos } from "./queries";

const SK = [
  { w: 110, pad: 8 },
  { w: 60, pad: 26 },
  { w: 44, pad: 26 },
  { w: 96, pad: 26 },
  { w: 84, pad: 26 },
  { w: 70, pad: 8 },
];

/** Groups rows by owner (A–Z as the server sorts them). */
export function groupByOwner(rows: AvailableRepository[]) {
  const out: { owner: string; rows: AvailableRepository[] }[] = [];
  for (const r of rows) {
    const g = out.find((x) => x.owner === r.owner);
    if (g) g.rows.push(r);
    else out.push({ owner: r.owner, rows: [r] });
  }
  return out;
}

/**
 * "Choose repositories" (design picker): search (60 chars), grouping by owner with a tri-state
 * select-all and n/m, visibility, relative update time, skeleton, no-match + Clear search, and the
 * footer count. The selection is local; Confirm sends the complete set (G9). Rows tracked through
 * another connection are disabled with their reason.
 */
export function RepoPicker({
  integration,
  mode,
  saving,
  onCancel,
  onConfirm,
}: {
  integration: Integration;
  /** "connect": the first picker after connecting ("Connect N repos"); "edit": "Save · N repos". */
  mode: "connect" | "edit";
  saving: boolean;
  onCancel: () => void;
  onConfirm: (externalIds: string[]) => void;
}) {
  const [q, setQ] = useState("");
  // The search filters the full list locally (it's ≤ 1,000 rows), so the selection survives searching.
  const all = useAvailableRepos(integration.id, "");
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const initial = new Set((all.data ?? []).filter((r) => r.tracked).map((r) => r.externalId));
  const sel = picked ?? initial;
  const needle = q.trim().toLowerCase();
  const allRows = all.data ?? [];
  const groups = groupByOwner(allRows);
  const visibleGroups = groups.map((g) => ({ ...g, shown: g.rows.filter((r) => !needle || r.fullPath.toLowerCase().includes(needle)) })).filter((g) => g.shown.length > 0);
  const n = allRows.filter((r) => sel.has(r.externalId)).length;
  const name = PROVIDER_NAME[integration.provider];

  const toggle = (ids: string[], on: boolean) => {
    const next = new Set(sel);
    ids.forEach((id) => (on ? next.add(id) : next.delete(id)));
    setPicked(next);
  };

  return (
    <DialogShell
      open
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
      title="Choose repositories"
      description={`Pick the ${name} repositories Lightex links to tasks.`}
      width={500}
      height={600}
    >
      <div className="flex items-center gap-2.5 pb-3 pl-4 pr-3 pt-3.5">
        <ProviderLogo provider={integration.provider} small />
        <h2 className="m-0 flex-1 text-[15px] font-semibold">Choose repositories</h2>
        <DialogClose />
      </div>
      <div className="relative mx-4 mb-3">
        <Search size={14} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-3" />
        <input
          type="search"
          value={q}
          maxLength={60}
          onChange={(e) => setQ(e.target.value.slice(0, 60))}
          placeholder="Search repositories"
          aria-label="Search repositories"
          className="h-8 w-full rounded-sm border border-control bg-surface pl-8 pr-2.5 text-[13px] text-fg outline-none placeholder:text-fg-3 focus:border-accent focus:shadow-[0_0_0_3px_var(--ring)] max-[760px]:h-11"
        />
      </div>
      <div role="group" aria-label="Repositories" className="min-h-0 flex-1 overflow-auto border-t border-line px-2 pb-2 pt-1">
        {all.isPending ? (
          <div aria-busy="true" aria-label="Loading repositories">
            {SK.map((s, i) => (
              <div key={i} className="flex h-[34px] items-center gap-2.5" style={{ paddingLeft: s.pad }}>
                <Skeleton className="size-4 rounded-[4px]" />
                <Skeleton className="h-2.5" style={{ width: s.w }} />
              </div>
            ))}
          </div>
        ) : all.isError ? (
          <ErrorState className="m-2" title="Couldn’t load repositories" body={errorMessage(all.error)} onRetry={() => void all.refetch()} retrying={all.isFetching} />
        ) : visibleGroups.length === 0 ? (
          <div role="status" className="flex flex-col items-center gap-2 py-7 text-fg-3">
            <span>{needle ? `No repositories match “${q.trim()}”` : `${name} shows no repositories for this connection.`}</span>
            {needle && (
              <Button variant="ghost" size="sm" onClick={() => setQ("")}>
                Clear search
              </Button>
            )}
          </div>
        ) : (
          visibleGroups.map((g) => {
            const selectable = g.rows.filter((r) => !r.trackedElsewhere);
            const on = selectable.filter((r) => sel.has(r.externalId)).length;
            const allOn = selectable.length > 0 && on === selectable.length;
            return (
              <div key={g.owner}>
                <label className="mt-1.5 flex h-8 cursor-pointer items-center gap-2.5 px-2 font-mono text-[11px] font-medium uppercase tracking-[0.05em] text-fg-3 max-[760px]:h-11">
                  <Checkbox
                    checked={allOn}
                    indeterminate={on > 0 && !allOn}
                    disabled={selectable.length === 0}
                    onChange={() => toggle(selectable.map((r) => r.externalId), !allOn)}
                    aria-label={`Select all in ${g.owner}`}
                  />
                  <span className="flex-1">{g.owner}</span>
                  <span>
                    {on}/{g.rows.length}
                  </span>
                </label>
                {g.shown.map((r) => {
                  const row = (
                    <label
                      key={r.externalId}
                      className={
                        "flex h-[34px] items-center gap-2.5 rounded-[6px] pl-[26px] pr-2 text-fg-3 max-[760px]:h-11 " +
                        (r.trackedElsewhere ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-hover")
                      }
                    >
                      <Checkbox
                        checked={sel.has(r.externalId)}
                        disabled={r.trackedElsewhere}
                        aria-describedby={r.trackedElsewhere ? `te-${r.externalId}` : undefined}
                        onChange={(e) => toggle([r.externalId], e.target.checked)}
                      />
                      <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-fg">{r.name}</span>
                      {r.trackedElsewhere && (
                        <span id={`te-${r.externalId}`} className="sr-only">
                          Connected through another account
                        </span>
                      )}
                      <span className="inline-flex h-[22px] items-center rounded-[6px] border border-line bg-raised px-2 font-mono text-[11.5px] text-fg-2">{r.visibility}</span>
                      <span className="w-[26px] text-right text-[11.5px]">{r.updatedAt ? ago(r.updatedAt).replace("just now", "now") : ""}</span>
                    </label>
                  );
                  return r.trackedElsewhere ? (
                    <Tooltip key={r.externalId} content="Connected through another account">
                      {row}
                    </Tooltip>
                  ) : (
                    row
                  );
                })}
              </div>
            );
          })
        )}
      </div>
      {integration.manageUrl && integration.provider === "github" && (
        <a href={integration.manageUrl} target="_blank" rel="noopener noreferrer" className="border-t border-line px-4 py-2 text-[12px] text-fg-3 underline-offset-2 hover:text-fg hover:underline">
          Missing a repository? Change access on GitHub
        </a>
      )}
      <div className="flex items-center gap-2 border-t border-line px-4 py-3">
        <span className="flex-1 font-mono text-[11.5px] text-fg-3">{n} selected</span>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          loading={saving}
          disabledReason={n === 0 ? "Choose at least one repository" : undefined}
          onClick={() => onConfirm(allRows.filter((r) => sel.has(r.externalId)).map((r) => r.externalId))}
        >
          {mode === "edit" ? "Save · " : "Connect "}
          {n} {n === 1 ? "repo" : "repos"}
        </Button>
      </div>
    </DialogShell>
  );
}
