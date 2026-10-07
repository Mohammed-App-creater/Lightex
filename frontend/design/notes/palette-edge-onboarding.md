# Command palette, edge screens and onboarding — build spec

Sources (both read in full, markup + CSS + `text/x-dc` logic):
- `clean/22-Command-palette.html` — board title "Search and commands"
- `clean/23-Edge-screens-amp-onboarding.html` — board title "Edge screens and onboarding"

Target: Next.js + Tailwind, palette built on **cmdk**. Everything below is taken from the files. Notes marked **[impl]** are my implementation advice and are not in the design.

> **Not in these boards (do not invent from here):** maintenance screen, archived-project screen, a full-page global search, a keyboard-shortcuts help dialog, and a palette "recents" management UI. The only "Recent" is a palette section. The only shortcut list is the palette's action hints (section 1.11). Nothing is labeled v2 or "coming soon".

---

## 0. Shared foundation (identical in both files)

### 0.1 Theme tokens (`.t-navy` default, `.t-dark`, `.t-light`)

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
| --av-l / --av-c (avatar oklch) | .40 / .10 | .40 / .10 | .90 / .06 |
| --pk-l / --pk-c (project badge bg) | .32 / .07 | .32 / .06 | .93 / .04 |
| --pkt-l / --pkt-c (badge text) | .88 / .09 | .88 / .08 | .42 / .12 |
| --logo | #3B7BFF | #3B7BFF | #1D4ED8 |
| --scrim | rgba(2,5,14,.6) | rgba(5,5,8,.55) | rgba(18,18,23,.28) |
| --warn-s *(file 23 only)* | rgba(245,183,59,.12) | rgba(245,183,59,.12) | #FFF6E0 |
| --ok-s *(file 23 only)* | rgba(74,222,128,.12) | rgba(74,222,128,.12) | #E7F6EC |
| --danger-s *(file 23 only)* | rgba(255,122,112,.12) | rgba(255,122,112,.12) | #FDECEA |

Motion tokens on `.ds`: `--ease: cubic-bezier(.16,1,.3,1)` and `--spring: cubic-bezier(.34,1.56,.64,1)`.
Base text: `font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif; font-size: 13px; color: var(--text); background: var(--bg); -webkit-font-smoothing: antialiased`, with `box-sizing: border-box` on everything. Mono is `'JetBrains Mono', ui-monospace, monospace`.
Reduced motion: `@media (prefers-reduced-motion: reduce)` sets every animation and transition duration to `.001ms !important`. File 23 also sets `animation-iteration-count: 1 !important`.

### 0.2 Shared atoms
- **Kbd `.tp-kbd`**: `font: 500 11px/1 JetBrains Mono`, min-width 18px, height 18px, padding `0 5px`, inline-flex centered, `border: 1px solid var(--line-2)` with `border-bottom-width: 2px`, radius 4px, bg `--raised`, color `--text-2`.
- **Status glyph `.tp-g`** (14×14 circle, colored through `color:`):
  - backlog: `1.5px dashed currentColor`, color `--text-3`
  - todo: `1.5px solid`, color `--todo`
  - progress: 1.5px border, `padding: 2px`, `conic-gradient(currentColor 0 180deg, transparent 0) content-box`, color `--warn`
  - review: same as progress but 270deg, color `--info`
  - done: filled `currentColor` plus a checkmark `::after` (left 4px, top 2px, 3×6px, `border: solid var(--bg)`, widths `0 1.5px 1.5px 0`, `rotate(45deg)`), color `--ok`
  - cancel: 1.5px solid, color `--text-3`
  - `.fx` celebration (palette file): `tppop 240ms var(--spring)` (scale .6 → 1.2 at 60% → 1). `::before` draws six 3px `--spark` dots at offsets (0,-11) (10,-5) (10,6) (0,11) (-10,6) (-10,-5) and runs `tpspark 440ms var(--ease)` (scale .3, opacity 1 → scale 1.8, opacity 0).
  - Status labels: Backlog, Todo, In progress, In review, Done, Canceled.
- **Priority bars `.tp-bars`**: inline-flex, align flex-end, gap 1.5px, height 12px. Four 3px-wide bars (radius 1px) at heights 4, 7, 10 and 12px. Inactive bars are `--line-2`. Class `.nN` fills the first N bars with currentColor. Mapping: 4 = Urgent n4 `--danger`, 3 = High n3 `--orange`, 2 = Medium n2 `--warn`, 1 = Low n1 `--low`, none = "No priority" `--text-3`.
- **Avatar `.tp-av`**: 20×20 circle, font 9px/600, color `--text`, bg `oklch(var(--av-l) var(--av-c) <hue>)`. `.l` is 36×36 / 13px.
- **Project badge `.badge`**: radius 5px, `font: 600 8.5px/1 JetBrains Mono` (file 23: 9px with min-width 22px and padding `0 4px`), 22×20, bg `oklch(var(--pk-l) var(--pk-c) var(--h))`, text `oklch(var(--pkt-l) var(--pkt-c) var(--h))`. `.badge.l` is 36×36, radius 8px, 11px.
- **Logo**: the wordmark "Lighte" plus an SVG "x" symbol (viewBox 0 0 46 39). The symbol is a backslash stroke `M-4 -4L50 43`, `--text`, stroke-width 9.5, masked by a knocked-out bolt. The bolt is `M50 -5L27 17H38L-4 44`, `--logo`, stroke-width 8.5, miter join. Wordmark `.logo` is weight 600, `letter-spacing: -.04em`, line-height 1, inline-flex baseline. The `.lx` svg is `.644em × .546em` with `margin-left: .02em`.
- **Board frame chrome** (doc only, not product): `figcaption` 14px/600 with a meta span `500 11px/1 mono --text-3`. Device `.dev` is `1px solid --line-2`, radius 14px (phone 28px), `overflow: hidden`. The phone status bar `.phone-bar` is 36px tall, padding `0 26px`, `600 12px mono`, and shows "9:41" and "5G".
- **Focus ring (everywhere)**: `outline: none; box-shadow: 0 0 0 1px var(--accent), 0 0 0 4px var(--ring)`.
- **Skeleton `.sk`**: radius 4px, `linear-gradient(90deg, --raised 0%, --hover 50%, --raised 100%)`, `background-size: 200% 100%`, `sk 1.2s linear infinite` (background-position 200% 0 → -200% 0).

