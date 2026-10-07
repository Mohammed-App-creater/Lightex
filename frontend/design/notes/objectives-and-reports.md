# Objectives & Milestones + Reports — implementation spec

Sources: `clean/16-Objectives-amp-milestones.html`, `clean/17-Reports.html` (x-dc design canvases; templates + inline `text/x-dc` logic, all read in full).
Target: Next.js + Tailwind, charts in Recharts. "Today" in all mock data = **2026-10-07 (Oct 7)**. Current sprint = **Sprint 14, Oct 1–14, day 7 of 14**.

---

## 0. Shared foundations (both boards)

### 0.1 Theme tokens (3 themes: `t-navy` default, `t-dark`, `t-light`)

| token | navy | dark | light |
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
| color-scheme | dark | dark | light |

**Reports-only chart palette** (comment in source: "orchid (series 1) + olive (series 2), neutral reference. Validated: navy #0C1326, dark #121217, light #FFFFFF"):

| token | navy | dark | light |
|---|---|---|---|
| --c1 (series 1, orchid) | #C564AB | #C564AB | #B04496 |
| --c2 (series 2, olive) | #A39335 | #A39335 | #848E2D |
| --c1-t (series-1 track tint) | #44243B | #3E2437 | #F8DFF0 |
| --cref (reference/ideal line) | #8794B6 | #8E8E9D | #5F5F70 |

Motion: `--ease: cubic-bezier(.16,1,.3,1)`; `--spring: cubic-bezier(.34,1.56,.64,1)`.
Base: `font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif; font-size:13px; -webkit-font-smoothing: antialiased; box-sizing: border-box`.
`.mono` = `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace`.

Avatars: `background: oklch(var(--av-l) var(--av-c) <hue>)`, text `var(--text)`.
Project badges (`PR`, etc.): `background: oklch(var(--pk-l) var(--pk-c) <hue>); color: oklch(var(--pkt-l) var(--pkt-c) <hue>)`, 18×18, radius 5px, `font: 600 9px/1 JetBrains Mono`.

People (initials → name, avatar hue): AK Alex Kim 285 · JL Jordan Lee 200 · SP Sam Patel 20 · RC Riley Chen 150 · MD Morgan Diaz 60 · TN Taylor Ng 330.
Projects (badge, name, hue): PR Platform Rebuild 255 · MO Mobile App 175 · IN Infra 75 · DS Design System 300 · AP Public API 25 · (plus BI 140, SE 215, ON 335, DA 100, QA 50, SC 5, DO 230, GR 155, MK 285, PE 195, AN 60 for "many" sidebar).

Reduced motion: both boards collapse all animation/transition durations to `.001ms` under `prefers-reduced-motion: reduce`. Reports additionally renders final chart state immediately (no draw-in) and stops skeleton shimmer.

### 0.2 Shared primitives

- **kbd**: `font:500 11px/1 JetBrains Mono; min-width:18px; height:18px; padding:0 5px; border:1px solid var(--line-2); border-bottom-width:2px; radius 4px; bg var(--raised); color var(--text-2)`.
- **Focus ring (all interactive)**: `outline:none; box-shadow: 0 0 0 1px var(--accent), 0 0 0 4px var(--ring)`. (Chart hit columns: `inset 0 0 0 1px var(--accent), 0 0 0 3px var(--ring)`.)
- **Skeleton `.sk`**: `background: linear-gradient(90deg, var(--raised) 0%, var(--hover) 50%, var(--raised) 100%); background-size:200% 100%; animation: shimmer 1.4s linear infinite` (background-position 200% → -200%). Radius 6px (Objectives) / 8px (Reports).
- **Spinner `.spin`**: 14×14 circle, 2px border. Objectives: `border var(--line-2); border-top-color var(--text)`; Reports: `border rgba(128,140,170,.35); border-top-color currentColor`; `animation: spin .7s linear infinite`.
- **Task status glyph `.tp-g`** (14×14 circle, colored via `color`):
  - backlog: `1.5px dashed currentColor` border — color `var(--text-3)`
  - todo: `1.5px solid` — `var(--todo)`
  - progress (In progress): solid border + 2px padding + `conic-gradient(currentColor 0 180deg, transparent 0) content-box` (half filled) — `var(--warn)`
  - review (In review): same, 270deg fill — `var(--info)`
  - done: filled circle + white-ish checkmark (::after: left 4px, top 2px, 3×6, border `solid var(--bg)` 0 1.5px 1.5px 0, rotate 45deg) — `var(--ok)`
  - cancel: solid border (unused here)
  - Group order everywhere: In progress → In review → Todo → Backlog → Done.

### 0.3 App sidebar (identical block in both files)
Both boards embed the standard app sidebar (documented with the shell boards). Relevant bits: full width **264px**, collapsed rail **64px**, `bg var(--surface)`, `border-right:1px solid var(--line)`, width transition 220ms ease. Under project "PR" the sub-nav lists: Board, Backlog, Sprints, Objectives, Milestones, Reports (icons below). **Viewer** role only sees Board, Backlog, Objectives, Milestones (no Sprints, no **Reports**). Sub-item active indicator: pill `bg var(--accent-s)`, translateY(idx×32px; 44px on touch), spring 220ms; active icon colored `var(--accent-t)`. Footer sprint card: "Sprint 14", "65% · 7d left", ring r=11.5 dasharray 72.3. Sidebar hidden under 760px.

Sub-nav icon paths (16×16 viewBox, stroke 1.4, round caps/joins):
- objectives: `M8 2.5a5.5 5.5 0 110 11 5.5 5.5 0 010-11zM8 5.5a2.5 2.5 0 110 5 2.5 2.5 0 010-5z` (target)
- milestones: `M4 14V2.5h7.5L10 5.5l1.5 3H4` (flag)
- reports: `M3 13V8M6.5 13V4M10 13V9.5M13.5 13V6` (bars)

Selecting Objectives / Milestones in sidebar switches the Goals page tab (and vice versa: page tab updates sidebar sub).

---

## 1. Objectives & milestones (board 16)

### 1.1 Board canvas
Canvas 1440×3920, padding 64px 80px, column gap 36px. Header: eyebrow `SCREENS · GOALS` (mono 12px, text-3, letter-spacing .04em), H1 "Objectives & milestones" 48/54 600 letter-spacing -.03em. Right legend (mono 12px text-3, gap 16): "ring = done / linked" · "at risk = behind time" · "Esc closes panel" · "today Oct 7".
Frames laid out in a flex-wrap row, gap 48px (row) 40px (col). Each frame = figure: caption (14px 600) + mono 11px meta, then device box (`border:1px solid var(--line-2); radius 14px (36 on phone); overflow hidden; bg var(--bg)`).

