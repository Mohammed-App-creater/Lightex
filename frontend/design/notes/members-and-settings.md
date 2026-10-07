# Members & roles + Profile / Workspace settings — implementation notes

Sources: `clean/18-Members-amp-roles.html` (board 18) and `clean/20-Profile-amp-workspace-settings.html` (board 20). Both are x-dc design canvases. Markup uses `{{...}}` templates and an inline `text/x-dc` script (`class Component extends DCLogic`) that holds all the data, validation and state logic. Everything below comes from reading the full markup, CSS and script.

Global conventions on both boards:
- Fonts: `'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif`. Base size is 13px. `-webkit-font-smoothing: antialiased`. Mono is `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace`.
- Easing: `--ease: cubic-bezier(.16,1,.3,1)` and `--spring: cubic-bezier(.34,1.56,.64,1)`.
- `*` uses `box-sizing: border-box`.
- Focus ring, used on every interactive element: `outline:none; box-shadow: 0 0 0 1px var(--accent), 0 0 0 4px var(--ring)`.
- `prefers-reduced-motion: reduce` sets every animation and transition duration to `.001ms` and turns off the skeleton shimmer.
- The theme is a prop (`navy` default | `dark` | `light`). It maps to the classes `.t-navy` / `.t-dark` / `.t-light` on the root.

---

## 0. Design tokens (identical on both boards unless noted)

| Token | navy (default) | dark ("Near-black") | light |
|---|---|---|---|
| --bg | #060B18 | #0B0B0F | #FAFAFB |
| --surface | #0C1326 | #121217 | #FFFFFF |
| --raised | #131C34 | #1A1A21 | #F3F3F6 |
| --hover | #1B2644 | #22222B | #EAEAEF |
| --line | #1C2845 | #24242E | #E4E4EA |
| --line-2 | #2B3A5E | #34343F | #D0D0D9 |
| --control | #5F6F96 | #6A6A7C | #8A8A9B |
| --text | #EAF0FF | #ECECF1 | #121217 |
| --text-2 | #A5B2D1 | #A3A3B1 | #55556A |
| --text-3 | #8794B6 | #8E8E9D | #5F5F70 |
| --accent | #2B67F5 | #2662EE | #1D4ED8 |
| --accent-h | #2F6DF6 | #2B67F5 | #2563EB |
| --accent-t | #8AB0FF | #7FA8FF | #1D4ED8 |
| --accent-s | rgba(43,103,245,.2) | rgba(38,98,238,.18) | rgba(29,78,216,.10) |
| --ring | rgba(90,150,255,.5) | rgba(79,140,255,.5) | rgba(29,78,216,.35) |
| --spark | #5BE0FF | #5BE0FF | #0891B2 |
| --low | #2DD4BF | #2DD4BF | #0F766E |
| --todo | #C4CBE0 | #C4C4D0 | #3E3E50 |
| --ok | #4ADE80 | #4ADE80 | #157A3A |
| --warn | #F5B73B | #F5B73B | #8A5A00 |
| --danger | #FF7A70 | #FF7A70 | #B92F26 |
| --info | #B79CFF | #B79CFF | #6B3FD4 |
| --orange | #FF9A4D | #FF9A4D | #A84A0A |
| --shadow-pop | 0 8px 24px rgba(0,0,0,.5) | 0 8px 24px rgba(0,0,0,.45) | 0 8px 24px rgba(18,18,23,.10) |
| --shadow-modal | 0 24px 64px rgba(0,0,0,.6) | 0 24px 64px rgba(0,0,0,.55) | 0 24px 64px rgba(18,18,23,.18) |
| --av-l / --av-c (avatar oklch L/C) | .40 / .10 | .40 / .10 | .90 / .06 |
| --pk-l / --pk-c (project-badge bg) | .32 / .07 | .32 / .06 | .93 / .04 |
| --pkt-l / --pkt-c (project-badge text) | .88 / .09 | .88 / .08 | .42 / .12 |
| --logo | #3B7BFF | #3B7BFF | #1D4ED8 |
| --scrim (board 18 only) | rgba(2,5,14,.55) | rgba(0,0,0,.55) | rgba(18,18,23,.28) |
| --danger-solid (board 20 only) | #C23A30 | #C23A30 | #B92F26 |

- Avatar background: `oklch(var(--av-l) var(--av-c) <hue>)`, with text in `var(--text)`.
- Project badge: background `oklch(var(--pk-l) var(--pk-c) <hue>)`, text `oklch(var(--pkt-l) var(--pkt-c) <hue>)`.
- Hues used:

  | Person / project | Hue |
  |---|---|
  | Alex Kim | 285 |
  | Jordan Lee | 200 |
  | Sam Patel | 20 |
  | Riley Chen | 150 |
  | Taylor Ng | 330 |
  | Morgan Diaz | 60 |
  | Platform Rebuild "PR" | 255 |
  | Workspace badge (board 20) | 255 |
- Shared `.kbd` key cap:
  - Box: `font: 500 11px/1 JetBrains Mono; min-width 18px; height 18px; padding 0 5px; border 1px solid var(--line-2); border-bottom-width 2px; radius 4px`.
  - Colors: background `var(--raised)`, text `var(--text-2)`.
- Skeleton shimmer:
  - Fill: `linear-gradient(90deg, var(--raised) 0%, var(--hover) 50%, var(--raised) 100%)` with `background-size: 200% 100%`.
  - Animation: background-position moves from 200% 0 to -200% 0 over 1.4s, linear, infinite.
  - Corner radius 6px.
- Fade-in: opacity 0→1. The class `.fade` runs it for 180ms with `--ease`.

**Gotchas:**
- Board 20's settings scrim hard-codes `rgba(2,5,14,.55)` for all themes.
- `.btn-danger:hover` uses a hard-coded `rgba(255,122,112,.18)` ring.
- Error input focus uses a hard-coded `rgba(255,122,112,.25)` ring.
- Map these to tokens if you want correct light-theme behaviour.

---

# PART A — Members & roles (board 18)

## A.1 Board / canvas
- Canvas size: 1440×4680, padding `64px 80px`, flex column with gap 36.
- Board header (presentation only):
  - Left side:
    - Lightex wordmark: 18px, weight 600, letter-spacing -.04em. Inline SVG; the "x" is a stroke mark in `--text` plus `--logo`.
    - Mono caption `SCREENS · MEMBERS & ROLES`: 12px, `--text-3`, letter-spacing .04em.
    - H1 "Members & roles": 48/54, weight 600, letter-spacing -.03em.
  - Right side, mono 12px `--text-3`, gap 16: `Workspace ⇄ Project` · `System roles locked` · `Esc closes` · `⌘S save`.
- Frame grid: 6 columns, gap 40. Each frame is a `<figure>`:
  - Figcaption: 14px weight 600, followed by a meta span (mono 11px weight 500, `--text-3`).
  - Device box `.dev`: `border 1px solid var(--line-2); border-radius 14px` (28 for mobile); `overflow hidden; background var(--bg)`.

| # | Frame label | Meta (verbatim) | Span / size | Config |
|---|---|---|---|---|
| 1 | Members & roles | interactive · switch scope, tabs, roles · role tweak | span 6, width 100% (=1280), h 860 | With app sidebar (264px, collapsible, role from prop). Initial selected role: ws=`qa`, prj=`captain`. Members tab. |
| 2 | Invite dialog | chips · validation · Esc closes | span 3 (~620w), h 580, compact | Invite dialog open. Chips: `priya@team.dev`, `sam@team.dev`, `jamie@team`. Role: member. |
| 3 | Delete role in use | reassign first · Delete enables after | span 3, h 580, compact | Roles tab, QA lead selected, delete dialog open |
| 4 | Locked system role | read-only toggles · duplicate | span 3, h 720, compact | Roles tab, Admin selected |
| 5 | Unsaved changes | sticky bar · ⌘S · switching role shakes | span 3, h 720, compact | Roles tab, QA lead with a draft: `r.export` removed, `p.sprints` added (2 changes) |
| 6 | Permission denied | member opens Roles | span 3, h 480, compact | role=member, Roles tab |
| 7 | Error | retry | span 3, h 480, compact | state=error |
| 8 | Loading | skeleton in final positions | span 3, h 480, compact | state=loading |
| 9 | Empty | new workspace | span 3, h 480, compact | Only the current user is a member |
| 10 | Mobile · members | 390 · cards | span 2, 390×800, r 28, narrow | Members as cards |
| 11 | Mobile · role editor | full-screen page | span 2, 390×800, r 28, narrow | Roles tab, QA lead, editor open |
| 12 | Mobile · invite | bottom sheet | span 2, 390×800, r 28, narrow | Invite open with chip `priya@team.dev` |

Prop `role` is `admin` (default), `member` or `viewer`. It drives frames 1 and 10 and the sidebar.