---

## 1. Command palette (file 22)

Board: 1440×2480, padding 64px 80px, gap 40px. Header eyebrow is "SCREENS · COMMAND PALETTE" (500 12px mono, `--text-3`, letter-spacing .04em). H1 "Search and commands" is 48/54, weight 600, -.03em. The right-hand meta row is mono 12px, gap 16px: `⌘K` · `> # @` · `↑↓ ↵ Tab Esc` · `150ms scale + fade`.
Frames sit in a 3-column grid with 40px gaps. The first frame spans all 3 columns. Board props: `theme` (navy|dark|light) and `role` (admin|member|viewer, default admin).

### 1.1 Frames
| # | Caption | Meta | Size | Config |
|---|---|---|---|---|
| 1 | Search ⌘K | interactive · type > # @ · ↑↓ ↵ Tab Esc | full width × 760, r14 | Live app mock + palette `.wide` (780px) with preview pane |
| 2 | Prefix > | commands only | 1 col × 500 | scope `cmd`, query "go" |
| 3 | Prefix @ | people | 1 col × 500 | scope `people`, query "", active index 1 |
| 4 | Search error | local results kept · ↵ retries | 1 col × 500 | `error`, query "re" |
| 5 | No results | suggestions | 1 col × 500 | query "roadmap" |
| 6 | Loading | skeleton | 1 col × 500 | `loading`, query "sprint" |
| 7 | Mobile | 390 · full screen | 390 × 800, r28 | `mobile`, query "board" |

Frames 2–6 use the `.narrow` palette (`max-width: 560px`) on a static scrim (`padding: 28px 16px 16px`). Behind it is a fake page: `.fake` (padding 22px, gap 12px) with a 34%-width 12px bar (radius 4px, `--raised`) and six 64px cards (radius 8px, `1px --line`, `--surface`).

### 1.2 Trigger (app top bar, frame 1)
- **App mock `.am`**:
  - Sidebar is 220px wide, `border-right: 1px solid --line`, bg `--surface`, padding `16px 10px`, gap 2px.
  - Logo is 18px with padding `4px 8px 18px`.
  - Nav items `.am-nav`: 30px tall, padding `0 8px`, radius 6px, gap 10px, weight 500, color `--text-2`. The active item `.on` uses bg `--hover` and color `--text`. Items are "My work" (person icon) and "Inbox" (tray icon).
  - Section header "Projects" (`.am-h`): padding `16px 8px 6px`, 500 11px mono, uppercase, letter-spacing .06em, `--text-3`. Projects are listed as badge + name: PRJ Platform Rebuild (hue 255), MO Mobile App (150), IN Infra (60).
- **Top bar `.am-top`**: 52px tall, padding `0 20px`, gap 12px, `border-bottom: 1px solid --line`.
  - Breadcrumb is `crumbA / crumbB` with crumbA and the slash in `--text-3` and crumbB at weight 600. For the My work view it reads "Platform team / My work". For other views it reads `<project> / Board|Sprints|Milestones`.
  - The search trigger `.am-search` is a button:
    - 260×32, padding `0 6px 0 10px`, radius 7px, `1px solid --line-2`, bg `--raised`, color `--text-3`, 400 13px Inter, gap 8px.
    - Content: 14px magnifier icon, "Search" (flex 1, left-aligned), then kbd `⌘` and kbd `K`.
    - Hover: border `--control`, color `--text-2`. Transition: border-color and background-color at 120ms `--ease`. Focus uses the standard ring.
    - Attributes: `aria-haspopup="dialog"` and `aria-expanded`.
    - On mobile (`max-width: 760px`) the width becomes auto and the sidebar is hidden.
  - A 28px avatar "AK" (hue 285, 11px) follows the trigger.
- **Body**: padding `20px 24px`, gap 14px.
  - The list view shows rows `.am-row`: 40px tall, padding `0 12px`, `border-bottom: 1px --line`, each with glyph, a 52px key, title, and avatar.
  - The board view uses `.am-cols`, a 3-column grid with 14px gaps. Each column `.am-col` has padding 10px, radius 10px, bg `--surface`, `1px --line`. Column headers are glyph + name (600) + count. Cards `.am-card` have padding `10px 12px`, radius 8px, bg `--raised`, `1px --line-2`. Each card shows key (mono 11px `--text-3`), title (500, line-height 18px) and avatar. Columns: Todo (PRJ-47, IN-7), In progress (PRJ-42, MO-12), In review (PRJ-51).
- **Open**: click the trigger or press ⌘K **[impl: also Ctrl+K]**. Opening resets query, scope and index and autofocuses the input.
- **Close**: wait 150ms (the out animation), then return focus to the trigger button with `focus({preventScroll: true})`.

### 1.3 Scrim and container
- **`.pk-scrim`**: absolute inset 0, z-index 10, flex with `justify-content: center` and `align-items: flex-start`, padding `72px 24px 24px`. Bg `var(--scrim)` with `backdrop-filter: blur(8px)`. Enter: `pkfade 150ms var(--ease) both` (opacity 0→1). Exit `.out`: `pkfadeout 150ms forwards`. Clicking the scrim itself (target === currentTarget) closes the palette.
- **`.pk` dialog**:
  - `role="dialog" aria-modal="true" aria-label="Search and commands"`.
  - Width 100% with `max-height: 100%`, flex column. Radius 12px, bg `--surface`, `1px solid --line-2`, `box-shadow: var(--shadow-modal)`, `overflow: hidden`.
  - `transform-origin: 50% 0`. Enter: `pkin 150ms --ease both` (opacity 0 with `scale(.98)` → opacity 1 with none). Exit: `pkout 150ms forwards`.
  - Variants: `.wide` is 780px (used with the preview pane) and `.narrow` is `max-width: 560px`.

