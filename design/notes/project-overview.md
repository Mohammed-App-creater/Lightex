# Project Overview: design spec (boards 11 and 12)

Sources: `clean/11-Project-overview.html` (title "Lightex · Project overview") and `clean/12-Project-overview-new-project.html` (title "Lightex · New project").
Both are x-dc design-canvas components: a template with `{{bindings}}`, `<sc-if>` and `<sc-for>`, plus a `class Component extends DCLogic` script that holds state and interactions. Everything below comes from the markup, CSS and script.

> **Scope notes**
> - Neither file contains a **kanban board** (columns or cards). "Board" appears only as a tab link and a sidebar sub-item.
> - Neither file contains a **create-project modal or form**. Board 12 is the state *right after* a project was created: an onboarding checklist plus empty widgets.
> - Nothing is labelled "v2", "coming soon" or "beta feature". The only "v2" is the demo epic name **"Billing v2"**. "Beta launch" is a demo milestone name.

---

## 0. Shared foundations (both boards)

### 0.1 Canvas props (prototype knobs; map these to real state)

| Board | Prop | Options | Default |
|---|---|---|---|
| 11 | `theme` | `navy`, `dark`, `light` | `navy` |
| 11 | `role` | `admin`, `member`, `viewer` | `admin` |
| 11 | `state` | `ready`, `loading`, `error` | `ready` |
| 11 | `$preview` | **1440 × 1900** | |
| 12 | `theme` | `navy`, `dark`, `light` | `navy` |
| 12 | `$preview` | **1440 × 1500** | |

Theme class mapping: `light → .t-light`, `navy → .t-navy`, anything else → `.t-dark`. The theme class sits on the root `div.ds.app`.

### 0.2 Design tokens (CSS custom properties)

The theme classes define these tokens. Board 12 omits `--low`, `--danger`, `--info` and `--orange`, which it never uses. Otherwise the values are identical.

| Token | `.t-dark` | `.t-light` | `.t-navy` (default) |
|---|---|---|---|
| `--bg` | `#0B0B0F` | `#FAFAFB` | `#060B18` |
| `--surface` | `#121217` | `#FFFFFF` | `#0C1326` |
| `--raised` | `#1A1A21` | `#F3F3F6` | `#131C34` |
| `--hover` | `#22222B` | `#EAEAEF` | `#1B2644` |
| `--line` | `#24242E` | `#E4E4EA` | `#1C2845` |
| `--line-2` | `#34343F` | `#D0D0D9` | `#2B3A5E` |
| `--control` | `#6A6A7C` | `#8A8A9B` | `#5F6F96` |
| `--text` | `#ECECF1` | `#121217` | `#EAF0FF` |
| `--text-2` | `#A3A3B1` | `#55556A` | `#A5B2D1` |
| `--text-3` | `#8E8E9D` | `#5F5F70` | `#8794B6` |
| `--accent` | `#2662EE` | `#1D4ED8` | `#2B67F5` |
| `--accent-h` (hover) | `#2B67F5` | `#2563EB` | `#2F6DF6` |
| `--accent-t` (accent text) | `#7FA8FF` | `#1D4ED8` | `#8AB0FF` |
| `--accent-s` (accent soft) | `rgba(38,98,238,.18)` | `rgba(29,78,216,.10)` | `rgba(43,103,245,.2)` |
| `--ring` | `rgba(79,140,255,.5)` | `rgba(29,78,216,.35)` | `rgba(90,150,255,.5)` |
| `--spark` | `#5BE0FF` | `#0891B2` | `#5BE0FF` |
| `--low` (11 only) | `#2DD4BF` | `#0F766E` | `#2DD4BF` |
| `--todo` | `#C4C4D0` | `#3E3E50` | `#C4CBE0` |
| `--ok` | `#4ADE80` | `#157A3A` | `#4ADE80` |
| `--warn` | `#F5B73B` | `#8A5A00` | `#F5B73B` |
| `--danger` (11 only) | `#FF7A70` | `#B92F26` | `#FF7A70` |
| `--info` (11 only) | `#B79CFF` | `#6B3FD4` | `#B79CFF` |
| `--orange` (11 only) | `#FF9A4D` | `#A84A0A` | `#FF9A4D` |
| `--shadow-pop` | `0 8px 24px rgba(0,0,0,.45)` | `0 8px 24px rgba(18,18,23,.10)` | `0 8px 24px rgba(0,0,0,.5)` |
| `--av-l` / `--av-c` (avatar OKLCH L/C) | `.40` / `.10` | `.90` / `.06` | `.40` / `.10` |
| `--logo` | `#3B7BFF` | `#1D4ED8` | `#3B7BFF` |
| `--pk-l` / `--pk-c` (project badge bg) | `.32` / `.06` | `.93` / `.04` | `.32` / `.07` |
| `--pkt-l` / `--pkt-c` (project badge text) | `.88` / `.08` | `.42` / `.12` | `.88` / `.09` |

`.ds` (root) also sets:
- `--ease: cubic-bezier(.16,1,.3,1)` (expo-out). Used for nearly every transition.
- `--spring: cubic-bezier(.34,1.56,.64,1)` (overshoot). Used for card lift, the sidebar indicator and the checklist ring pop.
- `font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif; font-size:13px; color:var(--text); background:var(--bg); -webkit-font-smoothing:antialiased`
- `.ds * { box-sizing:border-box }`

Generated colors:
- **Avatar background:** `oklch(var(--av-l) var(--av-c) <hue>)`. Avatar text is `var(--text)`.
- **Project/workspace badge:** background `oklch(var(--pk-l) var(--pk-c) <hue>)`, text `oklch(var(--pkt-l) var(--pkt-c) <hue>)`.

People and hues: Alex Kim **AK** = 285, Jordan Lee **JL** = 200, Sam Patel **SP** = 20, Riley Chen **RC** = 150.

### 0.3 Typography utilities

- `.mono`: `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace`
- `.cap`: `font-size:12px; line-height:16px; color:var(--text-3)`
- `.big`: `32px/40px`, weight 600, `letter-spacing:-.02em`.
  - Board 11 adds `font-variant-numeric:tabular-nums`.
  - Board 12 uses `color:var(--text-3)` instead (muted zeros) and has no tabular-nums.
- `h1` (project name): `margin:0; 24px/32px; 600; letter-spacing:-.02em`
- `.ph h2` (panel titles): `margin:0; 14px; 600`

### 0.4 Shared primitives

