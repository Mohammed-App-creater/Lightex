# Lightex: Sidebar navigation (board 13) and List view (board 15)

Source files: `clean/13-Sidebar-navigation.html` and `clean/15-List-view.html`. Both are x-dc design canvases. The sidebar markup, CSS and JS are copied verbatim into board 15 between the `SB-CSS-START/END`, `SB-START/END` and `SB-JS-START/END` markers, so treat the sidebar as **one shared component**. There is one difference: in board 15 the sprint ring has no mount animation (see 1.9).

---

## 0. Shared foundations

### 0.1 Fonts and base
- `.ds`: `font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif; font-size: 13px; color: var(--text); background: var(--bg); -webkit-font-smoothing: antialiased`. All elements use `box-sizing: border-box`.
- `.mono`: `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace`.
- Easings (defined on `.ds`):
  - `--ease: cubic-bezier(.16,1,.3,1)` (expo-out style; used for nearly everything)
  - `--spring: cubic-bezier(.34,1.56,.64,1)` (overshoot; used for the sub-nav indicator, sprint card lift, checkbox tick, bulk bar and done-pop)
- `.fade`: `animation: fadein 180ms var(--ease)`, from opacity 0 to 1.
- `body { margin: 0 }`.

### 0.2 Theme tokens (3 themes: `.t-navy` is the default, plus `.t-dark` and `.t-light`)

| Token | navy | dark | light |
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
| --accent-h (hover) | #2F6DF6 | #2B67F5 | #2563EB |
| --accent-t (accent text) | #8AB0FF | #7FA8FF | #1D4ED8 |
| --accent-s (accent soft) | rgba(43,103,245,.2) | rgba(38,98,238,.18) | rgba(29,78,216,.10) |
| --ring | rgba(90,150,255,.5) | rgba(79,140,255,.5) | rgba(29,78,216,.35) |
| --ok | #4ADE80 | #4ADE80 | #157A3A |
| --warn | #F5B73B | #F5B73B | #8A5A00 |
| --shadow-pop | 0 8px 24px rgba(0,0,0,.5) | 0 8px 24px rgba(0,0,0,.45) | 0 8px 24px rgba(18,18,23,.10) |
| --av-l / --av-c (avatar oklch L/C) | .40 / .10 | .40 / .10 | .90 / .06 |
| --logo | #3B7BFF | #3B7BFF | #1D4ED8 |
| --pk-l / --pk-c (project badge bg L/C) | .32 / .07 | .32 / .06 | .93 / .04 |
| --pkt-l / --pkt-c (project badge text L/C) | .88 / .09 | .88 / .08 | .42 / .12 |

Additional tokens that only board 15 (list) defines:

| Token | navy | dark | light |
|---|---|---|---|
| --spark | #5BE0FF | #5BE0FF | #0891B2 |
| --low | #2DD4BF | #2DD4BF | #0F766E |
| --todo | #C4CBE0 | #C4C4D0 | #3E3E50 |
| --danger | #FF7A70 | #FF7A70 | #B92F26 |
| --info | #B79CFF | #B79CFF | #6B3FD4 |
| --orange | #FF9A4D | #FF9A4D | #A84A0A |
| --shadow-modal | 0 24px 64px rgba(0,0,0,.6) | 0 24px 64px rgba(0,0,0,.55) | 0 24px 64px rgba(18,18,23,.18) |

Derived colours:
- **Project and workspace badge**: `background: oklch(var(--pk-l) var(--pk-c) <hue>); color: oklch(var(--pkt-l) var(--pkt-c) <hue>)`.
- **Avatar**: `background: oklch(var(--av-l) var(--av-c) <hue>)`. Text is `var(--text)`.
- **Epic swatch** (list): `oklch(.66 .13 <hue>)`. This is the same in every theme.

Board 13 is hard-coded to `t-navy`. Board 15 takes a `theme` prop (`navy` | `dark` | `light`, default `navy`).

### 0.3 Keycap `.kbd` / `.tp-kbd` (identical)
`font: 500 11px/1 JetBrains Mono; min-width: 18px; height: 18px; padding: 0 5px; inline-flex centered; border: 1px solid var(--line-2); border-bottom-width: 2px; border-radius: 4px; background: var(--raised); color: var(--text-2)`.

### 0.4 Focus ring (all interactive sidebar and list controls)
`outline: none; box-shadow: 0 0 0 1px var(--accent), 0 0 0 4px var(--ring)` on `:focus-visible`.

### 0.5 Reduced motion
`@media (prefers-reduced-motion: reduce)` sets `transition: none !important; animation: none !important` on these:
- Sidebar: `.sbw, .sb-col, .sb-ind, .sb-chev, .sb-sect svg, .sb-rg, .sb-spr, .sb-menu, .sb-tip`, plus `.drawer, .scrim, .fade` (animation only).
- List: `.lv *, .ph *, .lv-col, .lv-bulk, .lv-menu, .lv-toast, .sk, .tp-g.fx`.

---

## 1. Board 13: Sidebar navigation

### 1.1 Canvas
- Page: **1440 × 2080**, `padding: 64px 80px`, flex column, `gap: 36px`, theme navy.
- Header (flex, `align-items: flex-end`, `justify-content: space-between`, `gap: 24px`):
  - Eyebrow `SCREENS · NAVIGATION`: mono 12px, `--text-3`, `letter-spacing: .04em`. It has a 10px gap to the title.
  - H1 `Sidebar`: 48px/54px, weight 600, `letter-spacing: -.03em`.
  - Right-hand meta (mono 12px, `--text-3`, `gap: 16px`): `264 / 64 px` · `⌘B collapse` · `⌘K search` · `C new task`.
- Frame grid: `grid-template-columns: repeat(3, minmax(0,1fr)); gap: 40px`.
- Each frame is a `figure.frame` (flex column, `gap: 12px`). The figcaption is 14px/600, flex with `gap: 10px`, and carries a mono 11px/500 `--text-3` meta span.
- `.device`: `position: relative; display: flex; background: var(--bg); border: 1px solid var(--line-2); border-radius: 14px; overflow: hidden`. The `.ovf` variant uses `overflow: visible` so rail tooltips can escape.

### 1.2 Frames

| ID | Caption | Meta (verbatim) | Span | Device w×h | Radius | Config |
|---|---|---|---|---|---|---|
| A | Expanded | `click anything · ⌘B button collapses` | 2 | 840×860 | 14 | role admin, collapsible, content mock to the right |
| B | Collapsed rail | `⌘B · hover for tooltips` | 1 | 400×860 | 14 | admin, rail = true, Inbox tooltip forced visible (`tipDemo`), overflow visible, content mock |
| C | 16 projects | `scrolls · sticky header · filter` | 1 | 264×820 | 14 | admin, `many` (all 16 projects), filter input, masked scroll, sticky Projects header, no content |
| D | Viewer | `fewer items` | 1 | 264×820 | 14 | role viewer, not collapsible |
| E | Mobile drawer | `44px targets · tap scrim to close` | 1 | 390×820 | 28 | role member, touch sizes, closable, drawer width 300, phone mock underneath |

### 1.3 Sidebar container `.sbw`
- `position: relative; flex: none; height: 100%; background: var(--surface); border-right: 1px solid var(--line); overflow: hidden; z-index: 3`.
- **Width**: expanded is **264px** by default (`cfg.width`, which is 300 in the mobile drawer). The collapsed rail is **64px**. Width animates with `transition: width 220ms var(--ease)`.
- In rail mode (`.israil`), `overflow: visible` so tooltips can render outside the rail.
- Content switches between `nav.sb` (full) and `nav.sb-rail` (rail). Each mounts with the `.fade` animation (180ms).
- Collapse/expand also closes the workspace and profile menus.

### 1.4 Expanded sidebar `nav.sb` (top to bottom)
`nav.sb` is a flex column at 100% height with `aria-label="Main navigation"`.