### 1.2 Frames

| id | caption · meta | size | config |
|---|---|---|---|
| M | App · "interactive · expand · link · mark complete" | 1280×880 | sidebar (full, collapsible), role from prop (admin default), Objectives tab, "Cut p95 latency to 200ms" expanded |
| C | Create objective panel · "title required" | 620×720, `.nar` | Objectives tab; side panel open, New objective, empty title, `tried=true` → title error shown, owner TN, date 2026-11-30 |
| D | Milestone completed · "cyan spark" | 620×720, `.nar` | Milestones tab, **List** view, "Beta launch" expanded and marked done, check spark looping, toast "Beta launch completed" |
| E1 | New project — empty · objectives | 620×440 `.nar` | empty objectives |
| E2 | New project — empty · milestones | 620×440 `.nar` | empty milestones |
| L | Loading · "skeleton in place" | 620×420 `.nar` | Objectives loading |
| X | Error · "retry" | 620×420 `.nar` | error |
| V | Viewer · "read-only" | 850×820 | sidebar as rail (64px), role viewer, Milestones tab, Timeline view, Beta selected |
| P | Mobile · "390" | 390×820, radius 36, `.ph` | no sidebar, Objectives tab, "Ship beta on time" expanded, tab width 182 |

`.nar` = narrow (≈620px) variant; `.ph` = phone variant. In production map `.nar` to a container/breakpoint (~<760 main width) and `.ph` + `@media (max-width:760px)` to mobile.

### 1.3 Page layout (`main.pg`, flex column, bg var(--bg))

1. **Top bar `.g-top`** — height 48px, padding 0 28px (nar: 0 18px), gap 8px, `border-bottom:1px solid var(--line)`, color text-2. Content: project badge `PR` (hue 255) · "Platform Rebuild" · "/" (text-3) · **bold tab name** ("Objectives" / "Milestones", text, 600). Viewer: right-aligned pill `.g-ro` (margin-left:auto; height 22; padding 0 8; radius 6; border 1px line-2; mono 500 11px text-3; gap 6) with eye icon 12px + "View only".
2. **Mobile top `.g-mtop`** (phone only; replaces g-top) — height 52, padding 0 8 0 4, gap 6, border-bottom line. Hamburger icon button 44×44 ("Open navigation"), title (flex 1, 600 15px) = tab name, optional "View only" pill (margin-right 8), and primary round "+" icon button `.g-ib.pri` 36×36 bg accent, white, radius 7 (aria-label "New objective"/"New milestone").
3. **Header `.g-head`** — flex, align-items flex-end, gap 12, padding 12px 28px 0 (nar 12px 18px 0; phone 0 12px, gap 0), border-bottom 1px line, wrap.
   - **Tabs** (role tablist, "Goals"): two buttons each width **132px** (182px on phone), height 38, `font:500 13px Inter`, color text-2 → text on hover/selected, hover bg var(--hover), radius 6px 6px 0 0, gap 8. Labels: "Objectives" + count, "Milestones" + count (count: mono 500 11px text-3). Counts in mock: 4 / 4.
   - **Tab indicator** `.g-ind`: absolute bottom -1px, height 2px, radius 2px, bg var(--accent), width = tab width, `translateX(0 | tabW)`, transition transform 260ms **spring**.
   - **Tools** (margin-left:auto, gap 8, padding-bottom 8; phone: full width row, no padding):
     - **View segmented control** (only Milestones tab with ≥1 milestone): container `padding:2px; radius 8; border 1px line-2; bg surface`. Buttons 84×26, `500 12px`, text-2 (text when pressed/hover), gap 6, radius 6. Thumb `.g-segt` 84×26 at left/top 2px, bg var(--hover), `box-shadow: inset 0 0 0 1px var(--line-2)`, translateX(0 | 84px) 240ms spring. Options: **Timeline** (icon `M2 4h7M5 8h8M3 12h6`), **List** (icon `M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01`). Phone: margin 10px 0.
     - **Primary button** `.btn.btn-primary.sm` "+ New objective" / "+ New milestone" (hidden on phone; hidden when list empty, loading/error, or viewer).
4. **Body `.g-body`** — flex 1, overflow auto, padding 20px 28px 40px (nar 16px 18px 28px; phone 12px 12px 32px), flex column gap 12 (phone 10).

Buttons: `.btn` height 32, padding 0 12, radius 6, `500 13px/1 Inter`, gap 8, border 1px transparent, active `scale(.97)`; `.sm` height 28, padding 0 10, 12px. Primary: bg accent, #fff; hover bg accent-h + `box-shadow 0 0 0 4px var(--accent-s)`; kbd inside primary `bg rgba(255,255,255,.16); border rgba(255,255,255,.3); color #fff`. Secondary: bg raised, border line-2, color text; hover bg hover, border control. Ghost: transparent text-2; hover bg hover, color text. Icon button `.g-ib`: 30×30, radius 7, text-3 → hover bg hover/text.

### 1.4 Objectives list

`.g-list` flex column gap 8. Each objective = `article.g-ob`: `border:1px solid var(--line); radius 10px; bg var(--surface)`; hover/open → border var(--line-2) (150ms).

**Header row `.g-oh`** (flex, align center, gap 2, padding-right 10):
- Toggle button `.g-otg` (flex 1; gap 14; padding 12px 8px 12px 14px; radius 10; text-align left; phone gap 12, padding 12) contains:
  - **Progress ring** 40×40 SVG: track circle r=16 stroke var(--line-2) width 4; progress circle r=16, width 4, round cap, `stroke-dasharray:100.5`, `stroke-dashoffset = 100.5 × (1 − pct/100)`, rotate(-90 20 20). Stroke = `var(--accent-t)`, or **`var(--ok)` when 100%**. Center label = pct number (no % sign) `600 10.5px/1 JetBrains Mono`, color text. Animation: offset transitions 900ms ease from full (100.5, empty) to value ~80ms after mount; stroke color 200ms. aria-label "{pct} percent, {done} of {n} tasks done".
  - Title column (flex col gap 6): title `14px 600 letter-spacing -.01em`, single-line ellipsis. Meta row `.g-meta` (gap 14, text-3 12px, wraps): owner (20×20 avatar, 9px 600 initials + full name), date (mono, calendar icon 12px `M3 4.5h10v8.5H3zM3 7h10M5.5 3v3M10.5 3v3`, "Dec 15"), linked count (mono, link icon `M6.8 9.2a2.6 2.6 0 003.7 0l2.2-2.2a2.6 2.6 0 00-3.7-3.7l-.8.8M9.2 6.8a2.6 2.6 0 00-3.7 0L3.3 9a2.6 2.6 0 003.7 3.7l.8-.8`, "2/6 tasks").
  - Chevron 14px (`M6.5 4.5L10 8l-3.5 3.5`), text-3, rotates 90° when open (220ms).
