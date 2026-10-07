# Lightex email templates

Seven transactional / notification emails from design board 36 (`design/clean/36-Email-templates.html`,
designer exports in `desing - orignal/*.html`). The backend renders and sends them; the frontend only
owns the markup. Preview them with sample data at **`/dev/emails`** (dev tools only, like `/dev/ui`).

## Format

- Email-safe HTML: nested `role="presentation"` tables, inline styles, no external scripts, fonts or
  images (the logo is live text: "Lighte" + accent "x"). Safe system font stack; Menlo/Consolas for keys.
- Width 600px; a `max-width:620px` media query switches to the 375px mobile layout (24px gutters,
  20px headline, full-width button).
- Light by default; dark via `@media (prefers-color-scheme: dark)` plus the Outlook.com hooks
  `[data-ogsb]` / `[data-ogsc]`. Colours are the light / navy theme tokens.
- Outlook desktop: VML `v:roundrect` button and an MSO 600px ghost table.
- Each file starts with a hidden preheader (inbox preview line) and lists its merge tags in the head
  comment.

## Merge tags

Placeholders are `{{snake_case}}`. **The backend must HTML-escape every value** (names, titles and
comment excerpts are user content). URLs must be absolute. Tags shared by all templates:

| Tag | Meaning |
| --- | --- |
| `{{cta_url}}` | Absolute URL of the primary button (deep link to the task / sprint / invite / reset). |
| `{{workspace_name}}` | Workspace the event happened in. |
| `{{preferences_url}}` | `…/:workspace/settings/notifications` for the recipient. |
| `{{unsubscribe_url}}` | One-click unsubscribe for this notification type (List-Unsubscribe target too). Not in password reset. |
| `{{company_address}}` | Sender postal address for the footer (CAN-SPAM). |

`{{priority}}` is the label (`Urgent`, `High`, `Medium`, `Low`, `No priority`) and `{{priority_color}}`
its mid-tone that reads on light and dark: Urgent `#E5484D`, High `#F76B15`, Medium `#E5A000`,
Low `#12A594`, None `#8E8E9D`.

## Templates

Notification events refer to the rows of **Settings → Notifications** (`src/features/notifications/preferences.tsx`,
`NotificationEvent` in `src/lib/api/types.ts`). A notification email is sent only when that event's
**Email** column is on, batched per the recipient's "Email delivery" choice (instant / hourly / daily).

### `invitation.html` · Workspace invitation
- **Subject:** `You're invited to {{workspace_name}} on Lightex`
- **Trigger:** transactional. `POST /workspaces/:slug/invites` and `…/invites/:id/resend`. Not
  preference-gated (the recipient may have no account yet).
- **Tags:** `inviter_name`, `inviter_email`, `recipient_email`, `role` (role name), `invite_expires`
  (formatted date), `workspace_name`, `cta_url` (accept link), `unsubscribe_url`, `company_address`.

### `task-assigned.html` · Task assigned
- **Subject:** `{{task_key}} assigned to you`
- **Event:** `assigned` ("Assigned to me").
- **Tags:** `assigner_name`, `task_key`, `task_title`, `project_name`, `sprint_name`, `due_date`,
  `priority`, `priority_color`, `workspace_name`, `cta_url`, `preferences_url`, `unsubscribe_url`,
  `company_address`. If the task has no sprint or due date the backend should send the sentence
  without that clause (design copy: "It's in {{sprint_name}} and due {{due_date}}.").

### `mentioned.html` · Mentioned in a comment
- **Subject:** `{{author_name}} mentioned you on {{task_key}}`
- **Event:** `mentioned` ("Mentioned").
- **Tags:** `author_name`, `comment_excerpt` (plain text, first ~200 chars, mentions rendered as
  `@Name`), `task_key`, `task_title`, `project_name`, `priority`, `priority_color`, `workspace_name`,
  `cta_url` (task link with the comment anchor), `preferences_url`, `unsubscribe_url`, `company_address`.

### `due-soon.html` · Due soon
- **Subject:** `{{task_key}} is due {{due_relative}}`
- **Event:** `due_soon` ("Due soon"): assignee of an open task due within 24 hours.
- **Tags:** `task_key`, `task_title`, `project_name`, `due_date` (e.g. `Oct 8, 2026`), `due_relative`
  (`today` / `tomorrow`), `priority`, `priority_color`, `workspace_name`, `cta_url`, `preferences_url`,
  `unsubscribe_url`, `company_address`.

### `sprint-started.html` · Sprint started
- **Subject:** `{{sprint_name}} has started`
- **Event:** `sprint_started` ("Sprint started"): every member of the sprint's project.
- **Tags:** `sprint_name`, `project_name`, `sprint_start`, `sprint_end`, `task_count`, `points_total`,
  `your_task_count`, `workspace_name`, `cta_url` (board), `preferences_url`, `unsubscribe_url`,
  `company_address`.

### `sprint-completed.html` · Sprint completed
- **Subject:** `{{sprint_name}} is complete`
- **Event:** none yet. The preferences matrix has no "Sprint completed" row; until a
  `sprint_completed` event is added (requested), gate it on `sprint_started` · email.
- **Tags:** `sprint_name`, `next_sprint_name`, `project_name`, `sprint_start`, `sprint_end`,
  `completed_count`, `task_count`, `carried_count`, `completed_pct` (integer 0–100, drives the
  progress bar width), `workspace_name`, `cta_url` (sprint report), `preferences_url`,
  `unsubscribe_url`, `company_address`.

### `password-reset.html` · Password reset
- **Subject:** `Reset your Lightex password`
- **Trigger:** security, transactional. `POST /auth/forgot-password`. Always sent, ignores
  notification preferences, no unsubscribe link.
- **Tags:** `user_email`, `expires_at` (local time the link expires, e.g. `10:45 AM`), `cta_url`
  (single-use reset link; also printed as the fallback link), `preferences_url`, `company_address`.
  The copy says the link lasts **30 minutes**; change the text if the token TTL differs.

## Not covered by a template

`status_change` ("Status change on my tasks") and `comment` ("New comment") have Email toggles in
preferences but no designed email. Until boards exist, send them only in the hourly / daily digest or
keep them in-app only.