**a) Workspace row `.sb-ws`**: `display: flex; align-items: center; gap: 4px; padding: 10px 10px 8px; position: relative`.
- **Workspace button `.sb-wsb`**: `flex: 1; height: 36px; padding: 0 8px; gap: 9px; border-radius: 8px; border: 0; transparent; color: --text; font: 600 13px/1 Inter`. Hover and `[aria-expanded=true]` use `background: --hover` (120ms transition). It uses `aria-haspopup="menu"`. Contents:
  1. Logo tile `.sb-xt`: 24×24, radius 6, `background: --raised`, `border: 1px solid --line-2`. It contains a 15×13 SVG with viewBox `0 0 46 39` and `overflow: visible`, made of three paths:
     - `M-4 -4L50 43`, stroke `--text`, width 10
     - `M50 -5L26 18H39L-4 44`, stroke `--surface`, width 17 (knock-out), miter join, miterlimit 10
     - the same path again, stroke `--logo`, width 10
  2. Workspace name, ellipsised. Default is **"Platform team"**.
  3. Chevron-down icon, 16px, `--text-3`, path `M4.5 6.5L8 10l3.5-3.5`, stroke 1.5.
- **Collapse button** (only when `collapsible`): `.sb-icb` 30×30, radius 7, `color: --text-3`. Hover uses `--hover` background and `--text` colour. Icon path `M2.5 3h11v10h-11zM6 3v10M10.5 6.5L9 8l1.5 1.5` (panel with a left arrow), stroke 1.4. Its tooltip appears to the **left** (`left: auto; right: calc(100% + 8px)`) and reads `Collapse` followed by the kbd `⌘B`.
- **Close button** (mobile drawer only, `closable`): `.sb-icb` at 44×44 with an X icon `M4 4l8 8M12 4l-8 8`. `aria-label="Close navigation"`.
- **Workspace menu** (`role="menu"`, `aria-label="Workspaces"`): absolute `top: 48px; left: 10px; right: 10px`. Items in order:
  1. `[PT]` **Platform team** (hue 255). The current workspace shows a check icon `M3.5 8.5l3 3 6-7` (stroke `--accent-t`, width 1.7).
  2. `[DG]` **Design guild** (hue 300)
  3. `[PE]` **Personal** (hue 155)
  4. Separator. The following items appear for admins only.
  5. **Workspace settings**
  6. **Create workspace**

  Workspace items are `role="menuitemradio"` with `aria-checked`. Each badge is an 18×18 `.sb-pk`. Picking an item sets the workspace name and closes the menu.

**b) Search `label.sb-search`**: `margin: 0 10px`. It contains a visually-hidden label "Search".
- Search icon 16px, absolute at `left: 10px`, vertically centred, `--text-3`. Path `M7 2.8a4.2 4.2 0 110 8.4 4.2 4.2 0 010-8.4zM10.2 10.2l3.3 3.3`.
- Input `.sb-sinp`: `type="search"`, placeholder **"Search or jump…"**, `width: 100%; height: 34px; padding: 0 44px 0 32px; border-radius: 9px; border: 1px solid --line-2; background: --bg; font: 400 13px/1 Inter`. Placeholder colour `--text-3`.
  - Hover: border `--control`.
  - Focus: border `--accent`, `box-shadow: 0 0 0 3px var(--accent-s), 0 0 18px 2px var(--accent-s)` (a glow). Transitions run 150ms.
- Kbd **⌘K**, absolute at `right: 8px`, centred (`margin-top: -9px`).

**c) New task button `.sb-new`** (hidden for viewers): `height: 32px; margin: 8px 10px 4px; padding: 0 8px 0 10px; gap: 8px; border-radius: 8px; border: 1px solid --line-2; background: --raised; font: 500 13px/1 Inter`.
- Hover: background `--hover`, border `--control`. Active: `transform: scale(.98)`. Transitions run 120ms.
- Contents: a plus icon (`M8 3v10M3 8h10`, stroke 1.6), the label **"New task"** (flex 1, left-aligned), and the kbd **C**.

**d) Scroll region `.sb-scroll`**: `flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 4px 10px 10px; scrollbar-width: thin; scrollbar-color: var(--line-2) transparent`.
- The `.masked` variant (16-project frame) applies `mask-image: linear-gradient(to bottom, transparent 0, #000 10px, #000 calc(100% - 28px), transparent 100%)`, which fades the top 10px and bottom 28px.

Nav item `.sb-it`:
- Box: `height: 30px; padding: 0 8px; gap: 10px; border-radius: 7px; color: --text-2; font-weight: 500; 13px; width: 100%`.
- Hover and `.on`: background `--hover`, colour `--text`. Transitions run 120ms.
- The label `.lab` is ellipsised.

Items in order:
1. **Inbox** (`#inbox`). Inbox-tray icon `M2.5 9.5l1.6-5.2A1 1 0 015.1 3.5h5.8a1 1 0 011 .8l1.6 5.2V12a1 1 0 01-1 1h-9a1 1 0 01-1-1zM2.5 9.5h3l1 1.5h3l1-1.5h3`. It has an unread pill `.sb-unread`: `min-width: 20px; height: 18px; padding: 0 6px; radius 9px; background: --accent-s; color: --accent-t; font: 600 11px/1 JetBrains Mono`. The value is **3** (viewer: **1**). `aria-label="N unread"`.
2. **My tasks** (`#mine`, hidden for viewers). Check-circle icon `M8 2.5a5.5 5.5 0 110 11 5.5 5.5 0 010-11zM5.6 8.1l1.7 1.7 3.2-3.4`. Count **7**, styled `.sb-count` (500 11px/1 mono, `--text-3`).
3. Section header **PINNED VIEWS** (collapsible, open by default):
   - **My open bugs**, count 4. Funnel icon `M2.5 3.5h11l-4.2 5v4l-2.6 1v-5z`.
   - **Due this week**, count 9. Calendar icon `M3 4.5h10v8.5H3zM3 7h10M5.5 3v3M10.5 3v3`.
   - **Blocked**, count 2. No-entry icon `M8 2.5a5.5 5.5 0 110 11 5.5 5.5 0 010-11zM4.1 4.1l7.8 7.8`.

   All three link to `#view`.
4. Section header **PROJECTS**, followed by the count in `--text-3` with `letter-spacing: 0` (5 for admin/member, 3 for viewer, 16 in frame C). There is a **"+" New project** button (`.sb-icb.sm`, 22×22, radius 5, 12px plus icon at stroke 1.8). It is **admin only** and its tooltip reads "New project" (shown to the right).
   - Frame C adds a filter input `.sb-filter`: placeholder **"Filter projects…"**, `height: 28px; margin: 2px 0 6px; padding: 0 10px; radius 7; border: 1px solid --line; background: --bg; font: 400 12px/1 Inter`. Focus: border `--accent`, `box-shadow: 0 0 0 3px --accent-s`. Its value is truncated to 60 characters. It matches the project name as a case-insensitive substring, or the badge code exactly. With no results it shows **"No projects match."** (`margin: 6px 8px; 12px; --text-3`).
   - Project rows are `button.sb-it` with `aria-expanded`. Each row has an 18×18 badge, the name, and a 12px chevron-right (`M6.5 4.5L10 8l-3.5 3.5`, stroke 1.6, `--text-3`) that rotates 90° when open (200ms ease). The row gets `.on` (hover background) only when it is the active project **and collapsed**. Clicking toggles open/closed, and only one project is open at a time (accordion).
   - Sub-navigation under the open project `.sb-subs`: `margin: 2px 0 6px 16px; padding-left: 10px; border-left: 1px solid --line`, `role="list"`.
     - Sub item `.sb-si`: 30px tall, `margin-bottom: 2px; padding: 0 8px; gap: 9px; radius 7; --text-2; 500 13px`.
       - Hover: `color: --text; background: rgba(128,140,170,.08)`.
       - `.on`: `color: --text`, and the icon colour becomes `--accent-t`. It also sets `aria-current="page"`.
     - **Sliding active indicator `.sb-ind`**: absolute, `left: 10px; right: 0; top: 0; height: 30px; radius 7; background: --accent-s`. It moves via `transform: translateY(idx * 32px)` (44px step in touch mode) with `transition: transform 220ms var(--spring), opacity 150ms var(--ease)`. Opacity is 1 only when this project is active. It sits behind the items, which use `z-index: 1`.
     - Sub items in order, each with a 16px icon:
       - **Board** `M2.5 3h3v10h-3zM6.5 3h3v7h-3zM10.5 3h3v5h-3z`
       - **Backlog** `M2.5 4h11M2.5 8h11M2.5 12h7`
       - **Sprints** `M12.5 6.5A4.8 4.8 0 004 5M3.5 9.5A4.8 4.8 0 0012 11M3.8 2.8v2.4h2.4M12.2 13.2v-2.4H9.8`
       - **Objectives** `M8 2.5a5.5 5.5 0 110 11 5.5 5.5 0 010-11zM8 5.5a2.5 2.5 0 110 5 2.5 2.5 0 010-5z`
       - **Milestones** `M4 14V2.5h7.5L10 5.5l1.5 3H4`
       - **Reports** `M3 13V8M6.5 13V4M10 13V9.5M13.5 13V6`
     - **Viewers see only Board, Backlog, Objectives and Milestones** (no Sprints or Reports).
   - The project list in order (badge, name, hue). Default roles show the first 5, viewers the first 3, and frame C all 16:
     PR Platform Rebuild 255 · MO Mobile App 175 · IN Infra 75 · DS Design System 300 · AP Public API 25 · BI Billing 140 · SE Search 215 · ON Onboarding 335 · DA Data Pipeline 100 · QA QA Automation 50 · SC Security 5 · DO Docs 230 · GR Growth 155 · MK Marketing Site 285 · PE Performance 195 · AN Analytics 60.
   - The default state is active project **PR**, open, sub **Board**.

