"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ErrorState, Skeleton } from "@/components/ui/feedback";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Field, Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { toast } from "@/components/ui/toast";
import { CopyGlyph, DEV_ICON, DevGlyph, KeyText } from "@/features/integrations/icons";
import { checksAria, CHECK_LABEL, devCountLabel, formatDuration, hashHue, PR_STATE_LABEL, PROVIDER_NAME } from "@/features/integrations/lib/dev-lib";
import { highlightKeys } from "@/features/integrations/lib/key-match";
import { useCopy, useProjectKeys } from "@/features/integrations/queries";
import { useProjectMembers } from "@/features/projects/queries";
import { useProjects } from "@/features/workspace/queries";
import { api } from "@/lib/api/endpoints";
import { errorMessage, isApiError } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import type { CheckState, DevAuthor, DevBranch, DevCommit, DevItem, DevPullRequest, TaskDetail, TaskDevelopment } from "@/lib/api/types";
import { can, useCurrentWorkspace } from "@/lib/permissions/can";
import { useLiveInterval } from "@/lib/realtime/status-store";
import { cn } from "@/lib/utils/cn";
import { ago } from "@/lib/utils/dates";
import { CreateBranchButton } from "./create-branch";

const STATE_TONE: Record<DevPullRequest["state"], { color: string; icon: string }> = {
  open: { color: "text-ok", icon: DEV_ICON.prOpen },
  merged: { color: "text-info", icon: DEV_ICON.prMerged },
  draft: { color: "text-fg-3", icon: DEV_ICON.prOpen },
  closed: { color: "text-danger", icon: DEV_ICON.prClosed },
};
const CHECK_TONE: Record<CheckState, string> = { passing: "text-ok", failing: "text-danger", running: "text-warn" };

/**
 * Task panel "Development" (board 37 §9.5), above Description. Renders when the project has a
 * connected repository or the task already has links. Viewers see everything without the controls
 * (`development.link` gates Create branch, Link… and Unlink).
 */
export function DevelopmentSection({ task }: { task: TaskDetail }) {
  const ws = useCurrentWorkspace()!;
  const { data: projects } = useProjects(ws.slug);
  const project = projects?.find((p) => p.id === task.projectId);
  const show = Boolean(project?.devEnabled) || task.dev !== null;
  if (!show) return null;
  return <Section task={task} archived={project?.status === "archived"} />;
}