### 1.4 Input row `.pk-top`
- 52px tall, padding `0 14px`, gap 10px, `border-bottom: 1px --line`, color `--text-3`. On `:focus-within` it shows `box-shadow: inset 0 -1px 0 var(--accent)` (transition 120ms).
- Contents, in order:
  1. Desktop: 16px magnifier (stroke 1.5). Mobile: back-chevron button instead (`.pk-ib`, 36×36, radius 8px, `--text-2`, hover bg `--hover`, `aria-label="Close search"`, chevron path `M10 3L5 8l5 5` at stroke 1.7).
  2. Scope chip `.pk-chip`, shown only when a scope is set:
     - 24px tall, padding `0 3px 0 8px`, radius 6px, bg `--accent-s`, color `--accent-t`, 500 12px Inter, gap 6px.
     - Content: the symbol in `<b>` (600 12px mono), then the label ("Commands" / "Projects" / "People"), then an 18×18 clear button (radius 4px, hover bg `--accent-s`, 9px ✕ icon, `aria-label="Clear <Label> scope"`).
     - Enter animation: `pkchip 180ms var(--spring)` (scale .8, opacity 0 → none).
  3. Input `.pk-in`:
     - flex 1, no border, transparent bg, 400 15px/1 Inter, `--text`; placeholder color `--text-3`.
     - `role="combobox"`, `aria-expanded="true"`, `aria-controls=<listId>`, `aria-activedescendant=<active option id>`, `aria-autocomplete="list"`, `aria-label="Search tasks, projects, people and commands"`, autocomplete off, spellcheck false. Max 120 chars.
  4. Desktop only: `Esc` kbd.
- Placeholders:
  - no scope: **"Search or type > # @"**
  - cmd: **"Run a command…"**
  - proj: **"Jump to a project…"**
  - people: **"Find a person…"**

### 1.5 Prefixes / scopes
| Prefix | Scope id | Chip | Section shown | Matches on |
|---|---|---|---|---|
| `>` | cmd | `>` Commands | "Commands" (all matching actions, no limit) | action name |
| `#` | proj | `#` Projects | "Projects" | name or key |
| `@` | people | `@` People | "People" (no limit) | name or email |

- If no scope is set and the input's first character is `>`, `#` or `@`, the character is consumed (stripped from the query) and the scope is set. Each scope change resets the active index to 0.
- Clear the scope with the chip's ✕, with Backspace on an empty query, or with Esc (see 1.9).
- **Mobile only**: when no scope is set, a prefix bar `.pk-pre` sits under the input:
  - Bar: flex, gap 6px, padding `8px 12px`, `border-bottom: 1px --line`, `overflow-x: auto`.
  - Buttons `.pk-pb`: 32px tall, padding `0 10px`, radius 8px, `1px --line-2`, bg `--raised`, `--text`, 500 12.5px. The symbol is `<b>` 600 12px mono in `--accent-t`.
  - Labels: "> Commands", "# Projects", "@ People".
- **[impl]** In cmdk, keep the scope in your own state. Filter yourself with `shouldFilter={false}`, because the design uses plain substring matching and fixed per-section limits.

### 1.6 Result groups and order
Matching is a case-insensitive substring test (`indexOf`) on the trimmed, lowercased query.

**No scope, empty query (default), in this order:**
1. **Recent**: PRJ-42 (task), MO (project), PRJ-51 (task). This is a mixed list of recently opened tasks and projects.
2. **Tasks**: 3 tasks, excluding the ones already in Recent: PRJ-47, PRJ-38, MO-12.
3. **Projects**: all (PRJ, MO, IN).
4. **Actions**: first 3 permitted actions.
5. **People**: first 3 (Alex Kim, Jordan Lee, Sam Patel).

**No scope, with a query:**
1. Tasks matching key or title, max 4.
2. Projects matching name or key, all.
3. Actions matching name, max 4.
4. People matching name, max 3.

- Empty sections are removed.
- The group header count shows only when the section has more than one item, and never for the "Try" section.
- **Role gating**: for `viewer`, actions flagged `edit` are removed ("Create task", "Assign to me") and so is the "Create task “q”" suggestion.

**Group header `.pk-h`**: flex, gap 8px, padding `12px 8px 6px`, 500 11px/1 mono, uppercase, letter-spacing .06em, `--text-3`. The count is a span with letter-spacing 0 and opacity .8. `role="presentation"`.

**List `.pk-list`**: `role="listbox"`, `aria-label="Results"`, padding `4px 6px 8px`, `max-height: 460px` (none on mobile), `overflow: auto`, `scrollbar-width: thin`.
- Auto-scroll keeps the active row visible. If the row's top is less than `scrollTop + 4`, set `scrollTop = top - 32` (min 0). If its bottom passes the viewport, set `scrollTop = bottom - clientHeight + 8`.

### 1.7 Row anatomy `.pk-row`
- **Row box**:
  - flex, gap 10px, 36px tall (44px on mobile), padding `0 8px`, radius 7px, 500 13px Inter, `--text`.
  - Background transition 80ms `--ease`.
  - Active `.on` bg is `--accent-s`. There is no separate hover style: mouse-move sets the active index.
  - `role="option"`, `aria-selected`, with a stable id `<paletteId>-o<section>-<itemId>`.
- **Leading element, by kind**:
  - **Task**: status glyph (`aria-label` = status name), then the key `.pk-key` (500 11.5px mono, `--text-3`, fixed width 50px, nowrap). The key is highlighted too.
  - **Project**: `.badge` with `--h` = project hue and the key text.
  - **Person**: 20px avatar with initials.
  - **Action**: icon tile `.pk-ic`, 22×20, radius 5px, bg `--raised`, `1px --line`, `--text-2`. 12px icons by type:
    - plus: `M6 2v8M2 6h8`
    - arrow: `M2 6h8M7 3l3 3-3 3`
    - theme: half-filled circle r4.2
    - user: head and shoulders
    - link: chain
  - **Suggestion**: the same tile with a text symbol (`+`, `>`, `#`, `@`) in 600 11px mono.
  - **Error**: tile `.err` (transparent bg and border, `--danger`) with a 14px circle-exclamation icon.
- **Label `.pk-lab`**: flex 1, ellipsis. Matched substrings (every occurrence) render as `.pk-m`:
  - color `--accent-t`, weight 600
  - `text-decoration: underline`, decoration color `--accent-s`, thickness 2px, `text-underline-offset: 3px`
- **Meta `.pk-meta`**: 12px, `--text-3`, nowrap. The `.mono` variant is 11px, used for person emails.
  - Task: status name ("In progress").
  - Project: "`<n>` open".
  - Person: email (hidden on mobile).
  - Error: "Retry".
