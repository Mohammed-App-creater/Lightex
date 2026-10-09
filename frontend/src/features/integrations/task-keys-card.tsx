"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/choice";
import { useMyTasks } from "@/features/workspace/queries";
import type { Task } from "@/lib/api/types";
import { CopyGlyph, DEV_ICON, DevGlyph, KeyText } from "./icons";
import { suggestBranch } from "./lib/branch-name";
import { highlightKeys } from "./lib/key-match";
import { useCopy, useProjectKeys } from "./queries";

/**
 * "Task keys" (design): three static examples, then the branch-name generator over the caller's open
 * assigned tasks (first 20; hidden when there are none, §11 #17), prefix plain / feature/, Copy.
 */
export function TaskKeysCard({ slug }: { slug: string }) {
  const keys = useProjectKeys(slug);
  const prefixes = keys.length ? keys : ["PRJ"];
  const ex = (label: string, icon: string, text: string) => (
    <div className="grid min-h-10 grid-cols-[84px_minmax(0,1fr)] items-center gap-3 border-t border-line px-3.5 first:border-t-0">
      <span className="inline-flex items-center gap-[7px] whitespace-nowrap text-[12px] font-medium text-fg-3">
        <DevGlyph d={icon} />
        {label}
      </span>
      <code className="truncate font-mono text-[12.5px] leading-[18px] text-fg">
        <KeyText parts={highlightKeys(text, prefixes)} />
      </code>
    </div>
  );
  return (
    <div className="overflow-hidden rounded-[12px] border border-line bg-surface">
      {ex("Branch", DEV_ICON.branch, "prj-42-fix-reflow")}
      {ex("PR title", DEV_ICON.prOpen, "PRJ-42 Fix flaky board reflow")}
      {ex("Commit", DEV_ICON.commit, "fix(board): debounce reflow (PRJ-42)")}
      <Generator slug={slug} prefixes={prefixes} />
    </div>
  );
}

function Generator({ slug, prefixes }: { slug: string; prefixes: string[] }) {
  const mine = useMyTasks(slug);
  const tasks = (mine.data ?? []).filter((t) => !t.completedAt && !t.deletedAt).slice(0, 20);
  if (!tasks.length) return null;
  return <GeneratorInner tasks={tasks} prefixes={prefixes} />;
}

function GeneratorInner({ tasks, prefixes }: { tasks: Task[]; prefixes: string[] }) {
  const [key, setKey] = useState(tasks[0]!.key);
  const [prefix, setPrefix] = useState<"" | "feature/">("");
  const { copied, copy } = useCopy();
  const task = tasks.find((t) => t.key === key) ?? tasks[0]!;
  const branch = suggestBranch(task.key, task.title, prefix);
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-line bg-bg px-3.5 py-3">
      <select
        aria-label="Task for branch name"
        value={task.key}
        onChange={(e) => setKey(e.target.value)}
        className="h-8 w-[210px] rounded-sm border border-control bg-surface px-2 font-mono text-[12px] text-fg outline-none focus:border-accent max-[760px]:h-11 max-[760px]:w-full"
      >
        {tasks.map((t) => (
          <option key={t.id} value={t.key}>
            {t.key} · {t.title}
          </option>
        ))}
      </select>
      <Segmented
        label="Branch prefix"
        value={prefix === "" ? "plain" : "feature"}
        onChange={(v) => setPrefix(v === "plain" ? "" : "feature/")}
        options={[
          { value: "plain", label: <span className="font-mono">plain</span> },
          { value: "feature", label: <span className="font-mono">feature/</span> },
        ]}
      />
      <div className="flex h-[34px] min-w-[200px] flex-1 items-center gap-2 rounded-[6px] border border-line-2 bg-surface pl-2.5 pr-[3px] font-mono text-[12.5px] font-medium">
        <span aria-label="Branch name" className="min-w-0 flex-1 truncate">
          <KeyText parts={highlightKeys(branch, prefixes)} />
        </span>
        <Button size="sm" aria-label="Copy branch name" onClick={() => copy(branch)}>
          <CopyGlyph copied={copied === branch} />
          {copied === branch ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}