function Section({ task, archived }: { task: TaskDetail; archived: boolean }) {
  const ws = useCurrentWorkspace()!;
  const qc = useQueryClient();
  const keys = useProjectKeys(ws.slug);
  const prefixes = keys.length ? keys : [task.key.split("-")[0]!];
  const deleted = Boolean(task.deletedAt);
  const canLink = can("development.link", task.project.my_permissions) && !deleted && !archived;
  // Without the stream: refetch on focus, and every 30 s while visible if any check is running.
  const poll = useLiveInterval(30_000);
  const q = useQuery({
    queryKey: qk.development(task.id),
    queryFn: () => api.development.get(task.id),
    refetchInterval: (query) => ((query.state.data as TaskDevelopment | undefined)?.pullRequests.some((p) => p.checks?.state === "running") ? poll : false),
    refetchIntervalInBackground: false,
  });
  const [flash, setFlash] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const key = qk.development(task.id);

  const touchTask = () => {
    void qc.invalidateQueries({ queryKey: qk.task(ws.slug, task.key) });
    void qc.invalidateQueries({ queryKey: qk.scope(task.projectId) });
  };

  const onCreated = (b: DevBranch) => {
    qc.setQueryData<TaskDevelopment>(key, (d) => (d ? { ...d, branches: [b, ...d.branches] } : d));
    setFresh(b.id);
    setFlash("Branch created");
    window.setTimeout(() => setFlash(null), 1800);
    touchTask();
    void qc.invalidateQueries({ queryKey: key });
  };

  const unlink = async (item: DevItem) => {
    await qc.cancelQueries({ queryKey: key });
    const prev = qc.getQueryData<TaskDevelopment>(key);
    qc.setQueryData<TaskDevelopment>(key, (d) =>
      d
        ? {
            ...d,
            pullRequests: d.pullRequests.filter((x) => x.id !== item.id),
            branches: d.branches.filter((x) => x.id !== item.id),
            commits: d.commits.filter((x) => x.id !== item.id),
            commitTotal: d.commitTotal - (item.kind === "commit" ? 1 : 0),
          }
        : d,
    );
    const label = item.kind === "pull_request" ? item.ref : item.kind === "branch" ? item.name : item.shortSha;
    try {
      await api.development.unlink(task.id, item.id);
      toast({
        title: `Unlinked ${label}`,
        tone: "info",
        duration: 5000,
        action: {
          label: "Undo",
          onClick: () => {
            void api.development
              .link(task.id, item.url)
              .catch((e) => toast.error(`Couldn’t link ${label} again`, { body: errorMessage(e) }))
              .finally(() => {
                void qc.invalidateQueries({ queryKey: key });
                touchTask();
              });
          },
        },
      });
    } catch (e) {
      if (prev) qc.setQueryData(key, prev);
      toast.error(`Couldn’t unlink ${label}`, { body: `${errorMessage(e)} Reverted.` });
    } finally {
      void qc.invalidateQueries({ queryKey: key });
      touchTask();
    }
  };

  const d = q.data;
  const empty = d && !d.pullRequests.length && !d.branches.length && !d.commits.length;
  const canBranch = canLink && d?.enabled && d.repositories.some((r) => r.canCreateBranch);

  return (
    <section aria-label="Development">
      <div className="mb-2 flex min-h-8 flex-wrap items-center gap-2.5">
        <h3 className="m-0 text-[13px] font-semibold">Development</h3>
        {d && !empty && <span className="font-mono text-[11px] font-medium text-fg-3">{devCountLabel(d.pullRequests, d.branches.length, d.commitTotal)}</span>}
        {flash && (
          <span role="status" className="inline-flex items-center gap-[5px] text-[12px] text-ok animate-[fade-in_160ms_var(--ease)]">
            <DevGlyph d={DEV_ICON.check} size={12} strokeWidth={2} />
            {flash}
          </span>
        )}
        <span className="flex-1" />
        {canBranch && d && <CreateBranchButton taskId={task.id} suggested={d.suggestedBranch} repositories={d.repositories} onCreated={onCreated} />}
        {canLink && d?.enabled && (
          <Menu>
            <MenuTrigger asChild>
              <Button variant="ghost" icon size="sm" aria-label="More development actions">
                <MoreHorizontal size={15} aria-hidden />
              </Button>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem onSelect={() => setLinkOpen(true)}>Link pull request or commit…</MenuItem>
            </MenuContent>
          </Menu>
        )}
      </div>

      {q.isPending ? (
        <DevSkeleton />
      ) : q.isError ? (
        <ErrorState title="Couldn’t load linked work" body={errorMessage(q.error)} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : empty ? (
        <EmptyDev dev={d!} prefixes={prefixes} />
      ) : (
        <div className="flex flex-col">
          {d!.pullRequests.length > 0 && (
            <>
              <GroupHead label={d!.pullRequests.every((p) => p.provider === "gitlab") ? "Merge requests" : "Pull requests"} n={d!.pullRequests.length} first />
              {d!.pullRequests.map((p) => (
                <PrRow key={p.id} pr={p} prefixes={prefixes} projectId={task.projectId} canLink={canLink} onUnlink={() => void unlink(p)} />
              ))}
            </>
          )}
          {d!.branches.length > 0 && (
            <>
              <GroupHead label="Branches" n={d!.branches.length} first={!d!.pullRequests.length} />
              {d!.branches.map((b) => (
                <BranchRow key={b.id} branch={b} prefixes={prefixes} fresh={fresh === b.id} canLink={canLink} onUnlink={() => void unlink(b)} />
              ))}
            </>
          )}
          {d!.commits.length > 0 && (
            <>
              <GroupHead label="Commits" n={d!.commitTotal} first={!d!.pullRequests.length && !d!.branches.length} />
              {d!.commits.map((c) => (
                <CommitRow key={c.id} commit={c} prefixes={prefixes} projectId={task.projectId} canLink={canLink} onUnlink={() => void unlink(c)} />
              ))}
              {d!.commitTotal > d!.commits.length && new Set(d!.commits.map((c) => c.repoFullPath)).size === 1 && (
                <a
                  href={`${d!.commits[0]!.url.split("/commit/")[0]!.replace(/\/-$/, "")}/${d!.commits[0]!.provider === "gitlab" ? "-/" : ""}commits`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 text-[12px] text-fg-3 underline-offset-2 hover:text-fg hover:underline"
                >
                  Show all {d!.commitTotal} on {PROVIDER_NAME[d!.commits[0]!.provider]}
                </a>
              )}
            </>
          )}
        </div>
      )}
      {linkOpen && (
        <LinkDialog
          taskId={task.id}
          onClose={() => setLinkOpen(false)}
          onLinked={(item) => {
            setLinkOpen(false);
            const label = item.kind === "pull_request" ? item.ref : item.kind === "branch" ? item.name : item.shortSha;
            toast.success(`Linked ${label}`);
            void qc.invalidateQueries({ queryKey: key });
            touchTask();
          }}
        />
      )}
    </section>
  );
}

function GroupHead({ label, n, first }: { label: string; n: number; first?: boolean }) {
  return (
    <div className={cn("mb-1 flex items-center gap-[7px] font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-fg-3", first ? "mt-0.5" : "mt-3")}>
      {label}
      <span>{n}</span>
    </div>
  );
}

const rowCls = "group/dv -mx-2 flex min-h-9 items-center gap-2.5 rounded-[6px] px-2 transition-colors duration-[120ms] hover:bg-hover max-[760px]:min-h-11";

/** Matched member → their avatar; anyone else → initials + hashHue(login) (§9.7, §11 #16). */
function AuthorAvatar({ author, projectId }: { author: DevAuthor; projectId: string }) {
  const { data: members = [] } = useProjectMembers(projectId);
  const m = author.userId ? members.find((x) => x.userId === author.userId)?.user : undefined;
  const name = m?.name ?? author.name ?? author.login;
  return <Avatar name={name} hue={m?.hue ?? hashHue(author.login)} size={20} ring={false} />;
}

function RowMenu({ label, onUnlink }: { label: string; onUnlink: () => void }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={`Actions for ${label}`}
          className="flex size-[26px] flex-none items-center justify-center rounded-[5px] text-fg-3 opacity-0 transition-opacity hover:bg-raised hover:text-fg focus-visible:opacity-100 group-hover/dv:opacity-100 data-[state=open]:opacity-100 max-[760px]:size-9 max-[760px]:opacity-100 [@media(hover:none)]:opacity-100"
        >
          <MoreHorizontal size={14} aria-hidden />
        </button>
      </MenuTrigger>
      <MenuContent align="end">
        <MenuItem danger onSelect={onUnlink}>
          Unlink
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

function PrRow({ pr, prefixes, projectId, canLink, onUnlink }: { pr: DevPullRequest; prefixes: string[]; projectId: string; canLink: boolean; onUnlink: () => void }) {
  const [open, setOpen] = useState(false);
  const tone = STATE_TONE[pr.state];
  const c = pr.checks;
  return (
    <>
      <div className={rowCls}>
        <span className={cn("inline-flex h-[22px] w-[78px] flex-none items-center gap-[5px] rounded-[11px] bg-[color-mix(in_oklab,currentColor_14%,transparent)] px-1.5 text-[11.5px] font-semibold", tone.color)}>
          <DevGlyph d={tone.icon} size={12} strokeWidth={1.6} dashed={pr.state === "draft"} />
          {PR_STATE_LABEL[pr.state]}
        </span>
        <span className="flex-none font-mono text-[11.5px] font-medium text-fg-3">{pr.ref}</span>
        <a href={pr.url} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate text-[13px] text-fg hover:underline">
          <KeyText parts={highlightKeys(pr.title, prefixes)} />
        </a>
        {c && (
          <button
            type="button"
            aria-expanded={open}
            aria-label={checksAria(c)}
            onClick={() => setOpen((o) => !o)}
            className={cn(
              "inline-flex h-6 flex-none items-center gap-[5px] rounded-[6px] border border-line pl-1.5 pr-2 text-[11.5px] font-semibold transition-colors hover:border-line-2 hover:bg-raised aria-[expanded=true]:border-line-2 aria-[expanded=true]:bg-raised max-[760px]:h-9",
              CHECK_TONE[c.state],
            )}
          >
            <CheckIcon state={c.state} />
            {CHECK_LABEL[c.state]}
          </button>
        )}
        <AuthorAvatar author={pr.author} projectId={projectId} />
        {canLink && <RowMenu label={pr.ref} onUnlink={onUnlink} />}
      </div>
      {open && c && (
        <ul aria-label="Checks" className="m-0 mb-1.5 ml-[30px] flex list-none flex-col gap-0.5 border-l border-line-2 py-1 pl-3 animate-[fade-in_160ms_var(--ease)]">
          {c.items.map((it) => (
            <li key={it.name} className="flex h-6 items-center gap-2 text-[12px]">
              <span className={cn("inline-flex", CHECK_TONE[it.state])}>
                <CheckIcon state={it.state} />
              </span>
              {it.url ? (
                <a href={it.url} target="_blank" rel="noopener noreferrer" className="truncate font-mono text-[12px] text-fg hover:underline">
                  {it.name}
                </a>
              ) : (
                <span className="truncate font-mono text-[12px] text-fg">{it.name}</span>
              )}
              <span className={cn("text-[11.5px] font-semibold", CHECK_TONE[it.state])}>{CHECK_LABEL[it.state]}</span>
              <span className="flex-1" />
              <span className="font-mono text-[11.5px] text-fg-3">{formatDuration(it.durationSec)}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function CheckIcon({ state }: { state: CheckState }) {
  if (state === "running") return <span aria-hidden className="inline-block size-3 rounded-full border-[1.5px] border-current border-t-transparent motion-safe:animate-spin" />;
  return <DevGlyph d={state === "passing" ? DEV_ICON.check : DEV_ICON.x} size={11} strokeWidth={2.2} />;
}

function BranchRow({ branch: b, prefixes, fresh, canLink, onUnlink }: { branch: DevBranch; prefixes: string[]; fresh: boolean; canLink: boolean; onUnlink: () => void }) {
  const { copied, copy } = useCopy();
  return (
    <div className={cn(rowCls, fresh && "animate-[rise-in_320ms_var(--ease)]")}>
      <DevGlyph d={DEV_ICON.branch} className="text-fg-3" />
      <a href={b.url} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate font-mono text-[12.5px] font-medium leading-[1.3] text-fg hover:underline">
        <KeyText parts={highlightKeys(b.name, prefixes)} />
      </a>
      <span className="flex-none whitespace-nowrap font-mono text-[11.5px] text-fg-3 max-[760px]:hidden">{b.repoFullPath.split("/").pop()}</span>
      <span className="w-14 flex-none whitespace-nowrap text-right text-[11.5px] text-fg-3">{b.aheadBy != null ? `${b.aheadBy} ahead` : ago(b.updatedAt)}</span>
      <Button variant="ghost" icon size="sm" aria-label={`Copy ${b.name}`} onClick={() => copy(b.name)}>
        <CopyGlyph copied={copied === b.name} />
      </Button>
      {canLink && <RowMenu label={b.name} onUnlink={onUnlink} />}
    </div>
  );
}

function CommitRow({ commit: c, prefixes, projectId, canLink, onUnlink }: { commit: DevCommit; prefixes: string[]; projectId: string; canLink: boolean; onUnlink: () => void }) {
  const first = c.message.split("\n")[0] ?? "";
  return (
    <div className={rowCls}>
      <a href={c.url} target="_blank" rel="noopener noreferrer" className="w-[58px] flex-none font-mono text-[12px] font-medium text-accent-t hover:underline">
        {c.shortSha}
      </a>
      <span className="min-w-0 flex-1 truncate text-[13px] text-fg">
        <KeyText parts={highlightKeys(first, prefixes)} />
      </span>
      <AuthorAvatar author={c.author} projectId={projectId} />
      <span className="w-[26px] flex-none text-right text-[11.5px] text-fg-3">{ago(c.committedAt).replace("just now", "now")}</span>
      {canLink && <RowMenu label={c.shortSha} onUnlink={onUnlink} />}
    </div>
  );
}

function EmptyDev({ dev, prefixes }: { dev: TaskDevelopment; prefixes: string[] }) {
  const { copied, copy } = useCopy();
  return (
    <div className="flex flex-col gap-2.5 rounded-[10px] border border-dashed border-line-2 p-3.5">
      <span className="flex items-center gap-2 font-medium">
        <DevGlyph d={DEV_ICON.branch} size={14} className="text-fg-3" />
        No linked work yet
      </span>
      <div className="flex h-[34px] items-center gap-2 rounded-[6px] border border-line-2 bg-surface pl-2.5 pr-[3px] font-mono text-[12.5px] font-medium">
        <span aria-label="Suggested branch name" className="min-w-0 flex-1 truncate">
          <KeyText parts={highlightKeys(dev.suggestedBranch, prefixes)} />
        </span>
        <Button variant="ghost" icon size="sm" aria-label="Copy branch name" onClick={() => copy(dev.suggestedBranch)}>
          <CopyGlyph copied={copied === dev.suggestedBranch} />
        </Button>
      </div>
      <span className="text-[12px] text-fg-3">Use {dev.taskKey} in a branch, PR or commit</span>
    </div>
  );
}

function DevSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading linked work" className="flex flex-col gap-1">
      {[180, 140].map((w) => (
        <div key={w} className="flex h-9 items-center gap-2.5">
          <Skeleton className="h-[22px] w-[78px] rounded-[11px]" />
          <Skeleton className="h-2.5" style={{ width: w }} />
          <span className="flex-1" />
          <Skeleton className="h-[22px] w-16" />
        </div>
      ))}
      <div className="flex h-9 items-center gap-2.5">
        <Skeleton className="size-3.5 rounded-[4px]" />
        <Skeleton className="h-2.5 w-[150px]" />
      </div>
      <div className="flex h-9 items-center gap-2.5">
        <Skeleton className="h-2.5 w-14" />
        <Skeleton className="h-2.5 w-[170px]" />
        <span className="flex-1" />
        <Skeleton className="size-5 rounded-full" />
      </div>
    </div>
  );
}

/** ⋯ → "Link pull request or commit…" (§11 #10): a URL, D2. */
function LinkDialog({ taskId, onClose, onLinked }: { taskId: string; onClose: () => void; onLinked: (item: DevItem) => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      onLinked(await api.development.link(taskId, url.trim()));
    } catch (e) {
      const f = isApiError(e) ? ((e.details as { fields?: Record<string, string> } | undefined)?.fields ?? {}) : {};
      setError(f.url ?? errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Link pull request or commit"
      description="Paste a pull request, merge request, commit or branch URL from a connected repository."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabledReason={!url.trim() ? "Paste a URL first" : undefined} onClick={() => void submit()}>
            Link
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim()) void submit();
        }}
      >
        <Field label="URL" error={error}>
          <Input autoFocus value={url} onChange={(e) => setUrl(e.target.value)} mono inputMode="url" placeholder="https://github.com/org/repo/pull/214" />
        </Field>
      </form>
    </Modal>
  );
}
