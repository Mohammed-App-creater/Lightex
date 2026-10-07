"use client";

import { useState } from "react";
import { AppLoader } from "@/components/brand/app-loader";
import { ILLUSTRATIONS, Illustration } from "@/components/brand/illustrations";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/choice";
import { EmptyState } from "@/components/ui/feedback";
import { ActivityFeed } from "@/features/audit/activity-feed";
import type { ActivityEntry } from "@/lib/api/types";

/* Board 35 (illustrations, loading) and the board 31 activity feed, for the /dev/ui gallery. */

// Anchored to the hour so the server render and hydration agree on timestamps.
const ANCHOR = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const min = (m: number) => new Date(ANCHOR - m * 60_000).toISOString();
const entry = (id: string, actorId: string, verb: ActivityEntry["verb"], ago: number, taskKey: string | null, data: ActivityEntry["data"] = {}): ActivityEntry => ({
  id,
  actorId,
  verb,
  projectId: "p_demo",
  taskId: taskKey,
  taskKey,
  taskTitle: null,
  data,
  createdAt: min(ago),
});

const FEED: ActivityEntry[] = [
  entry("f1", "jl", "status_changed", 30, "PRJ-44", { to: "In review" }),
  entry("f2", "md", "commented", 110, "PRJ-50", { quote: "Carry-over should skip canceled tasks." }),
  entry("f3", "tn", "assigned", 300, "PRJ-57", { assignee: "Taylor Ng" }),
  entry("f4", "rc", "member_added", 60 * 26, null, { member: "Morgan Diaz" }),
  entry("f5", "ak", "status_changed", 60 * 50, "PRJ-42", { to: "Done" }),
];
const PEOPLE = new Map([
  ["ak", { id: "ak", name: "Alex Kim", hue: 285 }],
  ["jl", { id: "jl", name: "Jordan Lee", hue: 200 }],
  ["md", { id: "md", name: "Morgan Diaz", hue: 60 }],
  ["rc", { id: "rc", name: "Riley Chen", hue: 150 }],
  ["tn", { id: "tn", name: "Taylor Ng", hue: 330 }],
]);

export function BrandGallery() {
  const [motion, setMotion] = useState<"on" | "still">("on");
  const [run, setRun] = useState(0);
  return (
    <>
      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <h3 className="m-0 font-mono text-caption uppercase text-fg-3">Illustrations</h3>
          <Segmented
            label="Idle motion"
            value={motion}
            onChange={setMotion}
            className="ml-auto"
            options={[
              { value: "on", label: "Idle on" },
              { value: "still", label: "Still" },
            ]}
          />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {ILLUSTRATIONS.map((il) => (
            <figure key={il.name} className="m-0 flex flex-col items-center gap-1.5 rounded-md border border-line bg-surface p-2">
              <Illustration name={il.name} width={128} still={motion === "still"} title={il.label} />
              <figcaption className="text-center text-[11px] text-fg-2">
                {il.label} <span className="font-mono text-fg-3">· {il.motion}</span>
              </figcaption>
            </figure>
          ))}
        </div>
        <EmptyState
          align="center"
          illustration="projects"
          title="No projects yet"
          body="Create a project to start planning sprints."
          actions={<Button variant="primary">New project</Button>}
        />
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <h3 className="m-0 font-mono text-caption uppercase text-fg-3">Loading · 820ms</h3>
          <Button size="sm" className="ml-auto" onClick={() => setRun((r) => r + 1)}>
            Replay
          </Button>
        </div>
        <div key={run} className="grid grid-cols-2 gap-3">
          <AppLoader className="min-h-0 h-[200px] rounded-md border border-line" label="Wordmark loader demo" />
          <AppLoader variant="splash" className="min-h-0 h-[200px] rounded-md border border-line" label="Splash loader demo" />
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="m-0 font-mono text-caption uppercase text-fg-3">Activity feed</h3>
        <ActivityFeed entries={FEED} people={PEOPLE} className="h-[420px]" hasMore onMore={() => undefined} />
      </section>
    </>
  );
}
