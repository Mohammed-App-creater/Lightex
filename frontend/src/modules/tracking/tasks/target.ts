import type { TargetRef } from "@/api/types";

/** Platform Stage 2: the generic target key tracking registers for tasks (comments, attachments, notifications). */
export const TASK_TARGET = "tracking.task";

/** A task as a comment / attachment target. `targetId` is the task's id, never its key. */
export const taskTarget = (taskId: string): TargetRef => ({ targetType: TASK_TARGET, targetId: taskId });