- **Shortcut keys `.pk-keys`**: gap 3px, one `.tp-kbd` per key. Actions only; hidden on mobile.
- **Enter hint**: a `↵` kbd (`margin-left: 2px`) shown only on the active row, desktop only.

### 1.8 Preview pane (wide palette only, frame 1)
- **`.pk-pv`**: 300px wide, `border-left: 1px --line`, padding 18px, gap 14px, bg `--bg`, `aria-label="Preview"`. It sits to the right of the list inside `.pk-body` (flex).
- **Task preview**:
  - Line 1: key (mono, auto width) and "· <Project name>" (`.pk-meta`).
  - Title `.pk-pvt`: 15px/21px, 600, -.01em.
  - Description `.pk-pvd`: 12.5px/19px, `--text-2`, clamped to 2 lines.
  - Definition grid `.pk-pvg`: columns `72px 1fr`, row-gap 10px, `padding-top: 12px`, `border-top: 1px --line`. `dt` is 11.5px/500 `--text-3`. `dd` is 500, flex with gap 7px, ellipsis. Rows:
    - Status: glyph + name
    - Priority: bars + name
    - Assignee: avatar + name
    - Sprint: sprint name or "No sprint"
- **Project preview**: 36px badge, title, then rows Key / Open / Lead.
- **Person preview**: 36px avatar, name, then rows Email / Role / Open ("`<n>` tasks").
- **Action preview**: title, then its keys as large kbds (24px tall, min-width 24px, 12px, gap 4px). There is no grid.
- **Nothing active / loading**: a centered 28px document icon in `--text-3`.

### 1.9 Keyboard (on the input)
| Key | Behavior |
|---|---|
| ↓ / ↑ | Next/previous item, **wraps** around (headers are skipped) |
| Enter | Run the active item (ignored while loading) |
| Tab / Shift+Tab | Jump to the first item of the next/previous **section** (wraps). Always calls preventDefault. Does nothing with only 1 section. |
| Esc | Layered: 1) clears the query if there is one → 2) else clears the scope → 3) else closes. Calls stopPropagation. |
| Backspace | On an empty query with a scope set: clears the scope |

**Footer `.pk-foot`** (desktop only):
- 38px tall, padding `0 14px`, gap 14px, `border-top: 1px --line`, 12px `--text-3`, nowrap.
- Contents: `↑` `↓` Move · `↵` **Open|Run** · `Tab` Section, then pushed right (`margin-left: auto`): **>** commands **#** projects **@** people. The symbols are `<b>` 600 12px mono in `--accent-t` with `margin-left: 6px`.
- The Enter verb is "Run" when the active row is an action, suggestion or error, and "Open" otherwise.

### 1.10 States
- **Loading (frame 6, "skeleton")**:
  - The list contains `aria-busy="true"` and a visually hidden `role="status"` reading "Searching".
  - Skeleton layout: header bar (46×8), then 3 task rows (each a 14px circle, a 44×9 key bar, and a title bar at 58% / 44% / 66% × 10), then a header (60×8), then 2 action rows (22×20 tile with a title bar at 40% / 30%). Skeleton rows use `cursor: default`.
  - The preview shows the empty icon.
- **No results (frame 5, query "roadmap")**:
  - Block `.pk-empty` (`role="status"`): flex column, centered, gap 8px, padding `28px 16px 10px`.
  - Icon tile `.pk-eico`: 40×40, radius 10px, `1px dashed --line-2`, `--text-3`, 18px magnifier with a slash.
  - Text: **No results for “roadmap”** (`strong` 14px/600, ellipsis). With a scope and an empty query, it reads "No results for “commands|projects|people”".
  - Below it, a **"Try"** group, in order:
    1. `+` **Create task “roadmap”** (query truncated to 40 chars; only if the user can edit and the query is non-empty)
    2. `>` **Search commands**
    3. `#` **Browse projects**
    4. `@` **Find people**

    The current scope's own entry is omitted. Picking a scope suggestion sets that scope and clears the query. Picking Create runs create-with-title.
- **Search error (frame 4, caption "local results kept · ↵ retries", query "re")**:
  - The Tasks section is replaced by one error row: a danger icon, the label **"Task search unavailable"**, and meta **"Retry"**.
  - Local sections still show: Projects (Platform Rebuild) and Actions (Create task).
  - Enter or click on the error row shows the loading skeleton for 700ms, then the task results come back (PRJ-42, PRJ-51).
  - **Backend**: tasks are a server search that can fail on its own. Projects, actions and people are client-side or cached.
- **Prefix > frame**: chip "> Commands", query "go", results Go to board (G B), Go to sprints (G S), Go to milestones (G M), with "Go" highlighted. Footer verb: Run.
- **Prefix @ frame**: chip "@ People", empty query, all 6 people (header count "6"), Jordan Lee active.

### 1.11 Data used (seed)
- **People** (name · initials · hue · email · role · open tasks):
  - Alex Kim AK 285 alex@team.dev Admin 6
  - Jordan Lee JL 200 jordan@team.dev Member 4
  - Sam Patel SP 20 sam@team.dev Member 5
  - Riley Chen RC 150 riley@team.dev Member 3
  - Morgan Diaz MD 60 morgan@team.dev Admin 2
  - Taylor Ng TN 330 taylor@team.dev Viewer 0
- **Tasks** (key · title · status · priority · assignee · sprint · description):
  - PRJ-42 "Fix flaky board reflow on column resize" · progress · 3 · AK · Sprint 14 · "Columns jump when the sidebar collapses mid-drag. Repro: resize the window while holding a card."
  - PRJ-51 "Rotate refresh tokens on sign-in" · review · 4 · SP · Sprint 14 · "Old tokens stay valid after a password change. Rotate on every sign-in and revoke the previous pair."
  - PRJ-47 "Persist saved filters per project" · todo · 2 · JL · Sprint 14 · "Filters reset on reload. Store them per project and restore on open."
  - PRJ-38 "Virtualize board columns over 200 cards" · done · 3 · RC · Sprint 13 · "Render only visible cards so scrolling holds 60fps at 1,000 cards."
  - MO-12 "Queue task edits while offline" · progress · 2 · MD · Sprint 14 · "Edits made offline sync in order once the app reconnects."
  - IN-7 "Cache board queries at the edge" · backlog · 1 · TN · no sprint · "Serve board reads from the edge cache to cut p95 latency."