## A.2 App sidebar (frame 1 only; shared app-shell component)
The sidebar width is 264. In rail mode it is 64. The width animates with `transition: width 220ms var(--ease)`.

Container `.sbw`:
- Fill and edge: `background var(--surface)` with `border-right 1px solid var(--line)`.
- Stacking: `z-index 3`.

Top to bottom:

- **Workspace switcher.** Row padding `10px 10px 8px`, gap 4.
  - Button: 36px tall, padding 0 8px, radius 8, gap 9, font 600 13px. Hover/expanded background is `--hover`.
  - Contents: 24×24 logo tile (`--raised` background, 1px `--line-2` border, radius 6), then the name "Platform team", then a chevron-down.
  - Collapse icon button: 30×30, radius 7, color `--text-3`.
  - Collapse tooltip: "Collapse ⌘B". Tooltip box is padding 5×8, radius 6, `--raised` background, `--line-2` border, `--shadow-pop`, 12px/500. It appears after a 150ms delay.
  - Menu: absolute at top 48, left/right 10. Padding 4, radius 10, `--raised` background, `--shadow-pop`. Animation `sbpop` 160ms: translateY(-4px) scale(.98) → none.
  - Menu items (`menuitemradio`), each with an 18×18 badge:
    - PT "Platform team" (hue 255)
    - DG "Design guild" (300)
    - PE "Personal" (155)
  - The current item shows a check in `--accent-t`.
  - Admin-only items follow a separator: "Workspace settings", "Create workspace".
- **Search.**
  - Container margin 0 10.
  - Input: 34px tall, radius 9, padding `0 44px 0 32px`, `--bg` background, 1px `--line-2` border. Placeholder "Search or jump…", with a `⌘K` kbd.
  - Hover border: `--control`.
  - Focus: border `--accent` plus `0 0 0 3px var(--accent-s), 0 0 18px 2px var(--accent-s)`.
- **New task** (hidden for viewer).
  - Size and spacing: 32px tall, margin `8px 10px 4px`, radius 8.
  - Surface: `--raised` background, `--line-2` border.
  - Contents: "+" icon, text "New task", kbd `C`.
  - Active state: scale(.98).
- **Scroll list.** Padding `4px 10px 10px`.
  - Items are 30px tall, radius 7, gap 10, 13px/500, `--text-2`. Hover and `.on` use `--hover` background with `--text`.
  - Items:
    - "Inbox" with an unread pill showing 3 (1 for viewer). Pill: min-width 20, height 18, radius 9, `--accent-s` background, `--accent-t` text, mono 600 11px.
    - "My tasks" with count 7 (mono 11px `--text-3`).
  - Section header "Pinned views": mono 11px uppercase, letter-spacing .07em, 28px tall, margin-top 14. The chevron rotates -90deg when collapsed.
    - "My open bugs" 4
    - "Due this week" 9
    - "Blocked" 2
  - Section "Projects" with a count. The "+" (New project) button is admin only.
  - Projects, each with an 18×18 oklch badge (radius 5, mono 600 9px) and a chevron:
    - PR Platform Rebuild
    - MO Mobile App
    - IN Infra
    - DS Design System
    - AP Public API
  - Sub-list under the expanded project:
    - Indented with margin-left 16 and padding-left 10, plus a 1px `--line` left border.
    - Sub-items: Board, Backlog, Sprints, Objectives, Milestones, Reports.
    - The active indicator `.sb-ind` slides with `--spring` 220ms.
    - Viewers see only Board, Backlog, Objectives and Milestones.
  - In frame 1, `sub: 'none'` means no sub-item is active.
- **Footer.** Padding `8px 10px 10px`, top border `--line`.
  - Sprint card: padding 9×10, radius 10, `--bg` background, `--line` border. Hover lifts 1px.
    - Ring: 30×30 progress ring, r 11.5, stroke 3.5, `--accent-t` on `--raised`, dasharray 72.3, 65%.
    - Text: "Sprint 14" (600 13/16) and mono "65% · 7d left".
  - "Members & roles" link (admin only) and "Settings" link with `⌘,`.
  - "?" shortcuts button, tooltip "Shortcuts ?".
  - Profile button: 30px avatar "AK" with presence dot (9px, `--ok`, ring 2px `--surface`).
    - Name "Alex Kim".
    - Subline 11px `--text-3`: "{Role} · Platform team".
  - Account menu opens upward. It shows "Alex Kim" / "alex@team.dev", then "Profile" (kbd `G P`), "Preferences", separator, "Sign out".
- **Rail mode** (64px): icon buttons 40×36 with tooltips to the right.
  - Unread dot: 7px `--accent-t`.
  - Separators: 28×1.
  - "Expand ⌘B" button.
- Hidden below 760px.

## A.3 Screen shell `.mm`
- Root: flex column, `--bg`, overflow hidden. The scroll area `.mm-scroll` has `overflow: auto`.
- Content wrapper `.mm-wrap`: `max-width 980px; margin 0 auto; padding 26px 32px 104px`, flex column with gap 16.
  - `.compact` (the 620px frames): padding `20px 20px 96px`.
  - `.narrow` / ≤760px: padding `14px 16px 96px`, gap 14.
- Mobile top bar `.mm-mtop` (narrow only): 52px tall, padding 0 8, bottom border `--line`. Contains a hamburger icon button ("Open navigation") and the title "Members & roles" (weight 600).

### Header row `.mm-head`
Flex row, gap 16, wraps.

- **H1** "Members & roles":
  - Type: 20px/28px, weight 600, letter-spacing -.015em, nowrap.
  - Compact: 18px. Hidden on narrow screens (the top bar shows the title instead).
- **Scope segmented control** `.mm-seg` (role=group, aria-label "Scope"):
  - Container: width 380 (100% on narrow), padding 3, radius 9, `--raised` background, 1px `--line` border. Two equal columns.
  - Buttons: 28px tall (36 on narrow), padding 0 10, gap 7, font 500 12px, `--text-2`. The pressed button uses `--text`.
  - Thumb `.mm-thumb`: absolute at left/top/bottom 3, width `calc(50% - 3px)`, radius 6, `--hover` background, `box-shadow: inset 0 0 0 1px var(--line-2)`. Moves with `transform: translateX(0%|100%)` over 220ms `--spring`.
  - Button 1: "Workspace".
  - Button 2: a 16×16 project badge "PR", then "Project: Platform Rebuild".
    - Badge style: radius 4, mono 600 8.5px, hue 255.
    - "Project: " is hidden on narrow screens, which leaves "Platform Rebuild".
- **Switching scope** resets the role filter, the search, the open editor and the name error.
  - If the role editor has unsaved changes, the click is blocked and the unsaved bar shakes.

### Tabs `.mm-tabs`
- Container: width 216 (100% on narrow), bottom border `--line`, role=tablist.
- Tab: `flex 1; height 36` (42 on narrow); font 500 13px; `--text-2`; radius `6px 6px 0 0`.
  - Hover: `--hover` background with `--text`.
  - Selected: `--text`.
- Labels:
  - "Members" + count (mono 500 11px `--text-3`).
  - "Roles" + count. For non-admins there is a 12px lock icon before "Roles".
- Indicator `.mm-ind`: absolute at the bottom (-1px), width 50%, 2px tall, `--accent`, radius 2. Moves with translateX(0|100%) over 220ms `--spring`.
- Counts:
  - Workspace: Members 8 (includes 2 invited), Roles 6.
  - Project: Members 7, Roles 4.
- Switching to Members while the role editor is dirty is blocked and shakes the bar.

## A.4 Members tab

### Toolbar `.mm-tools`
Flex row, gap 8, wraps.

- **Search** `.mm-search`:
  - Width 240 (180 compact; flex 1 on narrow).
  - Input: 32px tall (40 narrow), padding `0 10px 0 31px`, radius 8, 1px `--line-2` border, `--surface` background, 13px.
  - Search icon: 14px at left 10, `--text-3`.
  - Placeholder and aria: "Search members". Max length 80.
  - Focus: `--accent` border plus `0 0 0 3px var(--accent-s)`.
  - Matching is case-insensitive on name, and substring on email.
- **Role filter chip** `.mm-chip`:
  - Box: 32px tall (40 narrow), padding 0 10, radius 8, 1px `--line-2` border, `--surface` background. Font 500 12.5px, gap 7.
  - Icon: 13px funnel in `--text-3`.
  - Label: "All roles" or the selected role's name.
  - Hover/expanded: `--control` border with `--hover` background.
  - Menu `.mm-menu` (listbox "Filter by role") at top 38:
    - Box: min-width 200, padding 4, radius 10, `--raised` background, `--line-2` border, `--shadow-pop`.
    - Animation `mmmenu` 150ms: translateY(-4px) scale(.98) → none.
    - Options: "All roles" (total), then every role with its member count.
    - Option style: 30px tall, radius 6, 500 13px. The selected option has an `--accent-s` background.
