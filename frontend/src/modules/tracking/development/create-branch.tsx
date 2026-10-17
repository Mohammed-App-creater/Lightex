"use client";

import * as Popover from "@radix-ui/react-popover";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { CopyGlyph, DEV_ICON, DevGlyph } from "@/features/integrations/icons";
import { BRANCH_MAX, validateBranch } from "@/features/integrations/lib/branch-name";
import { useCopy } from "@/features/integrations/queries";
import { api } from "@/lib/api/endpoints";
import { errorMessage, isApiError } from "@/lib/api/errors";
import type { DevBranch, DevRepositoryOption } from "@/lib/api/types";

/**
 * The design's "Create branch" popover (§9.5): name prefilled with the suggestion and validated with
 * validateBranch, Copy, "from {defaultBranch} in [repo ▾]", Cancel / Create ↵. Not optimistic (a
 * remote write, §11 #19): Create shows a spinner; 409 / 422 show inline under the name.
 */
export function CreateBranchButton({
  taskId,
  suggested,
  repositories,
  onCreated,
}: {
  taskId: string;
  suggested: string;
  repositories: DevRepositoryOption[];
  onCreated: (b: DevBranch) => void;
}) {
  const repos = repositories.filter((r) => r.canCreateBranch);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(suggested);
  const [repoId, setRepoId] = useState(repos[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { copied, copy } = useCopy();
  const repo = repos.find((r) => r.id === repoId) ?? repos[0];

  const create = async () => {
    const n = name.trim().replace(/\s+/g, "-");
    const v = validateBranch(n);
    if (v) {
      setError(v);
      return;
    }
    if (!repo) return;
    setBusy(true);
    setError(null);
    try {
      const b = await api.development.createBranch(taskId, { repositoryId: repo.id, name: n });
      setOpen(false);
      onCreated(b);
    } catch (e) {
      const fields = isApiError(e) ? ((e.details as { fields?: Record<string, string> } | undefined)?.fields ?? {}) : {};
      setError(fields.name ?? fields.repositoryId ?? errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          setName(suggested);
          setError(null);
        }
      }}
    >
      <Popover.Trigger asChild>
        <Button size="sm" aria-haspopup="dialog">
          <DevGlyph d={DEV_ICON.branch} />
          Create branch
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          role="dialog"
          aria-label="Create branch"
          align="end"
          sideOffset={6}
          collisionPadding={12}
          className="z-[70] flex w-[320px] max-w-[calc(100vw-24px)] flex-col gap-2.5 rounded-md border border-line-2 bg-raised p-3 shadow-pop outline-none data-[state=open]:animate-[menu-in_180ms_var(--ease)]"
        >
          <div className="flex items-center gap-1.5">
            <input
              autoFocus
              aria-label="Branch name"
              aria-invalid={Boolean(error) || undefined}
              aria-describedby={error ? "dv-branch-err" : undefined}
              value={name}
              maxLength={BRANCH_MAX}
              spellCheck={false}
              onChange={(e) => {
                setName(e.target.value.slice(0, BRANCH_MAX));
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void create();
                }
              }}
              className="h-8 min-w-0 flex-1 rounded-[6px] border border-accent bg-surface px-2.5 font-mono text-[12.5px] font-medium text-fg shadow-[0_0_0_3px_var(--accent-s)] outline-none aria-[invalid=true]:border-danger aria-[invalid=true]:shadow-[0_0_0_3px_var(--danger-s)] max-[760px]:h-11"
            />
            <Button variant="ghost" icon size="sm" aria-label="Copy branch name" onClick={() => copy(name)}>
              <CopyGlyph copied={copied === name} />
            </Button>
          </div>
          {error && (
            <p id="dv-branch-err" role="alert" className="m-0 text-[12px] text-danger">
              {error}
            </p>
          )}
          <div className="flex items-center gap-1.5">
            <span className="whitespace-nowrap font-mono text-[11.5px] font-medium text-fg-3">from {repo?.defaultBranch ?? "main"} in</span>
            <select
              aria-label="Repository"
              value={repo?.id ?? ""}
              onChange={(e) => setRepoId(e.target.value)}
              className="h-7 min-w-0 flex-1 rounded-[6px] border border-line-2 bg-surface px-2 font-mono text-[12px] font-medium text-fg outline-none focus-visible:shadow-[0_0_0_1px_var(--accent),0_0_0_4px_var(--ring)] max-[760px]:h-11"
            >
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" loading={busy} onClick={() => void create()}>
              Create <Kbd>↵</Kbd>
            </Button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