- **Projects** (key · name · hue · open · lead): PRJ Platform Rebuild 255 · 24 · Alex Kim; MO Mobile App 150 · 11 · Morgan Diaz; IN Infra 60 · 7 · Riley Chen.
- **Actions** (in order; name · keys · icon · requires edit):
  1. Create task · `C` · plus · edit
  2. Go to board · `G` `B` · arrow
  3. Switch theme · `⌘` `⇧` `L` · theme
  4. Go to sprints · `G` `S` · arrow
  5. Assign to me · `I` · user · edit
  6. Go to milestones · `G` `M` · arrow
  7. Copy link · `⌘` `L` · link

  These, plus ⌘K, are the only global shortcuts defined in these boards.

### 1.12 Run results (frame 1) and toast
Every run closes the palette (150ms out animation).
| Item | Effect | Toast |
|---|---|---|
| Switch theme | toggles light ↔ navy on the app | "Theme: Light" / "Theme: Navy" |
| Create task (action or suggestion) | creates the next key (PRJ-59, PRJ-60, …) | "PRJ-59 created", or with a suggestion "PRJ-59 created · <query≤32>"; uses the **celebration** glyph (`done fx`, `--ok`) |
| Go to board / sprints / milestones | switches view; breadcrumb becomes "<project> / Board" | — |
| Assign to me | — | "PRJ-42 assigned to you" |
| Copy link | — | "Link copied" |
| Task | open task | "Opened PRJ-42" |
| Project | sets the project, goes to its board, highlights it in the sidebar | — |
| Person | goes to My work | "Showing <Name>’s tasks" |

**Toast `.pk-toast`**:
- Position: absolute, right 20px, bottom 20px, z-index 25.
- Box: flex, gap 10px, padding `10px 14px`, radius 10px, bg `--raised`, `1px --line-2`, `--shadow-pop`, weight 500, `role="status"`.
- Animation: `pktoast 180ms --ease` (translateY 8px with scale .98 → none). Auto-dismiss after 2600ms.
- Leading glyph: `done` in `--accent-t`, or `done fx` in `--ok` for create.

### 1.13 Mobile (frame 7, and `@media (max-width: 760px)`)
- Full screen: the scrim gets `.mob` (padding `36px 0 0` to clear the status bar, bg `--surface`, no blur). The dialog has height 100%, no border, radius or shadow, and **no animation**.
- The input row is 56px tall with padding `0 8px`: back chevron + input. There is no magnifier and no Esc kbd.
- The prefix button bar shows when no scope is set. Rows are 44px. There are no kbd hints, no ↵ hint, no person email, no preview pane and no footer.
- Frame content for "board": Tasks (header count 3) PRJ-42, PRJ-38, IN-7, then Actions: Go to board.

---

## 2. Edge screens (file 23, top grid)

Board: 1440×2720, padding 64px 80px, gap 40px. Eyebrow "SCREENS · EDGE + FIRST RUN". H1 "Edge screens and onboarding". Meta: `404 · 403 · 500` · `offline` · `session` · `3-step setup`. Edge frames sit in a 2-column grid (gap 40px), each 460px tall.

### 2.1 Shared edge layout
- **`.ed`**: absolute, flex column.
- **Top bar `.ed-bar`**: 48px tall, padding `0 18px`, gap 12px, `border-bottom: 1px --line`, bg `--surface`. Contents: 16px logo, then an optional path `.ed-meta` (500 12px/1 mono, `--text-3`, `margin-left: 6px`).
- **Center `.ed-c`**: flex 1, column, centered both ways, gap 14px, padding 24px, text centered.
  - `h2`: 20/28, 600, -.015em, `max-width: 420px`.
- **Icon tile `.ed-ico`**: 48×48, radius 12px, bg `--raised`, `1px --line-2`, `--text-2`.
  - `.dng`: `--danger` on `--danger-s`, no border.
  - `.wrn`: `--warn` on `--warn-s` (defined but unused).
- **Action row `.ed-row`**: flex wrap, gap 8px, centered.
- **Pill `.ed-pill`**: 30px tall, radius 15px, padding `0 12px`, gap 8px, weight 500, `edin 220ms` (translateY 4px with opacity 0 → none).
  - `.ok`: `--ok-s` / `--ok`
  - `.dng`: `--danger-s` / `--danger`
- **Buttons `.btn`**:
  - Base: 32px tall, padding `0 12px`, radius 6px, 500 13px Inter, gap 8px, `1px solid transparent`. Transitions: bg, box-shadow, transform and color at 120ms. `:active` is `scale(.97)`.
  - `.btn-primary`: bg `--accent`, text #fff. Hover: `--accent-h` with `box-shadow: 0 0 0 4px var(--accent-s)`. A kbd inside uses bg `rgba(255,255,255,.16)`, border `rgba(255,255,255,.3)`, text #fff.
  - `.btn-sec`: `--raised`, border `--control`. Hover: `--hover`.
  - `.btn-ghost`: transparent, `--text-2`. Hover: `--hover` / `--text`.
  - `.sm`: 28px tall, padding `0 10px`, 12px.
  - `[aria-busy=true]`: `cursor: progress`.
- **Spinner `.spin`**: 13px, `2px solid currentColor` with a transparent right border, `spin 700ms linear infinite`.

### 2.2 404 — "Not found" (caption meta "404")
- Bar: logo only.
- Big code `.ed-code`: "4" + the logo-x symbol (54×46, margin `0 6px`, opacity .9) + "4". Style: 600 64px/1 Inter, -.05em, `--text-3`, `aria-hidden`.
- h2 **"Page not found"**.
- Meta (mono) **`/platform/tasks/PRJ-999`**, i.e. echoes the requested path.
- Actions (`margin-top: 6px`): primary **"Go to My work"**; secondary **"Search ⌘K"** (with a `⌘K` kbd; opens the palette).