**`.btn`**
- Base: `inline-flex; align-items:center; gap:8px; height:32px; padding:0 12px; border-radius:6px; font:500 13px/1 Inter; border:1px solid transparent; white-space:nowrap; cursor:pointer`.
- Transition: `background-color, box-shadow, transform, color` at 120ms `var(--ease)`.
- `:active`: `transform:scale(.97)`.
- `.btn.sm`: `height:28px; padding:0 10px; font-size:12px`.

| Variant | Rest | Hover |
|---|---|---|
| `.btn-primary` | bg `var(--accent)`, text `#fff` | bg `var(--accent-h)` + `box-shadow:0 0 0 4px var(--accent-s)` |
| `.btn-sec` | bg `var(--raised)`, border `var(--control)`, text `var(--text)` | bg `var(--hover)` |
| `.btn-ghost` | transparent, text `var(--text-2)` | bg `var(--hover)`, text `var(--text)` |

**Focus ring** (all interactive elements: `.btn`, `.tab`, `.card`, `.key`, `.hit` and the sidebar controls):
`outline:none; box-shadow:0 0 0 1px var(--accent), 0 0 0 4px var(--ring)` on `:focus-visible`.

**`.kbd` (keycap)**
- `font:500 11px/1 JetBrains Mono; min-width:18px; height:18px; padding:0 5px; inline-flex centered`.
- `border:1px solid var(--line-2); border-bottom-width:2px; border-radius:4px; background:var(--raised); color:var(--text-2)`.
- Inside `.btn-primary`: `background:rgba(255,255,255,.16); border-color:rgba(255,255,255,.3); color:#fff`.

**`.av` (avatar)**
- `border-radius:50%; inline-flex centered; font-weight:600; color:var(--text); flex:none`.
- Board 11 adds `box-shadow:0 0 0 2px var(--bg)`, a ring that separates stacked avatars.
- Board 11 sizes: `.s20` = 20×20, font 9px. `.s28` = 28×28, font 11px.
- Board 12 `.av` defaults to 28×28, font 11px, with no ring.

**`.tabs` / `.tab`** (project views nav)
- `.tabs`: `display:flex; gap:2px; border-bottom:1px solid var(--line); overflow-x:auto`. Board 11 adds `position:relative`.
- `.tab`: `height:36px; padding:0 12px; inline-flex; color:var(--text-2); font-weight:500; border-radius:6px 6px 0 0; white-space:nowrap`.
- Hover: `color:var(--text); background:var(--hover)`.
- Active (`aria-current="page"`): `color:var(--text); box-shadow:inset 0 -2px 0 var(--accent)`, a 2px accent underline.

**`.panel`**
- `border:1px solid var(--line); background:var(--surface); border-radius:12px; padding:20px; flex column; min-width:0`.
- Gap is **16px** in board 11 and **14px** in board 12.

**`.ph`** (panel header): `flex; align-items:center; gap:10px`.

**`.stat`**: `border:1px solid var(--line); background:var(--surface); border-radius:12px; padding:16px 18px; flex column; gap:6px`.

**Reduced motion:** `@media (prefers-reduced-motion:reduce)` forces all animation and transition durations to `.001ms`. Board 11 also sets `.draw{stroke-dashoffset:0}`, `.card:hover{transform:none}` and `.sk{animation:none}`. The sidebar has its own reduced-motion block (see 0.6).

**Legacy CSS (unused, ignore):** `.side` (232px), `.nav`, `.pk`, `.prof`, `.pmenu`, `.pmi`, `.pres`, `.sbkbd-unused`, plus top-level `profOpen`/`toggleProf` in the script. The real sidebar uses the `.sb-*` classes. The `.fade` class on `nav.sb` has no CSS rule.

### 0.5 App shell layout

```
div.ds.<theme>.app        display:flex; height:100vh; overflow:hidden
├── div.sbw.sb-host        sidebar wrapper, width 264px (rail 64px), full height
└── main.main              flex:1; min-width:0; overflow:auto   (the scroll container)
    └── div.wrap           max-width:1180px; margin:0 auto; padding:28px 32px 64px;
                           flex column; gap:24px
        ├── header         project header
        ├── nav.tabs       project view tabs
        └── content
```

There is **no top bar**. The project header is the top of the content column.

Responsive, `@media (max-width:760px)`:
- The sidebar is hidden (`.sb-host{display:none!important}`).
- `.mtop` (a hamburger ghost button, 32px wide, padding 0, centered) becomes `inline-flex` as the first header item. Board 11 uses an SVG of 3 lines (`M2.5 4h11M2.5 8h11M2.5 12h11`, 16px, stroke 1.5). Board 12 uses the text glyph `≡`. `aria-label="Open menu"`.
- `.wrap` padding becomes `16px 16px 48px`.
- Board 11: epic rows collapse (see 1.6).
- Board 12: `.step{flex-wrap:wrap}` and `.step .cta{width:100%}`.

### 0.6 Sidebar (identical markup and JS in both boards)

The wrapper `.sbw` has:
- `position:relative; flex:none; height:100%; background:var(--surface); border-right:1px solid var(--line); overflow:hidden; z-index:3`
- `transition:width 220ms var(--ease)`
- Width from JS: **264px** expanded, **64px** collapsed. When collapsed it gets `.israil`, which sets `overflow:visible` so tooltips can escape.

Configuration:
- Board 11: `sbFrame('main', {role, collapsible:true, active:'PR', sub:'overview'})`
- Board 12: `{role:'admin', collapsible:true, active:'MO', sub:'overview'}`

The sidebar's sub-item list does not include `overview`, so on these pages **no sub-item is highlighted**: the indicator has opacity 0. The active project is expanded because `open` defaults to the active project. Its parent row does **not** get `.on`, because `.on` applies only when the project is active and collapsed.

#### Expanded sidebar (`nav.sb`, flex column, height 100%), top to bottom

**1. Workspace row `.sb-ws`**
- Container: `relative; flex; align-items:center; gap:4px; padding:10px 10px 8px`.
- Workspace button `.sb-wsb`:
  - `flex:1; height:36px; padding:0 8px; gap:9px; border-radius:8px; transparent; font:600 13px/1 Inter; color:var(--text)`.
  - Hover or `aria-expanded=true`: bg `var(--hover)`.
  - Contents:
    - **Logo tile** `.sb-xt`: 24×24, radius 6, bg `var(--raised)`, `1px solid var(--line-2)`. It holds a 15×13 SVG (viewBox `0 0 46 39`, overflow visible) built from three paths:
      - `M-4 -4L50 43`, stroke `var(--text)`, width 10.
      - `M50 -5L26 18H39L-4 44`, stroke `var(--surface)`, width 17, miter (knock-out).
      - The same path again, stroke `var(--logo)`, width 10. The result is an X formed by a straight stroke and a lightning-bolt stroke.
    - Workspace name (ellipsis). Default "Platform team".
    - Chevron-down 16px in `var(--text-3)`, path `M4.5 6.5L8 10l3.5-3.5`.