- Edit icon button (pencil `M10.5 2.5l3 3L6 13H3v-3z`, aria "Edit {title}") — hidden for viewer.

**Expand area** — collapse via `display:grid; grid-template-rows: 0fr → 1fr` (280ms ease), inner overflow hidden. Only one objective expanded at a time (accordion). Content `.g-ox`: padding 2px 16px 16px **68px** (aligned under title; nar 16px left; phone 2px 12px 14px), flex col gap 12.
- **Task groups** `.g-grps`: `grid-template-columns: repeat(auto-fill, minmax(240px,1fr)); gap 4px 24px`. Each group: header `.g-gh` height 28, gap 8, 12px 600 text-2: status glyph + group name ("In progress", "In review", "Todo", "Backlog", "Done") + mono 11px 500 text-3 count. Empty groups omitted.
- **Task row `.g-tr`**: flex, gap 9, min-height 30, padding 0 8, margin 0 -8, radius 6, hover bg hover. Key `500 11.5px JetBrains Mono` text-3 (e.g. "PRJ-38"); title flex 1 ellipsis; assignee avatar 20×20 (title attr = full name).
- No links → "No linked tasks" (12px text-3).
- **"Link tasks" button `.g-link`** (editors only): align-self start, height 28, padding 0 10, radius 7, **1px dashed var(--line-2)**, transparent, text-2, 500 12px, gap 7, link icon 13px. Hover/expanded: border control, text.
- **Link-task picker popover `.g-pick`** (inline below button, role dialog "Link tasks to {title}"): `border 1px line-2; radius 10; bg raised; shadow-pop; max-width 440px`; enters with `gin` 180ms (opacity 0, translateY(-4px) → none).
  - Search row (padding 8, border-bottom line): input `.g-ps` height 32, padding 0 10 0 30, radius 7, border line-2, bg var(--bg), 13px; focus border accent + `0 0 0 3px var(--accent-s)`; search icon 14px at left 18px. Placeholder "Search tasks…". Filters by key or title (case-insensitive substring; max 60 chars).
  - List `.g-pl` max-height 206px, overflow auto, padding 4. Item `.g-pi` (label): min-height 32, padding 0 8, radius 6, gap 9, hover bg hover: **checkbox** + status glyph + key + title. Toggling immediately links/unlinks (ring/count update live).
  - No results: "No tasks match" (padding 10px 8px).
  - Footer `.g-pf`: border-top line, padding 6 6 6 12, mono 500 11px text-3: "{n} linked" (flex 1) · kbd "Esc" · secondary sm "Done". Esc closes (stopPropagation).
- **Checkbox `.g-cb`**: 16×16, `border:1.5px solid var(--control)`, radius 4; checked bg/border accent; check mark = 8×4 box with 2px white bottom-left borders rotated -45deg, scale 0→1 150ms spring.

**Progress computation (objective)**: `pct = round(doneLinkedTasks / linkedTasks × 100)`, 0 if no links. Label "{done}/{n} tasks". No "at risk" on objectives in this screen.

**Mock objectives** (all tasks list below):

| id | title | owner | target date | linked tasks | done / n | pct |
|---|---|---|---|---|---|---|
| o1 | Cut p95 latency to 200ms | RC Riley Chen | 2026-12-15 "Dec 15" | PRJ-38, 41, 44, 47, 52, 63 | 2/6 | 33 |
| o2 | Ship beta on time | AK Alex Kim | 2026-10-21 "Oct 21" | PRJ-31, 34, 42, 46, 51, 61 | 3/6 | 50 |
| o3 | Zero P1 incidents in Q4 | MD Morgan Diaz | 2026-12-31 "Dec 31" | PRJ-53, 55, 64 | 1/3 | 33 |
| o4 | Onboarding under 5 minutes | TN Taylor Ng | 2026-11-30 "Nov 30" | PRJ-58, 59, 60 | 0/3 | 0 |

o1 expanded shows: In progress 1 (PRJ-44 Batch status updates · JL), In review 1 (PRJ-47 Index task search · RC), Todo 1 (PRJ-52 Trim API payloads · SP), Backlog 1 (PRJ-63 Load test 10k tasks · RC), Done 2 (PRJ-38 Cache board queries · RC; PRJ-41 Virtualize board columns · RC).

**Task pool (21)** — key, title, status, assignee:
PRJ-31 Session token rotation done SP · PRJ-34 OAuth device flow done JL · PRJ-38 Cache board queries done RC · PRJ-41 Virtualize board columns done RC · PRJ-42 Drag-and-drop reorder review AK · PRJ-44 Batch status updates progress JL · PRJ-46 Beta invite emails progress TN · PRJ-47 Index task search review RC · PRJ-49 Sprint carry-over todo MD · PRJ-51 Feature flags for beta done AK · PRJ-52 Trim API payloads todo SP · PRJ-53 On-call runbook progress MD · PRJ-55 Alert on error budget todo MD · PRJ-56 Invoice proration backlog SP · PRJ-58 Guided first project progress TN · PRJ-59 Import from CSV todo JL · PRJ-60 Skippable product tour backlog TN · PRJ-61 Release notes page todo AK · PRJ-63 Load test 10k tasks backlog RC · PRJ-64 Public status page done MD · PRJ-65 Migrate audit log done RC.

### 1.5 Milestones — Timeline view (default) — this IS in v1 (not a v2 placeholder)

Container `.g-tl`: `border 1px line; radius 10; bg surface; overflow hidden; --lab: 210px` (nar 136px, phone 112px).