- A spacer pushes the remaining items right.
- **Non-admin:** shows the tag "Read-only".
  - Tag box `.mm-tag`: 22px tall, padding 0 8, radius 6, 1px `--line-2` border.
  - Tag text: mono 500 11px, `--text-3`.
- **Admin:** shows the primary button "+ Invite".
  - `.mm-btn.pri`: 30px tall (40 on narrow), padding 0 11, radius 7, font 500 12.5px, gap 7, `--accent` background, white text.
  - Hover: `--accent-h` background plus `0 0 0 4px var(--accent-s)`.
  - Active: scale(.97).
  - The "+" icon is 12px with stroke 1.8.

### Member table `.mm-tbl` (role=table, aria-label "Members")
- Container: 1px `--line` border, radius 10, `--surface` background.
- **Row grid** `.mm-tr`:
  - Columns: `minmax(0,1.5fr) minmax(0,1.3fr) 150px 92px 92px 32px`, areas `who email role status last menu`.
  - Spacing: column-gap 12, min-height 52, padding `0 10px 0 14px`, bottom border `--line` (none on the last row).
  - Hover: `--hover` background.
- **Header row** `.mm-th`: min-height 34, mono 500 11px, uppercase, letter-spacing .05em, `--text-3`.
  - Columns: **Name | Email | Role | Status | Last active | (menu)**.
  - In Project scope the third header reads **"Project role"**.
- **Cells:**
  - **Name** (`c-who`, gap 10):
    - Avatar: 28×28 circle, 600 10.5px, oklch background.
    - Name: weight 500. Your own row adds a "You" badge: mono 500 10.5px, padding 3×5, radius 4, `--raised` background, `--text-3`.
    - Under the name, `.c-em2` (12px `--text-3`) shows the email. It is visible only in compact and narrow layouts.
  - **Email**: `--text-2`, ellipsis.
  - **Role**: editable role picker `.mm-rp`:
    - Button: 28px tall (32 narrow), padding `0 6px 0 8px`, margin-left -8, radius 6, transparent 1px border, 500 13px. Content is the role name plus a 12px chevron-down in `--text-3`.
    - Hover/expanded: `--line-2` border with `--raised` background.
    - Popover listbox "Role" at top 32 / left -8: lists assignable roles, and the current one has a 14px check in `--accent-t`.
    - The role is shown as static text (`.mm-rs`, `--text-2`) when the viewer is not an admin, when the row is yourself, or when the row's role is Owner.
  - **Status** pill `.mm-st`:
    - Shape: 22px tall, padding 0 8, radius 11, 12px/500, with a 6px dot in currentColor.
    - "Active": `color var(--ok); background color-mix(in srgb, var(--ok) 12%, transparent)`.
    - "Invited": the same pattern with `--warn`.
  - **Last active**: 12px `--text-3`, nowrap. Values: "Now", "12m ago", "2h ago", "Yesterday", "5h ago", "3d ago". Invited rows show "—".
  - **Menu**:
    - `.mm-ib` "…" button: 30×30 (24 when `.sm`, 40 narrow), radius 7.
    - Present only when the role is pickable (admin, not yourself, not Owner).
    - Menu at top 34 / right 0, role=menu.
    - Active member: "Change role" · separator · "**Remove from workspace**" (in Project scope: "**Remove from project**"), in `--danger`.
    - Invited row: "Change role" · "Resend invite" · separator · "Revoke invite" (danger).
- **Invited rows** in the table (`.is-inv`):
  - Name shows the email, in `--text-2` weight 400.
  - The email column shows "Invited {sent}", e.g. "Invited Oct 5".
  - Avatar `.mm-av.inv`: transparent fill, `1.5px dashed var(--control)` border, `--text-3` text, 10px initials (first two letters of the email, e.g. "CA", "DE").
- A click-catcher overlay (`.mm-catch`, absolute inset 0, z 15) closes any open menu. Esc also closes menus.

### Seed data — Workspace scope ("Platform team")

| Name | Initials | Email | Role | Status | Last active |
|---|---|---|---|---|---|
| Alex Kim (You) | AK | alex@team.dev | Owner | Active | Now |
| Jordan Lee | JL | jordan@team.dev | Admin | Active | 12m ago |
| Sam Patel | SP | sam@team.dev | Member | Active | 2h ago |
| Riley Chen | RC | riley@team.dev | Member | Active | Yesterday |
| Taylor Ng | TN | taylor@team.dev | QA lead | Active | 5h ago |
| Morgan Diaz | MD | morgan@team.dev | Guest | Active | 3d ago |
| (invite) | CA | casey@team.dev | Member | Invited | sent Oct 5 |
| (invite) | DE | devon@team.dev | Guest | Invited | sent Sep 30 |

### Seed data — Project scope ("Platform Rebuild")

| Name | Email | Project role | Status | Last |
|---|---|---|---|---|
| Alex Kim (You) | alex@team.dev | Project admin | Active | Now |
| Jordan Lee | jordan@team.dev | Project admin | Active | 12m ago |
| Sam Patel | sam@team.dev | Contributor | Active | 2h ago |
| Riley Chen | riley@team.dev | Contributor | Active | Yesterday |
| Taylor Ng | taylor@team.dev | Release captain | Active | 5h ago |
| Morgan Diaz | morgan@team.dev | Observer | Active | 3d ago |
| (invite) CA | casey@team.dev | Contributor | Invited | sent Oct 6 |

### Pending invitations section (admin only, when invites exist)
- Section header `.mm-sh`: margin-top 10, gap 8. Contains h2 "Pending invitations" (14px/600) and a mono count (`--text-3`).
- The rows sit in a `.mm-tbl` card. Row `.mm-ivr`: flex, gap 12, min-height 48, padding `0 10px 0 14px`, bottom border.
- Each row contains, in order:
  - Dashed invite avatar.
  - Email (flex 1, ellipsis).
  - Role name (`--text-2`).
  - Sent date (mono 12px `--text-3`, width 76): "Oct 5", "Sep 30".
  - Right-aligned actions: ghost `.mm-btn` "Resend" and `.mm-btn.dngt` "Revoke" (text `--danger`).
- After Resend, the button is replaced for 2.2s by the status "✓ Sent" (`.mm-ok`: 12px/500 `--ok`, padding 0 11, height 30, fades in over 160ms). Resend creates no toast.
- Revoke removes the row. Toast: "Invite to {email} revoked", with Undo.
- On narrow screens rows wrap (padding 10×12, row-gap 4) and the email takes `calc(100% - 44px)`.

### Empty / no-match / loading / error states
- **No match**: dashed box `.mm-state.sm` (padding 22×16, `1px dashed var(--line-2)`, radius 10). Contains bold "No members match" (14/600) and a secondary button "Clear filters", which resets q and rf.
  - `.mm-btn.sec`: `--raised` background with `--line-2` border, `--text`. Hover: `--hover` background, `--control` border.
- **Just you** (Empty frame; only one member exists):
  - Box `.mm-state`: padding 36×16, dashed, centered, gap 8.
  - Icon tile: 40×40 radius 10, `--raised` background, `--line-2` border, user-plus icon.
  - Text: "**Just you so far**" and the meta line "Invite teammates to Platform team" (in project scope: "…to Platform Rebuild").
  - The table still shows your own row above the box, and the Invite button is still present.
- **Loading** (role=status "Loading members"):
  - Toolbar skeletons: 220×32, 104×32, a spacer, 84×30.
  - A real table header followed by 6 skeleton rows. Each row has:
    - 28px circle
    - Name bar (widths 120 / 96 / 132 / 104 / 118 / 90 × 12)
    - Email bar (150 / 170 / 140 / 160 / 130 / 150 × 12)
    - Role bar 76×12
    - Status 58×20 (radius 10)
    - Last 52×12
- **Error** (`.mm-state`, role=alert):
  - Icon: warning triangle on the icon tile, colored `--danger`.
  - Bold "Couldn’t load members".
  - Mono meta "503 · retrying won’t lose changes".
  - Secondary button "Retry" (margin-top 6). It shows loading for 900ms, then ready.

## A.5 Roles tab (admin only)
- Layout `.mm-roles`: grid `220px minmax(0,1fr)`, gap 20, align start.
  - Compact: `168px 1fr`, gap 14.
  - Narrow: a single column. The list and the editor are separate pages: `.ed-open` hides the list, otherwise the editor is hidden.

### Role list (nav "Roles")
- Group heading `.mm-rh`: mono 500 11px, uppercase, letter-spacing .06em, `--text-3`, padding `10px 8px 6px` (the first one has top padding 2).
  - **"System"** heading: each item shows a 12px lock icon (aria-label "Locked", `--text-3`), the name and a mono count.
  - **"Custom"** heading: each item shows an 8×8 hollow square (radius 3, `1.5px solid var(--accent-t)`), the name and a count.