- Collapse button `.sb-icb`:
  - 30×30, radius 7, color `var(--text-3)`. Hover: bg `var(--hover)`, color `var(--text)`.
  - Icon: panel-left with arrow, `M2.5 3h11v10h-11zM6 3v10M10.5 6.5L9 8l1.5 1.5`, stroke 1.4.
  - `aria-label="Collapse sidebar"`.
  - Tooltip appears to the left: "Collapse" + kbd **⌘B**.
- Workspace menu `.sb-menu` (when open):
  - Position `top:48px; left:10px; right:10px`. `role="menu"`, `aria-label="Workspaces"`.
  - Items are `menuitemradio`, each with a badge, a name, and a check icon (`M3.5 8.5l3 3 6-7`, stroke `var(--accent-t)`, 1.7) on the current workspace:
    - **PT** "Platform team" (hue 255)
    - **DG** "Design guild" (300)
    - **PE** "Personal" (155)
  - Admin only: a separator, then "Workspace settings" and "Create workspace".

**2. Search `.sb-search`**
- `margin:0 10px`. Input `.sb-sinp`: `height:34px; padding:0 44px 0 32px; radius 9px; border 1px var(--line-2); bg var(--bg); font 400 13px Inter`.
- Placeholder **"Search or jump…"** in `var(--text-3)`.
- Hover: border `var(--control)`. Focus: border `var(--accent)` + `box-shadow:0 0 0 3px var(--accent-s), 0 0 18px 2px var(--accent-s)` (glow). Transition 150ms.
- Magnifier icon at left 10px (`M7 2.8a4.2 4.2 0 110 8.4 4.2 4.2 0 010-8.4zM10.2 10.2l3.3 3.3`). Kbd **⌘K** at right 8px.
- Visually hidden label "Search".

**3. New task `.sb-new`** (hidden for viewer)
- `height:32px; margin:8px 10px 4px; padding:0 8px 0 10px; radius 8; border 1px var(--line-2); bg var(--raised); font 500 13px`.
- Hover: bg `var(--hover)`, border `var(--control)`. Active: `scale(.98)`.
- Content: plus icon (`M8 3v10M3 8h10`, stroke 1.6), "New task", kbd **C**.

**4. Scroll area `.sb-scroll`**
- `flex:1; overflow-y:auto; padding:4px 10px 10px; scrollbar-width:thin; scrollbar-color:var(--line-2) transparent`.
- When the long-list mode `many` is on, it is masked with a fade at top and bottom.
- Items `.sb-it`: `height:30px; padding:0 8px; gap:10px; radius 7; color var(--text-2); weight 500; 13px`. Hover and `.on`: bg `var(--hover)`, color `var(--text)`.
- Contents in order:
  - **Inbox** (inbox-tray icon) with an unread pill `.sb-unread`: min-width 20, height 18, radius 9, bg `var(--accent-s)`, text `var(--accent-t)`, `600 11px mono`. Value **3** (viewer: 1).
  - **My tasks** (check-circle icon), count **7** in `.sb-count` (`500 11px mono, var(--text-3)`). Hidden for viewer.
  - Section header **"PINNED VIEWS"**.
    - `.sb-sec`: `height:28px; margin-top:14px; padding:0 4px 0 8px; 500 11px mono; letter-spacing:.07em; uppercase; var(--text-3)`.
    - It is a toggle button with a 10px chevron. The chevron rotates −90° when collapsed (180ms).
    - The body collapses with a `grid-template-rows 0fr↔1fr` transition (220ms).
    - Views: "My open bugs" 4 (funnel icon), "Due this week" 9 (calendar icon), "Blocked" 2 (circle-slash icon).
  - Section header **"PROJECTS"** followed by the count (5, or 3 for viewer, 16 for many) in `var(--text-3)` with `letter-spacing:0`. Admin only: a `+` icon button `.sb-icb.sm` (22×22, radius 5) with tooltip "New project". **This is the only create-project entry point on these boards; no flow is shown.**
  - Optional filter input "Filter projects…" (only in `many` mode; max 60 chars; empty result shows "No projects match.").
  - Project rows, each with: badge, name, and a chevron-right 12px that rotates 90° when open (200ms).

    | Badge | Name | Hue |
    |---|---|---|
    | PR | Platform Rebuild | 255 |
    | MO | Mobile App | 175 |
    | IN | Infra | 75 |
    | DS | Design System | 300 |
    | AP | Public API | 25 |

    The full list of 16 adds: BI Billing 140, SE Search 215, ON Onboarding 335, DA Data Pipeline 100, QA QA Automation 50, SC Security 5, DO Docs 230, GR Growth 155, MK Marketing Site 285, PE Performance 195, AN Analytics 60.
  - Expanded project sub-list `.sb-subs`:
    - `margin:2px 0 6px 16px; padding-left:10px; border-left:1px solid var(--line)`.
    - Items `.sb-si`: 30px high, `margin-bottom:2px`. Hover bg `rgba(128,140,170,.08)`. `.on`: text `var(--text)`, icon `var(--accent-t)`.
    - A sliding indicator `.sb-ind` (bg `var(--accent-s)`, radius 7, `transform:translateY(idx*32px)`, transition 220ms spring) marks the current sub-item.
    - Sub-items: **Board, Backlog, Sprints, Objectives, Milestones, Reports**. Viewer sees only Board, Backlog, Objectives and Milestones.

**5. Footer `.sb-foot`** (`padding:8px 10px 10px; border-top:1px solid var(--line); gap:2px`)
- **Sprint widget** `.sb-spr`:
  - `padding:9px 10px; radius 10; border var(--line); bg var(--bg); margin-bottom:6px`.
  - Hover: border `var(--line-2)`, bg `var(--raised)`, `translateY(-1px)` with 150ms spring.
  - Content:
    - 30px progress ring: r 11.5, stroke 3.5, track `var(--raised)`, progress `var(--accent-t)`, `stroke-dasharray:72.3`, offset `72.3*(1-0.65)`, so **65%**. Transition 800ms.
    - "Sprint 14" (600, 13/16).
    - "65% · 7d left" (mono 11/14, `var(--text-3)`).
    - Chevron-right.
  - `aria-label` "Sprint 14, 65 percent, 7 days left. Open board". Click opens PR → Board.