- **Header `.g-tlh`**: grid `var(--lab) minmax(0,1fr)`, height 36, border-bottom line. Track area `.g-lt` (relative, margin-right **36px** so end labels fit). Month labels `.g-mo` absolutely at month-start %: `padding-left 8; border-left 1px line; mono 500 11px text-3`. Months: Sep, Oct, Nov, Dec. "Today" chip `.g-tdy`: top 8, translateX(-50%), height 20, padding 0 7, radius 5, bg accent-s, color accent-t, `600 10.5px/20px mono`, z 2.
- **Scale**: linear from **2026-09-01 (0%) to 2027-01-01 (100%)** (122 days), clamp 0..100. Month x: Sep 0%, Oct 24.59%, Nov 50.00%, Dec 74.59%. Today 29.51%.
- **Lane `.g-lane`** (button, one per milestone, sorted by date): grid `var(--lab) 1fr`, height **58px**, border-bottom line (none on last), hover bg hover; **selected** bg hover + `box-shadow: inset 2px 0 0 var(--accent-t)`.
  - Label cell `.g-ll`: padding 0 14, col gap 5. Name `600 13px` ellipsis; meta `.g-lm` (mono 500 11px text-3, gap 8): days label (`.g-days` — `.over` danger, `.dn` ok) + optional **"At risk"** badge.
  - Track: month gridlines (1px line), today line `border-left:1.5px dashed var(--accent-t); opacity .75`, **bar** `.g-bar` (top 50%, height 8, radius 4, bg line-2, overflow hidden) from start% to date% (min width 0.6%), with fill `.g-bf` (bg accent-t; `.risk` warn; `.ok` ok; width = pct%, transitions width 800ms from 0 on mount).
  - End marker at date%: open milestone = **diamond** `.g-mk` 12×12 rotated 45°, radius 2, bg surface, `2px solid var(--accent-t)` (warn if at risk), z1. Done milestone = filled green check `.g-chk` 16px (centered, margin -8).
  - Date label `.g-md` right of marker (translateX(12px)), mono 500 11px/12px text-2; if marker > 80% it flips left (`translateX(calc(-100% - 12px))`).
- Clicking a lane selects it → **Selected milestone detail card `.g-msd`** below: `border 1px line; radius 10; bg surface; padding 16px 18px (phone 14); col gap 14`.
  - Header: H3 name (15px 600 -.01em) + "At risk" badge; sub line (`.g-lm`): owner avatar 20 + "Oct 21 · " + days label + (if risk) " · expected 64%". Actions right: ghost sm "Edit" (editors), **"Mark complete"** button `.g-done` (height 28, padding 0 10, radius 7, border line-2, bg raised, 500 12px, gap 7, empty 14px circle `.g-o` 1.5px text-3 border; hover border var(--ok); active scale .97) or, when done, chip `.g-cdone` (height 28, padding 0 10 0 7, radius 7, `bg color-mix(in oklab, var(--ok) 14%, transparent)`, color ok, gap 8) with check + "Completed".
  - Progress row `.g-pr` (mono 500 11.5px text-2, gap 10): bar `.g-pb` (flex 1, height 6, radius 3, bg line-2) with `.g-bf` fill, then "{done}/{n}".
  - Linked tasks grid `.g-tks`: `repeat(auto-fill, minmax(240px,1fr))`, gap 0 24 — task rows with status glyph + key + title + avatar.

**"At risk" badge `.g-risk`**: inline-flex, height 20, padding 0 7, radius 5, `600 11px Inter`, color warn, `bg color-mix(in oklab, var(--warn) 13%, transparent)`, `border 1px solid color-mix(in oklab, var(--warn) 35%, transparent)`, ::before 6px dot currentColor, gap 5.

### 1.6 Milestones — List view

`.g-ml`: border 1px line, radius 10, bg surface, overflow hidden. Rows `.g-lr` separated by 1px line.
Row button `.g-lrb`: grid **`14px 16px minmax(0,1fr) 64px 76px 160px 64px`**, gap 14, min-height 54, padding 8px 16px, hover bg hover. Columns: chevron · marker (done check 16px or small diamond `.g-mks` 10×10, 2px accent-t border / warn) · name (+ At risk badge) · date (mono 11.5px text-2, e.g. "Oct 21") · days label ("14d left") · progress bar + "40%" · "10 tasks".
Narrow: grid `14px 16px minmax(0,1fr) 120px` (date/days/tasks columns `.hn` hidden; sub line `.g-sub` appears under name: "Oct 21 · 14d left" mono 11px text-3). Phone: `14px 16px minmax(0,1fr) 70px`, gap 10, padding 10px 12px.
Expanded `.g-lx` (padding 0 16 16 60; nar 16 left; phone 0 12 14): task grid, then action row (gap 6): "Mark complete" / "Completed" chip, ghost "Edit".

### 1.7 Milestone computation & mock data

- `pct = done ? 100 : round(doneLinked / linked × 100)`.
- `expected = clamp((today − start) / (date − start), 0, 1)` (if date ≤ start: 1 if today ≥ date else 0).
- **At risk** = `!done && pct/100 < expected` ("at risk = behind time"). Fill/diamond turn warn.
- Days label: done → "Done" (ok color); days<0 → "{n}d over" (danger); 0 → "Due today"; else "{n}d left". `days = round((date − today)/1day)`.
- Milestones require a **start** date (bar start). New milestones get `start = min(date, today)`.

| id | title | owner | start | date | linked | done/n | pct | expected | state |
|---|---|---|---|---|---|---|---|---|---|
| alpha | Alpha | SP | 2026-08-10 | 2026-09-12 "Sep 12" | PRJ-31, 34 | 2/2 | 100 | — | done ("Done", green check; bar 0%→9.02%) |
| beta | Beta launch | AK | 2026-09-12 | 2026-10-21 "Oct 21" | PRJ-38, 41, 51, 64, 42, 44, 46, 47, 61, 52 | 4/10 | 40 | 64% | **At risk**, "14d left", bar 9.02%→40.98% |
| rc | Release candidate | JL | 2026-09-28 | 2026-11-18 "Nov 18" | PRJ-65, 49, 53, 58 | 1/4 | 25 | 18% | on track, "42d left", bar 22.13%→63.93% |
| ga | General availability | AK | 2026-10-21 | 2026-12-09 "Dec 9" | PRJ-56, 59, 60, 63 | 0/4 | 0 | 0% | on track, "63d left", bar 40.98%→81.15% (date label flips left) |

Default selected = first not-done milestone (Beta launch).

### 1.8 Mark complete + toast + undo