- Item `.mm-ri`: 34px tall (48 narrow, with a bottom border and no radius), padding 0 8, radius 7, gap 9, 500 13px, `--text-2`.
  - Hover: `--hover`.
  - Selected `.on`: `--accent-s` background with `--text` (transparent on narrow).
- On narrow screens a 14px chevron-right appears on each item.
- Picking another role while dirty is blocked and shakes the bar.

### System vs custom roles (defaults)

**Workspace scope**

| Role | id | System? | Description (verbatim) | Default members |
|---|---|---|---|---|
| Owner | owner | System (locked) | Full control, including billing | 1 |
| Admin | admin | System | Manage members, roles and settings | 1 |
| Member | member | System | Create and edit work | 3 (incl. 1 invite) |
| Guest | guest | System | Invited projects only | 2 (incl. 1 invite) |
| QA lead | qa | Custom | Triage and verify bugs | 1 |
| Contractor | contractor | Custom | Time-boxed project access | 0 |

**Project scope**

| Role | id | System? | Description | Default members |
|---|---|---|---|---|
| Project admin | padmin | System | Manage the project and its roles | 2 |
| Contributor | contrib | System | Create and edit tasks | 3 (incl. 1 invite) |
| Observer | observer | System | Read and comment | 1 |
| Release captain | captain | Custom | Owns release checklists | 1 |

**Owner is never assignable.** It is excluded from the role pickers, the invite role list and the delete reassign list. An Owner's row has no menu.

### Permission catalogue (exact ids, groups, labels, descriptions, scope)
Groups render in this order: **Tasks, Planning, Collaboration, Reports, Administration**. `sc` controls visibility:
- `both`: shown in Workspace and Project scope.
- `ws`: Workspace only.
- `prj`: Project only.

| Group | id | Label | Description | Scope |
|---|---|---|---|---|
| Tasks | t.create | Create tasks | Add tasks to any board | both |
| Tasks | t.edit | Edit any task | Change fields on others’ tasks | both |
| Tasks | t.delete | Delete tasks | Remove tasks permanently | both |
| Tasks | t.comment | Comment | Reply and mention teammates | both |
| Planning | p.sprints | Manage sprints | Start, close and plan sprints | both |
| Planning | p.miles | Edit milestones | Move dates and epics | both |
| Planning | p.obj | Set objectives | Create and score objectives | both |
| Collaboration | c.invite | Invite members | Send invitations by email | both |
| Collaboration | c.share | Share links | Create public view links | both |
| Collaboration | c.views | Manage shared views | Edit team saved views | both |
| Reports | r.view | View reports | Velocity, burndown, cycle time | both |
| Reports | r.export | Export data | Download CSV exports | both |
| Administration | a.roles | Manage roles | Create and edit roles | both |
| Administration | a.wset | Workspace settings | Integrations, security, SSO | ws |
| Administration | a.billing | Billing | Plans, invoices and seats | ws |
| Administration | a.pset | Project settings | Workflow, fields, task key | prj |
| Administration | a.archive | Archive project | Close out finished projects | prj |

Each scope therefore shows 15 permissions:
- Workspace: Tasks 4, Planning 3, Collaboration 3, Reports 2, Administration 3 (`a.roles`, `a.wset`, `a.billing`).
- Project: the same groups, with Administration = `a.roles`, `a.pset`, `a.archive`.

### Default permission matrix — Workspace (✓ = granted)

| Permission | Owner | Admin | Member | Guest | QA lead | Contractor |
|---|---|---|---|---|---|---|
| t.create Create tasks | ✓ | ✓ | ✓ | | ✓ | ✓ |
| t.edit Edit any task | ✓ | ✓ | ✓ | | ✓ | |
| t.delete Delete tasks | ✓ | ✓ | | | | |
| t.comment Comment | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| p.sprints Manage sprints | ✓ | ✓ | ✓ | | | |
| p.miles Edit milestones | ✓ | ✓ | ✓ | | | |
| p.obj Set objectives | ✓ | ✓ | ✓ | | | |
| c.invite Invite members | ✓ | ✓ | | | | |
| c.share Share links | ✓ | ✓ | ✓ | | | |
| c.views Manage shared views | ✓ | ✓ | ✓ | | ✓ | |
| r.view View reports | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| r.export Export data | ✓ | ✓ | ✓ | | ✓ | |
| a.roles Manage roles | ✓ | ✓ | | | | |
| a.wset Workspace settings | ✓ | ✓ | | | | |
| a.billing Billing | ✓ | | | | | |
| **Total (of 15)** | 15 | 14 | 10 | 2 | 6 | 3 |

### Default permission matrix — Project

| Permission | Project admin | Contributor | Observer | Release captain |
|---|---|---|---|---|
| t.create | ✓ | ✓ | | ✓ |
| t.edit | ✓ | ✓ | | ✓ |
| t.delete | ✓ | | | |
| t.comment | ✓ | ✓ | ✓ | ✓ |
| p.sprints | ✓ | ✓ | | ✓ |
| p.miles | ✓ | ✓ | | ✓ |
| p.obj | ✓ | | | |
| c.invite | ✓ | | | |
| c.share | ✓ | ✓ | | |
| c.views | ✓ | | | |
| r.view | ✓ | ✓ | ✓ | ✓ |
| r.export | ✓ | | | ✓ |
| a.roles | ✓ | | | |
| a.pset Project settings | ✓ | | | |
| a.archive Archive project | ✓ | | | |
| **Total (of 15)** | 15 | 7 | 2 | 7 |

### Role editor `.mm-editor`
- Card: 1px `--line` border, radius 12, `--surface` background, padding `18px 18px 8px`, flex column with gap 12.
  - Narrow: no border, no background, no padding.
- **Header** `.mm-edh` (flex, gap 8). On narrow it starts with a back button (16px chevron-left, margin-left -10, "Back to roles"), which is guarded by the dirty check.
  - **System role (locked):**
    - h2 with the name: 17px/24px, 600, letter-spacing -.01em, ellipsis.
    - Tag `.mm-tag` with an 11px lock icon and the text "System".
  - **Custom role:** the name is an inline editable input `.mm-nin` (aria "Role name", maxlength 40).
    - Box: `font 600 17px/24px`, transparent 1px border, radius 7, padding 3×8, margin-left -9.
    - Hover: `--hover` background.
    - Focus: `--accent` border, 3px `--accent-s` ring, `--bg` background.
  - **"Duplicate"** button (`.mm-btn.sec`, title "Duplicate role", 13px copy icon). The text label is hidden on narrow screens.
  - **Delete** icon button (custom roles only): `.mm-ib.dng`, 15px trash icon, aria/title "Delete role". Hover color is `--danger`.
- **Name error** (`.mm-err`, 12px `--danger`, role=alert): "Name is required" or "A role with this name exists". Name uniqueness is case-insensitive within the scope.
- **Description:**
  - Locked roles: a paragraph `.mm-desc` (`--text-2`, line-height 20).
  - Custom roles: an input `.mm-din` (maxlength 80, placeholder "Short description", 400 13px/20px, `--text-2`), with the same inline-edit styling.
- **Members row** `.mm-mrow`:
  - Button `.mm-cntb`: 28px tall, 500 12.5px, `--text-2`.
    - Contents: an avatar stack of up to 4 members holding this role (20px avatars, overlap -5px, 2px `--surface` ring), then "1 member" / "N members".
    - Clicking switches to the Members tab filtered to this role (guarded when dirty).
  - Followed by mono meta "· {n} of 15 permissions" (e.g. "· 6 of 15 permissions").
- **Lock bar** (system roles only) `.mm-lockbar`:
  - Box: padding `9px 10px 9px 12px`, radius 8, `--raised` background, `--line-2` border.
  - Content: 14px lock icon and the text "**System role · duplicate to customize**" (12.5px, `--text-2`).
- **Permission groups** `.mm-grp`: top border `--line`, padding-top 10.
  - Group header: h3 (12.5px/600) plus a mono count "onN/total" (e.g. "4/4").
  - Each permission row `.mm-pr` is a `<label>`:
    - Grid: `1fr auto auto`, gap 10, min-height 44 (52 narrow), padding 4×8, margin 0 -8, radius 8, pointer cursor.
    - Hover and focus-within: `--hover` background.
    - Text block:
      - Label `.mm-pn`: weight 500.
      - Description `.mm-pd`: 12px `--text-3`, ellipsis.
    - Locked roles: the row is `.lck` (default cursor, no hover background), a 12px lock icon in `--text-3` appears before the toggle, and the toggle is disabled (opacity .5).
    - Changed since save (`.chg`): a 6px `--accent-t` dot appears after the label (`::after`).
  - **Toggle switch** `.tg` (checkbox, role=switch):
    - Track: 32×18, radius 9, 1px `--control` border, `--raised` background.
    - Knob: 12×12 circle at 2,2, `--text-2`.
    - Checked: track `--accent` background and border; knob is #fff and moves translateX(14px) over 180ms `--spring`.
    - Colors transition over 150ms.