Section header `.sb-sec`:
- Box: `display: flex; gap: 4px; height: 28px; margin-top: 14px; padding: 0 4px 0 8px; font: 500 11px/1 JetBrains Mono; letter-spacing: .07em; text-transform: uppercase; color: --text-3`.
- The toggle `.sb-sect` fills the width with `gap: 6px`. Its 10×10 caret (`M2.5 3.5L5 6l2.5-2.5`, stroke 1.4) rotates −90° when collapsed (180ms ease).
- `.sticky` (frame C, Projects header): `position: sticky; top: -4px; background: --surface; z-index: 2`.

**Collapse animation `.sb-col`**: `display: grid; grid-template-rows: 0fr` becomes `1fr` when `.open`, with `transition: grid-template-rows 220ms var(--ease)`. The child uses `overflow: hidden; min-height: 0`. This pattern is used for pinned views, projects and project sub-navigation.

**e) Footer `.sb-foot`**: `padding: 8px 10px 10px; border-top: 1px solid --line; flex column; gap: 2px`.
- **Sprint card `.sb-spr`**: `padding: 9px 10px; gap: 10px; radius 10; border: 1px solid --line; background: --bg; margin-bottom: 6px`.
  - Hover: border `--line-2`, background `--raised`, `transform: translateY(-1px)`. The transform uses `150ms var(--spring)`; colours use 120ms.
  - Contents:
    - A 30×30 progress ring: track circle r 11.5 with stroke `--raised` at width 3.5, and a progress circle with stroke `--accent-t` at width 3.5, round cap, `stroke-dasharray: 72.3`, rotated −90°.
    - Text: **"Sprint 14"** (600 13px/16px) and **"65% · 7d left"** (mono 11px/14px, `--text-3`), with `gap: 3px`.
    - A chevron-right (`--text-3`).
  - `aria-label="Sprint 14, 65 percent, 7 days left. Open board"`. Clicking navigates to PR / Board.
- **Row `.sb-row`** (`gap: 2px`): a left column (flex column, `gap: 2px`) holds:
  - **Members & roles** (`#members`, admin only), with a people icon.
  - **Settings** (`#settings`, hidden for viewers), with a gear icon and the trailing count text `⌘,`.

  To the right, aligned to the bottom, is a **Keyboard shortcuts** icon button (`?`-in-circle icon) whose tooltip (on the left) reads "Shortcuts" followed by the kbd **?**.
- **Profile button `.sb-prof`**: `padding: 8px; gap: 10px; radius 8; margin-top: 4px`. Hover and expanded use the `--hover` background. Contents:
  - Avatar `.sb-av`: 30×30 circle, 600 11px, hue 285, initials **AK**. Presence dot `.sb-pres`: 9×9, `--ok`, at `right: -1px; bottom: -1px`, with a `box-shadow: 0 0 0 2px var(--surface)` ring.
  - Name **"Alex Kim"** (600 13px/16px). Below it, **"{Role} · {Workspace}"**, for example "Admin · Platform team" (11px/14px, `--text-3`).
  - An up/down chevron icon `M4.5 6L8 2.8 11.5 6M4.5 10L8 13.2l3.5-3.2`.
  - `aria-label="Account: Alex Kim"`.
- **Account menu** (opens **upward**, `.sb-menu.up`): `left: 0; right: 0; bottom: calc(100% + 6px)`. Contents:
  - Header block (`padding: 8px 8px 10px; border-bottom: 1px solid --line; margin-bottom: 4px`): **Alex Kim** (600) and **alex@team.dev** (12px, `--text-3`).
  - **Profile** with kbd `G P` (`#profile`)
  - **Preferences** (`#prefs`)
  - Separator
  - **Sign out** (`#signout`)
  - **Escape** closes both the profile and workspace menus (keydown on the wrapper). Opening one menu closes the other.

**Menus `.sb-menu`**:
- Box: `position: absolute; z-index: 30; padding: 4px; radius 10; border: 1px solid --line-2; background: --raised; box-shadow: --shadow-pop`.
- Animation `sbpop` (160ms ease) runs from `opacity: 0; translateY(-4px) scale(.98)`. The upward variant `sbpopup` runs from `opacity: 0; translateY(4px)`.
- Item `.sb-mi`: `height: 30px; padding: 0 8px; gap: 10px; radius 6; 500 13px/1 Inter; --text`. Hover background `--hover`.
- Separator `.sb-sep`: 1px `--line`, `margin: 4px -4px` (full bleed).

### 1.5 Collapsed rail `nav.sb-rail` (64px)
- Box: flex column, centred, `gap: 4px; padding: 10px 0`. `aria-label="Main navigation (collapsed)"`.
- Rail item `.sb-ri`: **40×36**, radius 8, `--text-2`. Hover and `.on` use `--hover` background and `--text` colour.

Order:
1. Workspace logo tile. Clicking it **expands** the sidebar. Its tooltip shows the workspace name.
2. Search. Tooltip: "Search" + kbd `⌘K`.
3. New task (hidden for viewers). This one has `border: 1px solid --line-2; background: --raised`. Tooltip: "New task" + kbd `C`.
4. Separator `.sb-rsep`: 28×1, `--line`, `margin: 6px 0`.
5. Inbox. Instead of a count it shows an unread dot `.sb-dot` (7×7, `--accent-t`, at `right: 8px; top: 7px`, with a 2px `--surface` ring). Tooltip: "Inbox", then the number in mono `--accent-t`, then kbd `G I`.
6. My tasks (hidden for viewers). Tooltip: "My tasks" + kbd `G M`.
7. Separator.
8. Up to 6 projects as 22×22 badges (10px font). The active one gets `.on`. Clicking makes it active. The tooltip shows the project name.
9. Spacer (`flex: 1`).
10. Sprint ring at 24×24 (stroke 4). Tooltip: "Sprint 14 · 65% · 7d left".
11. Settings (hidden for viewers). Tooltip: "Settings" + kbd `⌘,`.
12. Expand. Icon `M2.5 3h11v10h-11zM6 3v10M9 6.5L10.5 8 9 9.5`. Tooltip: "Expand" + kbd `⌘B`.
13. Account: a 28×28 avatar (10px), with the button 40px tall. Tooltip: "Alex Kim · {Role}".

**Tooltip `.sb-tip`**:
- Box: `position: absolute; left: calc(100% + 10px); top: 50%; padding: 5px 8px; radius 6; background: --raised; border: 1px solid --line-2; box-shadow: --shadow-pop; 12px/500; --text; gap: 8px; white-space: nowrap; z-index: 40`.
- Hidden state: `opacity: 0; transform: translate(-4px,-50%)`.
- Shown on wrapper hover or `:focus-within`: `opacity: 1; translate(0,-50%)` with **transition-delay 150ms**. The transitions are opacity 120ms and transform 150ms ease. The `.show` class forces it visible with no delay.