- "Mark complete" → milestone `done=true`, pct 100, fill turns ok, diamond replaced by **check spark**, selection moves to it, toast appears.
- **Check `.g-chk`**: 16px circle bg var(--ok), check ::after (left 5.2, top 2.6, 3.5×7, border `solid var(--bg)` 0 1.6 1.6 0, rotate 45). With `.fx`: `gpop` 260ms spring (scale .6→1.2→1), check draw `gdraw` 180ms delay 60ms (clip-path inset 0 100% 100% 0 → 0), **spark burst** ::before: 3px cyan dot with 6 box-shadow dots at (0,-12),(11,-6),(11,6),(0,12),(-11,6),(-11,-6) all `var(--spark)`, `gspark` 480ms (scale .3→1.9, opacity 1→0). Board frame D loops it every 2400ms (demo only).
- **Toast `.g-toast`**: absolute bottom 20, centered, z7, height 40, padding 0 6 0 12, radius 10, border line-2, bg raised, shadow-pop, gap 10; enter `gtoast` 240ms spring (opacity 0, +8px Y). Content: check + "{Milestone} completed" (e.g. "Beta launch completed") + ghost sm "Undo" (editors). Auto-dismiss after **4000ms**. Undo reverts done.
- New/edited rows flash `.g-new`: `box-shadow 0 0 0 3px var(--accent-s) → none` over 1400ms.

### 1.9 Create / edit side panel (objective & milestone)

- **Scrim** `.g-scrim`: absolute inset 0, z8, `bg rgba(2,5,14,.55)` (light: `rgba(18,18,23,.22)`), `backdrop-filter: blur(4px)`, fade 200ms. Click = cancel.
- **Panel `.g-sp`** (role dialog, aria-modal): absolute right, full height, width **400px** (nar 360px), bg surface, border-left 1px line-2, shadow-modal, enter `gslide` 260ms (opacity 0, translateX(28px)). Phone/≤760: bottom sheet — `top:auto; left:0; height:88%; border-top 1px line-2; radius 18px 18px 0 0; gsheet` 280ms (translateY(100%)).
- Header `.g-sph`: height 52, padding 0 10 0 20, border-bottom line, gap 8: H2 (15px 600) "New objective" / "Edit objective" / "New milestone" / "Edit milestone" · kbd "Esc" · close icon button (X).
- Body `.g-spb`: padding 18px 20px, col gap 16, scrolls.
  - **Title** (required; max 120 chars). Placeholder: objective "e.g. Cut p95 latency to 200ms", milestone "e.g. Public launch". Error: **"Add a title"**.
  - Row of 2 (`grid 2 cols gap 12`; 1 col on phone): **Owner** select (options: Alex Kim, Jordan Lee, Sam Patel, Riley Chen, Morgan Diaz, Taylor Ng; default AK for new) · **Target date** (objective) / **Date** (milestone) — native date input, mono, min 2026-01-01, max 2027-12-31; required, error **"Pick a date"**.
  - **Description** textarea, placeholder "Optional", height 84, padding 8 10, line-height 20, no resize, max 1000 chars.
  - Milestone only: **"Linked tasks {n}"** group — scroll box `.g-lks` (border 1px line-2, radius 8, bg var(--bg), max-height 184, padding 4) with checkbox rows (same as picker) for all 21 tasks. (Objective form has no link list — linking is done inline via "Link tasks".)
  - Field label `.g-fl` 12px 500 text-2; field gap 6.
  - Inputs `.g-in`: height 34, padding 0 10, radius 7, border 1px line-2, bg var(--bg), 13px; hover border control; focus border accent + `0 0 0 3px var(--accent-s)`; `.err` border danger, focus ring `color-mix(in oklab, var(--danger) 25%, transparent)`. Error line `.g-err`: 12px danger, gap 6, circle-! icon 13px, fades in 160ms. Errors only show after a save attempt (`aria-invalid`, `aria-describedby`).
- Footer `.g-spf`: padding 12px 20px, border-top line, right-aligned gap 8: ghost sm "Cancel" · primary sm "Create"/"Save" + kbd "⌘↵".
- Keys: Esc closes; ⌘/Ctrl+Enter saves. On save: new item appended (milestones re-sorted by date), panel closes, tab switches to the relevant one, item gets `.g-new` flash (new milestone also becomes selected).

### 1.10 Empty / loading / error

- **Empty** `.g-empty` (centered column gap 16, padding 32 16): icon tile 56×56, radius 14, border line-2, bg surface, color accent-t, with 24px icon — objectives: concentric target (circles r5.8, r2.8, dot r.6); milestones: flag. Title `.g-et` 15px 600: "No objectives yet" / "No milestones yet". Primary button "+ New objective" / "+ New milestone" (editors only). Header "New" button and segmented control are hidden when empty.
- **Loading**: 4 skeleton rows `.g-skr` (flex gap 14, padding 12 14, border line, radius 10, bg surface): 40px circle + two bars (12px tall at widths 46/58/38/52%; 10px tall at 34%), row opacities 1, .85, .7, .55. `aria-busy`.
- **Error** (`role=alert`): icon tile colored danger with warning triangle 22px, "Couldn’t load goals", mono sub "503 · retrying won’t lose anything" (12.5px text-3, margin-top -8), secondary sm "Retry" → loading (~1.1s) → ok.

### 1.11 Roles
- admin/member: full editing. **viewer**: no New buttons, no Edit icons, no Link tasks, no Mark complete, no Undo; "View only" pill in top bar; sidebar lacks Sprints/Reports.

### 1.12 Backend implications (Goals)
- `Objective { id, projectId, title(≤120), ownerId, targetDate, description(≤1000), linkedTaskIds[] }` — progress derived from linked task statuses (done count / linked count). Many-to-many task↔objective.
- `Milestone { id, projectId, title, ownerId, startDate, date, description, linkedTaskIds[], completedAt|null }` — expected/at-risk derived server- or client-side from start/date/today. Endpoints: list, create, update, link/unlink tasks, complete, un-complete (Undo).
- Error copy implies idempotent retry (503).

---

## 2. Reports (board 17)

### 2.1 Board canvas
1440×4720, padding 64px 80px, gap 36. Eyebrow "SCREENS · REPORTS", H1 "Reports" (48/54 600). Right legend (mono 12px text-3): swatch 10×10 radius 2 `var(--c1)` "series 1" · swatch `var(--c2)` "series 2" · "5 charts" · "700ms draw" · "table view".
Frames grid: `grid-template-columns: 850px 390px; gap 40px`.