- **Duplicate** creates a custom role named "Copy of {name}" (or "Copy of {name} 2", "3"…). It copies the description and permissions, then selects the copy. Toast: "Created Copy of …".
- **Delete:**
  - With 0 members: deletes immediately. Toast "Deleted {name}", with Undo.
  - With members: opens the delete dialog (A.7).

### Unsaved changes bar `.mm-bar` (Roles tab, when a draft differs)
- Position: absolute, bottom 16 (12 narrow), centered, width 500 (max `100% - 24px`), z 12.
- Box: padding `7px 7px 7px 14px`, radius 12, `--raised` background, `--line-2` border, `--shadow-pop`, gap 8.
- Content:
  - 8px `--warn` dot.
  - "Unsaved changes" (weight 500) and a mono count, e.g. "2".
  - Ghost "Discard".
  - Primary "Save" with a `⌘S` kbd, hidden on narrow. The kbd inside a primary button is styled `rgba(255,255,255,.16)` background, `rgba(255,255,255,.3)` border, white text.
- The change count is: toggled permissions, plus 1 if the name changed, plus 1 if the description changed.
- Enter animation `mmbar` 260ms `--spring`: from opacity 0 and translate(-50%, 28px).
- **Shake** (360ms `--ease`) whenever a guarded navigation is attempted while dirty:
  - Guarded actions: switch role, switch tab, switch scope, Duplicate, Back, the member-count button.
  - Keyframes: x offsets -7, +6, -4, +2 px. Two identical keyframe sets (`shk0`/`shk1`) alternate so the animation restarts each time.
- ⌘S / Ctrl+S saves when on Roles and dirty.
- On save, the name is trimmed to 40 and the description to 80. Toast: "Saved {name}", with Undo.

### Toast `.mm-toast`
- Position: absolute, bottom 16, or 72 when the unsaved bar is visible (`.up`). Centered, width 400, z 13.
- Box: padding `8px 8px 8px 14px`, radius 10, `--raised` background, `--line-2` border, `--shadow-pop`, gap 10.
- Content:
  - 14px check icon in `--ok`.
  - Single-line text with ellipsis.
  - Optional secondary "Undo" (26px tall).
  - Dismiss "×" (24×24).
- Animation `mmtoast` 200ms: from translate(-50%, 10px) and opacity 0.
- Auto-dismisses after 5s.
- Undo restores the entire previous data snapshot.
- Toast copy (verbatim templates):
  - "Saved {name}"
  - "Created {name}"
  - "Deleted {name}"
  - "{Role} deleted · {n} moved to {Role}"
  - "{name or email} is now {Role}"
  - "Removed {name}"
  - "Invite to {email} revoked"
  - "Invite sent to {email}"
  - "{n} invitations sent"

### Permission denied (non-admin on the Roles tab) `.mm-deny`
- Card: padding 48×16, centered, 1px `--line` border, radius 12, `--surface` background, gap 8.
- Content:
  - Lock icon tile.
  - h2 "You can’t manage roles" (16px/600).
  - Meta "Admins only · you’re a member". The role label is lowercase, taken from the prop: member / viewer.
  - Primary "Request access" (margin-top 8). After clicking, it is replaced by "✓ Requested · Jordan Lee notified" (`--ok`, margin-top 14).
- Non-admins also see a lock icon on the Roles tab, the "Read-only" tag, static role text, no row menus and no Pending section.

## A.6 Invite dialog (modal; bottom sheet on mobile)
- **Scrim** `.mm-scrim`: absolute inset 0, z 30, `var(--scrim)` with `backdrop-filter: blur(6px)`. Fades in over 200ms. Clicking it closes the dialog.
- **Wrapper:** z 31, centered, padding 16.
- **Dialog** `.mm-dlg` (role=dialog, aria-modal):
  - Box: width 460, `--surface` background, 1px `--line-2` border, radius 14, `--shadow-modal`, padding `18px 20px 16px`, flex column with gap 10.
  - Animation `mmdlg` 220ms: from translateY(8px) scale(.98).
- **Header:** h2 "Invite to Platform team" (Project scope: "Invite to Platform Rebuild"), 16px/22px, 600, -.01em. Close × button (title "Close (Esc)").
- **Field label** `.mm-fl` (12px/500 `--text-2`, margin-top 4): "Emails".
- **Chip box** `.mm-chipbox`:
  - Box: flex-wrap, gap 6, min-height 42, padding 6, 1px `--line-2` border, radius 8, `--bg` background, text cursor.
  - Focus-within: `--accent` border plus 3px `--accent-s` ring.
  - When any chip is invalid (`.bad`) and the box is not focused, the border is `--danger`.
  - **Email chip** `.mm-ec`: 26px tall, padding `0 3px 0 8px`, radius 6, `--raised` background, `--line-2` border, 12.5px/500. Pops in with `mmmenu` 140ms.
    - × remove button: 20×20 with a 9px icon, opacity .75 (1 on hover, with `--hover` background).
    - Invalid (`.bad`): `--danger` border and text, transparent background. Title "Invalid email".
    - Duplicate / already a member (`.dup`): dashed border, `--text-3`, line-through. Title "Already a member".
  - **Text input** `.mm-ein`: flex 1, min-width 140, 28px tall, no border, 13px. Autofocused.
    - Placeholder "name@team.dev, …" (only when there are no chips).
- **Chip entry rules:**
  - Typing a space, comma or semicolon splits the text into chips.
  - Enter or Tab with text adds a chip.
  - Enter with empty text sends.
  - Backspace on empty text removes the last chip.
  - Blur adds the pending text as a chip.
  - Chips are lowercased and trimmed; duplicates within the box are ignored.
  - Limits: max 20 chips, 120 chars each.
  - Validation regex: `/^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/i`.
- **Message** `.mm-msg` (12px/16px, role=alert):
  - Error (`--danger`): "“jamie@team” isn’t a valid email", or "{n} invalid emails".
  - Otherwise a note (`--text-3`): "sam@team.dev already in Platform team · skipped" (comma-joined list).
- **Field label "Role"** and a select button `.mm-sel`:
  - Box: 38px tall, padding `0 10px 0 12px`, radius 8, `--line-2` border, `--bg` background, 500 13px, gap 10. Hover: `--control` border.
  - Contents: role name, then the role description as meta (12px `--text-3`), then a chevron.
  - Listbox at top 42 spanning full width: each assignable role with its description on the right.
  - Default role: Workspace → **Member** ("Create and edit work"); Project → **Contributor**.
  - Options: every role except Owner, custom roles included.
- **Footer** `.mm-df`: margin-top 8, padding-top 12, top border `--line`, gap 8.
  - Left hint (meta, flex 1, hidden on narrow):
    - "Fix invalid emails to send" when any chip is invalid.
    - "Enter or comma adds an email" when there are no valid chips.
    - Otherwise empty.
  - Ghost "Cancel".
  - Primary "Send invite", or "Send {n} invites" when there is more than one valid chip.
    - Disabled (opacity .45, not-allowed) when there are no valid chips or any invalid chip.
- **On send**, new rows are added:
  - Status `invited`, sent "Oct 7", initials = first 2 letters of the email.
  - Duplicates are skipped.
- Esc closes the open role menu first, then the dialog.
- Frame 2 state:
  - Chips: priya (valid), sam (dup), jamie@team (invalid).
  - Message: error "“jamie@team” isn’t a valid email".
  - Hint: "Fix invalid emails to send". Button: "Send invite", disabled.
- **Mobile bottom sheet** (narrow / ≤760):
  - Wrapper aligns to flex-end with no padding.
  - Dialog: width 100%, radius `18px 18px 0 0`, no bottom border, padding `10px 16px 20px`.
  - Animation `mmsheet` 280ms: from translateY(100%).
  - Grab handle `::before`: 36×4, radius 2, `--line-2`, centered, margin-bottom 6.
  - Footer buttons are 44px tall with flex 1.

## A.7 Delete role in use dialog (alertdialog)
- Same dialog shell. The close button is autofocused.
- Title: "Delete “QA lead”?" (curly quotes).
- **Warning box** `.mm-warn`:
  - Box: padding 9×12, radius 8.
  - Colors: background `color-mix(in srgb, var(--danger) 10%, transparent)`, border `1px solid color-mix(in srgb, var(--danger) 35%, transparent)`.
  - Content: 15px triangle icon in `--danger` and the text "In use by 1 member. Reassign before deleting." (plural "members").
