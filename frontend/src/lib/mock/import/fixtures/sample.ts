/*
 * Board 40 "Use sample file" (mock mode only): the design's sampleText() verbatim. 48 data rows,
 * CRLF, cells quoted when they contain " , ; or a newline. Against PRJ: 44 tasks, 4 skipped
 * (rows 8 and 42 "Missing title", row 20 "Invalid due date", row 27 "Estimate is not a number").
 */

export const SAMPLE_FILE_NAME = "tasks-export.csv";

const TITLES = [
  "Fix login redirect loop",
  "Add SSO for admin console",
  "Board loads slowly with 500 cards",
  "Rate-limit password reset",
  "Dark mode for settings",
  "Export sprint report as PDF",
  "Flaky test: drag between columns",
  "Webhook retries with backoff",
  "Keyboard shortcut cheatsheet",
  "Archive closed sprints",
  "Paginate activity feed",
  "Mobile: offline task cache",
  "Audit log for role changes",
  "Invite flow email copy",
  "Bulk edit priority",
  "Search by task key",
  "Billing: proration on seat change",
  "Upgrade to Node 22",
  "Remove legacy v1 endpoints",
  "Attachment virus scan",
  "Due date reminders",
  "Burndown off by one day",
  "Slack notifications digest",
  "Custom fields on cards",
  "Reduce bundle size under 300 KB",
  "Timezone bug in due dates",
  "Retry failed uploads",
  "Sticky table headers",
  "Onboarding checklist",
  "Two-factor recovery codes",
];

const csvCell = (v: string) => (/[",\n\r;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function sampleText(): string {
  const ST = ["todo", "in progress", "todo", "done", "review", "in progress", "blocked"];
  const AS = ["Alex Kim", "Riley Chen", "Sam Patel", "Chris Ortiz", ""];
  const PR = ["High", "Medium", "Low", "Urgent", "Medium", ""];
  const ES = ["3", "2", "5", "1", "8", ""];
  const TG = ["frontend", "backend", "frontend;perf", "", "api"];
  const DS = ["Repro in Safari 17", "See incident 112", "", 'Spec in "Billing v2" doc', ""];
  const lines = [["Title", "Description", "Status", "Assignee", "Priority", "Estimate", "Due", "Tags"].join(",")];
  for (let i = 0; i < 48; i++) {
    const title = i === 6 || i === 40 ? "" : TITLES[i % 30]! + (i >= 30 ? " (follow-up)" : "");
    const due = i === 18 ? "next week" : i % 4 === 3 ? "" : "2026-10-" + String(8 + (i % 20)).padStart(2, "0");
    const est = i === 25 ? "XL" : ES[i % 6]!;
    lines.push([title, DS[i % 5]!, ST[i % 7]!, AS[i % 5]!, PR[i % 6]!, est, due, TG[i % 5]!].map(csvCell).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

/** The sample as a File (what the drop zone would have received). */
export function sampleFile(): File {
  return new File([sampleText()], SAMPLE_FILE_NAME, { type: "text/csv" });
}