| id | caption · meta | size / grid pos | config |
|---|---|---|---|
| main | Reports · "1280 × 1000 · interactive" | full width (cols 1–2), h 1000, r 14 | sidebar (264, collapsible, sub=Reports), PR, Last 6 sprints, ready |
| light | Light theme · "same page" | cols 1–2, h 1000 | same, forced `t-light` |
| loading | Loading · "skeleton in final positions" | col 1, h 600 | no sidebar |
| empty | Not enough data yet · "new project · sprint 1" | col 1, h 1110 | project DS (project menu adds DS) |
| error | Error · "retry recovers" | col 1, h 420 | |
| mobile | Mobile · "390 · stacked" | col 2, rows 3–6, h 1960, r 28 | stacked layout |

### 2.2 Page layout
- `main.rp-main`: flex 1, overflow auto, `container-type:inline-size; container-name: rp`; thin scrollbar (line-2).
- `.rp-pg`: **max-width 1240px**, centered, padding **22px 28px 40px**, flex col gap 16.
- Mobile top `.rp-mtop` (≤760 container): flex, height 52, margin -12px -16px 0, padding 0 12, border-bottom line, bg surface, gap 10: hamburger (44×44, "Open menu"), 24×24 logo tile (radius 6, bg raised, border line-2), project name 600.
- **Header `.rp-head`** (flex wrap, align center, gap 12px 16px):
  - Left: H1 "Reports" 22px/30px 600 -.02em; under it mono caption (12/16 text-3): **"Sprint 14 · day 7 of 14 · Last 6 sprints"** (format `Sprint {n} · day 7 of 14 · {rangeLabel}`).
  - Right controls `.rp-ctl` (margin-left auto, gap 8, wrap; mobile full width):
    1. **Project select** `.rp-sel` (height 32, padding 0 10, radius 7, border line-2, bg raised, 500 13px, gap 8; hover/open bg hover, border control): badge + "Platform Rebuild" + chevron-down (text-3). Menu (listbox) options: Platform Rebuild, Mobile App, Infra (+ Design System first in the empty frame); selected shows check (accent-t, 16px).
    2. **Date-range select**: calendar icon + label + chevron. Menu min-width 228: "Last 2 sprints", "Last 6 sprints" (default), "Last 90 days", separator, "Custom range" (expands inline). Custom panel `.rp-cust` (col gap 8, padding 6 8 8): rows "From [date]" / "To [date]" (12px text-2, space-between), date inputs `.rp-date` height 28, padding 0 8, radius 6, border line-2, bg var(--bg), mono 12px, max 2026-10-07, defaults 2026-08-03 → 2026-10-07; secondary sm "Apply" right-aligned. Apply swaps reversed dates, falls back to defaults if invalid; label becomes "Aug 3 – Oct 7".
    3. **Export** primary button `.rp-btn.pri` (download icon `M8 2.5v8M4.5 7.5L8 11l3.5-3.5M3 13.5h10`) → menu (min-width 180): "CSV" hint "data", "PNG" hint "charts", "PDF" hint "report" (hint mono 11px text-3, right). Picking shows status `.rp-status` (12px text-2, spinner) **"Preparing CSV…"** for 1.6s.
  - Menus `.rp-menu`: absolute top 38, z20, min-width 200, padding 4, radius 10, border line-2, bg raised, shadow-pop, enter 150ms (opacity 0, translateY(-4px) scale(.98)). Items `.rp-mi` height 30, padding 0 8, radius 6, 500 13px, hover bg hover. Separator 1px line, margin 4px -4px. Esc closes menus and tooltips. Only one menu open at a time.
  - Changing project or range re-runs the 700ms draw animation.

### 2.3 KPI tiles `.rp-stats`
Grid 4 cols gap 12 (mobile 2 cols gap 10). Tile `.rp-stat`: border 1px line, bg surface, radius 12, padding 14px 16px (mobile 12 14), col gap 4.
- Label `.rp-sl` 12/16 text-2 (optional red alert dot `.rp-alert`: 14×14 circle bg danger, "!" 700 9px color var(--bg)).
- Value `.rp-val` **28px/36px 600 -.02em** (mobile 24/30) + unit `<small>` 15px 500 text-2 margin-left 3.
- Meta: mono caption 12/16 text-3.
- Values **count up** with easeOutCubic over 700ms on load.

| tile | PR value (Last 6 sprints) | meta | notes |
|---|---|---|---|
| Completed this sprint | 23 | "of 31 planned" | |
| Avg cycle time | 3.7 **d** | "p85 6.3d" | = base 3.4 + range offset; p85 = avg × 1.7 |
| Overdue | 5 | "oldest PRJ-18" | alert "!" when > 0; meta "none" when 0 |
| Scope change | +6 **pts** | "since Oct 1" | sign "+" / "−" (U+2212) / none |

### 2.4 Chart grid & card chrome
`.rp-grid`: 3 columns gap 16 align-start (container ≤1000px → 2 cols; ≤760 → 1 col, span reset).
Layout (3-col): row 1 = **Sprint burndown (span 2)** + **Velocity**; row 2 = **Cycle time**, **Throughput**, **Objectives & milestones**.
Card `.rp-card`: border 1px line, bg surface, radius 12, padding 14px 18px (mobile 12 14), col gap 10.
Card header `.rp-ch` (min-height 24, gap 8): H2 13/18 600 + mono caption meta + spacer + optional table toggle `.rp-tbtn` (height 24, padding 0 8, radius 6, 500 12px text-3, gap 6, table icon 14px `M2.5 3.5h11v9h-11zM2.5 7h11M2.5 10h11M6.5 3.5v9`; hover bg hover/text; pressed bg hover, text, border line-2).
Legend `.rp-leg`: flex gap 14, 12/16 text-2, item gap 6. Keys: `.lk-line` 14×2 radius 1 c1; `.lk-dash` 14 wide, 2px dashed cref top border; `.lk-rect` 10×10 radius 2; `.lk-tick` 2×12 radius 1 bg text.