### 2.3 403 — "Permission denied" (meta "403 · interactive")
- Bar path: "/ Infra".
- Icon: lock (rect 12×8.5 with rx 2, plus shackle).
- h2 **"You’re not a member of this project"**.
- Context row: badge **IN** (hue 60) · **Infra** (500) · "· admin" (mono meta) · avatar MD (hue 60) · **Morgan Diaz** (`--text-2`). This shows the project and who to ask.
- Action row (`min-height: 32px`, `aria-live="polite"`), three states:
  - **Idle**: primary **"Request access"** + ghost **"Back to My work"**.
  - **Busy** (700ms): primary with spinner **"Sending"** (`aria-busy`).
  - **Sent**: pill ok (done glyph) **"Request sent"** + ghost sm **"Withdraw"** (returns to idle). Below it, meta **"Morgan Diaz notified · just now"**.
- **Backend**: `POST` access request to the project admin, a notification to that admin, and withdraw (delete) the request. Load the project's name, key, hue and admin even when the user has no access.

### 2.4 500 — "Server error" (meta "500 · retry → still failing")
- Bar path: "/ Platform Rebuild / Board".
- Icon `.dng`: warning triangle.
- h2 **"Something went wrong"**.
- Meta **`GET /boards/prj · 500`**, i.e. the failed request method, path and status.
- Actions:
  - primary **"Retry"**. While busy (900ms) it shows a spinner and **"Retrying"**. After a failure it reads **"Retry again"**.
  - ghost **"Status page"**.
- After a failed retry (`role="status"`):
  - Pill dng (circle-exclamation icon) **"Still failing · attempt N"**, where N is the retry count.
  - Reference chip `.ed-ref`: 30px tall, padding `0 4px 0 10px`, radius 7px, `1px --line-2`, `--raised`, 500 12px mono, `--text-2`. Text **"Ref 7F3A-91C2"**.
  - Copy button: 24×24 `.ib` (radius 6px, hover `--hover`), `aria-label="Copy reference id"`. It copies `7F3A-91C2` and swaps to an `--ok` check for 1400ms.
- **Backend**: errors need a request/reference id (format `XXXX-XXXX` hex) and a status-page URL.

### 2.5 Session expired (meta "modal · inline validation")
- **Background**: bar path "/ PRJ-42", a task page mock with title "Fix flaky board reflow on column resize" (18px/600) and 3 skeleton lines (92/84/60%, 10px tall). The comment box is focused (`1px --accent`, radius 8px, ring `0 0 0 3px --accent-s`) and holds the draft "Repro’d on Safari too. Looks like will-change…".
- **Scrim `.scrim`**: centered, padding 20px, `--scrim` with blur 8px, `fade 200ms`.
- **Modal `.modal`** (a `<form>`, `role="dialog"`, labelled by the title):
  - 360px wide, radius 12px, `--surface`, `1px --line-2`, `--shadow-modal`, padding 22px, gap 14px.
  - Enter animation: `modin 180ms` (scale .98 → 1).
  - Header: a clock icon tile (36×36, radius 9px), title **"Session expired"** (16/22, 600), and subtitle **"Your unsaved edits are kept."** (12.5px `--text-2`).
  - **Email** field: readonly, value `alex@team.dev`. Readonly style: bg `--raised`, `--text-2`.
  - **Password** field: `type=password`, `autocomplete=current-password`, max 128.
  - Field atoms:
    - Label `.lbl`: 12px/500 `--text-2`. Field `.fld`: column, gap 6px.
    - Input `.in`: 36px tall, padding `0 12px`, radius 7px, `1px --line-2`, `--surface`, 400 13.5px. Focus: border `--accent` with `0 0 0 3px --accent-s`. `.bad`: border `--danger`, focus ring `--danger-s`.
  - Validation (shown after a submit attempt): empty → **"Enter your password"**; fewer than 8 characters → **"At least 8 characters"**. The error line `.ferr` is 12px `--danger`, gap 6px, `edin 160ms`, `role="alert"`, linked via `aria-describedby`.
  - Buttons (right-aligned, gap 8px): ghost **"Use SSO"**; primary submit **"Sign in again ↵"** (kbd). Busy state (800ms): spinner **"Signing in"**.
- **Success**: the modal closes and a toast shows **"Signed in · draft restored"** (done glyph `--ok`).
  - Toast `.toast`: right/bottom 16px, padding `10px 12px`, radius 10px, `--raised`, `1px --line-2`, `--shadow-pop`, `toastin 180ms`.
  - A demo-only bar button "Expire session" reopens the modal.
- **Backend**: re-auth without navigating away. Keep client drafts. SSO path.

### 2.6 Offline banner (meta "queue · reconnect")
- Bar path: "/ Platform Rebuild / My work", then a 24px avatar AK. A demo button "Go offline" appears when idle.
- **Banner `.ob-ban`** sits under the bar:
  - 40px tall, padding `0 10px 0 16px`, gap 10px, weight 500, 1px bottom border, `role="status" aria-live="polite"`.
  - Enter animation: `banin 220ms` (height 0, opacity 0 → 40px, 1). Bg and color transition over 200ms.
  - **Offline** `.off`: bg `--warn-s`, color `--warn`, border `rgba(245,183,59,.3)`. Contents: crossed-wifi icon pulsing (`pulse 1.6s infinite`, opacity 1 → .45), then **"Offline"**, then mono 11.5px (opacity .85) **"· 3 changes queued"**, a spacer, and ghost sm **"Retry now"** (color inherit).
  - **Reconnecting** (still `.off` colors, 1300ms): 14px spinner + **"Reconnecting"** + three bouncing dots (4px each, `dot 1s` with delays 0 / .15s / .3s; opacity .25 → 1 and translateY -2px at 40%), then right-aligned mono **"3 queued"**.
  - **Online** `.on`: `--ok-s` / `--ok`, border `rgba(74,222,128,.3)`. Done glyph + **"Back online"** + mono **"· 3 changes synced"**. Shown for 1800ms, then `.leaving` (`banout 220ms`, height 40 → 0), then removed.
- **List rows `.mk-row`**: 40px tall, padding `0 4px`, `border-bottom: 1px --line`, weight 500. Each row has glyph, a 50px mono key, title (ellipsis), a queue marker and an avatar.
  - Queue marker `.mk-q` (500 11px mono, gap 5px, `edin 200ms`): `--warn` clock icon **"queued"** while offline/reconnecting, and `--ok` check **"synced"** after.
  - Rows (queued ones marked *): PRJ-42* (progress, AK), PRJ-47* (todo, JL), PRJ-51 (review, SP), PRJ-38* (done, RC), MO-12 (progress, MD), IN-7 (todo, TN).
