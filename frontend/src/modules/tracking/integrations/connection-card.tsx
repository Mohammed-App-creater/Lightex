"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Menu, MenuCheckboxItem, MenuContent, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { useProjects } from "@/features/workspace/queries";
import { api } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import type { Integration, IntegrationsOverview, Project, Repository } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";
import { ago } from "@/lib/utils/dates";
import { DEV_ICON, DevGlyph, ProviderLogo } from "./icons";
import { ERROR_BADGE, integrationMeta, PR_NOUN, PROVIDER_NAME } from "./lib/dev-lib";

/**
 * One connection (design "Connected + status" / "Error"): logo, name and account, the Connected or
 * error badge (§9.7), meta, actions (managers only, §11 #6), and the tracked repositories with a
 * per-row project scope menu (§11 #8).
 */
export function ConnectionCard({
  integration: i,
  slug,
  canManage,
  waiting,
  onEditRepos,
  onReconnect,
  onDisconnect,
  onAddAnother,
}: {
  integration: Integration;
  slug: string;
  canManage: boolean;
  /** "Waiting for authorization…" while a reconnect redirect is pending. */
  waiting: boolean;
  onEditRepos: () => void;
  onReconnect: () => void;
  onDisconnect: () => void;
  onAddAnother: () => void;
}) {
  const qc = useQueryClient();
  const name = PROVIDER_NAME[i.provider];
  const err = i.status === "error";
  const sync = useMutation({
    mutationFn: () => api.integrations.sync(i.id),
    onSuccess: (next) => {
      qc.setQueryData<IntegrationsOverview>(qk.integrations(slug), (o) => (o ? { ...o, integrations: o.integrations.map((x) => (x.id === next.id ? next : x)) } : o));
    },
    onError: (e) => toast.error("Couldn’t start a sync", { body: errorMessage(e) }),
  });
  const syncWait = i.nextSyncAt && !i.syncing ? `Synced recently. Sync again ${new Date(i.nextSyncAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.` : undefined;

  return (
    <div className={cn("overflow-hidden rounded-[12px] border bg-surface animate-[fade-in_200ms_var(--ease)]", err ? "border-danger" : "border-line")}>
      <div className="flex flex-wrap items-center gap-3 p-3.5">
        <ProviderLogo provider={i.provider} />
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2 text-[14px]">
            <b className="font-semibold">{name}</b>
            <span className="truncate font-mono text-[12px] text-fg-3">{i.account.login}</span>
            <span
              className={cn(
                "inline-flex h-5 items-center gap-[5px] rounded-[10px] bg-[color-mix(in_oklab,currentColor_14%,transparent)] pl-1.5 pr-2 text-[11.5px] font-semibold",
                err ? "text-danger" : "text-ok",
              )}
            >
              <DevGlyph d={err ? DEV_ICON.warn : DEV_ICON.check} size={11} strokeWidth={2} />
              {i.error ? ERROR_BADGE[i.error.code] : "Connected"}
            </span>
          </div>
          <span className="font-mono text-[11.5px] text-fg-3">{integrationMeta(i)}</span>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1.5 max-[760px]:ml-0 max-[760px]:w-full">
          {waiting && (
            <span role="status" className="inline-flex items-center gap-2 whitespace-nowrap text-[12px] text-fg-2">
              <Spinner />
              Waiting for authorization…
            </span>
          )}
          {canManage && !err && (
            <Button size="sm" loading={sync.isPending} aria-busy={i.syncing || undefined} disabledReason={syncWait} onClick={() => sync.mutate()}>
              {i.syncing ? <Spinner /> : <DevGlyph d={DEV_ICON.sync} />}
              {i.syncing ? "Syncing" : "Sync now"}
            </Button>
          )}
          {canManage && !err && (
            <Button size="sm" variant="ghost" onClick={onEditRepos}>
              Edit repos
            </Button>
          )}
          {canManage && err && !waiting && (
            <Button size="sm" variant="primary" onClick={onReconnect}>
              Reconnect
            </Button>
          )}
          {!canManage && err && (
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[12px] text-fg-3">
              <DevGlyph d={DEV_ICON.lock} />
              Ask a workspace admin to reconnect
            </span>
          )}
          {canManage && !waiting && (
            <Button size="sm" variant="danger-ghost" onClick={onDisconnect}>
              Disconnect
            </Button>
          )}
        </div>
      </div>
      {err && i.error && <p className="m-0 border-t border-line px-3.5 py-2 text-[12px] text-fg-2">{i.error.message}</p>}
      <ul aria-label={`${name} repositories`} className="m-0 list-none border-t border-line p-0">
        {i.repositories.length === 0 && <li className="flex h-[38px] items-center px-3.5 text-[12.5px] text-fg-3">No repositories chosen yet.</li>}
        {i.repositories.map((r) => (
          <RepoRow key={r.id} repo={r} slug={slug} canManage={canManage} paused={err} />
        ))}
      </ul>
      {canManage && (
        <div className="flex border-t border-line px-3.5 py-2">
          <button type="button" onClick={onAddAnother} className="text-[12px] font-medium text-fg-3 underline-offset-2 hover:text-fg hover:underline">
            {i.provider === "github" ? "Add organization" : "Add GitLab connection"}
          </button>
        </div>
      )}
    </div>
  );
}