**Chart scaffold (all XY charts)** — grid `28px minmax(0,1fr)` × `auto 20px`:
- Y labels column (28px): labels right-aligned (right 8px, translateY(-50%)), `500 10.5px JetBrains Mono` text-3, tabular nums. **Exactly 3 ticks: max, max/2 (rounded), 0.**
- Gridlines: 1px var(--line) at each tick; baseline (0) var(--line-2). No vertical gridlines; no axis lines.
- X labels row (20px): labels centered on slot, top 7px, same mono 10.5px text-3; "Today" label text-2.
- Plot uses `aspect-ratio` W/H (below). `niceMax(v, step) = max(step, ceil(v/step)*step)`.
- Hover/focus: plot covered by equal-width **hit columns** (buttons, cursor crosshair, radius 4 4 0 0); hovered column bg `rgba(128,140,170,.07)`; bars brighten (`brightness(1.18)`; light theme `brightness(.88)`).
- **Tooltip `.rp-tip`**: absolute top 4, left calc(50% + 10px) (flips to right side `.l` when slot center > 58% width), z6, min-width 128, padding 8 10, radius 8, border line-2, bg raised, shadow-pop, col gap 6, enter 120ms (opacity 0, translateY(2px)). Header mono 500 11px text-3. Rows 12/16 text-2, gap 8: key swatch (`.rp-k` 12×2 line; `.dash` dashed cref; `.rect` 8×8 r2; `.tick` 2×10) + **value bold 13px 600 text, min-width 26** + label.
- Every hit column is keyboard focusable with descriptive aria-label; tooltips also on focus.

#### Chart 1 — Sprint burndown (line, span 2)
- Header: "Sprint burndown" · meta **"Sprint 14 · Oct 1–14"** · toggle **"View as table"**.
- Legend: line "Remaining", dashed "Ideal".
- Size: viewBox **572×200** (mobile 296×170).
- X: 14 day slots (Oct 1…Oct 14), point x = slot center `(i+0.5)/14`. X labels: "Oct 1", "Today" (at day 7, text-2), "Oct 14".
- Y: `max = niceMax(max(remaining), 10)` → PR: **50 / 25 / 0**.
- Series: **Remaining** line — stroke var(--c1), width 2, round caps/joins, no fill, only through today (7 points). **Ideal** — straight dashed line `stroke var(--cref); width 1.5; dasharray 4 4` from (day1, start) to (day14, 0).
- Today vertical line at day 7: 1px var(--line-2) full height.
- End marker: dot 9×9 c1 with `0 0 0 2px var(--surface)` ring + label (12px 600 text) "18" offset (9px, -120%).
- Tooltip head "Oct 7 · today" (or "Oct 3"), rows: line key **{v}** "pts remaining" (only for reached days) + dashed key **{ideal}** "ideal". Hover shows vertical crosshair (1px text-3) + dot at value.
- aria: "Sprint 14 burndown: 18 of 46 points remaining on Oct 7, ideal 25, ahead of ideal."
- Ideal formula: `round(start × (1 − i/13))`.
- Table view (replaces chart): columns Day | Remaining | Ideal; 14 rows, future days "—".

PR data (Oct 1–7 remaining): **46, 43, 47, 40, 36, 27, 18** (note the scope bump on Oct 3).
Ideal (Oct 1–14): 46, 42, 39, 35, 32, 28, 25, 21, 18, 14, 11, 7, 4, 0.
MO: 37, 35, 30, 29, 26, 22, 19 · IN: 38, 38, 36, 40, 37, 33, 31 · DS: 21, 21, 20, 18, 18, 15, 14 (max 30/15/0).

#### Chart 2 — Velocity (grouped bars)
- Header "Velocity" · meta **"avg 42 pts"** (mean completed, rounded) · toggle "Table" (aria "View velocity as table").
- Legend: rect c2 "Committed", rect c1 "Completed".
- Size 247×190 (mobile 296×170). Sprints shown = range sprints (Last 2 → 2, Last 6 → 6, Last 90 days → 7, Custom → 4; mobile max 4).
- Per sprint slot: two bars side by side gap 2px, each `width: clamp(5px, 30%, 24px)`, radius 4 4 0 0; Committed **c2** first (left), Completed **c1** second.
- X labels "S8"…"S13" (sprint numbers = current − n … current − 1). Y max niceMax(…,10) → **50/25/0**.
- Tooltip head "Sprint 8 · 103%" (completed/committed), rows: rect c1 **41** "completed", rect c2 **40** "committed".
- Table: Sprint | Committed | Completed.
- Data (last 8 sprints, oldest→newest; slice last n): PR committed **38, 42, 40, 44, 42, 46, 48, 46**; completed **30, 36, 41, 38, 42, 39, 45, 47**. Last 6 → S8–S13: committed 40,44,42,46,48,46; completed 41,38,42,39,45,47 (avg 42 / committed avg 44).
  MO committed 30,28,32,34,30,33,35,34 / completed 24,27,30,29,31,30,33,32. IN 36,34,38,40,36,38,40,40 / 28,31,26,33,30,29,34,31.

#### Chart 3 — Cycle time (histogram, single series)
- Header "Cycle time" · meta **"120 tasks · median 3.0d"** (median = avg × 0.8). No table toggle.
- Size 247×170 (mobile 296×150). Bars `.rp-bar.one`: `width: clamp(6px, 62%, 24px)`, c1.
- Bins (x labels): **<1d, 1–2d, 2–3d, 3–5d, 5–8d, 8d+**. Y max niceMax(…,5) → PR: **35 / 18 / 0**.
- Counts = base hist × range factor k (Last 2: 1, Last 6: 3, 90d: 3.4, Custom: 2.3). PR base **6, 11, 9, 8, 4, 2** → Last 6: **18, 33, 27, 24, 12, 6** (total 120).
- Tooltip head bin name, row rect c1 **33** "tasks · 28%".
- aria "Cycle time distribution: 120 tasks, most in 1–2d."
- MO base 9,12,7,4,2,1; IN base 2,5,7,9,8,6.

#### Chart 4 — Throughput (line + area)
- Header "Throughput" · meta **"tasks / week"**.
- Size 247×170 (mobile 296×150). Line c1 width 2; **area fill c1 at opacity .1** down to baseline. End dot + value label centered above (`translate(-50%,-150%)`).
- Weekly points for completed weeks; last = **week of Sep 28**. Weeks per range: Last 2 → 4, Last 6 → 12, 90d → 13, Custom → 9. X labels: first, middle, last week ("Jul 13", "Aug 17", "Sep 28" for 12 wks). Y niceMax(…,5) → PR Last 6: **15 / 8 / 0**.
- Tooltip head "Week of Sep 28", row line-key **11** "tasks completed"; crosshair + dot.
- Mock series (deterministic seeded): PR Last 6 (Jul 13…Sep 28): **10, 10, 10, 8, 12, 10, 12, 8, 12, 9, 9, 11** (end label 11). PR Last 2 (Sep 7–28): 9, 8, 12, 14. PR 90d (Jul 6…Sep 28): 8, 8, 10, 10, 8, 9, 12, 9, 13, 11, 9, 13, 12. PR Custom (Aug 3…Sep 28): 9, 9, 11, 10, 9, 13, 9, 13, 12. MO Last 6: 8,6,8,8,6,9,9,8,7,10,9,10. IN Last 6: 4,4,6,6,5,5,5,5,7,8,5,7.

