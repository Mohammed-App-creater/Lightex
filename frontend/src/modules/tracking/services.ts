import type { QueryKey } from "@tanstack/react-query";
import { qk } from "@/api/query-keys";
import type { ModuleServices } from "@/registry/services";
import { importNotificationText } from "./import/import-lib";
import { TASK_TARGET } from "./tasks/target";

/** Tracking's non-UI contributions to the platform (see `src/registry/services.ts`). */
export const trackingServices: ModuleServices = {
  targets: {
    [TASK_TARGET]: {
      label: "Task",
      related: (taskId, { qc, slug, projectId }) => {
        const keys: QueryKey[] = [qk.taskActivity(taskId)];
        // The open task detail is keyed by its key, which collab events don't carry: find it by id.
        const detail = qc.getQueriesData<{ id?: string }>({ queryKey: ["task", slug] }).find(([, d]) => d?.id === taskId)?.[0];
        if (detail) keys.push(detail);
        if (projectId) keys.push(qk.activity(projectId));
        return keys;
      },
    },
  },
  notificationText: {
    import: (n) => importNotificationText(n.payload),
  },
};