### 1.6 Touch variant (`.touch`, mobile drawer)
- `.sb-it`, `.sb-si` and `.sb-mi` become **42px** tall, and `.sb-ind` becomes 42px.
- `.sb-new` becomes **44px** and `.sb-sinp` becomes **44px**.
- The indicator step is 44px.
- The drawer is 300px wide and uses role member: it has New task and My tasks, no Members & roles, no New project, and no admin workspace items.

### 1.7 Mobile drawer frame (E)
Device 390×820, radius 28.

Behind the drawer is a phone mock (`position: absolute; inset: 0`):
- Top bar: 52px tall, `padding: 0 8px`, with `border-bottom: 1px solid --line`. It has a hamburger button (44×44, `aria-label="Open navigation"`), the title **"Board"** (600, flex 1), and a Search button (44×44).
- Body: `padding: 14px; gap: 10px`, with three placeholder blocks 92px tall.

The drawer itself:
- `.scrim`: `position: absolute; inset: 0; background: rgba(2,5,14,.6); backdrop-filter: blur(6px)`, fade-in 200ms ease, `z-index: 2`. Clicking it closes the drawer.
- `.drawer` (added to `.sbw`): `position: absolute; left: 0; top: 0; bottom: 0; z-index: 3; box-shadow: 24px 0 48px rgba(0,0,0,.4)`. It enters with `drawin` 250ms ease, from `translateX(-100%)`.
- The drawer is open by default. The close X and the scrim close it; the hamburger reopens it.

### 1.8 Content mock (frames A and B)
- `.mock` (flex 1) has a top bar `.mock-top`: 48px tall, `padding: 0 18px; gap: 8px; border-bottom: 1px solid --line; --text-2`. It renders a breadcrumb: `{Project name}` `/` (in `--text-3`) `{Sub label}` (600, `--text`), for example "Platform Rebuild / Board". It updates live from the sidebar selection.
- Body: grid `repeat(auto-fill, minmax(150px,1fr))`, `gap: 12px; padding: 18px`, with five `.blk` placeholders (120px tall, radius 8, `--surface`, 1px `--line` border). The last block has opacity .6. The body fades in.

### 1.9 Animations summary (sidebar)
| What | Duration | Easing |
|---|---|---|
| Width change (264↔64) | 220ms | --ease |
| Hover background/colour | 120ms | --ease |
| Search border/glow | 150ms | --ease |
| Section caret rotate | 180ms | --ease |
| Section / project collapse (grid rows) | 220ms | --ease |
| Project chevron rotate 90° | 200ms | --ease |
| Sub-nav indicator slide | 220ms | --spring (opacity 150ms ease) |
| Sprint card lift | 150ms | --spring |
| Sprint ring fill | 800ms | --ease, on mount; on board 13 it starts 80ms after mount from dashoffset 72.3 to 25.3 |
| Menu pop | 160ms | --ease |
| Tooltip | 120ms opacity / 150ms transform, 150ms delay | --ease |
| Nav content swap | 180ms fade | --ease |
| Drawer slide / scrim | 250ms / 200ms | --ease |

Ring maths: circumference is 72.3 (r = 11.5). `dashoffset = 72.3 × (1 − pct/100)`, so 65% gives **25.3**. On board 15 the offset is rendered directly with no mount animation.

### 1.10 Roles (sidebar permissions)
| Element | admin | member | viewer |
|---|---|---|---|
| New task (button and rail) | yes | yes | no |
| My tasks | yes | yes | no |
| Projects "+" | yes | no | no |
| Members & roles | yes | no | no |
| Workspace settings / Create workspace | yes | no | no |
| Settings | yes | yes | no |
| Sub-nav | all 6 | all 6 | Board, Backlog, Objectives, Milestones |
| Projects shown | 5 | 5 | 3 |
| Inbox count | 3 | 3 | 1 |

`roleLabel` is the role name capitalised: "Admin", "Member" or "Viewer".

### 1.11 Not wired in the mock (implement for real)
- The ⌘B, ⌘K, C, G I, G M, G P, ⌘, and ? shortcuts appear as **hints only**; there are no global key handlers.
- The search input, both New task buttons, the New project button, Workspace settings, Create workspace, the Keyboard shortcuts button, the rail Search button, and the rail account button have no handlers.
- Links point to hash placeholders (`#inbox`, `#mine`, `#view`, `#members`, `#settings`, `#profile`, `#prefs`, `#signout`).
- Backend data this implies:
  - workspaces list and current workspace, and the user's role per workspace
  - inbox unread count
  - my-task count
  - pinned saved views, each with a live count
  - projects (badge code, name, hue)
  - active sprint (name, % complete, days left)
  - user profile (name, email, presence)
- State that should persist: rail collapsed or expanded, section and project open state, and the last active project/sub-view.

---

## 2. Board 15: List view

### 2.1 Canvas
- Page: **1440 × 2520**, `padding: 64px 80px`, `gap: 36px`. Theme comes from a prop (navy by default).
- Props: `theme` (navy | dark | light), `role` (admin | member | viewer, default admin), `state` (ready | loading | error, default ready).
- Header:
  - Eyebrow **"SCREENS · PROJECT VIEWS"** (500 12px mono, `--text-3`, `.04em`).
  - H1 **"List view"** (48px/54px, 600, −.03em).
  - Meta (500 12px mono, `--text-3`, `gap: 16px`): `9 columns` · `4 groupings` · `36px rows` · `Esc clears`.
- Frame grid: `repeat(6, minmax(0,1fr)); gap: 40px; align-items: start`. The figcaption is flex with baseline alignment, `gap: 10px`, 14px/600, and a meta span in 500 11px mono `--text-3`.
- `.dev`: `position: relative; border: 1px solid --line-2; overflow: hidden; background: --bg`. The radius is set per frame.

### 2.2 Frames

| ID | Caption | Meta (verbatim) | Grid col / row | w×h | r | Config |
|---|---|---|---|---|---|---|
| main | List view | `click a cell to edit · drag a header edge · check rows` | 1 / span 6, row 1 | 1280×860 | 14 | All 9 columns, sidebar (264, collapsible, PR open, no sub highlighted), top bar, follows the `state` prop. The "Canceled" group is collapsed. |
| sel | Selected rows | `3 selected · Esc clears` | 1 / span 4, row 2 | 840×440 | 12 | 7 columns (Key, Title, Status, Priority, Assignee, Due, Labels). No top bar or sidebar. In review, Backlog, Done and Canceled are collapsed. PRJ-42, PRJ-44 and PRJ-50 are selected, so the bulk bar is visible. |
| mob | Mobile | `390 · rows become cards` | 5 / span 2, rows 2–3 | 390×844 | 36 | Phone layout. Backlog, Done and Canceled are collapsed. |
| hov | Hover row actions | `open · copy key · more` | 1 / span 4, row 3 | 840×374 | 12 | 7 columns, grouped by **Epic**. Auth, Sprint and Billing epics are collapsed. Row PRJ-42 is forced into the hover state. |
| emp | Empty group | `In review · 0` | 1 / span 3, row 4 | 620×320 | 12 | 5 columns (Key, Title, Status, Assignee, Due). Every status except In review is collapsed. |
| load | Loading | `skeleton in final columns` | 4 / span 3, row 4 | 620×320 | 12 | 5 columns, state loading. |

### 2.3 Layout
- `.app` is `display: flex; height: 100%`: the sidebar host (`.sbw.sb-host`, 264px) followed by `section.lv`.
- `section.lv`: `position: relative; flex: 1; min-width: 0; flex column; background: --bg`. `aria-label="Task list"`. It handles keydown for Escape.
- Responsive rule `@media (max-width: 760px)`:
  - `.sb-host { display: none !important }`
  - `.lv-top { flex-wrap: wrap; height: auto; padding: 8px 12px; gap: 6px }`
  - `.lv-seg { order: 3 }` (the view switcher wraps to its own line)

### 2.4 Top bar `.lv-top` (main frame only)
Box: `height: 52px; flex: none; flex row; align-items: center; gap: 6px; padding: 0 12px 0 16px; border-bottom: 1px solid --line`.