#### Chart 5 — Objectives & milestones progress (bullet bars)
- Header "Objectives & milestones" (no meta, no toggle). Legend: rect c1 "Progress", tick "Expected today".
- Group labels `.rp-pgrp` "OBJECTIVES" / "MILESTONES" (mono 500 11px, letter-spacing .06em, uppercase, text-3, margin 4px 0 2px). Milestones group hidden on mobile.
- Row `.rp-prow` (grid `minmax(0,1fr) 42% 34px`, gap 10, height 28, width calc(100% + 12px), margin 0 -6, padding 0 6, radius 6, 400 12.5px; hover bg hover): name (ellipsis) · track (height 8, radius 4, bg **var(--c1-t)**) with fill (c1, radius 4, width = pct%) and **target tick** (2px wide, extends 4px above/below, radius 1, bg var(--text), `box-shadow 0 0 0 1px var(--surface)`, at expected %) · value "68%" (mono 500 11.5px text-2 right).
- Tooltip `.rp-tip.p` above row (bottom calc(100%+2px), right 44px): head name; rows rect c1 **68%** "complete", tick **70%** "expected today" (+ " · due Oct 21" for milestones).
- aria "{name}: 68 percent, expected 70 percent, behind by 2".
- PR data [progress, expected]: Cut p95 latency to 200ms 68/70 · Ship beta on time 42/60 · Zero P1 incidents in Q4 85/80 · Onboarding under 5 minutes 55/50; Alpha 100/100 (due Sep 12) · Beta launch 64/78 (Oct 21) · Release candidate 20/25 (Nov 18) · General availability 0/5 (Dec 9).
  MO: 40/55, 71/60, 90/80, 62/70; 100/100, 58/70, 12/20, 0/5. IN: 52/70, 30/60, 95/80, 20/50; 100/100, 48/70, 8/20, 0/5.
  **Note:** these values are illustrative and do NOT match the Goals screen's computed values (e.g. Beta 40% there). In production feed both from the same source (task-completion %, expected = time-elapsed %).

### 2.5 Animation ("700ms draw")
On load / project change / range change: a reset class applied for one frame (~40ms) then removed:
- Bars: `transform: scaleY(0) → none`, origin bottom, 700ms ease; staggered `transition-delay: i×45ms` (velocity completed bar +60ms).
- Lines: dash trick (pathLength 1, dasharray "1 2", dashoffset 1.05 → 0) 700ms ease = draw left→right.
- Ideal line opacity 0→1 400ms; area opacity 0→.1 500ms delay 300ms; end dot/label opacity 200ms delay 600ms.
- Progress fills: `scaleX(0) → none`, origin left, 700ms, stagger i×50ms.
- KPI count-up easeOutCubic 700ms.
Recharts mapping: `isAnimationActive`, `animationDuration={700}`, `animationEasing="ease-out"`, per-bar `animationBegin` stagger; area with `fillOpacity={0.1}`.

### 2.6 States
- **Loading** (`aria-busy`, "Loading reports"): 4 KPI skeletons (height 86), grid of cards in final positions: span-2 card (title sk 120×14, sub 180×10, chart 200 tall), card (90×14, 150×10, 200), card (100×14, 200), card (90×14, 200), card (140×14, 200).
- **Error** `.rp-err` (role alert; border line, bg surface, radius 12, padding 32, col gap 12, items start): red "!" dot · **"Couldn’t load reports"** (15px 600) · row: secondary sm "Retry" (refresh icon `M13 8a5 5 0 11-1.5-3.5M13 2.5v3h-3`, swaps to spinner while retrying ~900ms) + mono caption **"503 · ref 7f3a91"**. Recovers to ready + draw animation.
- **Not enough data** (new project DS, Sprint 1): burndown still renders (DS data); Velocity, Cycle time, Throughput show `.rp-empty` (min-height 190, padding 16, border **1px dashed var(--line-2)**, radius 10, centered col gap 8): 20px icon (bars / trend line `M2.5 12l3.5-4 3 2.5 4.5-6`) stroke text-3, **"Not enough data yet"** (13px 600), mono caption **"1 of 3 sprints"**, mini progress `.rp-need` 96×4 radius 2 bg raised with 33% fill text-3. Velocity table toggle and meta hidden. O&M card: target icon, **"No objectives linked"**, caption **"0 of 4"**. DS KPIs: Completed 3 of 12 planned · Avg cycle 1.8d p85 3.1d · Overdue 0 "none" (no alert) · Scope change 0 pts.
- Empty-data threshold implied: velocity/cycle/throughput require **3 completed sprints**.

### 2.7 Responsive / mobile (390, "stacked")
Container ≤760: show mobile top bar; page padding 12px 16px 32px, gap 14; controls full width; KPI 2×2; charts single column; burndown 296×170; velocity max 4 sprints (S10–S13) 296×170; cycle/throughput 296×150; O&M shows Objectives only; card padding 12 14; value 24/30. Sidebar hidden. ≤1000: 2-column chart grid.

### 2.8 Data fields / backend implications (Reports)
Per project + range:
- `sprint { number, startDate, endDate, dayIndex, lengthDays }`
- KPIs: `completedThisSprint`, `plannedThisSprint`, `avgCycleTimeDays`, `p85CycleTimeDays`, `overdueCount`, `oldestOverdueKey`, `scopeChangePts` (since sprint start).
- Burndown: daily remaining points for current sprint (+ start total for ideal).
- Velocity: per sprint `{sprint, committedPts, completedPts}`.
- Cycle time: per completed task cycle time → bucketed into 6 bins; total + median.
- Throughput: completed tasks per ISO week.
- Objectives/milestones: `{name, progressPct, expectedPct, dueDate?}`.
- Range filter values: `last2sprints | last6sprints | last90days | custom(from,to ≤ today)`.
- Export: CSV (data), PNG (charts), PDF (report) — async generation with "Preparing {fmt}…" status (likely a job endpoint).
- Reports hidden from **viewer** role in nav.

### 2.9 v2 / coming soon
Nothing in either file is marked v2 or "coming soon". Timeline view for milestones is fully specified (v1). Export formats appear functional (mock 1.6s spinner) — backend is TBD.
