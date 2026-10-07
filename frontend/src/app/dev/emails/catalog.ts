/*
 * Email template catalogue (board 36). Mirrors emails/README.md: file, subject, trigger, and sample
 * merge data used by the /dev/emails preview. Subjects use the same {{merge_tags}} as the body.
 */

export type EmailTemplate = {
  id: string;
  file: string;
  label: string;
  subject: string;
  /** What sends it, and which notification-preferences event (if any) gates it. */
  trigger: string;
  sample: Record<string, string>;
};

const COMMON = {
  workspace_name: "Platform team",
  company_address: "Lightex Inc., 548 Market St, San Francisco, CA 94104",
  preferences_url: "https://app.lightex.dev/platform/settings/notifications",
  unsubscribe_url: "https://app.lightex.dev/unsubscribe/u_8f2k1",
};

const PRIORITY = { High: "#F76B15", Urgent: "#E5484D", Medium: "#E5A000", Low: "#12A594", None: "#8E8E9D" };

export const EMAIL_TEMPLATES: EmailTemplate[] = [
  {
    id: "invitation",
    file: "invitation.html",
    label: "Workspace invitation",
    subject: "You're invited to {{workspace_name}} on Lightex",
    trigger: "Transactional: an admin invites an email (POST /workspaces/:slug/invites, resend). Not preference-gated.",
    sample: {
      ...COMMON,
      inviter_name: "Alex Kim",
      inviter_email: "alex@team.dev",
      recipient_email: "taylor@team.dev",
      role: "Member",
      invite_expires: "Oct 14, 2026",
      cta_url: "https://app.lightex.dev/invite/inv_3k9q",
    },
  },
  {
    id: "task-assigned",
    file: "task-assigned.html",
    label: "Task assigned",
    subject: "{{task_key}} assigned to you",
    trigger: "Preference event “Assigned to me” (assigned · email).",
    sample: {
      ...COMMON,
      assigner_name: "Alex Kim",
      task_key: "PRJ-42",
      task_title: "Cache board queries per sprint",
      project_name: "Platform Rebuild",
      sprint_name: "Sprint 14",
      due_date: "Oct 9",
      priority: "High",
      priority_color: PRIORITY.High,
      cta_url: "https://app.lightex.dev/platform/tasks/PRJ-42",
    },
  },
  {
    id: "mentioned",
    file: "mentioned.html",
    label: "Mentioned in a comment",
    subject: "{{author_name}} mentioned you on {{task_key}}",
    trigger: "Preference event “Mentioned” (mentioned · email).",
    sample: {
      ...COMMON,
      author_name: "Jordan Lee",
      comment_excerpt: "Can you confirm the refresh window before Beta launch?",
      task_key: "PRJ-38",
      task_title: "Auth token refresh drops session",
      project_name: "Platform Rebuild",
      priority: "Urgent",
      priority_color: PRIORITY.Urgent,
      cta_url: "https://app.lightex.dev/platform/tasks/PRJ-38#comment-91",
    },
  },
  {
    id: "due-soon",
    file: "due-soon.html",
    label: "Due soon",
    subject: "{{task_key}} is due {{due_relative}}",
    trigger: "Preference event “Due soon” (due_soon · email): assignee, task due within 24 hours, not done.",
    sample: {
      ...COMMON,
      task_key: "PRJ-51",
      task_title: "Sprint burndown endpoint",
      project_name: "Platform Rebuild",
      due_date: "Oct 8, 2026",
      due_relative: "tomorrow",
      priority: "Medium",
      priority_color: PRIORITY.Medium,
      cta_url: "https://app.lightex.dev/platform/tasks/PRJ-51",
    },
  },
  {
    id: "sprint-started",
    file: "sprint-started.html",
    label: "Sprint started",
    subject: "{{sprint_name}} has started",
    trigger: "Preference event “Sprint started” (sprint_started · email): every project member.",
    sample: {
      ...COMMON,
      sprint_name: "Sprint 14",
      project_name: "Platform Rebuild",
      sprint_start: "Oct 1",
      sprint_end: "Oct 14",
      task_count: "24",
      points_total: "58",
      your_task_count: "6",
      cta_url: "https://app.lightex.dev/platform/projects/PRJ/board",
    },
  },
  {
    id: "sprint-completed",
    file: "sprint-completed.html",
    label: "Sprint completed",
    subject: "{{sprint_name}} is complete",
    trigger:
      "Sprint completed. No preference row exists for it yet; until one is added it follows “Sprint started” (sprint_started · email). Requested event: sprint_completed.",
    sample: {
      ...COMMON,
      sprint_name: "Sprint 13",
      next_sprint_name: "Sprint 14",
      project_name: "Platform Rebuild",
      sprint_start: "Sep 17",
      sprint_end: "Sep 30",
      completed_count: "19",
      task_count: "24",
      carried_count: "5",
      completed_pct: "79",
      cta_url: "https://app.lightex.dev/platform/projects/PRJ/sprints/sp_13",
    },
  },
  {
    id: "password-reset",
    file: "password-reset.html",
    label: "Password reset",
    subject: "Reset your Lightex password",
    trigger: "Security, transactional: POST /auth/forgot-password. Always sent; ignores notification preferences.",
    sample: {
      ...COMMON,
      user_email: "sam@team.dev",
      expires_at: "10:45 AM",
      cta_url: "https://app.lightex.dev/reset/7f3k9q",
    },
  },
];

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]!);

/** Replaces {{tag}} with HTML-escaped sample values; unknown tags are left visible. */
export function renderTemplate(html: string, data: Record<string, string>) {
  return html.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/g, (m, k: string) => (k in data ? escapeHtml(data[k]!) : m));
}

export const mergeTags = (html: string) => [...new Set([...html.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/g)].map((m) => m[1]!))].sort();
