/*
 * What this tab shows right now, for the event applier (spec §7.8): the open task (toast flag) and
 * the open dashboard (deleted by someone else → toast and back to the index). Screens register on
 * mount and clear on unmount.
 */

export const onScreen = {
  taskId: null as string | null,
  dashboard: null as { id: string; onDeleted: () => void } | null,
};