- **Members & roles** (admin only), people icon.
- **Settings** (non-viewer), gear icon, count text "⌘,".
- A help "?" icon button with tooltip "Shortcuts" + kbd **?**.
- **Profile button** `.sb-prof`:
  - Avatar `.sb-av` 30px "AK", with a presence dot `.sb-pres` (9px, `var(--ok)`, ring `0 0 0 2px var(--surface)`).
  - Text: "Alex Kim" (600 13/16) and "Admin · Platform team" (11/14, `var(--text-3)`). The role label is capitalized.
  - Up-down chevron icon.
  - The menu opens upward (`.sb-menu.up`): header "Alex Kim" / "alex@team.dev", then "Profile" (kbd **G P**), "Preferences", separator, "Sign out". **Escape** closes it.

Sidebar menus and tooltips:
- **Menu panel** `.sb-menu`: `padding:4px; radius 10; border var(--line-2); bg var(--raised); shadow var(--shadow-pop); z-index:30`.
  - Entry animation `sbpop` 160ms: `opacity 0, translateY(-4px) scale(.98)` → none.
  - The `.up` variant uses `sbpopup`: `translateY(4px)` → none.
- **Menu item** `.sb-mi`: height 30, radius 6, `500 13px`, hover bg `var(--hover)`.
- **Separator** `.sb-sep`: 1px `var(--line)`, `margin:4px -4px`.
- **Tooltips** `.sb-tip`:
  - `padding:5px 8px; radius 6; bg var(--raised); border var(--line-2); shadow-pop; 12px 500`.
  - Hidden state: `opacity 0`, `translate(-4px,-50%)`. On hover or focus-within they appear after a **150ms delay** (opacity 120ms, transform 150ms).

#### Collapsed rail (`.sb-rail`, 64px)
- Column layout, items centered, `gap:4px`, `padding:10px 0`.
- Buttons `.sb-ri`: 40×36, radius 8, `var(--text-2)`. Hover and `.on`: bg `var(--hover)`.
- Items, top to bottom:
  - Logo (click expands the sidebar).
  - Search (tooltip "Search ⌘K").
  - New task (bordered, `var(--raised)` bg; tooltip "New task C").
  - Separator `.sb-rsep` (28px × 1px `var(--line)`, margin 6px 0).
  - Inbox, with an unread dot `.sb-dot` (7px, `var(--accent-t)`). Tooltip "Inbox 3 G I".
  - My tasks (tooltip "My tasks G M").
  - Separator.
  - Up to 6 project badges (22×22, 10px font).
  - Spacer.
  - Sprint ring (24px, stroke 4; tooltip "Sprint 14 · 65% · 7d left").
  - Settings (⌘,).
  - Expand button (tooltip "Expand ⌘B").
  - Account avatar 28px (tooltip "Alex Kim · Admin").

Touch variant (`.touch`): item and menu rows 42px, indicator 42px with a 44px step, New task and search 44px.

Sidebar reduced motion: all sidebar transitions and animations are disabled.

### 0.7 Project tabs (both boards; same order)

**Overview** (active), **Board**, **Backlog**, **Sprints**, **Milestones**, **Objectives**. These are anchor links: `#overview`, `#board`, and so on, with `aria-label="Project views"`.
The sidebar sub-list has no "Overview" entry and adds a "Reports" entry that is not among the tabs.

---

## 1. Board 11: Project overview (populated project)

**Purpose:** a dashboard for an established project, "Platform Rebuild" (key PRJ). It shows KPIs, objectives, a milestone timeline, epics, the active sprint burndown and recent activity, with loading and error states and role gating.
**Viewport:** 1440 × 1900. The content column is capped at 1180px and centered inside `main`, which is 1440 − 264 = 1176px wide. In practice the content is about 1112px wide after the 32px side padding.

### 1.1 Project header (`header`)

Layout: `display:flex; flex-wrap:wrap; align-items:flex-start; gap:16px`. Children, left to right:

1. `.mtop` hamburger (mobile only).
2. **Project tile**: 44×44, `border-radius:10px`, bg `var(--raised)`, `1px solid var(--line-2)`, text **"PR"** in `600 13px/1 JetBrains Mono`, centered.
3. **Title block**: `flex:1 1 320px; min-width:0; flex column; gap:6px`.
   - Row (`flex; align-items:center; gap:10px; wrap`):
     - `h1` **"Platform Rebuild"**.
     - **Key chip** `.key` **"PRJ"**:
       - `height:22px; padding:0 6px; gap:6px; radius 5; border 1px var(--line-2); transparent; color var(--text-2); 500 12px/1 mono`. Hover: bg `var(--hover)`, color `var(--text)`.
       - `aria-label="Copy project key PRJ"`.
       - **Click** writes "PRJ" to the clipboard (`navigator.clipboard.writeText`, errors swallowed). It then shows **"Copied"** (`role="status"`, 12px, `var(--ok)`) next to the chip for **1400ms**.
   - Description: **"Rebuild the board and sprint engine so every interaction lands under 100ms."** (`color:var(--text-2); 13px/20px`).
4. **Actions** (`flex; align-items:center; gap:12px; wrap`):
   - **Member stack** (`role="group"`, `aria-label="8 members"`, `padding-left:6px`). 28px avatars, each with `margin-left:-6px` and the 2px `var(--bg)` ring:
     - AK (285), JL (200), SP (20), RC (150).
     - Overflow "+4": bg `var(--hover)`, text `var(--text-2)`.
   - **Invite** (`.btn.btn-sec.sm`). Admin only.
   - **New task** + kbd **C** (`.btn.btn-primary.sm`). Hidden for viewer.

### 1.2 Tabs

See 0.7.

### 1.3 Content states (prop `state`)

**Error** (`isError`)
- Container: `.panel` with `align-items:flex-start; padding:40px 32px; role="alert"`, gap 16.
- Contents:
  - A 16px circle in `var(--danger)` holding "!" (`700 10px Inter`, color `var(--bg)`).
  - **"Couldn’t load the overview"** (b, 15px, 600). Note the curly apostrophe.
  - **"The board and tasks still work; only these summaries failed."** (13px, `var(--text-2)`).
  - A row (gap 10) with a **Retry** button (`.btn-sec.sm`) + kbd **R**, and a mono caption **"ref 2c91e4"**, an error reference id.
- Retry behavior: switch to `loading`, wait **900ms**, switch to `ready`, then replay the entry animation.