- **Affected row** `.mm-aff` (12.5px `--text-2`): an avatar stack of up to 5, then names (up to 3 comma-joined, then " +N"), e.g. "Taylor Ng".
- **Label "Reassign to"** and a `.mm-sel`:
  - Placeholder "Choose a role" in `--text-3` weight 400.
  - Options: all roles except this one and Owner, each with a count. For QA lead in the workspace: Admin 1, Member 3, Guest 2, Contractor 0.
- **Footer:**
  - Hint: "Pick a role to enable Delete", or "1 → Member".
  - Ghost "Cancel".
  - Button "Delete role" (`.mm-btn.dngf`: `--danger` background, `--bg` text, weight 600). Disabled until a role is chosen.
- **Confirm:**
  - Removes the role and moves the affected members to the chosen role, then selects that role.
  - Toast: "QA lead deleted · 1 moved to Member", with Undo.

## A.8 Responsive behaviour
- **Compact (~620px frame):**
  - Table columns become `minmax(0,1fr) 124px 80px 32px` with areas `who role status menu`.
  - The Email and Last active columns are hidden; the email shows under the name.
  - H1 is 18px. Search is 180px wide.
- **Narrow (390 / ≤760px):**
  - The sidebar is hidden and the mobile top bar is shown.
  - The table header is hidden and the table becomes a stack of **cards** (gap 8):
    - Card padding `12px 8px 12px 12px`, 1px `--line` border, radius 12, `--surface` background.
    - Grid `auto auto 1fr 40px` with areas `"who who who menu" "role status last last"`, row-gap 10, column-gap 8.
    - Role is indented 46px. Last active is right-aligned.
    - Icon buttons are 40×40.
  - Tools: the search grows to fill; controls are 40px tall.
  - Roles become a list page and the editor a full-screen page with a back button. Permission rows are 52px tall.
  - Dialogs become bottom sheets.

## A.9 Keyboard
- Esc closes the open menu.
- In dialogs, Esc closes the inner menu first, then the dialog.
- ⌘S / Ctrl+S saves the role draft.
- Enter in the invite input adds a chip or sends.

## A.10 Backend implications (Members & roles)
- **Two scopes with independent role sets and memberships:**
  - Workspace members and roles.
  - Project members and project roles. The project role column is labelled "Project role".
- **Permission catalogue:** a static list of 17 keys, each with a `scope` attribute (`both` / `ws` / `prj`). Store role permissions as an array of keys.
- **Role model:** `{id, name (≤40, unique case-insensitive per scope), desc (≤80), sys: boolean, perms: string[]}`.
  - System roles are immutable: no rename, no permission edits, no delete. They can only be duplicated.
  - Owner exists but cannot be assigned through the UI. Transfer of ownership is **not designed**; there is no transfer flow on either board.
- **Member model:** `{id, name, initials, avatarHue, email, role, status: 'active'|'invited', lastActive, sentAt (invites), isYou}`.
- **Endpoints implied:**
  - list members (with search/filter)
  - change role
  - remove member (workspace vs project wording)
  - create invites in bulk with a role
  - resend invite
  - revoke invite
  - list/create/update/duplicate/delete roles
  - delete-with-reassign, done atomically
  - request admin access (notifies an admin; Jordan Lee in the mock)
- **Server-side rules:**
  - You cannot change your own role or remove yourself from this table.
  - The Owner's row is not editable.
  - Invite duplicates are detected against existing members and invites.
- **Undo:** every mutation shows an Undo toast for 5s. Implement either as an optimistic delay or as reversible API calls.
- **Error state:** the design shows "503 · retrying won’t lose changes".

---

# PART B — Profile & workspace settings (board 20)

## B.1 Board / canvas
- Canvas size: 1440×3440, padding 64/80, gap 36.
- Board header:
  - Mono caption "SCREENS · SETTINGS".
  - H1 "Settings" (48/54, 600, -.03em).
  - Right side, mono: `Profile` · `Workspace` · `Danger zone` · `owner / viewer`.
- Grid: 3 columns, gap 40, align-items start. Each column is about 400px wide.
- Each frame's device box has its own theme class (the Profile frame's theme tiles retheme that frame). It transitions background and color over 250ms.

| Id | Label | Meta (verbatim) | Grid position | Size | Config |
|---|---|---|---|---|---|
| P | Profile | theme tiles switch this frame · try the password | col 1/4, row 1 | 1280×900 | page profile, owner |
| W | Workspace | try “Design Guild” or “design-guild” | col 1/3, row 2 | 840×600 | page workspace, owner |
| L | Loading | skeleton | col 3, row 2 | 400×600 | narrow, phase loading |
| D | Danger zone | type the slug to unlock | col 1/3, row 3 | 840×600 | page danger, owner |
| X | Save failed | Retry works | col 3, row 3 | 400×600 | narrow, workspace, init wsName "Platform team HQ", saveState error |
| V | Viewer / non-owner | read-only · danger zone hidden | col 1/3, row 4 | 840×520 | workspace, role viewer, person Taylor Ng (TN, hue 330, taylor@team.dev) |
| M | Mobile | 390 · back opens menu | col 3, row 4 | 390×844, r 28 | narrow + touch, page profile |

The default person is Alex Kim, alex@team.dev, AK, hue 285, role Owner.

## B.2 Settings shell
### Settings nav `.st-nav` (wide layouts only)
- Box: width 220, flex none, right border `--line`, `--surface` background, padding `16px 10px 10px`, flex column with gap 2.
- **Back link** `.st-back`: 30px tall, padding 0 8, margin-bottom 10, radius 7, weight 600, `--text`. A 14px chevron-left in `--text-3`, then "Settings". Hover: `--hover`.
- **Section label** `.st-sec`: padding `12px 8px 6px`, mono 500 11px, uppercase, letter-spacing .07em, `--text-3`.
- **Item** `.st-it`: 30px tall, padding 0 8, radius 7, gap 10, weight 500, `--text-2`, with a 16px stroke icon (1.4).
  - Hover: `--hover` background with `--text`.
  - Current page (`aria-current=page`): `--accent-s` background, `--text`, icon `--accent-t`.
  - Danger item: icon in `--danger`.
- **Structure:**
  - **ACCOUNT**
    - Profile (person icon)
    - Notifications (bell icon). Links to a separate screen, `Notifications.dc.html`.
  - **WORKSPACE**
    - Workspace (building icon)
    - Members (people icon). `#members` goes to the Members & roles screen.
    - Danger zone (triangle icon, red; **owner only**, hidden for viewer)
- **Footer** `.st-me`: margin-top auto, padding 8, top border `--line`, gap 10.
  - 28px avatar (11px initials).
  - Name (600).
  - "Owner · Platform team" or "Viewer · Platform team" (11px `--text-3`).
- Icon paths (16×16 viewBox):

  | Icon | Path |
  |---|---|
  | profile | `M8 7.5a2.6 2.6 0 100-5.2 2.6 2.6 0 000 5.2zM3 13.5c.6-2.5 2.6-4 5-4s4.4 1.5 5 4` |
  | notifications | `M4 11V7a4 4 0 018 0v4l1 1.5H3zM6.5 14h3` |
  | workspace | `M2.5 13.5V4l5-1.5v11M7.5 5.5h6v8M4.5 6.5h1M4.5 9h1M9.5 8h2M9.5 10.5h2M1.5 13.5h13` |
  | members | `M6 7.5a2.3 2.3 0 100-4.6 2.3 2.3 0 000 4.6zM2 13c.5-2.2 2-3.5 4-3.5s3.5 1.3 4 3.5M10.5 3.2a2.2 2.2 0 010 4.2M12 9.8c1 .5 1.7 1.6 2 3.2` |
  | danger | `M8 2.5l6 10.5H2zM8 6.5v3M8 11.3v.1` |

### Main area `.st-main`
- Flex 1, position relative (it hosts the save bar).
- Mobile top bar `.st-mtop` (narrow):
  - 52px tall, padding 0 8, gap 6, bottom border.
  - A back icon button `.st-ib` (36×36, or 44×44 in touch mode, radius 8, "Back to settings"), which opens the settings menu.
  - h2 page title (15px/600): "Profile", "Workspace", "Danger zone" or "Settings".
  - On the menu page the back button is replaced by a 10px spacer.
- Scroll area: overflow-y auto, thin scrollbar in `--line-2`.
- Content `.st-wrap`: `max-width 880px; padding 28px 40px 96px`, flex column. Fades in over 180ms. Narrow: padding `16px 16px 96px`.
- Page header `.st-head`: padding-bottom 20, gap 12. h2 is 20px/28px, 600, -.015em. Hidden on narrow screens.
- **Section row** `.st-row`:
  - Grid `168px minmax(0,1fr)`, column-gap 32, row-gap 10, padding `20px 0`, top border `--line`.
  - h3 is 13px/600, line-height 32px (18px on narrow).
  - Narrow: a single column, padding 16 0.