Items left to right:
1. **Breadcrumb `.lv-crumb`** (600, `gap: 8px`, `margin-right: 8px`, nowrap): an 18px `PR` badge (hue 255) and **"Platform Rebuild"**.
2. **View switcher `nav.lv-seg`** (`aria-label="Project views"`). Box: `inline-flex; padding: 2px; radius 8; background: --surface; border: 1px solid --line`.
   - Links: `height: 26px; padding: 0 10px; gap: 6px; radius 6; --text-2; 500 12.5px/1 Inter`. Hover colour `--text`.
   - The current link (`[aria-current=page]`): `background: --raised; color: --text; box-shadow: inset 0 0 0 1px --line-2`.
   - Tabs, each with a 14px icon: **Board** (`#board`, column icon), **List** (current, three lines `M2.5 4h11M2.5 8h11M2.5 12h11`), and **Timeline** (`#timeline`, staggered lines `M2.5 4h6M5 8h8M3.5 12h5`).
3. Spacer.
4. **Group button**: icon of two stacked bars (`M2.5 3.5h11v3h-11zM2.5 9.5h11v3h-11z`), the word "Group" in `--text-3`, then the current grouping (for example **"Status"**). It opens the Group menu (width 180).
5. **Filter button**: funnel icon and "Filter". When filters are active it adds a badge `.lv-badge`: `min-width: 16px; height: 16px; padding: 0 4px; radius 8; background: --accent-s; color: --accent-t; font: 600 10.5px/16px mono`, holding the count. It opens the Filter menu (width 200).
6. **Columns button**: three-column icon, "Columns", and `.lv-mm` text showing visible/total (for example **"9/9"**). It opens the Columns menu (width 196), aligned to the right edge.
7. (Editors only) a vertical separator `.lv-vsep` (1×20, `--line`, `margin: 0 4px`), then the **primary "New task"** button: 13px plus icon, the label, and kbd **C**. Inside the primary button the kbd uses `background: rgba(255,255,255,.16); border-color: rgba(255,255,255,.3); color: #fff`.

**Button `.lv-btn`**:
- Base: `inline-flex; gap: 7px; height: 30px; padding: 0 10px; radius 7; font: 500 12.5px/1 Inter; border: 1px solid transparent; background: transparent; color: --text-2`.
- Hover and `[aria-expanded=true]`: background `--hover`, colour `--text`. Active: `scale(.97)`. Transitions run 120ms.
- Variants:
  - `.pri`: `background: --accent; color: #fff`; hover `--accent-h`.
  - `.sec`: `background: --raised; border-color: --line-2; color: --text`.
  - `.dng`: `color: --danger`.

### 2.5 Table structure
- `.lv-scroll`: `flex: 1; min-height: 0; overflow: auto` (both axes), thin scrollbar in `--line-2` on transparent.
- `.lv-tbl` (`role="table"`, `aria-label="Tasks"`): `padding-bottom: 72px` (room for the bulk bar). `min-width` is the total of all column widths.
- **Grid template** shared by the header and every row: `{selW}px {col widths…} minmax(0,1fr)`.
  - `selW` is the checkbox column: **36px** for editors and **14px** for viewers (no checkboxes).
  - A trailing `minmax(0,1fr)` filler column absorbs the remaining width.

**Columns** (id, label, default width, minimum width; the maximum for every column is **480**):

| id | Label | Default w | Min |
|---|---|---|---|
| key | Key | 70 | 56 |
| title | Title | 216 | 140 |
| status | Status | 112 | 48 |
| pri | Priority | 88 | 44 |
| asg | Assignee | 104 | 44 |
| sprint | Sprint | 84 | 64 |
| ms | Milestone | 112 | 72 |
| due | Due | 68 | 56 |
| labels | Labels | 120 | 72 |

With all 9 columns the total is 974 + 36 = **1010px**.

**Header row `.lv-head`**:
- Box: `position: sticky; top: 0; z-index: 5; height: 34px; background: --bg; border-bottom: 1px solid --line; color: --text-3`.
- Header cell `.lv-hc`: `padding: 0 4px; position: relative`, carrying `aria-sort` (`none`, `ascending` or `descending`).
- Sort button `.lv-hb`: `height: 26px; padding: 0 6px; gap: 4px; radius 5; font: 500 11.5px/1 Inter` (sentence case, not uppercase). Hover: background `--hover`, colour `--text`. A sorted column's text is `--text`.
  - Arrow `.ar`: 11px up-arrow `M8 13V3.5M4.5 7L8 3.5 11.5 7` at stroke 1.8.
  - Arrow opacity is 0 by default, .5 on hover, and 1 in `--accent-t` when the column is active. In `.desc` it rotates 180° (transform 180ms, opacity 120ms).
  - `aria-label="Sort by {label}"`.
- **Resize handle `.lv-rz`** (`role="separator"`, vertical orientation):
  - Box: absolute at `right: -5px; top: 5px; bottom: 5px; width: 10px; cursor: col-resize; z-index: 2; touch-action: none`.
  - Its `::after` draws a 1px `--line` line. On header-cell hover the line becomes `--line-2`. On handle hover, drag (`.on`) or focus it becomes **2px `--accent`**.
  - Pointer-drag uses pointer capture; width = start width + dx, clamped to min..480.
  - Keyboard: **←/→ ±8px, Shift ±32px, Home resets to default**.
  - ARIA: `aria-valuenow`, `aria-valuemin`, `aria-valuemax="480"`, and `aria-label="Resize {label} column"`.
- The first header cell is an empty `lv-c0` with `aria-label="Select"`.

**Sorting**: clicking a header sorts ascending. Clicking the same header again toggles asc and desc (sorting is never cleared). With no sort set, rows are ordered by key number. Sorting applies **within each group**. Ties break by key number. Sort values per column:
- key: number
- title: lowercase title
- status: flow order backlog < todo < progress < review < done < cancel
- priority: 0–4, so ascending puts No priority first
- assignee: full name, with unassigned last (`'~'`)
- sprint: number, with no sprint as 99
- milestone: index in alpha, beta, rc, ga, with none last
- due: date, with no date last
- labels: first label, with none last

### 2.6 Group header `.lv-gh`
- Box: `position: sticky; top: 34px; z-index: 3; flex; gap: 6px; height: 36px; padding-right: 10px; background: --surface; border-bottom: 1px solid --line`. It sits under the sticky column header.
- Structure:
  - `lv-c0` (width = selW) holding a tri-state "select all" checkbox `.lv-gcb` (`role="checkbox"`, `aria-checked` true/false/mixed, `aria-label="Select all in {group}"`). It shows only when the group has rows and the user can edit.
  - Toggle `.lv-gt`: `height: 28px; padding: 0 8px 0 4px; margin-left: -4px; gap: 8px; radius 6; 600 13px/1 Inter; --text`. Hover background `--hover`. `aria-expanded`. Contents:
    - A 12px chevron (`--text-3`) that rotates 90° when open (200ms).
    - A group glyph:
      - status: the status glyph in its colour
      - epic: a 10×10 radius-3 swatch `oklch(.66 .13 hue)`
      - sprint: a 14px sprint/cycle icon in `--text-2`
      - assignee: a 20px avatar
      - unassigned: a dashed empty avatar `.lv-avn` (20×20, `1.5px dashed --control`)
    - The group name.
    - The count `.lv-cnt` (500 11px mono, `--text-3`).
  - Optional meta `.lv-gm` (mono 11px, `--text-3`), sprint grouping only. Sprint 14 shows "Active · Oct 1–14"; the others show their date range.
  - Spacer.
  - (Editors) an add button `.lv-ib` (26×26, radius 6, `--text-3`; hover `--hover` / `--text`) with a 13px plus icon and `aria-label="Add task to {group}"`.
- Collapse uses `.lv-col` (the same grid-rows 0fr→1fr technique at 220ms, plus `visibility: hidden` delayed 220ms when closed, so collapsed rows are not focusable). Collapse state is tracked per `"{groupBy}:{groupId}"`.

**Groupings** (order as listed):
- **Status**: In progress, In review, Todo, Backlog, Done, Canceled.
- **Epic**: Auth overhaul (hue 255), Board performance (200), Sprint engine (150), Billing v2 (60).
- **Sprint**: Sprint 14 (Oct 1–14, "Active"), Sprint 13 (Sep 17–30), Sprint 12 (Sep 3–16), No sprint.
- **Assignee**: Alex Kim (285), Jordan Lee (200), Sam Patel (20), Riley Chen (150), Morgan Diaz (60), Taylor Ng (330), Unassigned.