**Loading** (`isLoading`)
- `aria-busy="true"`, `aria-label="Loading overview"`. Column layout, gap 24.
- Row 1: grid `repeat(auto-fit,minmax(min(220px,100%),1fr))`, gap 12, with 3 skeletons 88px tall.
- Row 2: flex wrap, gap 24. Skeletons `flex:999 1 560px; height:420px` and `flex:1 1 320px; height:420px`.
- `.sk` shimmer:
  - `border-radius:6px; background:linear-gradient(90deg, var(--raised) 0%, var(--hover) 50%, var(--raised) 100%); background-size:200% 100%`.
  - `animation: shimmer 1.4s linear infinite`, where `@keyframes shimmer{from{background-position:200% 0}to{background-position:-200% 0}}`.
- A `.spin` spinner (14px, 2px `var(--line-2)` border, top `var(--text)`, `spin .7s linear infinite`) is defined in CSS but not used.

**Ready** (`isReady`): sections 1.4 to 1.9.

### 1.4 KPI stat row

Grid `repeat(auto-fit, minmax(min(220px,100%), 1fr))`, gap 12px, with three `.stat` cards. Each is a column: `.cap` label, `.big` number, `.cap` footnote.

| Label | Value (counts up) | Extra | Footnote |
|---|---|---|---|
| "Open tasks" | **64** | | "across 4 epics" |
| "Overdue" | **5** | Pill **"Needs attention"** inline after the number (`.big` becomes `flex; gap:10px`). The pill's border is the current color `var(--danger)` (height 20, font 11) and its inner text is `var(--text)`. | "oldest: PRJ-18, 6 days late" |
| "Completed this week" | **23** | | "17 last week" |

`.pill`: `inline-flex; gap:6px; height:22px; padding:0 8px; radius 6; border 1px var(--line-2); 12px 500; color var(--text-2); nowrap`.

### 1.5 Two-column body

`display:flex; flex-wrap:wrap; gap:24px; align-items:flex-start`.
- Left column: `flex:999 1 560px; min-width:0; flex column; gap:24px`.
- Right column: `flex:1 1 320px; min-width:0; flex column; gap:24px`.

The columns stack when the width cannot fit 560 + 24 + 320.

### 1.6 Left column

#### A. Objectives panel

**Header:** `h2` "Objectives", mono `.cap` "3", spacer, ghost small button-link **"View all"** (`#objectives`).

**Grid:** `repeat(auto-fit, minmax(min(200px,100%), 1fr))`, gap 12, holding objective cards (`a.card` → `#objective`).

**`.card`**
- `flex column; gap:12px; padding:16px; radius 10; border 1px var(--line); bg var(--bg)`.
- Hover: border `var(--line-2)`, `translateY(-2px)`, `box-shadow:var(--shadow-pop)`.
- Transitions: border 120ms ease, transform 150ms **spring**, shadow 150ms ease.

**Row 1** (`flex; align-items:center; gap:14px`):
- A 56×56 progress ring SVG:
  - Track: `r=23`, stroke `var(--raised)`, width 5.
  - Progress (`.rg`): stroke = objective color, width 5, round caps, `dasharray 144.5`, `dashoffset = 144.5*(1-pct/100)`, rotated −90°. Transition `stroke-dashoffset 700ms var(--ease)`.
  - Centered label "{shown}%" (12px 600, tabular-nums), counting up.
- Objective name (600, 14/20).

**Row 2** (`flex; gap:8px; wrap; align-items:center`):
- Status pill containing a status glyph and the status text.
- `.cap` task count.
- 20px owner avatar pushed right (`margin-left:auto`).

**Data:**

| Name | % | Ring color | Status | Glyph (color) | Tasks | Owner |
|---|---|---|---|---|---|---|
| Cut p95 latency to 200ms | 68 | `var(--accent-t)` | On track | g-progress (`var(--warn)`) | "18 tasks · 12 done" | AK |
| Ship beta on time | 42 | `var(--warn)` | At risk | g-progress (`var(--warn)`) | "24 tasks · 10 done" | JL |
| Zero P1 incidents in Q4 | 85 | `var(--ok)` | On track | g-review (`var(--info)`) | "7 tasks · 6 done" | RC |

**Status glyphs `.g`** (14×14 circle, `position:relative`, inline-block):
- `.g-todo`: `border:1.5px solid currentColor`.
- `.g-progress`: border 1.5px + `padding:2px; background:conic-gradient(currentColor 0 180deg, transparent 0) content-box`, a half-filled pie.
- `.g-review`: same construction at 270deg, a three-quarter pie.
- `.g-done`: filled `currentColor`, with `::after` drawing a check mark (left 4, top 2, 3×6, border right/bottom 1.5px `var(--bg)`, rotate 45°).

#### B. Milestones panel (timeline)

**Header:** "Milestones", `.cap` **"Sep – Dec 2026"**, spacer, **"View all"** (`#milestones`).

**Body:** wrapper `overflow-x:auto; padding:4px 0`, containing `.tl` (`position:relative; height:150px; min-width:620px`, `role="list"`).

- **Track** `.track`: `absolute; left:0; right:0; top:74px; height:2px; bg var(--line-2); radius 1`.
  - Fill span: bg `var(--text-2)`, width animates 0 → **29.8%** over 700ms ease.
- **Today marker** `.today`:
  - `left:29.8%; top:40px; height:70px; border-left:1px dashed var(--accent-t)`.
  - Label "Today": `top:-18px; left:-20px; 500 11px mono; var(--accent-t)`.
- **Milestone** `.ms`: `absolute; top:0; bottom:0; width:150px; margin-left:-8px; left:{x}%`.
  - Dot: `top:67px`, 16×16 circle, bg `var(--surface)`, `2px solid var(--control)`.
    - `.done`: bg and border `var(--ok)`.
    - `.cur`: border `var(--accent)` + `box-shadow:0 0 0 4px var(--accent-s)`.
  - Label `.lab`: `absolute; left:0; width:150px; flex column; gap:4px`. `.up` sits at `top:0`; `.dn` sits at `top:96px`. Labels alternate below and above the track.
  - Label contents:
    - Name (600).
    - Mono `.cap` "{date} · {pct}%".
    - A 96px-wide `.bar`: `height:6px; radius 3; bg var(--raised); border 1px var(--line); overflow hidden`. The fill span has radius 3, the milestone color as background, and a width that animates over 700ms.

**Data:**

| Name | Date | x | % | Class | Label position | Color |
|---|---|---|---|---|---|---|
| Alpha | Sep 12 | 9.1% | 100 | done | dn | `var(--ok)` |
| Beta launch | Oct 21 | 41.3% | 64 | cur | up | `var(--accent-t)` |
| Release candidate | Nov 18 | 64.5% | 20 | (none) | dn | `var(--text-2)` |
| General availability | Dec 9 | 81.8% | 0 | (none) | up | `var(--text-2)` |

#### C. Epics panel

