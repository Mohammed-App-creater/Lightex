"use client";

import { useParams, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { TaskDetailView } from "@/features/tasks/task-detail";
import { api } from "@/lib/api/endpoints";
import { qk } from "@/lib/api/query-keys";
import { ProjectScope, useCurrentWorkspace } from "@/lib/permissions/can";
import { routes } from "@/lib/routes";

/** Full-page task (board 14 frame g): two columns with a 300px properties rail. */
export default function TaskPage() {
  const { taskKey } = useParams<{ taskKey: string }>();
  const key = decodeURIComponent(taskKey).toUpperCase();
  const ws = useCurrentWorkspace()!;
  const router = useRouter();
  const projectKey = key.split("-")[0] ?? "";
  // The project's my_permissions drive the shell's project-scoped UI (palette, C shortcut).
  const project = useQuery({ queryKey: qk.project(ws.slug, projectKey), queryFn: () => api.projects.get(ws.slug, projectKey), enabled: Boolean(projectKey), retry: false });
  return (
    <ProjectScope project={project.data ?? null}>
      <div className="h-full">
        <TaskDetailView
          taskKey={key}
          mode="full"
          onToggleFull={() => router.push(`${routes.project(ws.slug, projectKey, "board")}?task=${key}`)}
        />
      </div>
    </ProjectScope>
  );
}