Groups with 0 rows still render, with a count of 0.

### 2.7 Row `.lv-row`
- Box: `display: grid; height: 36px; border-bottom: 1px solid --line; position: relative`. Background transitions over 100ms.
- Hover, `.hov`, `:focus-within` and `.act` (a popover is open for this row) all use `background: --surface`.
- Selected (`.sel`): `background: --accent-s`, plus a **2px `--accent` left bar** (`::before`, `left: 0; top: 0; bottom: 0`). Selected rows also carry `aria-selected`.
- Checkbox cell `lv-c0` (flex centred) holds `input.lv-cbx`:
  - Box: 16×16, `border: 1.5px solid --control`, radius 4, transparent. Checked: `--accent` background and border, with a white tick (`::after`, 8×4, border 0 0 2px 2px, rotated −45°) that scales in over 150ms `--spring`.
  - Visibility: hidden (opacity 0) until row hover or `:focus-visible`, or whenever any selection exists (`.lv-tbl.selecting`). Group checkboxes follow the same rule on group-header hover.
  - `aria-label="Select PRJ-xx"`.
- Cell `.lv-c`: `padding: 0 4px`, containing the value element `.lv-cv`:
  - Box: `flex: 1; height: 28px; padding: 0 6px; gap: 7px; radius 5; font: 400 13px/1 Inter; --text; nowrap; overflow: hidden`.
  - Editable cells are `<button>`. Hover: `background: --hover; box-shadow: inset 0 0 0 1px --line-2`. Open: `background: --accent-s; box-shadow: inset 0 0 0 1px --accent`. Transitions run 120ms.
  - Read-only cells (Key column, and every cell for viewers) are `<span>` with no hover effect.
  - Each cell has `aria-label="{Column}: {value}"` and a `title` tooltip (full title, full assignee name, "Milestone · date", or comma-joined labels).
- Text classes on `.lv-t` (always ellipsised):
  - `.mono`: 500 12px mono
  - `.key`: `--text-3`
  - `.tt`: 500 weight (title)
  - `.mut`: `--text-3`
  - `.late`: `--danger`
  - `.soon`: `--warn`

**Cell content by column**:
- **Key**: `PRJ-31` in mono, `--text-3`. Always read-only.
- **Title**: the title at weight 500. An empty title shows "Untitled" in muted text. Clicking enters inline edit.
- **Status**: glyph plus label.
- **Priority**: four signal bars plus label. Priority 0 shows `—` muted, with all bars grey.
- **Assignee**: 20px avatar plus **first name**. No assignee shows "Unassigned" muted.
- **Sprint**: "Sprint 14", or `—` muted.
- **Milestone**: the milestone name ("Beta launch"), or `—`.
- **Due**: mono "Oct 9". Colouring: **late** (`--danger`) if before today; **soon** (`--warn`) if 0–2 days away; muted if the task is Done or Canceled; `—` muted if there is no date. "Today" is fixed at **2026-10-07** in the mock.
- **Labels**: chips `.lv-lab`.
  - Chip: `height: 20px; padding: 0 7px; gap: 5px; radius 5; background: --raised; border: 1px solid --line; 11.5px/500; --text-2`. It contains a 7px colour dot.
  - The number of chips shown depends on column width: ≥200px shows 3, ≥150px shows 2, otherwise 1. The overflow is a `+N` marker (`.lv-more`, 500 11px mono `--text-3`). With no labels the cell shows `—`.
- **Trailing filler cell**: holds the hover actions.

**Status glyphs `.tp-g`** (14px circle):

| Status | Label | Colour token | Glyph |
|---|---|---|---|
| backlog | Backlog | --text-3 | 1.5px **dashed** ring |
| todo | Todo | --todo | 1.5px solid ring |
| progress | In progress | --warn | ring with 2px padding, half-filled conic (0–180°) |
| review | In review | --info | ring with 2px padding, 270° conic fill |
| done | Done | --ok | solid fill with a `--bg` checkmark (`::after` 3×6 at left 4 / top 2, border 0 1.5px 1.5px 0, rotated 45°) |
| cancel | Canceled | --text-3 | ring with a diagonal 7×1.5 slash rotated −45° |

**Done celebration** (setting status to Done through the cell menu):
- The glyph gets `.fx`, which runs `tppop` (240ms `--spring`: scale .6 → 1.2 → 1).
- At the same time a `::before` spark burst appears: six 3px `--spark` dots placed with box-shadows at (0,−11), (10,−5), (10,6), (0,11), (−10,6), (−10,−5). It runs `tpspark` (440ms `--ease`, scale .3→1.8, opacity 1→0).

**Priority bars `.tp-bars`**: four 3px-wide bars with radius 1 and a 1.5px gap, heights 4/7/10/12px, in a 12px-tall container. Unfilled bars are `--line-2`; filled bars use `currentColor`.

| Value | Label | Bars filled | Colour |
|---|---|---|---|
| 4 | Urgent | 4 | --danger |
| 3 | High | 3 | --orange |
| 2 | Medium | 2 | --warn |
| 1 | Low | 1 | --low |
| 0 | No priority | 0 | --text-3 |

**Label colours**: frontend `--low` · backend `--accent-t` · bug `--danger` · perf `--info` · infra `--orange` · design `--warn`.

**Avatar `.tp-av`**: 20×20 circle, 600 9px, `oklch(--av-l --av-c hue)`. People:

| Initials | Name | Hue |
|---|---|---|
| AK | Alex Kim | 285 (also the current user, "me") |
| JL | Jordan Lee | 200 |
| SP | Sam Patel | 20 |
| RC | Riley Chen | 150 |
| MD | Morgan Diaz | 60 |
| TN | Taylor Ng | 330 |

**Hover row actions `.lv-acts`**:
- Box: absolute at `right: 8px`, vertically centred. `padding: 2px; gap: 1px; radius 8; background: --raised; border: 1px solid --line-2`.
- Hidden with opacity 0 and no pointer events. It fades in over 120ms on row hover, `:focus-within`, `.hov` or `.act`.
- Buttons are `.lv-ib` at 24×24 in `--text-2`:
  1. **Open**: arrow-out icon `M5 11l6-6M6 5h5v5`. A link to the task detail page (`Task-Detail.dc.html`). `aria-label="Open PRJ-xx"`.
  2. **Copy key**: copy icon. Writes the key to the clipboard and shows the toast "Copied PRJ-xx".
  3. **More** (editors only): ⋯ icon. Opens the Task actions menu, right-aligned, width 190.

### 2.8 Inline editing
- **Title**: clicking replaces the cell with `input.lv-tin`:
  - Box: `flex: 1; height: 28px; padding: 0 6px; radius 5; border: 1px solid --accent; box-shadow: 0 0 0 3px --accent-s; background: --surface; 500 13px/1 Inter`. Placeholder "Task title". Autofocused.
  - **Enter** saves. **Escape** cancels (and stops propagation so selection survives). **Blur** saves.
  - The value is trimmed and capped at **200 chars**.
  - If saved empty on a task that has no title (a new task), the task is **removed**. If saved empty on an existing title, the edit is reverted.
- **Other editable cells** (Status, Priority, Assignee, Sprint, Milestone, Due, Labels) open a popover menu (`aria-haspopup="menu"`):
  - Width: `max(196, min(columnWidth, 240))`.
  - Position: below the cell (+4px), or flipped above it (−6px) if the menu would overflow the bottom. It is clamped 8px inside the list section's edges.
  - Clicking the same cell again toggles the menu closed.
  - An invisible full-size catcher `.lv-catch` (z-index 25) closes the menu on an outside click.