**Header:** "Epics", mono `.cap` "4". There is no View all link.

**List:** `role="list"`. Each row `a.erow` (→ `#epic`) has:
- `display:grid; grid-template-columns:minmax(0,1.4fr) minmax(120px,1fr) 64px 110px 24px; gap:16px; align-items:center; min-height:44px; padding:0 10px; margin:0 -10px; radius 8`.
- Hover: bg `var(--hover)`.

Columns:
1. Glyph + name (500, ellipsis), gap 10.
2. `.hide-sm`: a flexible `.bar` (fill `var(--text-2)`, animated width) and a mono `.cap` percentage (width 34, right-aligned).
3. Mono `.cap` count "done/total".
4. `.hide-sm` milestone `.pill` (`justify-self:start`).
5. 20px avatar.

Under 760px the grid becomes `minmax(0,1fr) 64px 24px` and the `.hide-sm` columns are hidden.

**Data:**

| Name | % | Count | Milestone | Glyph / color | Owner |
|---|---|---|---|---|---|
| Auth overhaul | 72 | 13/18 | Beta launch | g-progress `var(--warn)` | AK |
| Board performance | 45 | 9/20 | Beta launch | g-progress `var(--warn)` | JL |
| Sprint engine | 30 | 6/20 | Release candidate | g-progress `var(--warn)` | RC |
| Billing v2 | 0 | 0/12 | General availability | g-todo `var(--todo)` | SP |

### 1.7 Right column

#### D. Sprint panel ("Sprint 14")

**Header:** `h2` "Sprint 14", then a pill **"Active"** (height 20, font 11) containing a 10×10 `g-progress` glyph in `var(--warn)`, then a spacer and `.cap` **"7 days left"**.

**Headline row** (`flex; align-items:baseline; gap:8px`): `.big` overridden to **24px/30px**, counting up to **34**, followed by `.cap` "of 52 points done".

**Burndown chart** `.chart` (`relative; height:160px`):
- SVG: `width:100%; height:160`, `viewBox 0 0 348 160`, `preserveAspectRatio="none"`.
  - `aria-label`: "Burndown: 18 of 52 points remaining on day 6, ahead of the ideal line".
- Gridlines from x=28 to x=348:
  - y=10 and y=70 in `var(--line)` 1px.
  - y=130 (baseline) in `var(--line-2)`.
- Ideal line: `(28,10)` → `(348,130)`, `var(--text-3)`, width 1.5, `dasharray 4 4`, `vector-effect:non-scaling-stroke`.
- Remaining polyline `.draw`:
  - Points `28,10 52.6,16.9 77.2,21.5 101.8,37.7 126.5,46.9 151.1,67.7 175.7,88.5`, which correspond to remaining points 52, 49, 47, 40, 36, 27, 18 on days 1–7.
  - Stroke `var(--accent-t)`, width 2, round joins and caps, non-scaling.
  - Draw-on animation: `.draw{stroke-dasharray:400; stroke-dashoffset:400}`. Once `.wrap` gets `.on`, it runs `drawline 800ms var(--ease) forwards` to `stroke-dashoffset:0`.
- "Now" vertical line: x=175.7 from y4 to y130, `var(--accent-t)`, width 1, `dasharray 2 3`, opacity .6.
- Axis labels (mono `.cap`, font 10px, absolutely positioned):
  - "52" at left 0 / top 2.
  - "26" at left 0 / top 62.
  - "0" at left 4 / top 122.
  - "Oct 1" at left 28 / bottom 0.
  - "Oct 7" at left 48% / bottom 0.
  - "Oct 14" at right 0 / bottom 0.

**Hover hit areas** `.hits`: `absolute; left:28px; right:0; top:0; bottom:22px; display:flex`, holding 14 `button.hit` elements (`flex:1`, transparent, `cursor:crosshair`).
- Hover and focus-visible: bg `rgba(128,128,150,.08)`.
- Each hit area shows a tooltip on mouseenter or focus and hides it on mouseleave or blur.
- Tooltip text (also the `aria-label`):
  - Days 1–7: `"Oct {n}: {rem} pts left, ideal {52-4*(n-1)}"`, for example "Oct 6: 27 pts left, ideal 32".
  - Days 8–14: `"Oct {n}: not started, ideal {…}"`.
- Tooltip `.tip`:
  - Position `absolute; top:4px; left:{8 + (i+0.5)*(92/14)}%; transform:translateX(-50%)`.
  - Style `padding:6px 8px; radius 6; border var(--line-2); bg var(--raised); shadow-pop; 12px; nowrap; pointer-events:none; z-index:2`.

**Legend row** (`flex; gap:16px; wrap; align-items:center`):
- `.cap` "Remaining" with a 16×2 swatch in `var(--accent-t)`.
- `.cap` "Ideal" with a 16px swatch drawn as `border-top:1.5px dashed var(--text-3)`.
- Ghost small link **"Open sprint"** (`#sprint`), `margin-left:auto`.

#### E. Recent activity panel

**Header:** "Recent activity". The list has `role="feed"`.

**Item** `article.act`: `flex; gap:10px; padding:8px 0; 13px/20px; color var(--text-2)`.
- 20px avatar (`margin-top:1px`).
- Sentence: `<b>` actor (`var(--text)`, 500), the verb, the task key in mono 12px `var(--text)`, then the remaining text.
- `.cap` relative time (nowrap).

**Copy (verbatim data):**

| Actor | Verb | Key | Rest | When |
|---|---|---|---|---|
| Alex Kim | completed | PRJ-29 | Command palette v1 | 12m |
| Jordan Lee | moved | PRJ-51 | to In review | 40m |
| Riley Chen | commented on | PRJ-33 | (none) | 1h |
| Sam Patel | created | PRJ-52 | Empty state for new workspaces | 3h |
| Alex Kim | linked | PRJ-42 | to Cut p95 latency | 5h |
| Jordan Lee | moved milestone | (none) | Beta launch to Oct 21 | Yesterday |

### 1.8 Entry animation (script `run()`)

1. **On mount:** `t=0`, `on=false`.
2. **After 60ms:** `on=true`. This adds `.on` to `.wrap`, which triggers:
   - the burndown draw-on (800ms),
   - the ring dashoffsets moving from 144.5 to target (700ms ease),
   - the milestone and epic bar widths moving from 0 to target (700ms),
   - the track fill moving from 0 to 29.8%.
3. **In parallel:** a `requestAnimationFrame` loop runs `t` from 0 to 1 over **800ms**. Numbers count up with easeOutCubic `e = 1-(1-t)^3`:
   - Open tasks 64, Overdue 5, Completed 23, sprint points 34.
   - Each objective's `%` label.