- **Controls column** `.st-ctl`: flex column, gap 14, max-width 560.
  - `.st-g2` is a 2-column grid with gap 14 (1 column on narrow).
  - A field `.st-f` is a flex column with gap 6.
  - Label `.st-lbl`: 12px/500 `--text-2`.
- **Input** `.st-inp`:
  - Box: 34px tall (44 in touch mode, with 15px text), padding 0 10, radius 6, `1px solid var(--control)`, `--surface` background, 13px.
  - Hover: `--text-3` border.
  - Focus: `--accent` border plus `0 0 0 3px var(--ring)`.
  - Error (`.err`): `--danger` border; on focus, a 3px `rgba(255,122,112,.25)` ring.
  - Read-only: `--raised` background, `--text-2` text, `--line` border, default cursor. Focus shows a `--line-2` border with no ring.
  - `.mono`: 12.5px JetBrains Mono.
  - Trailing icon slot `.st-in-ic`: 28×28 at right 4, radius 5. Inputs with it get padding-right 38.
- **Help text** `.st-help`: 12px/16px, min-height 16, `--text-3`.
  - `.err`: `--danger`.
  - `.ok`: `--ok`.
- **Buttons `.btn`:**
  - Base: 32px tall, padding 0 12, radius 6, 500 13px, gap 8. Active: scale(.97).
  - Sizes: `.sm` is 28px tall, padding 0 10, 12px. `.icon` is square.
  - Variants:

    | Variant | Background / border / text | Hover |
    |---|---|---|
    | primary | `--accent`, #fff | `--accent-h` plus 4px `--accent-s` ring |
    | sec | `--raised`, `--control` border, `--text` | `--hover` |
    | ghost | transparent, `--text-2` | `--hover`, `--text` |
    | danger | `--danger-solid`, #fff | 4px `rgba(255,122,112,.18)` ring |

  - Danger disabled: `--raised` background, `--line` border, `--text-3`, not-allowed.
- **Spinner** `.spin`: 12px, 2px `--line-2` border with a `--text-2` top segment, 0.7s linear spin. `.w` variant: white on `rgba(255,255,255,.35)`.

## B.3 Profile page ("Profile")
Sections, each a `.st-row` with its h3 on the left:

### Avatar
- Row `.st-avrow`: gap 12, wraps.
- **Avatar** `.st-av`: 64×64 circle, overflow hidden, `box-shadow 0 0 0 1px var(--line-2)`. Three display modes:
  - `photo` (default mock): a CSS-drawn placeholder portrait `.st-photo`. Mock art only; swap for the real image:
    - `radial-gradient(circle at 50% 40%, oklch(.80 .05 60) 0 21%, transparent 22%)` (head)
    - `radial-gradient(ellipse 46% 34% at 50% 100%, oklch(.62 .09 255) 0 98%, transparent 100%)` (shoulders)
    - `linear-gradient(160deg, oklch(.48 .06 230), oklch(.30 .05 265))`
  - `img`: the uploaded image, object-fit cover.
  - `initials`: an initials avatar (22px font, oklch hue).
- Buttons:
  - `btn-sec sm` labelled "Change", or "Upload" when the avatar is initials. It toggles the upload panel (aria-expanded).
  - `btn-ghost sm` "Remove" (hidden when initials). It sets the avatar to initials.
- **Upload panel** `.st-upl`:
  - Box: grid `minmax(0,1fr) auto` (1 column on narrow), gap 14, padding 14, 1px `--line` border, radius 10, `--surface` background. Fades in.
  - **Drop zone** `.st-drop` (a `<label>` wrapping a hidden full-size file input):
    - Box: min-height 104, padding 12, `1.5px dashed var(--line-2)`, radius 8, centered column, gap 6, `--text-2`.
    - Hover: `--control` border.
    - Drag-over (`.over`): `--accent` border with `--accent-s` background.
    - Focus-within: focus ring.
    - Content: a 20px upload icon, "Drop image or browse" (500, `--text`), and mono 11px `--text-3` "PNG · JPG · 2 MB".
    - `accept="image/png,image/jpeg,image/webp"`.
    - Errors (span the full width, `.st-help.err`, role=alert): "PNG, JPG or WebP only", "Max 2 MB".
  - **Preview column:** circles of 64, 32 and 20px (`.st-pvs`, aligned to the bottom, gap 12, padding 0 4, 1px `--line-2` ring).
    - Before upload they show a hatch: `repeating-linear-gradient(135deg, var(--raised) 0 5px, var(--surface) 5px 10px)`.
  - Buttons, right-aligned with gap 6: ghost sm "Cancel", plus sec sm "Use photo" once a file is chosen.
  - The image is applied immediately and locally. Avatar changes do **not** go through the unsaved bar.

### Identity
Two columns (`st-g2`):
- **Name**: text input, autocomplete name, sliced at 60 characters.
  - Errors below: "Required" (empty after trim), "Max 40 characters".
  - Editing the name triggers the unsaved-changes bar.
- **Email**: read-only input (alex@team.dev) with a 14px lock icon at the trailing slot.
  - Help text: "Managed by workspace SSO". The email cannot be changed here.

### Password
- **Current**: field max-width 272, type password, autocomplete current-password. Error "Required" appears when submitted empty.
- 2-column row:
  - **New**: type toggles password/text. Trailing eye button with aria "Show password" / "Hide password" and aria-pressed; when shown, a slash line is added to the icon (path `M2.5 13.5l11-11`).
    - **Strength meter** `.st-meter`: a grid of 4 bars plus a label. Bars are 4px tall, radius 2, gap 4, and change color over 200ms. The label is mono 11px/500, min-width 52, right-aligned.
    - Scoring:
      - 0: empty.
      - 1: shorter than 8.
      - Otherwise start at 1, then:
        - +1 if length ≥ 12.
        - +1 if it has both lower and upper case.
        - +1 if it has a digit AND a symbol; else +0.5 for a digit OR a symbol.
      - Floor the result, max 4.
    - Labels and colors:

      | Score | Label | Color |
      |---|---|---|
      | 1 | Weak | --danger |
      | 2 | Fair | --orange |
      | 3 | Good | --warn |
      | 4 | Strong | --ok |

      Unfilled bars use `--raised`.
    - Help: "8+ characters" when empty. Errors:
      - "At least 8 characters"
      - "Must differ from current"
      - "Required" (on submit)
  - **Confirm**: help has margin-top 14 to align with the meter. Errors: "Doesn’t match", "Required". Success: "✓ Matches" in `--ok`. Enter submits.
- Button `btn-sec sm` "Update password". It shows a spinner while saving (800ms mock).
  - Success: "✓ Password updated" (`--ok`, role=status). It clears all fields and disappears after about 3.4s.
  - The password is independent of the unsaved bar.

### Theme
- Controls max-width 600.
- Radiogroup "Theme" `.st-tiles`: 4 columns (2 on narrow), gap 12.
- **Tile** `.st-tile` (role=radio):
  - Box: padding 6, radius 10, 1px `--line` border, `--surface` background, flex column with gap 8, 500 12.5px.
  - Hover: `--control` border and translateY(-1px) (spring).
  - Checked: `--accent` border plus `0 0 0 3px var(--accent-s)`.
  - Footer `.st-tl`: padding `2px 4px 4px`, space-between. Name, plus a 14px check in `--accent-t` when selected.
- **Preview** `.st-prev`: 64px tall, radius 6, 1px `--line` border. It contains a mini UI mock that carries its own theme class:
  - Sidebar `.a`: 28% wide, `--surface`, right border.
  - Two nav lines `.f`/`.g`: 4px tall, `--line-2`, at 6% left, top 12/22, widths 14%/12%.
  - Title bar `.b`: left 36%, top 12, 40% × 6px, `--text-2` at opacity .7.
  - Two lines `.c`/`.d`: 5px tall, `--raised`, top 26/37, widths 54%/46%.
  - Accent button `.e`: bottom 9, 18% × 8px, `--accent`, radius 3.
- Tiles:

  | Key | Name | Preview |
  |---|---|---|
  | `navy` | "Navy" | t-navy |
  | `dark` | "Near-black" | t-dark |
  | `light` | "Light" | t-light |
  | `system` | "System" | t-light with a t-navy overlay clipped diagonally: `clip-path: polygon(100% 0,100% 100%,0 100%)` |

- Picking a tile retheme the frame immediately; it does not use the save bar.
- System resolves `prefers-color-scheme: light` → light, otherwise **navy**.

## B.4 Workspace page — owner (editable)
h2 "Workspace". One section, **General**:
- **Badge** `.st-badge`:
  - Box: 40×40, radius 10, mono 600 14px, project-badge oklch at hue 255.
  - Content: generated from the name. First letter of word 1 plus first letter of word 2 (or the 2nd letter of word 1), uppercased: "PT".
  - Caption: "Icon from name" (12px `--text-3`).
  - There is no icon upload.