- Menu contents (single-select items are `menuitemradio`, with a trailing `--accent-t` check on the current value and a `.on` background of `--accent-s`):
  - **Status**: Backlog `1`, Todo `2`, In progress `3`, In review `4`, Done `5`, Canceled `6`. Each has its glyph, and the number is shown as meta (implies number-key shortcuts).
  - **Priority**: Urgent, High, Medium, Low, No priority, each with bars.
  - **Assignee**: the six people with avatars, then "Unassigned" with a dashed avatar.
  - **Sprint**: "Sprint 14" (meta "Oct 1–14"), "Sprint 13" ("Sep 17–30"), "Sprint 12" ("Sep 3–16"), "No sprint".
  - **Milestone**: Alpha (Sep 12), Beta launch (Oct 21), Release candidate (Nov 18), General availability (Dec 9), and "No milestone".
  - **Due** (preset quick-picks with no calendar): Today (Oct 7), Tomorrow (Oct 8), Sprint end (Oct 14), Beta launch (Oct 21), Release candidate (Nov 18), No due date.
  - **Labels**: multi-select checkboxes (`menuitemcheckbox`, with a `.lv-ck` 14×14 box). Options: frontend, backend, bug, perf, infra, design, each with a colour dot. The menu **stays open** while toggling.
  - Single-select menus close on pick.

**Menu `.lv-menu`**:
- Box: `position: absolute; z-index: 30; padding: 4px; radius 10; border: 1px solid --line-2; background: --raised; box-shadow: --shadow-pop`. Animation `lvmenu` (150ms ease) from `opacity: 0; translateY(-4px) scale(.98)`.
- The first item is autofocused.
- Item `.lv-mi`: `height: 30px; padding: 0 8px; gap: 9px; radius 6; 500 13px/1 Inter`. Hover background `--hover`.
  - `.on`: `--accent-s` background.
  - `.dng`: `--danger` text.
  - `.sep`: `margin-top: 5px` plus a 1px `--line` rule above it, full bleed.
- Meta `.lv-mm`: 500 11px mono, `--text-3`.
- Checkbox `.lv-ck`: 14×14, radius 4, `1.5px solid --control`. Checked: `--accent` fill with a white tick (7×3.5, border 1.8).

**Other menus**:
- **Group by** (radio): Status, Epic, Sprint, Assignee.
- **Filter** (checkbox): "Assigned to me" (assignee = AK), "Due this week" (due ≤ 2026-10-11 and not done or canceled), "Urgent & high" (priority ≥ 3). When any filter is on, a separator and "Clear filters" are added. Filters combine with AND.
- **Columns** (checkbox): every column except Title (which cannot be hidden): Key, Status, Priority, Assignee, Sprint, Milestone, Due, Labels. Then a separator and "Reset widths".
- **Task actions** (⋯):
  - "Copy link" `⌘L`. Toast: "Link to PRJ-xx copied".
  - "Duplicate" `⌘D`. Creates a new key (max + 1) with the title "{title} (copy)". Toast: "Duplicated as PRJ-nn".
  - (Admin only) a separator, then a red "Delete" `⌫`. Soft-deletes the task. Toast: "Deleted PRJ-xx" with **Undo**.

### 2.9 Adding tasks
- Sources: the group-header "+", the empty-group "+ Add task" link, and the top-bar New task button. The New task button adds to **Todo** when grouped by status, otherwise to the first group.
- A new task gets id `PRJ-{max+1}` with these defaults: status todo, priority 0, no assignee, epic auth, sprint 14, no milestone, no due date, no labels.
- The grouping field is overridden by the target group.
- Adding also expands that group, **clears filters**, closes any popover, and opens the title in edit mode (empty draft).

### 2.10 Selection and bulk actions
- Row checkboxes toggle individual rows. The group checkbox selects all rows in the group, or deselects all if every row is already selected (tri-state). Selection persists across groups.
- **Bulk bar `.lv-bulk`** (`role="toolbar"`, `aria-label="N tasks selected"`):
  - Box: absolute at `left: 50%; bottom: 16px; z-index: 20; height: 44px; padding: 0 6px 0 8px; gap: 2px; radius 12; background: --raised; border: 1px solid --line-2; box-shadow: --shadow-modal`.
  - Hidden state: `transform: translate(-50%, calc(100% + 28px)); opacity: 0; visibility: hidden`.
  - `.on` state: `translate(-50%, 0)`, using **transform 260ms `--spring`** and opacity 160ms ease. Visibility is delayed 260ms on hide.
  - Contents:
    - Count chip `.lv-bn`: `height: 30px; padding: 0 6px 0 10px; gap: 8px; radius 7; background: --accent-s; color: --accent-t; 600 12.5px`. It reads **"3"** (mono bold) followed by "selected", then a 20×20 X button (`aria-label="Clear selection"`).
    - **Assign**: person icon. Menu width 200, opens upward. Picking a person toast: "Assigned N tasks to {First}".
    - **Move**: arrow icon. Status list, width 200, opens upward. Toast: "Moved N tasks to {Status}".
    - **Label**: tag icon. Menu "Add label", width 190. Additive only; toast: "Labeled N tasks {label}".
    - (Admin only) a separator, then a red **Delete** (trash icon). Soft-deletes all selected tasks. Toast: "Deleted N tasks" with Undo.
    - The kbd **Esc**, with `margin: 0 4px 0 6px`.
  - Toast copy uses "1 task" for a single task and "N tasks" otherwise.
- The bulk bar is hidden for viewers and while loading.

### 2.11 Toast `.lv-toast`
- Box: absolute at `left: 16px` with `bottom: 16px`, or **72px when the bulk bar is visible** (animated via `transition: bottom 240ms ease`). `z-index: 22; height: 38px; padding: 0 6px 0 14px; gap: 10px; radius 10; background: --raised; border: 1px solid --line-2; box-shadow: --shadow-pop; weight 500`. `role="status"`.
- Enters with `lvtoast` (220ms ease) from `opacity: 0; translateY(8px)`.
- It auto-dismisses after **2400ms**, or after **5000ms** when it has Undo.
- The Undo button `.lv-link`: `height: 24px; padding: 0 6px; radius 5; color: --accent-t; 500 12.5px`; hover background `--accent-s`. Undo restores the soft-deleted ids.

### 2.12 Keyboard
- **Esc** inside the list closes the open popover first. Pressing Esc again clears the selection.
- **Esc** inside the bulk bar clears both the selection and the popover.
- Title edit: **Enter** saves, **Esc** cancels.
- Column resize: **← / →** (±8px), **Shift+arrow** (±32px), **Home** (reset to default).
- Hinted only (no handlers): **C** new task, status number keys **1–6**, **⌘L** copy link, **⌘D** duplicate, **⌫** delete.

### 2.13 Empty, loading and error states
- **Empty group** row `.lv-empty`: `height: 40px; gap: 12px; border-bottom: 1px solid --line; --text-3; 12.5px`. It has a selW spacer, then **"No tasks"** (`padding-left: 10px`), then (editors only) the link **"+ Add task"**.
- **No filter match** `.lv-state` (`min-height: 280px`):
  - Box: flex column, centred, `gap: 12px; padding: 40px`.
  - Contents: a 26px funnel icon in `--text-3`, an h3 **"No tasks match"** (15px/600), and a secondary button **"Clear filters"**.
  - It replaces the groups only when filters are active and nothing matches.
- **Loading** (`aria-busy="true"`, `aria-label="Loading tasks"`):
  - The column header stays real.
  - Three skeleton groups: header bars 84 / 56 / 70px wide, with 4 / 3 / 3 rows. Each group header shows a 14px circle, a bar, and a 14px bar.
  - Skeleton rows are full 36px `.lv-row`s using the same grid. Editors get a 14px checkbox square at opacity .6.
  - Each cell `.lv-skc` (`padding: 0 10px; gap: 8px`) holds a bar whose width is a percentage cycled from these presets:

    | Column | Width presets (%) |
    |---|---|
    | key | 72, 60, 78, 66 |
    | title | 82, 60, 92, 54, 74 |
    | status | 64, 52, 72 |
    | pri | 56, 70 |
    | asg | 60, 48, 66 |
    | sprint | 70, 58 |
    | ms | 74, 60 |
    | due | 62, 74 |
    | labels | 54, 70, 42 |

    Status and Assignee cells also get a leading 14px circle.
  - `.sk`: `height: 9px; radius 5; background: linear-gradient(90deg, --raised 0%, --hover 45%, --raised 90%); background-size: 240% 100%`, with the shimmer `shim` running **1.4s linear infinite** (background-position 120% → −120%).
- **Error** (`role="alert"`, replaces the table):
  - A 28px warning triangle in `--danger` (stroke 1.6).
  - h3 **"Couldn’t load tasks"** (uses a typographic apostrophe).
  - Meta `503 · PRJ list` (`.lv-mm`).
  - A secondary button **"Retry"** (in the mock it simply dismisses the error state).