4. **Reduced motion:** jump straight to `t=1`, `on=true`.

Retry re-runs this sequence. The loop stops on unmount.

### 1.9 Role gating summary (board 11)

| Element | admin | member | viewer |
|---|---|---|---|
| Header "Invite" | yes | no | no |
| Header "New task" | yes | yes | no |
| Sidebar New task / My tasks | yes | yes | no |
| Sidebar "+ New project" | yes | no | no |
| Workspace settings / Create workspace | yes | no | no |
| Members & roles | yes | no | no |
| Settings | yes | yes | no |
| Projects in sidebar | 5 | 5 | 3 |
| Sidebar sub-items | 6 | 6 | Board, Backlog, Objectives, Milestones |
| Inbox count | 3 | 3 | 1 |

---

## 2. Board 12: Project overview, new project (onboarding / empty state)

**Purpose:** the overview of a project created moments ago, "Mobile App" (key MOB). The user is the only member. An interactive **"Set up your project"** checklist drives the user through 6 steps. Every widget shows an empty state that fills in as steps are completed, and a success banner appears when all steps are done.
**Viewport:** 1440 × 1500. The shell, sidebar (MO active and expanded, role admin), `.wrap` and tabs are the same as board 11.

### 2.1 Header

Same flex layout as board 11. Differences:

- Project tile **"MO"**.
- Title row (`flex; gap:10px`, no wrap):
  - `h1` **"Mobile App"**.
  - A **static** key badge (not a button): mono `.cap` "MOB" with `border:1px solid var(--line-2); border-radius:5px; padding:4px 6px`.
- Subtitle **"Created just now"**: 13px, `var(--text-3)`. There is no description.
- Actions (`gap:12px`):
  - A single 28px avatar "AK" (hue 285, no ring) with `role="img"`, `aria-label="Only member: you"`.
  - **"Invite teammates"** (`.btn-sec.sm`). Click marks the *invite* step done.
  - **"New task"** + kbd **C** (`.btn-primary.sm`). Click marks the *tasks* step done.

### 2.2 Tabs

The same six tabs, with Overview active.

### 2.3 Success banner (shown only when all 6 steps are done)

`.win` (`role="status"`):
- `flex; align-items:center; gap:14px; padding:18px 20px; radius 14; border 1px solid var(--ok); bg var(--surface)`.
- Entry: `fade 220ms var(--ease)`, from `opacity 0, translateY(6px)`.

Contents:
- Bolt SVG `.bolt`: 28×24, viewBox `0 0 46 39`, path `M50 -5L27 17H38L-4 44`, stroke `var(--logo)`, width 9, miter.
  - Animation `boltflash 600ms var(--ease) both`: 0% `opacity 0, scale(.4) rotate(-12deg)` → 40% `opacity 1, scale(1.15)` → 100% `scale(1)`.
- Text column (gap 2):
  - **"Mobile App is ready to ship"** (b, 15px, 600).
  - `.cap` **"Setup complete."**
- Ghost small button **"Replay setup"**. It resets to `done={create:true}`, `last=null`, `skipped=false`.

### 2.4 Setup checklist card (shown while not all done and not skipped)

`section.setup`: `border:1px solid var(--line-2)` (stronger than `.panel`), `bg var(--surface); radius 14px; padding:24px; flex column; gap:18px`.

**Header row** (`flex; align-items:center; gap:16px; wrap`):
- Title column (`flex:1 1 320px`, gap 4):
  - `h2` **"Set up your project"**: 18px/26px, 600, `letter-spacing:-.01em`.
  - **"About 5 minutes"**: 13px, `var(--text-2)`.
- Progress group (gap 10):
  - Mono `.cap` "{doneCount}/6". Starts at **1/6**.
  - Progress bar `.prog` (`role="progressbar"`, `aria-valuenow` = pct): `width:180px; height:6px; radius 3; bg var(--raised); border var(--line); overflow hidden`.
    - Fill: bg `var(--ok)`, width `round(done/6*100)%` (starts at 17%), transition `width 300ms var(--ease)`.
- Ghost small **"Skip setup"**. It sets `skipped=true` and hides the checklist. **The design offers no way to un-skip; no banner appears.**

**Steps list** `ol` (no list style; flex column; gap 8px). Each `li.step`:
- `flex; align-items:center; gap:14px; padding:12px 14px; radius 10; border 1px var(--line); bg var(--bg)`.
- Transition: border-color and background 120ms.
- **`.next`** (the first incomplete step): `border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-s)`.

Step contents:
1. **Status ring** `.ring` (`role="img"`, `aria-label` "Done" or "Not done"):
   - 22×22 circle with a `2px solid var(--control)` border.
   - `.ok`: border and bg `var(--ok)`. `::after` draws a check (left 5, top 1, 5×10, border right/bottom 2px `var(--bg)`, rotate 45°).
   - `.fx` (only on the step just completed, `state.last`):
     - The ring runs `pop 260ms var(--spring)`: scale .7 → 1.18 at 60% → 1.
     - The check runs `draw 200ms var(--ease) 80ms both`: `clip-path inset(0 100% 100% 0)` → `inset(0 0 0 0)`.
     - `::before` spark burst: a 4px `var(--spark)` dot with six box-shadow copies at `(0,-16) (14,-8) (14,9) (0,16) (-14,9) (-14,-8)`. It runs `spark 460ms var(--ease) both`: opacity 1 / scale .3 → opacity 0 / scale 1.5. `pointer-events:none`.
2. **Text** (flex 1, column, gap 2):
   - Title (600). Completed steps get `.done-t` (`color:var(--text-3); text-decoration:line-through`).
   - `.cap` description at 12px/18px.
3. **CTA group** `.cta` (flex, gap 8), shown only while the step is todo:
   - An optional ghost alternate button.
   - The main button: **`btn-primary` for the `.next` step and `btn-sec` for the others**, with label + kbd.
   - Every CTA (including the alternate) **marks the step done**: `done[id]=true; last=id`.

**Steps (verbatim):**

| # | id | Title | Description | CTA | Kbd | Alt |
|---|---|---|---|---|---|---|
| 1 | create | Create the project | Mobile App · key MOB | (none; done initially) | | |
| 2 | invite | Invite your team | Members can create and edit | Invite | I | |
| 3 | objective | Add an objective | What does success look like? | Add objective | O | |
| 4 | milestone | Plan a milestone | A dated checkpoint | Add milestone | M | |
| 5 | tasks | Create your first tasks | Type them or import a CSV | New task | C | "Import CSV" (ghost) |
| 6 | sprint | Start a sprint | Plan the next 1–2 weeks | Start sprint | S | |