- **Workspace name**: input. Errors: "Required", "Max 48 characters". Input is capped at 60 characters.
- **URL**: input group `.st-ig`:
  - Box: `1px solid var(--control)`, radius 6, `--surface` background. Focus-within: `--accent` border plus ring. Error: `--danger`.
  - Prefix `.st-pre`: "lightex.app/" (mono 12.5px `--text-3`, padding-left 10).
  - Input: mono 500 12.5px, 32px tall, spellcheck off, autocomplete off, max 40 characters.
  - Trailing 30px status slot: spinner (checking), green check (available), or red alert-circle (invalid/taken).
- **Live URL preview** `.st-url` (mono 12px/16px `--text-3`):
  - Content: a 12px link icon, then `lightex.app/` and the slug in **bold `--accent-t`**.
  - Runs of illegal characters are highlighted `.bad`: `--danger` text on `rgba(255,122,112,.14)`, radius 2.
  - An empty slug shows "…".
- **Slug help / validation**, in order:
  - "Required"
  - "Lowercase only" (if the only problem is uppercase letters)
  - "Use a–z, 0–9 and hyphens"
  - "At least 3 characters"
  - "Max 32 characters"
  - "Can’t start or end with a hyphen"
  - "No double hyphens"
  - "Already taken"
- **Async availability check:**
  - Runs 450ms after a change, only if the slug passed local validation and differs from the saved slug.
  - Help while checking: "Checking…".
  - Available: "Available · old URL redirects" (`--ok`).
  - Default help: "a–z, 0–9, hyphens".
  - Mock taken list: `design-guild, personal, admin, api, app, settings`.
- Saved defaults: name "Platform team", slug "platform-team".

## B.5 Workspace page — viewer / non-owner (read-only)
- Note banner `.st-note`:
  - Box: padding 10×12, margin-bottom 20, radius 8, `--raised` background, `--line` border, 12.5px `--text-2`.
  - Content: an eye icon, then "View only" (flex 1), then on the right "Owner" with a 20px AK avatar (9px font) and "Alex Kim".
- General section (gap 6):
  - Row: badge, then label "Workspace name" over the value "Platform team" (600 14px).
  - Row (padding-top 10): label "URL" over mono 12.5px "lightex.app/" plus the slug in `--accent-t`.
    - Ghost sm button with a copy icon and the label "Copy". It shows "Copied" for 1.4s and copies `https://lightex.app/platform-team`.
- The Danger zone nav item is hidden, and no save bar appears.

## B.6 Danger zone (owner only)
- h2 "Danger zone".
- Card `.st-danger`:
  - Box: `1px solid var(--danger)`, radius 12, `--surface` background.
  - Row `.st-drow`: padding 16×18, gap 16. Rows after the first get a top border `--line`. On narrow screens the row stacks.
  - Content: h3 "Delete workspace" (13px/600, margin-bottom 4), then mono 12px `--text-3` "3 projects · 412 tasks · 6 members".
  - Button: `.btn.btn-danger` "Delete workspace".
- **Confirm dialog** (alertdialog):
  - Scrim: `.st-scrim`, z 20, `rgba(2,5,14,.55)`, blur 6px, fade 200ms. Clicking the scrim itself closes the dialog.
  - Dialog `.st-dlg`: width 420, flex column, gap 14, padding 20, radius 14, `--line-2` border, `--surface` background, `--shadow-modal`. Animation `dlgin` 240ms `--spring`: from scale(.96) translateY(6px).
  - Title (16px/600): "Delete Platform team?"
  - Chips `.st-chip`: 22px tall, padding 0 8, radius 6, `--raised` background, `--line` border, mono 11.5px `--text-2`. Values: "3 projects", "412 tasks", "6 members".
  - Label: "Type `platform-team` to confirm". The slug sits in a `.st-code` pill: mono 12px, padding 1×5, radius 4, `--raised` background, `--line` border.
  - Input: mono, autofocus, autocomplete/spellcheck off, max 60 characters.
  - Live status (role=status):

    | Input state | Message | Style |
    |---|---|---|
    | empty | "Type the URL slug to enable delete" | neutral |
    | prefix of the slug | "Keep typing" | neutral |
    | exact match | "Matches" | ok |
    | otherwise | "Doesn’t match" | err, and the input gets `.err` |

  - Buttons: ghost "Cancel"; danger "Delete workspace", disabled until the text matches exactly. It shows a white spinner while deleting (900ms).
  - Enter confirms and Esc closes. The dialog cannot close while deleting.
- **After delete (soft delete):**
  - Banner `.st-banner`: padding 12×14, radius 10, `--line-2` border, `--raised` background, gap 12, fade-in.
  - Content: a trash icon in `--danger`, then bold "Platform team scheduled for deletion" plus mono 11px `--text-3` "· 30 days".
  - Button: `btn-sec sm` "Restore" (undoes the delete).
  - The banner replaces the danger card.

## B.7 Save bar `.st-bar` (Profile name and Workspace name/slug)
- Position: absolute, bottom 16, centered.
- Box: 44px tall, padding `0 6px 0 14px`, radius 10, `--line-2` border, `--raised` background, `--shadow-pop`, z 5, gap 8, nowrap.
- Animation `barin` 240ms: from translate(-50%, 12px) and opacity 0.
- Message `.msg`: weight 500, margin-right 8, gap 8.
- States:

| State | Content |
|---|---|
| Dirty | 7px `--warn` dot, "Unsaved changes", ghost "Discard", primary "Save" plus kbd `⌘S` (the kbd shows on wide layouts only) |
| Invalid | "Fix errors to save" in `--danger`, ghost "Discard" |
| Pending (slug check) | spinner, "Checking URL" |
| Saving | spinner, "Saving" (700ms mock) |
| Error (`.err`, border `--danger`) | alert-circle icon with "Couldn’t save" in `--danger`, ghost "Discard", primary "Retry" |
| Saved (`.ok`, padding-right 14) | `--ok` check, "Saved". Auto-hides after 2.2s |

- ⌘S / Ctrl+S saves.
- Discard reverts to the saved values.
- Avatar, password and theme changes are not part of the bar.

## B.8 Loading (frame L)
- Narrow frame. Top bar shows a back button and the title "Workspace".
- Skeleton layout:
  - Header bar: 140×20.
  - Badge 40×40 (radius 10) next to a 120×12 line.
  - Label 110×10 over a full-width 34px field.
  - Label 70×10, a full-width 34px field, then a 62%×10 line.
  - Top-bordered block (padding-top 12): label 90×10 over a full-width 54px card (radius 10).
  - Gap 22 between blocks.
  - `aria-busy`.

## B.9 Mobile (frame M, 390×844, touch)
- No settings nav; the top bar has a back button and a title.
- Touch sizing: inputs 44px tall with 15px text; icon buttons 44px.
- **The back button opens the settings menu page.** It lists every nav item as `.st-mi` rows:
  - Row: 52px tall, padding 0 14, bottom border, 15px/500.
  - Leading 18px icon in `--text-2`; danger rows have a red icon.
  - Trailing chevron in `--text-3`.
- Profile sections stack into one column, and the theme tiles use 2 columns.

## B.10 Backend / data implications (settings)
- **User profile:** `name` (1–40), `email` (read-only, SSO-managed), `avatar` (none/initials or an uploaded image: PNG/JPEG/WebP, ≤2 MB), `themePreference` (`navy` | `dark` | `light` | `system`).
  - Initials and a hue are generated for the avatar fallback.
- **Change password:** needs current + new (≥8 characters, must differ from current) + confirm. Strength scoring is client-side. With SSO users this may be hidden (open question).
- **Workspace:** `name` (1–48), `slug`. Slug rules: 3–32 characters, `[a-z0-9-]`, no leading or trailing hyphen, no `--`, unique, reserved words blocked (`admin`, `api`, `app`, `settings`, ...).
  - Endpoint: debounced slug availability check.
  - On slug change, the **old URL redirects** (keep slug history).
  - The workspace icon is derived from the name (no upload).
- **Delete workspace:** owner only, confirmed by typing the slug.
  - It is a **soft delete with a 30-day restore window** ("scheduled for deletion · 30 days", Restore).
  - Needs counts: projects, tasks, members.
- **Roles on this screen:** Owner vs Viewer/non-owner.
  - Only the Owner can edit the workspace and see the Danger zone.
  - Non-owners see read-only values and the owner's identity.
- **Not designed / out of scope:**
  - Notifications page (separate file).
  - Integrations, security, SSO and billing pages (mentioned only as permission descriptions on board 18: "Integrations, security, SSO", "Plans, invoices and seats").
  - Ownership transfer.
  - Leave workspace.
  - Workspace icon upload.
  - Email change.
  - There are no explicit "v2 / coming soon" markers on either board.
