import type { ProjectTemplate, Status } from "@/lib/api/types";

/*
 * Project workflow templates (board 24 "4 templates"). Shared by the New project dialog (preview)
 * and the mock backend (statuses created with the project). The backend owns the real list.
 */

export type TemplateStatus = Pick<Status, "glyph" | "name" | "category">;

export interface TemplateDef {
  id: ProjectTemplate;
  name: string;
  /** Mono caption under the name, e.g. "6 · sprints". */
  meta: string;
  statuses: TemplateStatus[];
}

const s = (glyph: Status["glyph"], name: string): TemplateStatus => ({
  glyph,
  name,
  category: glyph === "done" || glyph === "canceled" ? "done" : glyph === "progress" || glyph === "review" ? "in_progress" : "todo",
});

export const PROJECT_TEMPLATES: TemplateDef[] = [
  { id: "simple", name: "Simple", meta: "3 statuses", statuses: [s("todo", "Todo"), s("progress", "In progress"), s("done", "Done")] },
  {
    id: "scrum",
    name: "Scrum",
    meta: "6 · sprints",
    statuses: [s("backlog", "Backlog"), s("todo", "Todo"), s("progress", "In progress"), s("review", "In review"), s("done", "Done"), s("canceled", "Canceled")],
  },
  {
    id: "kanban",
    name: "Kanban",
    meta: "5 · WIP limits",
    statuses: [s("backlog", "Backlog"), s("todo", "Ready"), s("progress", "Doing"), s("review", "Review"), s("done", "Done")],
  },
  {
    id: "bugs",
    name: "Bug tracking",
    meta: "6 · triage",
    statuses: [s("backlog", "Triage"), s("todo", "Confirmed"), s("progress", "Fixing"), s("review", "Verifying"), s("done", "Fixed"), s("canceled", "Won’t fix")],
  },
];

export const TEMPLATE_IDS = PROJECT_TEMPLATES.map((t) => t.id);

export function templateDef(id: string | null | undefined): TemplateDef {
  return PROJECT_TEMPLATES.find((t) => t.id === id) ?? PROJECT_TEMPLATES[1]!;
}

/** Status category columns for the preview: To do / In progress / Done. */
export const CATEGORY_LABEL: Record<Status["category"], string> = { todo: "To do", in_progress: "In progress", done: "Done" };