function syncLabel(r: Repository, paused: boolean) {
  if (paused || r.syncState === "paused") return "paused";
  if (r.syncState === "syncing") return "syncing";
  if (r.syncState === "queued") return "queued";
  if (r.syncState === "failed") return "failed";
  return r.lastSyncedAt ? ago(r.lastSyncedAt) : "—";
}

function RepoRow({ repo: r, slug, canManage, paused }: { repo: Repository; slug: string; canManage: boolean; paused: boolean }) {
  const { data: projects = [] } = useProjects(slug);
  const label = syncLabel(r, paused);
  const noun = PR_NOUN[r.provider];
  return (
    <li className={cn("flex min-h-[38px] items-center gap-2.5 border-t border-line px-3.5 text-fg-3 first:border-t-0 max-[760px]:min-h-11", paused && "opacity-60")}>
      <DevGlyph d={DEV_ICON.repo} size={14} strokeWidth={1.4} />
      <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
        {r.owner}/<b className="font-medium text-fg">{r.name}</b>
      </span>
      {canManage ? (
        <ScopeMenu repo={r} slug={slug} projects={projects} />
      ) : (
        !r.allProjects && <span className="hidden font-mono text-[11.5px] text-fg-3 min-[761px]:inline">{scopeText(r, projects)}</span>
      )}
      <span className="whitespace-nowrap font-mono text-[11.5px] max-[760px]:hidden">
        {r.openPullRequests} open {r.openPullRequests === 1 ? noun.one : noun.short}
      </span>
      <span className={cn("w-[58px] text-right text-[11.5px]", label === "failed" && "text-danger")}>{label}</span>
    </li>
  );
}

const scopeText = (r: Repository, projects: Project[]) =>
  r.allProjects ? "All projects" : r.projectIds.map((id) => projects.find((p) => p.id === id)?.key ?? "…").join(", ");

/** G10: "All projects ▾" — which projects this repository links into (§6.4). */
function ScopeMenu({ repo: r, slug, projects }: { repo: Repository; slug: string; projects: Project[] }) {
  const qc = useQueryClient();
  const scope = useMutation({
    mutationFn: (ids: string[]) => api.integrations.scopeRepository(r.id, ids),
    onMutate: async (ids) => {
      await qc.cancelQueries({ queryKey: qk.integrations(slug) });
      const prev = qc.getQueryData<IntegrationsOverview>(qk.integrations(slug));
      const patch = (x: Repository) => (x.id === r.id ? { ...x, projectIds: ids, allProjects: ids.length === 0 } : x);
      qc.setQueryData<IntegrationsOverview>(qk.integrations(slug), (o) => (o ? { ...o, integrations: o.integrations.map((i) => ({ ...i, repositories: i.repositories.map(patch) })) } : o));
      return { prev };
    },
    onError: (e, _ids, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.integrations(slug), ctx.prev);
      toast.error(`Couldn’t change ${r.fullPath}`, { body: `${errorMessage(e)} Reverted.` });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.integrations(slug) });
      void qc.invalidateQueries({ queryKey: qk.projects(slug) });
    },
  });
  const toggle = (id: string) => {
    const next = r.projectIds.includes(id) ? r.projectIds.filter((x) => x !== id) : [...r.projectIds, id];
    scope.mutate(next);
  };
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={`Projects for ${r.fullPath}: ${scopeText(r, projects)}`}
          className="inline-flex h-6 max-w-[150px] items-center gap-1 rounded-[6px] px-1.5 font-mono text-[11.5px] text-fg-2 hover:bg-hover max-[760px]:h-9"
        >
          <span className="truncate">{scopeText(r, projects)}</span>
          <ChevronDown size={12} aria-hidden className="flex-none" />
        </button>
      </MenuTrigger>
      <MenuContent align="end" width={240}>
        <MenuLabel>Link tasks of</MenuLabel>
        <MenuCheckboxItem checked={r.allProjects} onCheckedChange={() => scope.mutate([])} onSelect={(e) => e.preventDefault()}>
          All projects
        </MenuCheckboxItem>
        <MenuSeparator />
        {projects.map((p) => (
          <MenuCheckboxItem key={p.id} checked={!r.allProjects && r.projectIds.includes(p.id)} onCheckedChange={() => toggle(p.id)} onSelect={(e) => e.preventDefault()}>
            <span className="font-mono text-[11px] text-fg-3">{p.key}</span> {p.name}
          </MenuCheckboxItem>
        ))}
      </MenuContent>
    </Menu>
  );
}