### 2.14 Mobile list (frame "mob", 390×844, radius 36)
`.ph` is an absolute full-size flex column on `--bg`. Top to bottom:
1. **Status bar** `.ph-sb`: 44px tall, `padding: 0 30px`, 600 14px. It shows "9:41" and a 56×12 signal/battery SVG.
2. **Top bar** `.ph-top`: 52px tall, `padding: 0 4px; gap: 2px; border-bottom: 1px solid --line`.
   - Hamburger `.ph-ib` (44×44, radius 10, `--text-2`; hover `--hover` / `--text`).
   - Title stack (`gap: 3px`): **"List"** (600 15px/1) and **"Platform Rebuild · 20 tasks"** (11.5px, `--text-3`; the count is live).
   - Filter button and Search button (18px icons).
3. **Group chips** `.ph-chips` (`role="group"`, `aria-label="Group by"`): `padding: 10px 12px; gap: 6px`, horizontal scroll with a hidden scrollbar, `border-bottom: 1px solid --line`.
   - Chip `.ph-chip`: `height: 32px; padding: 0 12px; radius 16; border: 1px solid --line-2; transparent; --text-2; 500 13px`. `.on` uses `background: --accent-s; border-color: transparent; color: --accent-t`, with 150ms transitions and `aria-pressed`.
   - Chips: **Status**, **Epic**, **Sprint**, **Assignee**.
4. **Scroll area** `.ph-scroll` (`padding-bottom: 96px`, hidden scrollbar):
   - Sticky group header `.ph-gh` (`--surface`, bottom border). Its button `.ph-gt`: 44px tall, `padding: 0 16px; gap: 9px; 600 14px`, with the chevron, glyph, ellipsised name, and count.
   - Empty group: `.ph-empty` **"No tasks"** (`padding: 14px 16px; 13px; --text-3`).
   - Card list `.ph-list`: `flex column; gap: 8px; padding: 10px 12px`.
   - **Card `.ph-card`**: a link to the task detail page. `padding: 11px 12px; gap: 7px; radius 10; border: 1px solid --line; background: --surface`. On `:active` it uses `scale(.99)` with border `--line-2`. `aria-label="{key} {title}"`. Rows:
     1. Status glyph, the key (mono 12px `--text-3`), a spacer, then the due date (mono 12px, coloured late/soon/muted; hidden when there is none).
     2. Title: 500 14px/20px, **clamped to 2 lines**.
     3. Priority bars, then the subtitle (12px `--text-3`, ellipsised): the **epic name**, or **"Sprint N" / "No sprint"** when grouped by epic. Last is the assignee avatar, or a dashed empty avatar.
5. **FAB** `.ph-fab` (editors only): absolute at `right: 16px; bottom: 30px`, 54×54, **radius 16**, `--accent` with a white 20px plus, `box-shadow: --shadow-pop`. `aria-label="New task"`.
6. **Home indicator**: 134×5, radius 3, `--text-3` at opacity .5, at `bottom: 8px`.

Behaviour notes:
- Mobile ignores filters and sort; it sorts by key number.
- There is no selection or inline editing on mobile.
- The hamburger, Filter, Search and FAB buttons have no handlers.

### 2.15 Roles (list)
| Capability | admin | member | viewer |
|---|---|---|---|
| Checkbox column (selW 36) / selection / bulk bar | yes | yes | no (selW 14) |
| Inline cell edit, title edit | yes | yes | no (read-only spans) |
| New task button, group "+", "+ Add task", FAB | yes | yes | no |
| Row ⋯ menu | yes | yes | no |
| Delete (⋯ menu and bulk) | yes | no | no |
| Open and Copy key row actions | yes | yes | yes |

### 2.16 Data model (task) and seed data
Task fields:
- `id` (`PRJ-{n}`) and `n` (number)
- `title`
- `st` (backlog, todo, progress, review, done or cancel)
- `pri` (0–4)
- `asg` (initials or null)
- `ep` (epic id)
- `sp` (sprint number; 0 or null means none)
- `ms` (milestone id or null)
- `due` (ISO date or null)
- `labels` (string array)
- `del` (soft-delete flag)

Lookups:
- Epics: auth "Auth overhaul" · board "Board performance" · sprint "Sprint engine" · bill "Billing v2".
- Milestones: alpha "Alpha" (Sep 12) · beta "Beta launch" (Oct 21) · rc "Release candidate" (Nov 18) · ga "General availability" (Dec 9).

Seed (20 tasks; columns are key | title | status | priority | assignee | epic | sprint | milestone | due | labels):
```
PRJ-31 Rotate refresh tokens on reuse      | done     | 3 | AK | auth   | 13 | beta  | 2026-09-30 | backend
PRJ-33 SSO login with Okta                 | progress | 3 | JL | auth   | 14 | beta  | 2026-10-14 | backend, frontend
PRJ-34 Session timeout modal               | todo     | 2 | SP | auth   | 14 | beta  | 2026-10-10 | frontend, design
PRJ-36 Audit log for sign-ins              | backlog  | 1 | —  | auth   | —  | rc    | —          | backend
PRJ-38 Passkey enrollment flow             | todo     | 2 | TN | auth   | 14 | rc    | 2026-10-16 | frontend
PRJ-40 Virtualize board columns            | done     | 4 | AK | board  | 13 | beta  | 2026-10-02 | frontend, perf
PRJ-42 Fix flaky board reflow on column resize | progress | 3 | AK | board | 14 | beta | 2026-10-09 | frontend, bug
PRJ-44 Debounce reflow on sidebar toggle   | progress | 2 | JL | board  | 14 | beta  | 2026-10-08 | perf
PRJ-45 Drag latency regression test        | todo     | 2 | RC | board  | 14 | beta  | 2026-10-13 | perf
PRJ-47 Cache card thumbnails               | backlog  | 1 | —  | board  | —  | ga    | —          | perf
PRJ-49 Sprint rollover job                 | done     | 3 | SP | sprint | 12 | alpha | 2026-09-10 | backend
PRJ-50 Carry-over prompt at sprint close   | progress | 4 | MD | sprint | 14 | beta  | 2026-10-06 | frontend
PRJ-52 Velocity chart by assignee          | todo     | 1 | RC | sprint | 14 | rc    | 2026-10-20 | frontend
PRJ-53 Burndown off by one day             | done     | 3 | MD | sprint | 13 | beta  | 2026-09-29 | bug
PRJ-55 Capacity planning per sprint        | backlog  | 2 | —  | sprint | —  | ga    | —          | design
PRJ-57 Proration on plan change            | progress | 3 | TN | bill   | 14 | rc    | 2026-10-15 | backend
PRJ-58 Invoice PDF redesign                | todo     | 2 | SP | bill   | 14 | rc    | 2026-10-17 | design, frontend
PRJ-60 Stripe webhook retries              | done     | 4 | JL | bill   | 12 | alpha | 2026-09-08 | backend, infra
PRJ-61 Tax IDs for EU customers            | done     | 2 | TN | bill   | 13 | beta  | 2026-10-01 | backend
PRJ-63 Legacy coupon migration             | cancel   | 1 | MD | bill   | 13 | —     | —          | infra
```
No task is seeded "In review", which is why the In review group is empty.

### 2.17 Backend and product implications
- The list endpoint can fail; the error UI shows the code and source (`503 · PRJ list`), with Retry.
- Task keys are a per-project prefix plus a sequential number (`PRJ-n`, max + 1).
- **Delete is soft**, with Undo for 5s. That suggests delayed hard-delete, or a `deleted` flag with a restore endpoint.
- Bulk endpoints are needed for: assign, change status, add label, and delete.
- Duplicate copies all fields and appends " (copy)" to the title.
- Due-date colouring is computed relative to "today" in the user's timezone.
- **Column widths and visibility, grouping, sort, filters and per-group collapse** are per-view user preferences and should probably be persisted (the Columns menu's "Reset widths" implies stored widths).
- The filter "Assigned to me" requires the current user's id.
- Permissions follow the admin, member and viewer roles described above.
- The Board, List and Timeline tabs are separate project views; Timeline is not designed on this board.
- "Billing v2" is only an epic name in the seed data. **Nothing on either board is marked v2 or "coming soon".**