Initial state: `done = {create:true}`, so 1/6 and "Invite your team" is `.next`. Steps can be completed in any order, and `.next` always moves to the first incomplete step.

The kbd hints (I, O, M, C, S) imply global keyboard shortcuts. The prototype does not wire key handlers.

### 2.5 KPI row (same grid as board 11)

| Label | Value | Footnote |
|---|---|---|
| Open tasks | **0**, or **3** after the tasks step | "Create one with C", or "MOB-1 to MOB-3" after the tasks step |
| Overdue | 0 | "Nothing late" |
| Completed this week | 0 | "Your first done task lands here" |

Numbers are muted (`.big` uses `var(--text-3)`). There is no count-up.

### 2.6 Two-column body (same flex rules as board 11)

#### Left column

**Objectives panel** (header "Objectives" only; no count or View all)
- **Empty state** `.empty` (`flex column; align-items:flex-start; gap:8px; padding:6px 0`):
  - Icon tile `.eico`: 36×36, radius 9, `1px dashed var(--line-2)`, color `var(--text-2)`. It holds an 18px target icon (viewBox 14: circles r 5.2 and r 2, stroke 1.3).
  - **"No objectives yet"** (b 600).
  - **"Define what success looks like."** (13px, `var(--text-2)`, max-width 420).
  - **"Add objective"** + kbd **O** (`.btn-sec.sm`). Marks the objective step done.
- **After the objective step:** a row (`flex; gap:12; padding:12; border var(--line); radius 10; bg var(--bg)`) with:
  - A 40px circle with `4px solid var(--raised)` border and "0%" (11px 600) inside.
  - **"Launch on both app stores"** (b 600).
  - `.cap` "0 tasks linked yet".

**Milestones panel** (header only)
- Track `.track` (`relative; height:56px`). `::before` draws the line: `top:27px; border-top:2px dashed var(--line-2)`, full width. **The line is dashed here, not solid as in board 11.**
- Today marker `.today`: `left:8%; top:6px; height:44px; border-left:1px dashed var(--accent-t)`. Label "Today" at `top:-2px; left:6px`, `500 11px mono`, `var(--accent-t)`. The label sits to the right of the line.
- **Empty:** "No milestones yet." (13px `var(--text-2)`) + **"Add milestone"** (`.btn-sec.sm`), in a flex row with gap 12 and wrap.
- **After the milestone step:** a dot at `left:62%; top:20px` (16px, `2px solid var(--accent)`, bg `var(--surface)`) and a label **"Store beta · Dec 1"** at `left:62%; top:42px; margin-left:-10px` (12px 600).

**Epics panel**
- "No epics yet." (13px `var(--text-2)`) + ghost small **"+ New epic"** (`margin-left:-10px`). It has no handler and is never filled.

#### Right column

**"Active sprint" panel**
- **Empty:** **"No active sprint"** (b 600) + a note: "Add tasks first." before the tasks step, "Tasks ready." after it.
- **"Start sprint"** (`.btn-sec.sm`) appears **only after the tasks step** (`canSprint`). This is a dependency: you cannot start a sprint without tasks.
- **After the sprint step:** **"Sprint 1 · 14 days"** (b 600) + `.cap` **"0 of 3 points done · burndown appears after day 1"**.

**"Recent activity" panel**
- Rows: `flex; gap:10px; 13px/20px; var(--text-2)`. Each has a 20px AK avatar (`margin-top:1px`), **"You"** (b, `var(--text)`, 500), the action text, and a `.cap` time.
- Items are prepended newest-first. Every one is stamped "just now":
  - sprint → "started Sprint 1"
  - tasks → "created MOB-1, MOB-2, MOB-3"
  - milestone → "added milestone Store beta"
  - objective → "added objective Launch on both app stores"
  - invite → "invited 3 teammates"
  - always present (last) → "created this project"
- The feed order is fixed by step type, not by completion time.

### 2.7 Interactions, state and data (board 12)

**State:** `{ done:{create:true}, last:null, skipped:false }`.

**Handlers that mark a step done:**

| Handler | Step |
|---|---|
| Header "Invite teammates" (`s1`) | invite |
| Objectives "Add objective" (`s2`) | objective |
| Milestones "Add milestone" (`s3`) | milestone |
| Header "New task" (`s4`) | tasks |
| Sprint "Start sprint" (`s5`) | sprint |

The checklist CTAs mark the same steps. In a real build each would open the matching flow (invite dialog, objective form, milestone form, task create or CSV import, sprint start) and complete the step on success.

**Derived values:**
- `doneCount`, `pct = round(doneCount/6*100)`
- `showSetup = !allDone && !skipped`
- `allDone = doneCount === 6`

---

## 3. Data fields and backend implications

### Project
- `badge` (2-letter tile text), `name`, `key` (PRJ / MOB, copyable), `description`, `hue` (badge color), `createdAt` (shown as "Created just now").
- Members: a count ("8 members"), the first 4 avatars (initials + hue), and an overflow "+N".

### KPIs
- Open tasks + epic count.
- Overdue count + oldest overdue key + days late.
- Completed this week + last-week comparison.

### Objective
- name, percent complete, status (On track / At risk, mapped to glyph and color), task total/done, owner (initials, hue), ring color by health.

### Milestone
- name, date, percent, state (done / current / upcoming), position on a date range ("Sep – Dec 2026"), plus a "today" position.

### Epic
- name, status glyph, percent, done/total count, linked milestone, owner.

### Sprint
- name/number, status (Active), days left, points done/total, daily remaining-points series, an ideal line (linear from total to 0 across 14 days), and a sprint date range (Oct 1 – Oct 14). The sidebar repeats the percent and days left.

### Activity
- actor, verb (completed / moved / commented on / created / linked / moved milestone / started / added / invited), optional task key, trailing text, relative timestamp ("12m", "1h", "Yesterday", "just now").

### Onboarding
- A per-project setup checklist state that persists which steps are done, plus a "skipped" flag.

### Errors
- The overview summaries endpoint can fail independently of board/tasks ("only these summaries failed"). The error shows a short reference id ("ref 2c91e4") and supports a Retry.

### Permissions
- Roles admin / member / viewer gate UI elements (see 1.9).

### Shortcuts implied (not implemented in the prototype)

| Scope | Keys |
|---|---|
| Global | ⌘K search, ⌘B toggle sidebar, C new task, ⌘, settings, ? shortcuts, G I inbox, G M my tasks, G P profile |
| Error state | R retry |
| Setup | I invite, O objective, M milestone, S sprint |