- **Backend**: an offline mutation queue (ordered replay) with per-entity pending/synced state (see task MO-12).

### 2.7 App loading (meta "logo animation · ~1s")
- **`.ld`**: centered column, gap 28px, bg `--bg`, `role="status" aria-label="Loading Lightex"`.
  - Logo at 64px: the word "Lighte" (`.a-word`) and the x svg.
  - Progress track `.ld-track`: 140×2, radius 2px, `--line`. Its inner bar is 40% wide in `--accent`, `ldbar 1.1s --ease infinite` (left -40% → 100%).
- **Timeline** (each layer is applied with `.play`, `both` fill):
  | Element | Keyframes | Duration | Easing | Delay |
  |---|---|---|---|---|
  | `.a-bar` (backslash stroke) | barIn: clip-path `inset(0 100% 100% 0)` → `inset(0)` | 260ms | ease | 0 |
  | `.a-bolt` | strike: opacity 0, `translate(14px,-18px) scale(1.15)` → none | 320ms | spring | 140ms |
  | `.a-flash` (circle r24, `--spark` stroke 1.5) | flash: 0% opacity 0 scale .4 → 30% opacity .7 → 100% opacity 0 scale 1.8 | 460ms | ease | 300ms |
  | `.a-x` (whole symbol) | settle: scale 1.08 → 1 | 260ms | ease | 460ms |
  | `.a-word` | wordIn: opacity 0, translateX(10px) → none | 300ms | ease | 520ms |
  | `.ld-track` | wordIn | 300ms | ease | 700ms |

  SVG parts use `transform-box: fill-box; transform-origin: center`.
- A demo "Replay" ghost sm button sits bottom-right (12px inset).

---

## 3. Onboarding (file 23, bottom grid: `1fr 390px`, gap 40px; frames 800px tall)

- Frame A: "Onboarding" with meta "interactive · 3 steps + ready · Enter continues" (desktop, r14). It starts on step 0 with the workspace name prefilled "Platform team".
- Frame B: "Onboarding · mobile" with meta "390 · step 2" (phone, r28). It starts on step index 1 with ws "Platform team", project "Platform Rebuild", key "PRJ" (edited), template Scrum, and step 0 done.

### 3.1 Shell
- **`.ob`**: absolute, flex column, bg `--bg`.
- **Top `.ob-top`**: 56px tall, padding `0 20px`, gap 16px. Logo at 17px, a spacer, and ghost sm **"Skip for now"** (on steps 0–2). Skip jumps to the Ready step and records `skipped`.
- **Progress `.ob-prog`** (`role="progressbar"`, `aria-valuemin=0`, `aria-valuemax=3`, `aria-valuenow=step`, `aria-valuetext="Step N of 3"` or "Setup complete"):
  - Layout: 3-column grid, gap 8px, 420px wide, `margin: 8px auto 0`. Each segment `.ob-ps` is a column with gap 8px.
  - Track: 4px tall, radius 2px, bg `--line-2`. Fill: `--accent`, width transitions 320ms and bg color 300ms. Fill width is **100%** when done, **45%** when current, and **0** in the future. On the final step every track gets `.fin` and the fill becomes `--ok`.
  - Labels `.ob-pl`: 12px/500, `--text-3`. The current label is `--text`; done labels are `--text-2`. Before each label: a number (600 11px mono) or, when done, an 11px `--ok` check.
  - Label text: **1 Workspace · 2 Project · 3 Team**.
- **Main `.ob-main`**: scrolls, centered, padding `36px 24px 24px`. Card `.ob-card` is 460px wide, gap 20px.
- **Step container `.ob-step`**: column, gap 18px. Forward navigation runs `obin 240ms` (translateX 16px → 0, fade in). Back navigation runs `.back` → `obback` (from -16px).
- **Heading `.ob-h`**: 24/32, 600, -.02em. (`.ob-eb` eyebrow style exists but is unused.)
- **Footer `.ob-act`**: 508px wide, centered, padding `16px 24px 24px`, gap 10px. Contents: ghost **"Back"** (steps 1–2), a spacer, ghost **"Start over"** (Ready only), and the primary CTA with a `↵` kbd (desktop only).
- Enter in any step input means Continue. Focus moves to the step's first field on navigation.

### 3.2 Step 1 — "Create your workspace"
- Field **"Workspace name"**: placeholder "Platform team", max 40.
- Live URL preview `.ob-slug` (500 12px mono, `--text-3`): `lightex.app/` + **slug** in `<b>` (`--accent-t`, weight 500, ellipsis). With an empty name the slug shows "your-team".
  - Slug rule: lowercase, runs of non-`[a-z0-9]` become `-`, trim dashes, max 32.
- Validation (shown after blur with a value, or after pressing Continue):
  - **"Use at least 2 characters"** if the trimmed length is under 2.
  - **"lightex.app/<slug> is taken"** if the slug is reserved (`admin`, `lightex`, `api`, `app`).
- CTA **"Continue"**.
- **Backend**: slug availability check (the design only checks a reserved list; real use needs a uniqueness API).

### 3.3 Step 2 — "Create your first project"
- Two-column `.ob-2` (`1fr 96px`, gap 12px; mobile `1fr 84px`):
  - **"Project name"**: placeholder "Platform Rebuild", max 60.
  - **"Key"**: `.in.mono` (uppercase, letter-spacing .04em), placeholder "PRJ", max 5. Input is sanitized to uppercase A–Z.
- **Key auto-derivation** (until the user edits the key): take the letters-only words. One word → first 3 letters uppercased. Several words → initials of the first 4 words. Example: "Platform Rebuild" → "PR".
- Errors (each its own `.ferr` under the row, `margin-top: -8px`; the key error is hidden while the name error shows):
  - **"Name the project (2+ characters)"**
  - **"Key: 2–5 letters"** (regex `^[A-Z]{2,5}$`)
- Preview line `.ob-slug` (`margin-top: -6px`): "Tasks: **KEY-1, KEY-2…**" (shows "KEY" when empty).
- **Template** (`role="radiogroup"`, label "Template"): 3-column grid `.ob-tpls`, gap 10px.
  - Card `.ob-tpl`: column, gap 10px, padding 10px, radius 10px, `1px --line-2`, `--surface`. Hover border `--control`. Selected `.on`: border `--accent`, bg `--accent-s`. A hidden radio sits inside; focus-within shows the ring.
  - Art `.ob-art`: 46px tall, radius 6px, bg `--bg`, `1px --line`, padding 6px, gap 4px. Bars are `--line-2` with radius 2px. When selected, the bars become `--accent-t` at opacity .55.
  - Templates (name text is 500 12.5px):
    - **Kanban** (default): 3 columns, each a vertical gradient of two card stripes (0–8px, 11–19px).
    - **Scrum**: 3 staggered 6px bars (70%; 90% offset 10%; 55% offset 30%; gap 5px).
    - **Bug tracking**: 4 bars 5px tall (90/75/85/60%, gap 5px).
- CTA **"Continue"**.

### 3.4 Step 3 — "Invite your team"
- **"Emails"**: chip input `.ob-chips`.
  - Container: min-height 40px, padding `5px 6px`, radius 7px, `1px --line-2`, `--surface`, flex wrap, gap 6px. Focus-within: `--accent` border with a 3px `--accent-s` ring. `.bad`: `--danger` border.
  - Inner input: min-width 140px, 26px tall, 13.5px, `type=email`. Placeholder "jordan@team.dev, sam@team.dev" only while there are no chips.
  - Chip `.ob-chip`: 26px tall, radius 13px, padding `0 3px 0 4px`, `--raised`, `1px --line-2`, 12.5px/500, `chipin 160ms spring`.
    - Contents: an 18px avatar (8px font) with the first letter uppercased, or "!" when invalid. Avatar hues cycle 200, 20, 150, 60, 330, 285.
    - Then the email text (ellipsis), then an 18px round ✕ button (`aria-label="Remove <email>"`).
    - Invalid `.bad`: `--danger-s` bg, `--danger` border and text.
  - Tokenizing: typing comma, whitespace or semicolon commits the tokens. Enter commits the draft, or advances when the draft is empty. Blur commits. Backspace on an empty draft removes the last chip. Duplicates are ignored. Max 20 chips, 80 chars each.
  - Errors: one bad email → **"“<email>” isn’t an email"**; several → **"N emails need fixing"**. Validation regex: `^[^\s@,]+@[^\s@,]+\.[^\s@,]+$`.
- **"Role"**: segmented control `.ob-seg` (`aria-label="Role for invites"`).
  - Container: padding 3px, gap 2px, radius 8px, `--raised`, `1px --line`.
  - Buttons: 28px tall, padding `0 12px`, radius 6px, 500 12.5px, `--text-2`. Pressed: `--hover` bg, `--text`, inset `0 0 0 1px --line-2`.
  - Options: **Member** (default) · **Admin** · **Viewer**.
- CTA: **"Continue"** with no emails, or **"Send N invite(s)"** ("Send 1 invite" / "Send 3 invites"). Invites are optional, so Continue with an empty list advances.
- **Backend**: bulk invite with a role, plus email validation.

### 3.5 Completion — "You’re ready"
- Animated ring `.ob-ring`:
  - 48px `--ok` circle, `tppop 300ms spring`.
  - Check `::after` (left 18, top 11, 9×18, 3px `--bg` stroke, rotate 45°) draws with `tpdraw 220ms` at 120ms delay (clip-path reveal).
  - Spark `::before`: six 5px `--spark` dots at (0,-34) (30,-17) (30,17) (0,34) (-30,17) (-30,-17), `tpspark 520ms` at 80ms delay (scale .3 → 1.5, fade out).
- h2 **"You’re ready"** (`role="status"`). The step is left-aligned (`align-items: flex-start`).
- Summary `.ob-sum`: `1px --line`, radius 10px, `--surface`. Rows are 42px tall, padding `0 14px`, gap 10px, with a separator line. Labels are `.lbl` at 84px width. A row appears only for a completed, valid step:
  - **Workspace**: `lightex.app/<slug>` (mono)
  - **Project**: badge (hue 255) with the key, then the project name
  - **Invites**: "N person · Member" / "N people · Admin" (role capitalized; only when emails exist)

  If nothing was completed (skipped), no summary is shown.
- Footer: **"Start over"** (resets everything and plays the back animation) + primary **"Open board"** (navigates to the new project's board). The progress tracks all turn `--ok`, and there is no Skip and no Back.

### 3.6 Mobile onboarding (`.ob.mob`, and `@media (max-width: 760px)`)
- Top bar: 52px tall, padding `0 8px 0 14px`.
- Progress: `width: auto`, `margin: 0 16px`. Label text is hidden, so only the number or check shows.
- Main: padding `24px 16px`. Heading: 21/28.
- Templates: a single column. Each card is a row (`align-items: center`) with 64×40 art.
- Footer `.ob-act`: padding `12px 16px 24px`, `border-top: 1px --line`, bg `--surface`. The spacer is hidden. Buttons are 44px tall and the primary is flex 1. There is no ↵ kbd.
- Inputs are 44px tall.

---

## 4. Backend and data implications (summary)
- **Search API**: a federated query over tasks (key and title substring; may fail on its own, so return a typed error) and projects / actions / people (can be client-side). Per-group limits: tasks 4, actions 4, people 3 (people unlimited in `@` scope), projects all. Empty-query view needs **recents** per user (mixed tasks and projects, 3 shown) and a set of default tasks.
- **Fields**:
  - task {key, title, status, priority 1–4|null, assigneeId, sprint|null, description, projectKey}
  - project {key, name, hue, openCount, lead}
  - person {id, name, initials, hue, email, role, openCount}
- **Role**: viewers can't create or assign (hide edit actions and the create suggestion).
- **Edge**: access requests (create, withdraw, notify admin), error reference ids, status page link, silent re-auth (password or SSO) that keeps drafts, an offline mutation queue with replay, and slug uniqueness and reserved words.
- **Onboarding**: create workspace (name, slug), project (name, key, template ∈ kanban|scrum|bugs), invites (emails[], role ∈ member|admin|viewer), and a skip flag.
