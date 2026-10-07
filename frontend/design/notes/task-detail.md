# Task detail — implementation notes (boards 09, 10, 14)

Sources (all read in full):
- `clean/09-Task-detail-interactive.html` — "Lightex · Task detail". Interactive prototype: app shell (sidebar + kanban board) with the task panel opening over it. Preview 1440×960.
- `clean/10-Task-detail-states.html` — "Task detail states". Static spec sheet of 12 cropped state frames. Preview 1440×2300.
- `clean/14-Task-panel-v2-variants.html` — "Lightex · Task panel v2". Seven live frames of the **v2 task panel** (`.tp` component). Preview 1440×3020.

**Which design is final:** the v2 panel (`.tp-*` classes, `/*TP-CSS-START*/…/*TP-CSS-END*/` and `//TP-JS-START…//TP-JS-END`) is the shipped/chosen design. Board 14 is titled "SCREENS · TASK DETAIL v2", and board 09 also renders this exact component. Board 09 still contains an older v1 stylesheet (`.panel`, `.pbody`, `.prow`, `.menu`, `.ie`, `.desc-btn`, `.tabs`, `.att`, `.tile`, `.dz`, `.up`, `.cmt`, `.composer`, `.tl`, `.banner`, `.ro-note`, `.toast`) that its markup no longer uses, except for `.toast`, `.btn`, `.kbd`, the board and the glyphs. Treat v1 as superseded (summary in §9). Board 10 is a states sheet. Some of its microcopy and features differ from v2, such as a calendar picker, `/` commands and objective search; §6 lists the differences.

v2 design principles, from the header of board 14 (mono 12px, `--text-3`): **"3 chips" · "4 fields" · "Planning folded" · "empty = hidden"**.

---

## 1. Design tokens

### 1.1 Themes (class on the root `.ds` element). Default theme = **navy**.
The prop `theme` is an enum of `navy | dark | light` (default `navy`) in 09 and 10. Board 14 is hard-wired to `t-navy`.

| Token | `.t-navy` (default) | `.t-dark` | `.t-light` |
|---|---|---|---|
| `--bg` | `#060B18` | `#0B0B0F` | `#FAFAFB` |
| `--surface` | `#0C1326` | `#121217` | `#FFFFFF` |
| `--raised` | `#131C34` | `#1A1A21` | `#F3F3F6` |
| `--hover` | `#1B2644` | `#22222B` | `#EAEAEF` |
| `--line` | `#1C2845` | `#24242E` | `#E4E4EA` |
| `--line-2` | `#2B3A5E` | `#34343F` | `#D0D0D9` |
| `--control` | `#5F6F96` | `#6A6A7C` | `#8A8A9B` |
| `--text` | `#EAF0FF` | `#ECECF1` | `#121217` |
| `--text-2` | `#A5B2D1` | `#A3A3B1` | `#55556A` |
| `--text-3` | `#8794B6` | `#8E8E9D` | `#5F5F70` |
| `--accent` | `#2B67F5` | `#2662EE` | `#1D4ED8` |
| `--accent-h` (hover) | `#2F6DF6` | `#2B67F5` | `#2563EB` |
| `--accent-p` (pressed; 09 only) | `#2358DB` | `#1F52D6` | `#1E40AF` |
| `--accent-t` (accent text) | `#8AB0FF` | `#7FA8FF` | `#1D4ED8` |
| `--accent-s` (accent soft bg) | `rgba(43,103,245,.2)` | `rgba(38,98,238,.18)` | `rgba(29,78,216,.10)` |
| `--ring` | `rgba(90,150,255,.5)` | `rgba(79,140,255,.5)` | `rgba(29,78,216,.35)` |
| `--spark` | `#5BE0FF` | `#5BE0FF` | `#0891B2` |
| `--low` | `#2DD4BF` | `#2DD4BF` | `#0F766E` |
| `--todo` | `#C4CBE0` | `#C4C4D0` | `#3E3E50` |
| `--ok` | `#4ADE80` | `#4ADE80` | `#157A3A` |
| `--warn` | `#F5B73B` | `#F5B73B` | `#8A5A00` |
| `--danger` | `#FF7A70` | `#FF7A70` | `#B92F26` |
| `--info` | `#B79CFF` | `#B79CFF` | `#6B3FD4` |
| `--orange` | `#FF9A4D` | `#FF9A4D` | `#A84A0A` |
| `--danger-solid` (09 only) | `#C23A30` | `#C23A30` | `#B92F26` |
| `--shadow-pop` | `0 8px 24px rgba(0,0,0,.5)` | `0 8px 24px rgba(0,0,0,.45)` | `0 8px 24px rgba(18,18,23,.10)` |
| `--shadow-modal` (09, 14) | `0 24px 64px rgba(0,0,0,.6)` | `0 24px 64px rgba(0,0,0,.55)` | `0 24px 64px rgba(18,18,23,.18)` |
| `--av-l` / `--av-c` | `.40` / `.10` | `.40` / `.10` | `.90` / `.06` |
| `--logo` (09 only) | `#3B7BFF` | `#3B7BFF` | `#1D4ED8` |
| `--pk-l`/`--pk-c` (09, project badge bg) | `.32`/`.07` | `.32`/`.06` | `.93`/`.04` |
| `--pkt-l`/`--pkt-c` (09, project badge text) | `.88`/`.09` | `.88`/`.08` | `.42`/`.12` |

Motion tokens are set on `.ds`:
- `--ease: cubic-bezier(.16,1,.3,1)` (expo-out). This is the default easing for everything.
- `--spring: cubic-bezier(.34,1.56,.64,1)` (overshoot). Used for the done pop, checkboxes, tab indicator, card lift and sidebar indicator. 10 defines only `--ease`.

Avatars use `background: oklch(var(--av-l) var(--av-c) <hue>)`, with text `var(--text)` at weight 600. People and hues:
- Alex Kim `AK` 285
- Jordan Lee `JL` 200
- Sam Patel `SP` 20
- Riley Chen `RC` 150

Project badges use `oklch(var(--pk-l) var(--pk-c) hue)` for the background and `oklch(var(--pkt-l) var(--pkt-c) hue)` for the text.

### 1.2 Base typography
- `.ds`: `font-family:'Inter',system-ui,-apple-system,'Segoe UI',sans-serif; font-size:13px; color:var(--text); background:var(--bg); -webkit-font-smoothing:antialiased`. All elements use `box-sizing:border-box`.
- `.mono`: `'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace`.
- `.cap`: 12px/16px, `--text-3`. `.lbl`: 12px/500, `--text-2`.
- Focus ring (universal pattern): `outline:none; box-shadow:0 0 0 1px var(--accent), 0 0 0 4px var(--ring)` on `:focus-visible`. Drop zones use `:focus-within`.
- Reduced motion: `@media (prefers-reduced-motion:reduce){ .tp,.tp *{animation-duration:.001ms!important;transition-duration:.001ms!important} }`. In 09, `.ds *` also gets this rule and `.tc:hover{transform:none}`. In 10 the skeleton shimmer is set to `animation:none`.

### 1.3 Shared primitives
- **Kbd** (`.kbd` / `.tp-kbd`): `font:500 11px/1 'JetBrains Mono'; min-width:18px; height:18px; padding:0 5px; inline-flex center; border:1px solid var(--line-2); border-bottom-width:2px; border-radius:4px; background:var(--raised); color:var(--text-2)`. Inside a primary button: `background:rgba(255,255,255,.16); border-color:rgba(255,255,255,.3); color:#fff`.
- **Status glyph** (`.g` / `.tp-g`): 14×14 circle, `position:relative`, coloured via `currentColor`.
  - `backlog`: `border:1.5px dashed currentColor`.
  - `todo`: `1.5px solid`.
  - `progress`: `1.5px solid; padding:2px; background:conic-gradient(currentColor 0 180deg,transparent 0) content-box` (half pie).
  - `review`: same as progress at 270deg (three-quarter pie).
  - `done`: solid fill plus an `::after` check (`left:4px;top:2px;width:3px;height:6px;border:solid var(--bg);border-width:0 1.5px 1.5px 0;rotate(45deg)`).
  - `cancel`: `1.5px solid` ring plus an `::after` slash (`left:2px;top:5px;width:7px;height:1.5px;background:currentColor;rotate(-45deg)`).
- **Status map** (name / glyph / colour / menu key):
  1. Backlog / backlog / `--text-3` / `1`
  2. Todo / todo / `--todo` / `2`
  3. In progress / progress / `--warn` / `3`
  4. In review / review / `--info` / `4`
  5. Done / done / `--ok` / `5`
  6. Canceled / cancel / `--text-3` / `6`
- **Priority bars** (`.pr` / `.tp-bars`): `inline-flex; align-items:flex-end; gap:1.5px; height:12px`. Four `<i>` bars, each `width:3px; border-radius:1px; background:var(--line-2)`, at heights 4/7/10/12px. Class `n1..n4` fills the first N bars with `currentColor`.
  - Priority values: 4 Urgent `n4` `--danger` · 3 High `n3` `--orange` · 2 Medium `n2` `--warn` · 1 Low `n1` `--low` · 0 "No priority" (no fill, `--text-3`).
  - Priority menu order and keys: Urgent `0`, High `1`, Medium `2`, Low `3`, No priority `4`. These keys are the loop index, so they are 0-based. Status keys are 1-based.
- **Avatar** `.tp-av`: 20×20, font 9px. `.tp-av.l`: 28×28, font 11px. Both are `border-radius:50%`. v1 `.av` adds `box-shadow:0 0 0 2px var(--surface)`, with sizes `s20` (9px), `s24` (10px) and `s28` (11px).
- **Label colours** (`LABEL_C`):
  - `frontend` → `var(--low)`
  - `board` → `var(--orange)`
  - `perf` → `var(--info)`
  - any other label → `var(--text-3)`

---

## 2. Board 14 — Task panel v2 variants (canonical component)

### 2.1 Canvas
- Root: `.ds.t-navy`, `width:1440px; height:3020px; padding:64px 80px; flex column; gap:36px; overflow:hidden`.
- Header: flex, `align-items:flex-end; justify-content:space-between; gap:24px`.
  - Eyebrow "SCREENS · TASK DETAIL v2": `font:500 12px/1 'JetBrains Mono'; color:--text-3; letter-spacing:.04em`.
  - H1 "Task panel": `48px/54px; weight 600; letter-spacing:-.03em`. Eyebrow-to-title gap is 10px.
  - Right side: four mono 12px/500 `--text-3` spans with gap 16px: "3 chips", "4 fields", "Planning folded", "empty = hidden".
- Frame grid: `grid-template-columns:repeat(3,minmax(0,1fr)); gap:40px`, so each column is (1280−80)/3 = **400px**.
- Each frame is a `figure.frame` (flex column, gap 12px).
  - Caption: `figcaption` 14px/600, flex baseline, gap 10px, followed by a meta `<span>` in mono 11px/500 `--text-3`.
  - Device: `.dev`, `position:relative; border:1px solid var(--line-2); border-radius:14px` (overridden per frame), `overflow:hidden; background:var(--bg)`.
- Panels inside frames use `.tp.static`: `position:absolute; inset:0; width:auto; box-shadow:none; border-left:0`, with `showClose:false`. The close X is therefore hidden in every frame of board 14.

### 2.2 Frames
| # | Caption | Meta | Span | Device size | Radius | Data / init |
|---|---|---|---|---|---|---|
| a | Side panel | planning folded | 1 | 100%×920 | 14 | FULL task, Planning collapsed |
| b | Editing | planning open · + Add property | 1 | 100%×920 | 14 | FULL with `labels:[]`, `due:null`; init `planOpen:true, menu:'add'`. The Add-property menu is open and lists **Due date** and **Labels**. |
| c | Viewer | read-only | 1 | 100%×920 | 14 | FULL, `role:'viewer'`, `planOpen:true` |
| d | Empty fields | only what has a value | 1 | 100%×880 | 14 | EMPTY task (PRJ-58) |
| e | Mark done | click to replay the spark | 1 | 100%×880 | 14 | FULL with status `done`, init `fx:'PRJ-42'` (spark animation on mount) |
| f | Mobile bottom sheet | < 760px | 1 | **390px**×880 | **28** | FULL, `sheet:true`. Class forced to `'sheet'` (drops `static`). Background shows `.mockbg` and `.scrim`. |
| g | Full page | two columns · properties rail | **3** (1280px) | 100%×780 | 14 | FULL, `full:true`, `planOpen:true` |

Phone frame backdrop (frame f):
- `.mockbg`: `position:absolute; inset:0; padding:60px 14px 14px; flex column; gap:10px`. Contains four `<i>` blocks, each `height:84px; border-radius:8px; background:var(--surface); border:1px solid var(--line)` (fake cards).
- `.scrim`: `position:absolute; inset:0; background:rgba(2,5,14,.55); backdrop-filter:blur(4px)`.

### 2.3 Data
**FULL task**
- `key` PRJ-42
- `title` "Fix flaky board reflow on column resize"
- `status` progress
- `pri` 3 (High)
- `asg` Alex Kim (AK, 285)
- `reporter` Jordan Lee (JL, 200)
- `type` "Bug"
- `est` 3
- `due` `{date:'Oct 21', rel:'in 14 days', soon:false}`
- `sprint` "Sprint 14"
- `milestone` "Beta launch"
- `epic` "Auth overhaul"
- `objectives` ['o1','o2']
- `labels` ['frontend','board']
- `rich` true

**EMPTY task**
- `key` PRJ-58
- `title` "Write release notes for 2.4"
- `status` todo
- `pri` 0
- `asg` null
- `reporter` Jordan Lee
- `type`, `est`, `due`, `sprint`, `milestone`, `epic`: all null
- `objectives` [], `labels` []
- `rich` false

**Objectives catalogue (OBJ)**
- o1 "Cut p95 latency to 200ms"
- o2 "Ship beta on time"
- o3 "Zero P1 incidents in Q4"
- o4 "Onboarding under 5 minutes"

**People**: Alex Kim, Jordan Lee, Sam Patel, Riley Chen.

**Sub-tasks** (only shown when `rich`); initial state has PRJ-43 done:
- PRJ-43 "Add ResizeObserver to the board" (AK)
- PRJ-44 "Debounce reflow on sidebar toggle" (JL)
- PRJ-45 "Regression test: drag while resizing" (SP)

**Files** (rich):
- `drag-glitch.png` · 1.2 MB · img · ext PNG
- `reflow.ts` · 4 KB · code · ext TS. Preview text:
  ```
  export function reflow(
    cols: Column[],
  ) {
    cols.forEach(m);
  ```

**Comments** (rich):
- Jordan Lee · "2h" · "Repro’d on Safari too. @Alex Kim is `will-change` the culprit?"
- Alex Kim · "1h" · "Yes. Fix is behind the `board-reflow` flag."

**Activity** (rich):
- "**Alex Kim** moved this to **In progress** · 1h"
- "**Jordan Lee** linked **Cut p95 latency** · 3h"
- "**Jordan Lee** created the task · Oct 2"

When the task is not rich, activity is a single entry: "**Jordan Lee** created the task · today".

### 2.4 Panel container `.tp`
- Default overlay panel: `position:absolute; top:0; right:0; bottom:0; width:520px; max-width:100%; display:flex; flex-direction:column; background:var(--surface); border-left:1px solid var(--line-2); box-shadow:var(--shadow-modal); z-index:5; transition:width 250ms var(--ease)`.
- `.tp.full`: `width:100%; border-left:0; box-shadow:none`. The width transition animates 520 → 100%.
- `.tp.static`: `position:absolute; inset:0; width:auto; box-shadow:none; border-left:0`. Used for embedded previews.
- `.tp.leaving`: `animation:tpout 160ms var(--ease) forwards`, where `@keyframes tpout{to{opacity:0;transform:translateX(24px)}}`.
- `.tp.sheet` (mobile):
  - Layout: `top:auto; left:0; right:0; bottom:0; width:auto; height:88%; border-left:0; border-top:1px solid var(--line-2); border-radius:18px 18px 0 0`.
  - Shadow: `box-shadow:0 -16px 48px rgba(0,0,0,.45)`.
  - Enter animation: `animation:tpsheet 280ms var(--ease)`, where `tpsheet{from{transform:translateY(100%)}to{transform:none}}`.
- `@media (max-width:760px)`: `.tp:not(.static)` becomes `position:fixed; top:auto; left:0; right:0; bottom:0; width:auto!important; height:92vh`, with border-top, radius 18px 18px 0 0 and the `tpsheet` animation. In the real app this means a 92vh sheet. The board-14 mock uses 88%.
- Grab handle `.tp-grab`: `display:none`. It shows only in sheet or mobile, with `width:36px; height:4px; border-radius:2px; background:var(--line-2); margin:8px auto 0`.
- Scroll area `.tp-scroll`: `flex:1; min-height:0; overflow:auto`. It also carries `.tp-fade` (`animation:tpfade 160ms var(--ease)`, opacity 0→1). This fade re-plays when switching tasks.

### 2.5 Header `.tp-head`
`height:48px; flex:none; display:flex; align-items:center; gap:4px; padding:0 8px 0 14px; border-bottom:1px solid var(--line)`. Left to right:

1. **Breadcrumb** `.tp-crumb`: 12px, `--text-3`, nowrap, ellipsis, `max-width:150px`. Text is the task's epic, falling back to "Platform Rebuild" (09 passes `curT.epic || 'Platform Rebuild'`; 14 always shows "Platform Rebuild"). Hidden in `.sheet`.
2. Separator "/" in `--text-3`, `margin:0 2px`.
3. **Key button** `.tp-key`: `height:26px; padding:0 6px; radius 6px; color:--text-2; font:500 12px/1 JetBrains Mono; gap:6px`. Hover: `--hover` background and `--text` colour.
   - Content: the key (e.g. "PRJ-42") followed by a 12×12 copy icon (`rect x3.5 y3.5 w6.5 h6.5 rx1.2` plus path `M2 8V3a1 1 0 011-1h5`, stroke 1.3). Lucide equivalent: `copy`.
   - aria-label: "Copy task key PRJ-42".
   - Click: `navigator.clipboard.writeText(key)` and show `<span role=status>` "**Copied**" (12px, `--ok`) for **1400ms**.
4. Flex spacer.
5. **Mark done** `.tp-done`, shown only if `canEdit`:
   - Base: `height:28px; margin-right:4px; padding:0 10px; radius 7px; border:1px solid var(--line-2); background:--raised; color:--text; font:500 12px/1 Inter; gap:7px`. Transitions border/bg/color/transform at 120ms.
   - Hover: `border-color:var(--ok)`. Active: `scale(.97)`.
   - Done state `.is`: `border-color:transparent; background:rgba(74,222,128,.14); color:var(--ok)`.
   - Ring `.tp-ring`: 14×14 circle, `border:1.5px solid var(--text-3)`. In `.is` it becomes `background:--ok; border-color:--ok` with a check `::after` (`left:3.5px; top:1px; 3×6; border:solid var(--bg); 0 1.5px 1.5px 0; rotate 45deg`).
   - Label: "Mark done" / "Done". Title: "Mark done (⌘⇧D)" / "Reopen". Uses `aria-pressed`.
   - Click toggles status between done and **todo**. Reopen sets status to `todo`, not the previous status.
6. **Expand/collapse** `.tp-ib`: 30×30, radius 7px, colour `--text-2`, hover `--hover`/`--text`.
   - Hidden in sheet mode.
   - aria-label "Expand to full page" / "Collapse to panel". Title appends " (⌘⇧F)".
   - Icons are 14px, stroke 1.5. Expand: `M8.5 2h3.5v3.5M5.5 12H2V8.5M12 2L8 6M2 12l4-4` (lucide `maximize-2`). Collapse: `M12 2L8.5 5.5M8.5 2.5v3h3M2 12l3.5-3.5M5.5 11.5v-3h-3` (lucide `minimize-2`).
7. **More** `.tp-ib`: three filled dots (circles r1.3 at x 3.5/8/12.5, y 8; lucide `more-horizontal`). `aria-haspopup=menu`.
   - Menu `.tp-menu` at `top:36px; right:0`, with these items:
     - "Copy link" with kbd "⌘L". Fires the toast "Link to PRJ-42 copied" (no undo).
     - "Duplicate" with kbd "⌘D". Requires `canEdit`.
     - A `.tp-sep`, then "Delete task" with kbd "⌫" in `.dng` (`--danger`). Requires `canDelete` (admin and not already deleted).
8. **Close** `.tp-ib`: X icon `M3 3l8 8M11 3l-8 8`, 14px, stroke 1.5. aria-label "Close", title "Close (Esc)". Hidden when `showClose:false`.

### 2.6 Body grid `.tp-body`
- Panel mode: `display:grid; grid-template-columns:minmax(0,1fr); grid-template-areas:"title" "props" "main"; row-gap:16px; padding:18px 20px 40px; max-width:1200px; margin:0 auto`.
- Full page (`.full .tp-body`): `grid-template-columns:minmax(0,1fr) 300px; grid-template-areas:"title rail" "main rail"; column-gap:48px; row-gap:20px; padding:28px 40px 60px`. The props move into the rail: `.full .tp-props{grid-area:rail; border-left:1px solid var(--line); padding-left:24px; align-self:start}`.
- Sheet / narrow: `padding:12px 16px 32px`. At ≤760px everything returns to a single column, the props lose their left border, and chips switch to `flex-wrap:nowrap; overflow-x:auto` with `height:36px` (touch).
- Region classes:
  - `.tp-title`: flex column, gap 8px.
  - `.tp-props`: flex column, gap 12px.
  - `.tp-main`: flex column, **gap 24px**.
- Deleted state:
  - The body gets `.tp-dim`: `opacity:.55; pointer-events:none; filter:saturate(.6)`.
  - A banner sits above the body, wrapped in `padding:14px 20px 0`. Banner `.tp-banner`: `flex; align-items:center; gap:12px; padding:10px 12px; radius 8px; border:1px solid var(--line-2); background:var(--raised)`. It has `role=status`.
  - Banner contents: a 16px trash icon (stroke `var(--danger)` 1.5, path `M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5`, lucide `trash`), then "**Deleted** · restorable for 30 days" (the suffix is weight 400 `--text-3`), then the button "Restore" (`.tp-btn.sec`).

### 2.7 Title
- **Editable** `.tp-ti` (a button):
  - `display:block; width:100%; text-align:left; border:1px solid transparent; radius 7px; font:600 22px/30px Inter; letter-spacing:-.015em; padding:2px 8px; margin-left:-9px; cursor:text`.
  - Hover background is `--hover`.
- **Editing** `.tp-tin` (input):
  - `border:1px solid var(--accent); box-shadow:0 0 0 3px var(--accent-s); radius 7px; background:--surface; same font; padding:1px 7px; margin-left:-9px`. Autofocus.
  - aria-label "Task title".
  - Enter saves (trimmed, max 200 chars; an empty value is ignored). Escape cancels. Blur saves.
- **Read-only**: `<h2>` with the same font and margin 0.
- **Viewer note** `.tp-note`, below the title:
  - `flex; gap:8px; padding:8px 10px; radius 8px; background:--raised; 12px; --text-2`.
  - Content: a 14px eye icon (`M1.5 7S3.5 3 7 3s5.5 4 5.5 4-2 4-5.5 4-5.5-4-5.5-4z` plus circle r1.6; lucide `eye`) and the text "**View only**".

### 2.8 Properties block (`.tp-props`)

**(a) Three chips row** `.tp-chips`: `flex; gap:6px; wrap; align-items:center`.
- Chip `.tp-chip`:
  - `height:28px; padding:0 10px; radius 7px; border:1px solid var(--line-2); background:--raised; color:--text; font:500 12.5px/1 Inter; gap:7px; nowrap`.
  - Hover and `[aria-expanded=true]`: `border-color:--control; background:--hover`.
  - `.ro` (viewer): a span with `cursor:default`.
  - `.ghost` (empty value): `border-style:dashed; background:transparent; color:--text-3`, hover `--text`.
- Chip 1, **Status**: glyph plus name. aria-label "Status: In progress". Opens a listbox `aria-label="Status"` at `top:34px; left:0`. Options are glyph + name + kbd 1–6. The selected option gets `.on` (`--accent-s`). Picking Done triggers the spark fx.
- Chip 2, **Priority**: bars plus name. If unset and the user can edit, a ghost chip "**+ Priority**" appears. The listbox lists Urgent, High, Medium, Low and "No priority".
- Chip 3, **Assignee**: 20px avatar plus name. If unset, a ghost chip "**+ Assign**" appears. The listbox lists the four people with avatars. If set, it adds a `.tp-sep` and "Unassign".
- Viewers never see ghost chips: `priGhost` and `asgGhost` require `canEdit`.

**(b) Four-field grid** `.tp-grid`: `grid-template-columns:repeat(2,minmax(0,1fr)); gap:0 12px`. Only fields with values render.
- Field `.tp-f`:
  - A button (or a div when `.ro`): `flex column; gap:3px; padding:6px 8px; margin:0 -8px; radius 7px; text-align:left`.
  - Hover background `--hover`. In `.ro` mode there is no hover and the cursor is default.
- Label `.tp-fl`: 11px/14px, `--text-3`, weight 500.
- Value `.tp-fv`: 13px/18px, `--text`, weight 500, flex, gap 6px, nowrap, ellipsis.
- Sub text `.tp-sub`: `--text-3`, weight 400. `.tp-sub.soon` uses `--warn` (due soon).
- Field order and content:
  1. **Reporter**: 20px avatar plus name, e.g. "Jordan Lee".
  2. **Type**: e.g. "Bug".
  3. **Estimate**: "3 pts".
     - Clicking turns it into an input `.tp-num`: `width:72px; height:26px; padding:0 8px; radius 6px; border:1px solid --accent; box-shadow:0 0 0 3px --accent-s; font:500 13px/1 JetBrains Mono`, `type=number min=0 max=99`, aria-label "Estimate in points", followed by the suffix "pts".
     - Enter or blur saves (parseInt, clamped 0–99). Escape cancels.
  4. **Due date**: "Oct 21" with sub "· in 14 days" (`.soon` → warn colour).
- The other fields have empty `act` handlers in the prototype. The intended editors come from board 10 (calendar picker etc.).

**(c) Planning (folded accordion)** `.tp-plan`. Shown only if sprint, milestone, epic or objectives exist.
- Container: `border:1px solid var(--line); radius 10px; background:var(--bg)`.
- Header `.tp-planh` (a button):
  - Layout: `height:38px; padding:0 10px; radius 10px; font:600 12.5px/1 Inter; gap:8px`. Hover background `--hover`.
  - Chevron: 12px `M6.5 4.5L10 8l-3.5 3.5` (lucide `chevron-right`), `--text-3`, rotates 90deg when `aria-expanded=true` (200ms ease).
  - Label: "**Planning**".
  - Summary `.tp-sum` (flex:1, 400, `--text-3`, ellipsis) is the parts joined by " · ", e.g. "Sprint 14 · Beta launch · 2 objectives" (singular "1 objective"). It fades to `opacity:0` when expanded (150ms).
- Collapse mechanism: `.tp-col{display:grid; grid-template-rows:0fr; transition:grid-template-rows 220ms var(--ease)}`. `.open` sets `1fr`. The child has `overflow:hidden; min-height:0`.
- Inner wrapper: `padding:0 0 8px`.
- Rows `.tp-pr`: `grid-template-columns:84px minmax(0,1fr); align-items:center; min-height:30px; padding:0 10px`.
  - Label: `.tp-fl` at 12px.
  - Value button `.tp-pv`: `min-height:26px; padding:0 6px; margin-left:-6px; radius 6px; font:500 13px/1.3`. Hover `--hover`. `.ro` has no hover.
  - Rows in order: **Sprint** "Sprint 14", **Milestone** "Beta launch", **Epic** "Auth overhaul".
- **Objectives** row (`align-items:start; padding-top/bottom:4px`; label `padding-top:5px`):
  - Chips wrap with gap 6px.
  - Objective chip `.tp-oc`: `height:24px; padding:0 4px 0 8px; radius 6px; background:--raised; border:1px solid --line; 12px/500; gap:5px`.
    - Leading 11px target icon (two circles r5 and r1.8, stroke `--accent-t` 1.5; lucide `target`-like).
    - Name.
    - Unlink button: 18×18, radius 4, `--text-3`, hover `--hover`/`--text`, 9px X icon. aria-label "Unlink Cut p95 latency to 200ms".
    - `.ro` has `padding-right:8px` and no button.
  - Add button `.tp-mini` "+": `height:22px; min-width:22px; padding:0 6px; radius 6px; border:1px dashed --line-2; transparent; --text-3; 500 12px`. Hover `--text`/`--control`. aria-label "Link objective".
  - The add button opens a multiselect listbox (`aria-multiselectable=true`, `top:30px; left:0; width:250px`). Each row is a `label.tp-mi` containing a checkbox `.tp-cb` and the objective name (ellipsis). Toggling links or unlinks immediately.
  - The row is shown if there are objectives or the user can edit.

**(d) Labels** `.tp-labels` (flex wrap, gap 6px). Shown only if labels exist.
- Label pill `.tp-lab`: `height:22px; padding:0 8px; radius 6px; --raised; 1px --line; 12px/500; gap:6px`.
- Each pill has a 7×7 dot (`.tp-dot`, round) in the label colour, then the name ("frontend", "board").
- A `.tp-mini` "+" button (aria "Add label") follows if the user can edit.

**(e) "Add property"** `.tp-addp`. Shown when the user can edit and at least one property is missing.
- Button: `height:26px; padding:0 8px; margin-left:-8px; radius 6px; --text-3; 500 12px; gap:6px`, with a 12px plus icon. Hover and expanded: `--hover`/`--text`.
- Menu at `top:30px; left:-8px` lists the missing properties in this order: Type, Estimate, Due date, Sprint, Milestone, Epic, Objective, Labels.
- Picking an entry fills a demo default:
  - Type → Feature
  - Estimate → 2
  - Due date → Oct 24 / in 17 days
  - Sprint → Sprint 14
  - Milestone → Beta launch
  - Epic → Auth overhaul
  - Objective → o2
  - Labels → frontend
- Picking Sprint, Milestone, Epic or Objective auto-expands Planning.
- Note that Priority and Assignee are not in this list; they have ghost chips instead.

**Menus** (all popovers): `.tp-menu`
- Container: `position:absolute; z-index:20; min-width:220px; padding:4px; radius 10px; border:1px solid --line-2; background:--raised; box-shadow:--shadow-pop`.
- Enter animation: `tpmenu 150ms var(--ease)`, from `opacity:0; translateY(-4px) scale(.98)`.
- Item `.tp-mi`: `height:30px; padding:0 8px; radius 6px; gap:10px; font:500 13px/1 Inter`. Hover `--hover`. `.on` uses `--accent-s`. `.dng` uses `--danger`.
- Separator `.tp-sep`: `1px; --line; margin:4px -4px`.
- Section header `.tp-mh` (defined, unused): mono 11px/500, `letter-spacing:.06em`, uppercase, `--text-3`, `padding:6px 8px 4px`.
- Only one menu is open at a time (`menu` state). Escape closes the menu first, and only then closes the panel. Escape does not close the panel while title, description or estimate is being edited.

### 2.9 Main column (`.tp-main`, gap 24px)

**Section header** `.tp-sec`: `flex; align-items:center; gap:10px; margin-bottom:8px`. The h3 is 13px/600, margin 0. Counter `.tp-cnt`: mono 11px/500 `--text-3`.

**Description** (`section aria-label="Description"`, no visible heading)
- Rich text `.tp-rt`: 14px/22px, `--text`. `p` has `margin:0 0 10px`. `h4` is 13px/600 with `margin:12px 0 6px`. `ol` has `padding-left:20px`. Inline `code`: mono 12.5px, `padding:1px 5px`, radius 4px, `--raised` background, 1px `--line` border.
- Static editable mode: the paragraph is a button `.tp-descb` (`padding:6px 8px; margin:-6px -8px; radius 8px`, hover `--hover`, `cursor:text`, aria-label "Edit description") with the text "Columns jump when the sidebar collapses mid-drag. Reproduce by resizing the window while a card is held."
- Code block `.tp-code`: `border:1px solid --line; radius 8px; background:--bg; overflow:hidden; margin:4px 0 10px`.
  - Header `.tp-codeh`: `height:30px; padding:0 4px 0 12px; border-bottom:1px solid --line; mono 11px/500 --text-3; space-between`. Contains "typescript" and a copy button `.tp-btn` at `height:22px` labelled "Copy", which becomes "Copied" for 1400ms.
  - `pre`: `padding:12px 14px; font:400 12.5px/20px JetBrains Mono; overflow-x:auto`.
  - Syntax tokens: `.tk` keyword → `--info`, `.tf` function → `--accent-t`, `.tc` comment → `--text-3`.
  - Content:
    ```
    // keep columns in sync
    const ro = new ResizeObserver(() => {
      requestAnimationFrame(() => reflow(columns));
    });
    ```
- Empty state (not rich, can edit): button text "**Add a description…**" in `--text-3`, 14px. Viewers with no description see nothing.
- Editing mode `.tp-editor`: `border:1px solid --accent; box-shadow:0 0 0 3px --accent-s; radius 8px; background:--surface`.
  - Toolbar `.tp-tbar` (`role=toolbar`, aria "Formatting"): `flex; gap:2px; padding:4px 6px; border-bottom:1px solid --line`.
    - Buttons: `height:26px; min-width:26px; padding:0 6px; radius 5px; --text-2; 600 12px Inter`. Hover `--hover`/`--text`.
    - Button labels: "B" (Bold), "I" italic (Italic), "</>" mono (Code), "{ }" mono (Code block), "1." (List).
  - Body has `padding:10px 12px` and contains the paragraph and code block. The code header shows "typescript" with no copy button.
  - Footer: `flex end; gap:6px; padding:6px; border-top:1px solid --line`, with:
    - "Cancel" plus kbd "Esc" (`.tp-btn`)
    - "Save" plus kbd "⌘↵" (`.tp-btn.pri`)
  - Both buttons just exit edit mode in the prototype.

**Buttons** `.tp-btn`
- Base: `height:28px; padding:0 10px; radius 6px; font:500 12px/1 Inter; border:1px solid transparent; transparent; --text-2; gap:8px`. Hover `--hover`/`--text`.
- `.pri`: `--accent` background, `#fff` text. Hover `--accent-h`.
- `.sec`: `--raised` background, `--line-2` border, `--text`.

**Sub-tasks** (`section aria-label="Sub-tasks"`). Shown if there are sub-tasks or the user can edit.
- Header: h3 "**Sub-tasks**", count "1/3" (`.tp-cnt`), and a progress bar `.tp-bar` (`role=progressbar`, aria "Sub-task progress", `max-width:140px`).
  - Bar: `height:6px; radius 3px; background:--raised; border:1px solid --line; overflow:hidden; flex:1`.
  - Fill span: `--ok` colour, radius 3px, `transition:width 300ms var(--ease)`.
  - Percent is `round(done/total*100)`.
- Row `.tp-srow`: `flex; gap:10px; min-height:34px; padding:0 8px; margin:0 -8px; radius 6px`. Hover `--hover`. Contents:
  - **Editors**: checkbox `.tp-cb`.
    - Base: `appearance:none; 16×16; border:1.5px solid --control; radius 4px; grid center`.
    - Check mark `::after`: `8×4; border:solid #fff; 0 0 2px 2px; rotate(-45deg) scale(0); margin-top:-2px`, with `transition:transform 150ms var(--spring)`.
    - `:checked`: `--accent` background and border, scale(1). aria-label "Complete PRJ-43".
  - **Viewers**: a status glyph instead (done → `--ok`, otherwise todo `--todo`).
  - Key: mono 500 11px, `--text-3`, `width:50px`.
  - Title: flex 1. Done rows use `.tp-done-t` (`--text-3` plus line-through).
  - Assignee avatar: 20px.
- Footer button (editors): "**+ Add sub-task**" with kbd "⇧C" (`.tp-btn`, `margin-left:-10px`). It has no handler in the prototype.

**Attachments** (`section aria-label="Attachments"`). Shown if there are files or uploads, or the user can edit.
- Header: h3 "**Attachments**" and a count (number of finished files).
- Stack: flex column, gap 8px.
- Upload rows `.tp-up` (`role=status`) come first:
  - Row: `flex; gap:10px; padding:8px 10px; border:1px solid --line; radius 8px; background:--bg`.
  - Extension badge `.tp-ext`: `26×26; radius 6; mono 600 8.5px; --raised; 1px --line-2`. Text is e.g. "GIF".
  - Middle column (flex 1, column, gap 6px): a top line with the name `.tp-tn` (12px/500 ellipsis) on the left and meta on the right (mono 500 11px, `--text-3`, e.g. "38% · 6.8 MB"), then a progress bar with an `--accent` fill and `transition:width 120ms linear`. Progress aria: "Uploading <name>".
  - Trailing `.tp-ib` X: aria "Cancel upload", or "Dismiss" for errors.
  - Error rows `.err`: `border-color:--danger`, no bar, meta in `--danger` showing the error text.
- File grid `.tp-att`: `grid-template-columns:repeat(auto-fill,minmax(140px,1fr)); gap:8px`.
  - Tile `.tp-tile`: `border:1px solid --line; radius 8px; background:--bg; overflow:hidden`.
  - Image tiles show a placeholder `.tp-thumb`: `height:70px; centered ext text (mono 500 11px --text-3); border-bottom 1px --line; background:repeating-linear-gradient(135deg,var(--raised) 0 8px,var(--surface) 8px 16px)` (diagonal stripes).
  - Code tiles show `.tp-cprev`: `height:70px; padding:8px 10px; mono 400 10.5px/15px; --text-2; white-space:pre; overflow:hidden`. Uploaded code files without a preview fall back to `// <filename>`.
  - Meta `.tp-tm`: `padding:7px 10px; column; gap:2px`. Name is `.tp-tn`, size is `.tp-ts` (11px `--text-3`).
- Dropzone `.tp-dz` (editors only) is the last grid cell:
  - Box: `min-height:70px; padding:10px; border:1.5px dashed --line-2; radius 8px; column centred; gap:4px; --text-2`.
  - Contents: a 16px upload icon (`M9 12V3M5.5 6.5L9 3l3.5 3.5M3 12.5V15h12v-2.5`; lucide `upload`), the text "**Drop files or browse**" (12px/500, `--text`), and "≤ 10 MB" (`.tp-ts`).
  - Drag-over `.over`: `border-color:--accent; background:--accent-s; box-shadow:0 0 0 4px --accent-s`. Text changes to "**Drop to upload**".
  - A hidden full-cover `<input type=file multiple>` (aria "Upload attachments") accepts `image/*,.ts,.tsx,.js,.jsx,.py,.go,.rs,.java,.rb,.json,.yml,.yaml,.md,.sql,.sh,.css,.html,.txt,.diff`.
- Client-side validation (`tpAddFiles`):
  - At most **10 files** per drop. Names are cut to 120 chars. The extension badge is uppercased and cut to 4 chars.
  - Image extensions: png jpg jpeg gif webp svg. Code extensions: ts tsx js jsx py go rs java rb json yml yaml md sql sh css html txt diff.
  - Error copy: "Images or code files only"; "Too large · {x.x} MB (max 10)".
  - Progress is simulated (`setInterval` 140ms, +4–11% per tick). Finished uploads move into the grid with size "x.x MB".

**Comments / Activity tabs** (`section aria-label="Comments and activity"`)
- Tab list `.tp-tabs`: `position:relative; inline-flex; border-bottom:1px solid --line; margin-bottom:12px`.
- Tab `.tp-tab`: `width:112px; height:34px; --text-2; 500 13px; gap:6px`. Selected tab uses `--text`.
  - Tab 1: "Comments" followed by the count `.tp-cnt` (e.g. "2").
  - Tab 2: "Activity".
- Indicator `.tp-ind`: `position:absolute; left:0; bottom:-1px; width:112px; height:2px; --accent; radius 2px; transition:transform 200ms var(--spring)`, with `translateX(0 | 112px)`.
- Tab panels fade in with `.tp-fade` (160ms).
- **Comment** `.tp-cmt`: `flex; gap:12px; padding:8px 0`.
  - Avatar: 28px `.tp-av.l`.
  - Body column (gap 3px): a header row (baseline, gap 8px) with the name (600) and time `.tp-ts` ("2h"), then the text `p` (14px/22px).
  - Text is parsed so that `@Alex Kim|@Jordan Lee|@Sam Patel|@Riley Chen` becomes a mention and `` `code` `` becomes inline code.
    - Mention `.tp-mention`: `--accent-t` text on `--accent-s`, `padding:0 3px; radius 4; weight 500`.
    - Inline code `.tp-icode`: mono 12px, `padding:1px 4px; radius 4; --raised; 1px --line`.
- Empty state: "**No comments yet.**" (`.tp-ts`, 12px, `margin:0 0 6px`).
- **Composer** `.tp-comp` (editors only): `relative; flex; gap:10px; align-items:flex-start; padding-top:8px`.
  - Avatar: AK 28px.
  - Textarea `.tp-cin`: `flex:1; min-height:40px; padding:10px 12px; radius 8px; border:1px solid --line-2; --surface; 400 13px/20px; resize:none; rows=1`. Focus: `border --accent; box-shadow:0 0 0 3px --accent-s`.
    - Placeholder "**Comment… @ to mention**". aria-label "Write a comment".
  - Button "**Send**" (`.tp-btn.pri`, `margin-top:6px`). ⌘/Ctrl+Enter also sends.
  - New comments have author AK, time "just now" and are capped at 2000 chars.
  - Typing `@` plus up to 11 letters at the end of the draft opens a mention listbox (`aria-label="Mention"`) at `left:38px; bottom:52px`. It shows people whose names start with the typed query. Picking one replaces the token with `@Full Name `.
- **Activity timeline** `.tp-tl`: `relative; padding-left:22px; column; gap:12px`.
  - Vertical rule `::before`: `left:6px; top:6px; bottom:6px; 1px; --line-2`.
  - Item `.tp-tli`: 13px/20px, `--text-2`.
  - Dot `::before`: `left:-20px; top:6px; 9×9; round; --surface background; 1.5px --control border`.
  - Actor and object are `<b>` (`--text`, 500). Time is `.tp-ts` with the prefix "· ".

### 2.10 Permissions (from `tpBuild`)
- `role` is `admin | member | viewer`, and `canEdit = role !== 'viewer' && !deleted`.
- `canDelete = role === 'admin' && !deleted`. Members can edit but cannot delete.
- Viewer UI:
  - Read-only chips and fields (`.ro`); `<h2>` title; "View only" note.
  - No Mark done button, no ghost chips, no Add property.
  - No "+" for labels or objectives, and no unlink X.
  - Sub-task checkboxes become glyphs.
  - No dropzone, no composer, no "+ Add sub-task".
  - The More menu shows only "Copy link".
- Deleted: same restrictions plus dimmed body and the restore banner.

---

## 3. Board 09 — Task detail interactive (app context)

### 3.1 Purpose and props
This board is the full app prototype at 1440×960 (`$preview`). Props:
- `theme`: navy (default) / dark / light
- `role`: admin (default) / member / viewer
- `view`: panel (default) / full / closed
- `fields`: full (default) / empty

`fields=empty` makes PRJ-42 "Write release notes for 2.4", with status todo, no priority, no assignee, reporter JL and everything else empty.

### 3.2 Shell layout
- `.app` on the root: `display:flex; height:100vh; overflow:hidden`.
- **Sidebar** (`.sbw.sb-host`): width **264px** expanded, **64px** as a rail. `transition:width 220ms var(--ease)`, `--surface` background, `border-right:1px solid --line`. Hidden at ≤760px. (The legacy `.side` class is 232px and unused.) Full details in §3.6.
- **Main** `.main`: `position:relative; flex:1; min-width:0; flex column; overflow:hidden`, with inline `height:1038px`.
- **Top bar** `.top`: `height:52px; flex; gap:12px; padding:0 16px 0 20px; border-bottom:1px solid --line`. Contents:
  - A mobile-only hamburger (`.btn-ghost.icon.mtop`, 30×30, `M2.5 4h11M2.5 8h11M2.5 12h11`).
  - "Platform Rebuild" (`--text-2`), "/" (`--text-3`), "**Board**" (600). The first two are hidden on mobile.
  - A spacer.
  - "Filter" plus kbd "F" (`.btn-ghost.sm`, hidden on mobile).
  - "New task" plus kbd "C" (`.btn-primary.sm`, only if not viewer).
- Buttons `.btn`:
  - Base: `height:32px; padding:0 12px; radius 6px; 500 13px/1 Inter; gap:8px`. Transitions bg/shadow/transform/colour at 120ms. Active: `scale(.97)`.
  - `.btn-primary`: `--accent` background, white text. Hover `--accent-h` plus `box-shadow:0 0 0 4px var(--accent-s)`.
  - `.btn-sec`: `--raised` background, `--control` border.
  - `.btn-ghost`: `--text-2`, hover `--hover`.
  - `.btn-dng`: `--danger`.
  - `.sm`: 28px tall, `padding:0 10px`, 12px text.
  - `.icon`: 30×30.
- **Board** `.board`: `flex:1; overflow:auto; padding:16px 20px; flex; gap:14px; align-items:flex-start`.
  - Column `.col`: `width:272px; column; gap:8px`.
  - Column header `.colh`: `height:30px; padding:0 4px; gap:8px; 600`. Contents: glyph, name, and a count on the right (mono 11px `--text-3`).
  - Columns in order: Todo, In progress, In review, Done. Backlog and Canceled are not shown.
- **Card** `.tc` (a button), with aria-label "Open PRJ-42: …":
  - Box: `column; gap:10px; padding:12px; radius 8px; --surface; 1px --line`.
  - Transitions: `transform 150ms var(--spring), box-shadow 150ms ease, border-color/bg 120ms`.
  - Hover: `border-color:--line-2; translateY(-2px); box-shadow:--shadow-pop`.
  - Selected `.sel` (the open task): `border-color:--accent; background:--accent-s`.
  - Row 1 (space-between): key (mono 11px/500 `--text-3`) and a 20px avatar (or "–" when unassigned).
  - Row 2: title `.tt` (13px/20px/500).
  - Row 3 (gap 10px): status glyph, priority bars, and estimate "3 pts" (mono 11px `--text-3`).
- **Board data**:

  | Key | Title | Status | Pri | Assignee | Type | Est | Extra |
  |---|---|---|---|---|---|---|---|
  | PRJ-47 | Persist saved filters per project | todo | 2 | JL | Feature | 2 | |
  | PRJ-52 | Empty state for new workspaces | todo | 1 | SP | Feature | 1 | due Oct 9 · in 2 days (soon) |
  | PRJ-42 | Fix flaky board reflow on column resize | progress | 3 | AK | Bug | 3 | full data |
  | PRJ-33 | Sprint burndown chart | progress | 2 | RC | Feature | 5 | epic "Sprint engine" |
  | PRJ-51 | Keyboard shortcut sheet | review | 1 | JL | Chore | 2 | |
  | PRJ-29 | Command palette v1 | done | 3 | AK | Feature | 8 | |

  "Lite" tasks all have reporter JL and sprint "Sprint 14", and are not rich. Opening one shows the panel with 2–4 fields, a Planning block with only Sprint, and the editable empty states (Add a description…, sub-tasks header with only "+ Add sub-task", dropzone, "No comments yet." and a single activity entry "created the task · today").
- Initial state: `cur:'PRJ-42'`, panel open. A demo upload `drag-jump-recording.gif` (6.8 MB, 38%, GIF) is in progress in the panel.

### 3.3 Panel in context
- `.tp` with **width 520px**, absolutely positioned on the right of `.main` (it covers the board; the board does not reflow), with `--shadow-modal` and `border-left:1px solid --line-2`.
- `view=full` or toggling expand sets `.tp.full` (width 100% of `.main`, with a 250ms width transition) and the two-column body with the 300px rail.

### 3.4 Open / close animation
1. Clicking a card while the panel is closed (and reduced motion is off) runs `openCard`:
   - It measures the card rect relative to `.main`.
   - It renders `.ghost`: `position:absolute; z-index:6; --surface; 1px solid --accent; overflow:hidden; padding:12px; pointer-events:none`, with transitions on `left/top/width/height/border-radius` at **250ms var(--ease)**. The ghost starts at the card rect with radius 8px and shows the key (mono 11px `--text-3`) and the title (`.tt`, margin-top 8px).
   - After a double `requestAnimationFrame`, the ghost animates to the panel rect: `x = mainWidth − pw`, `y = 0`, `w = pw`, `h = mainHeight`, `r = 0`. Here `pw` is the main width when full or when main is under 760px wide, otherwise `min(520, mainWidth)`.
   - At **260ms** the ghost is removed and the panel mounts. Its content fades in with `tpfade` 160ms.
   - This is a card-to-panel "morph".
2. If the panel is already open, clicking another card swaps the task immediately. Menus and edit modes reset, and `.tp-fade` replays.
3. **Close** (X, or Esc when no menu or edit is active): add `.leaving` (`tpout` 160ms: opacity→0, translateX(24px)), then unmount after 160ms.
4. The legacy v1 `.panel.enter` (`pin` 220ms: from opacity 0, translateX(24px)) is defined but not used by `.tp`. If an explicit enter animation is wanted for direct-open without the ghost, use `pin` (220ms ease, translateX 24px→0, opacity 0→1).

### 3.5 Done celebration, delete and toast
- Status → done (Mark done, the status menu, or the card glyph on the board) plays several effects:
  - `tppop` 240ms spring (scale .6 → 1.2 at 60% → 1).
  - Check draw `tpdraw` 180ms ease with a 60ms delay (`clip-path:inset(0 100% 100% 0)` → `inset(0)`).
  - Spark burst `::before`: a 3px `--spark` dot with six box-shadow dots at `(0,-11) (10,-5) (10,6) (0,11) (-10,6) (-10,-5)`, animated by `tpspark` 440ms ease (scale .3 → 1.8, opacity 1 → 0).
  - The board card glyph uses v1 equivalents: `checkpop` 220ms spring to 1.18, `draw` 180ms with a 60ms delay, and `spark` 420ms to scale 1.7.
  - The done card then moves to the Done column.
- **Delete task** (admin):
  - The task disappears from the board, and the panel shows the deleted banner and dimmed body.
  - A toast "PRJ-42 deleted" appears with "Undo" and kbd "⌘Z". It auto-hides after **4000ms**.
  - Undo or Restore brings the task back.
- **Toast** `.toast`:
  - Box: `position:absolute; left:20px; bottom:20px; z-index:9; flex; gap:12px; padding:10px 10px 10px 14px; radius 10px; --raised; 1px --line-2; --shadow-pop`.
  - Enter animation: `tin` 180ms (from opacity 0, translateY(8px)).
  - Text is weight 500. The undo button is `.btn.btn-ghost.sm`.
  - Copy-link toast text: "Link to PRJ-42 copied" (no undo).

### 3.6 Sidebar (shell, included in 09)
**Workspace switcher row** `.sb-ws` (`padding:10px 10px 8px; gap:4px`)
- Button `.sb-wsb`: `height:36px; padding:0 8px; radius 8px; 600 13px; gap:9px`. Contents:
  - Logo tile `.sb-xt`: `24×24; radius 6; --raised; 1px --line-2`. The logo is an X mark SVG (viewBox 0 0 46 39, 15×13) with a `--text` stroke diagonal and a `--logo` lightning stroke over a `--surface` knockout.
  - Workspace name "Platform team".
  - A chevron-down icon.
- Collapse button `.sb-icb`: 30×30. Tooltip "Collapse ⌘B".
- Workspace menu (`top:48px`): "Platform team" (PT, hue 255, checked), "Design guild" (DG, 300), "Personal" (PE, 155). Admins also get a separator, "Workspace settings" and "Create workspace".

**Search** `.sb-sinp`
- Input: `height:34px; padding:0 44px 0 32px; radius 9px; 1px --line-2; --bg`. Placeholder "Search or jump…". Kbd "⌘K" on the right.
- Hover: `--control` border.
- Focus: `--accent` border plus `box-shadow:0 0 0 3px --accent-s, 0 0 18px 2px --accent-s`.

**New task** `.sb-new`: `height:32px; margin:8px 10px 4px; radius 8px; 1px --line-2; --raised`. Contents: plus icon, "New task", kbd "C". Hidden for viewers.

**Nav items** `.sb-it`: `height:30px; padding:0 8px; radius 7px; --text-2; 500 13px; gap:10px`. Hover and `.on` use `--hover`/`--text`.
- "Inbox": unread badge `.sb-unread` (`min-width:20px; height:18px; radius 9; --accent-s bg; --accent-t; mono 600 11px`). Count is 3, or 1 for viewers.
- "My tasks": count 7 (`.sb-count`, mono 11px `--text-3`). Hidden for viewers.

**Sections** `.sb-sec`: `height:28px; margin-top:14px; mono 500 11px; letter-spacing:.07em; uppercase; --text-3`. Section chevrons rotate -90deg when collapsed (180ms).
- Collapsible bodies use the grid-rows 0fr↔1fr pattern at 220ms.
- "Pinned views":
  - "My open bugs" 4
  - "Due this week" 9
  - "Blocked" 2
- "Projects" with a count. The "+" button (tooltip "New project") is admin-only.
  - Projects (badge, name, hue):
    - PR Platform Rebuild 255
    - MO Mobile App 175
    - IN Infra 75
    - DS Design System 300
    - AP Public API 25
  - Viewers see the first 3. The large list is 16 projects, with a "Filter projects…" input and "No projects match." empty text.
  - Project row: an 18×18 badge (radius 5, mono 600 9px) and a chevron that rotates 90deg (200ms).
  - Sub-items are indented: `margin:2px 0 6px 16px; padding-left:10px; border-left:1px solid --line`.
    - Items: Board, Backlog, Sprints, Objectives, Milestones, Reports. Viewers only get Board, Backlog, Objectives and Milestones.
    - A sliding indicator `.sb-ind` (30px tall, `--accent-s`, radius 7) moves with `translateY(index*32px)` (44px step on touch), `transition:transform 220ms spring`.
    - The active sub-item's icon is `--accent-t`.

**Footer** `.sb-foot` (`border-top 1px --line; padding:8px 10px 10px`)
- Sprint card `.sb-spr`: `padding:9px 10px; radius 10; 1px --line; --bg`. Hover: `--line-2`, `--raised`, `translateY(-1px)`. Contents:
  - A 30px ring (r 11.5, stroke 3.5, dasharray 72.3; track `--raised`, progress `--accent-t`; `stroke-dashoffset` transition 800ms).
  - "Sprint 14" (600 13px/16px) and "65% · 7d left" (mono 11px `--text-3`).
- Links: "Members & roles" (admin only) and "Settings" with "⌘," (not for viewers). A "?" button with tooltip "Shortcuts ?".
- Profile `.sb-prof`: a 30px avatar "AK" (hue 285) with a presence dot (9px `--ok`, `0 0 0 2px --surface` ring), "Alex Kim", and "Admin · Platform team" (11px `--text-3`).
  - Profile menu (opens upward, `sbpopup` 160ms from translateY(4px)): header "Alex Kim" / "alex@team.dev", then "Profile" (kbd "G P"), "Preferences", a separator, and "Sign out".
  - Escape closes the menu.

**Rail** (collapsed, 64px)
- Items `.sb-ri`: 40×36, radius 8. Order: logo, Search, New task (bordered), separator, Inbox (with a 7px `--accent-t` dot), My tasks, separator, up to 6 project badges (22px), spacer, sprint ring (24px), Settings, Expand ("Expand ⌘B"), and the avatar (28px).
- Tooltips `.sb-tip`:
  - Position: `left:calc(100% + 10px)`, start state `translate(-4px,-50%)` and opacity 0.
  - Show: opacity 1 and translate(0,-50%), with a 150ms delay.
  - Box: `padding:5px 8px; radius 6; --raised; 1px --line-2; --shadow-pop; 12px/500`.
  - Tooltip text includes "Inbox 3 G I" and "My tasks G M".

**Touch variant** (`.touch`): items 42px tall, New task and search 44px tall.

**Permissions summary** (sidebar)
- Viewer: no New task, no My tasks, no Settings, fewer project sub-pages, fewer projects.
- Member: no project creation, no Members & roles, no workspace admin entries.
- Admin: everything.

### 3.7 Mobile (≤760px) in 09
- Sidebar hidden; hamburger shown.
- Breadcrumb and Filter hidden.
- The panel becomes a fixed bottom sheet at 92vh with radius 18px top corners, the grab handle, and the 280ms slide-up.

---

## 4. Board 10 — Task detail states (spec sheet)

### 4.1 Canvas
- Root: `width:1440px; height:2300px; padding:72px 80px; column; gap:40px`. Theme prop navy/dark/light.
- Header (gap 14px):
  - Eyebrow "LIGHTEX · SCREENS · TASK DETAIL": mono 12px `--text-2`, `letter-spacing:.04em`.
  - H1 "Task detail: states": 48px/54px, 600, `-.03em`.
- Grid: `repeat(3,minmax(0,1fr)); gap:32px 24px`, so each column is ≈410.7px.
- Frame `figure.crop`: column, gap 10px.
  - Caption: `<b>` 14px/600 plus a `.cap` subtitle, gap 2px.
  - Crop box `.fr`: `position:relative; height:430px; border:1px solid --line-2; radius 12px; --surface; overflow:hidden`.
- Local primitives used in this board:
  - `.ph` header: 44px, `padding:0 12px 0 16px`, border-bottom.
  - `.pb` body: `padding:16px 18px; column; gap:6px`.
  - `.btn`: 28px, `0 10px`, 500 12px. `.btn.icon`: 28px wide.
  - `.prow`: `grid 92px | 1fr; min-height:32px`. `.pl` label: 12px `--text-3`.
  - `.pv` value: `28px; padding 0 8px; margin-left:-8px; radius 6; 500`. `.hov` uses `--hover`.
  - `.menu`: `padding 4; radius 8; 1px --line-2; --raised; --shadow-pop`.
  - `.mi`: 30px, `gap 10`, 500. `.on` uses `--accent-s`; `.hov` uses `--hover`.
  - `.chip`: 24px, `0 8px`, radius 6, `--raised`, 1px `--line`, 12px/500.
  - `.inp` (active input): `30px; padding 0 10px; radius 6; 1px --accent; box-shadow:0 0 0 3px var(--ring)`. Note this uses `--ring`; v2 uses `--accent-s`.
  - Title edit `.ti`: `600 18px/26px; -.015em; padding:2px 7px; margin-left:-8px`.

### 4.2 Frames (copy verbatim)
1. **Edit title, pick status** · "Inline input · status keys 1–6".
   - Title input showing "Fix flaky board reflow on column resize" in the editing style, with the hint "**Enter to save · Esc to cancel**" (`.cap`).
   - Property rows: Status = In progress (hovered), Assignee = AK Alex Kim, Priority = High (n3 orange), Type = Bug.
   - Status listbox (230px wide, at top 148 / left 110): Backlog 1, Todo 2, In progress 3 (`.on`), In review 4 (`.hov`), Done 5, Canceled 6.
2. **Estimate and due date** · "Inline number · calendar".
   - Estimate shows an active input "5" (mono, 72px wide) with the suffix "**points**".
   - Due date shows "Oct 21 · in 14 days" (hover). Sprint shows "Sprint 14".
   - Date-picker popover (`padding:10px`, at top 104 / left 108):
     - Header: "**October 2026**" (600) and "‹ ›" (mono cap).
     - Grid `.cal`: `repeat(7,28px); gap:2px; 11px; centered`. Cells are 26px tall with radius 6.
     - Weekday header row "Mo Tu We Th Fr Sa Su" (`.h`: mono 10px `--text-3`). Weeks start on Monday.
     - Days 28 29 30 (muted), 1…31, then 1 (muted). Today = 7 (`inset 0 0 0 1px --line-2`). Selected = 21 (`--accent` background, #fff text, 600).
     - Quick chips below (gap 6px, margin-top 8px): "**Tomorrow**", "**Next week**", "**Sprint end**".
3. **Description editing** · "Toolbar on focus · / commands".
   - Editor toolbar buttons: B, I, `</>` (active `.on`: `--accent-s`/`--text`), "**Link**", "1.", "{ }". The toolbar spans are 24px; v2 buttons are 26px.
   - Body: 13px/20px, gap 8px. Contains "Columns jump when the sidebar collapses mid-drag.", a code block (`.code`: mono 12px/19px, `padding:10px 12px`, `--bg`, radius 8, 1px `--line`) with `const ro = new ResizeObserver(() => {\n  reflow(columns);\n});`, and a typing line "/cod" followed by a caret (1.5px × 15px, `--accent-t`).
   - Footer: "Cancel" Esc (ghost) and "Save" ⌘↵ (primary).
   - Slash menu (220px, at top 236 / left 44):
     - "{ }  Code block" with kbd "↵" (hovered)
     - "</>  Inline code"
     - The mono glyph column is 22px wide, `--text-3`.
4. **Link objectives** · "Search · multi-select · × unlinks".
   - The Objectives row shows chips "Cut p95 latency to 200ms ×" and "Ship beta on time ×", plus a ghost button "**+ Link**" (24px tall, hover background).
   - Listbox (260px, multiselect) contains:
     - A search input with value "on" (the `.inp` style without the shadow).
     - Rows with a checkbox `.cbx`:
       - "Ship beta on time" (checked, hovered)
       - "Onboarding under 5 minutes"
       - "Zero P1 incidents in Q4"
     - The footer cap "**3 of 5 match**".
   - v2 has no search field and uses a "+" mini button.
5. **Upload in progress** · "Per-file progress · reasons on reject".
   - Active dropzone `.dz`: 92px tall, `1.5px dashed --accent`, `--accent-s` background, `0 0 0 4px --accent-s` ring. Contents: an 18px upload icon, "**Drop to upload**" (500), and "**Images or code · 10 MB max**" (11px cap).
   - Upload rows (`padding:9px 10px`):
     - GIF "drag-jump.gif" · "62% · 6.8 MB" with a bar at 62%
     - TS "board-layout.ts" · "18% · 0.2 MB" at 18%
     - Error MOV "screen-capture.mov" · "**Unsupported type. Images or code files only.**"
     - Error PNG "full-trace.png" · "**Too large (24.3 MB). Max 10 MB.**"
   - Error text is 12px `--danger`. The trailing "×" is labelled Cancel or Dismiss.
6. **Comment with mention** · "@ opens people · ↑↓ ↵".
   - Existing comment: a 26px avatar JL, "**Jordan Lee** 2h", and "Repro’d on Safari too. @Alex Kim can you check the drag layer?"
   - Composer pinned to the bottom (`left/right 18px; bottom 16px`): a 26px AK avatar and a 40px focused input containing "Thanks! cc " followed by the mention pill "@Jo" and a caret.
   - Mention menu (220px, at left 52 / bottom 76): Jordan Lee (hovered), Alex Kim.
   - The caption implies keyboard navigation with ↑/↓ and Enter to pick. v2 code does not implement arrow keys.
7. **Viewer (read-only)** · "Plain values · nothing to add".
   - Header: "PRJ-42" (mono cap), then Expand "⤢" and Close "×".
   - Title h3: 600 18px/26px.
   - Note `.ro-note` (`padding:8px 10px; radius 8; --raised; 12px --text-2`): "**You have view access to this project. Ask a project admin to edit.**"
   - Rows: Status In progress, Assignee Alex Kim, Priority High, Objectives chip "Cut p95 latency to 200ms", Sub-tasks with a done glyph and "2 of 4 done".
8. **Deleted** · "Dimmed · Restore · 30 days".
   - Banner: trash icon, "**This task was deleted**" (600), "Restorable for 30 days." (cap), and a "Restore" button (`.btn-sec`).
   - Body content at `opacity:.55; filter:saturate(.6)`.
   - Toast at the bottom left (`left/bottom 16px; padding:8px 8px 8px 12px; radius 10; --raised; 1px --line-2; --shadow-pop`): "**PRJ-42 deleted**" with "Undo ⌘Z".
9. **Loading** · "Skeleton in final positions" (`aria-busy="true"`).
   - Skeleton `.sk`: `radius 4; background:linear-gradient(90deg,var(--raised) 0%,var(--hover) 50%,var(--raised) 100%); background-size:200% 100%; animation:shimmer 1.4s linear infinite`, where `shimmer{from{background-position:200% 0}to{background-position:-200% 0}}`.
   - Layout:
     - Header: a 56×10 bar and a 20×20 square (radius 6) on the right.
     - Body (gap 14px):
       - Title lines at 86%×18 and 52%×18.
       - Four property rows (gap 12px; each row has gap 24px). Labels are 60×10. Values are 110, 90, 130 and 70 wide, all 10px tall.
       - Text lines at 100% (margin-top 10px), 94% and 60%, each 10px tall.
10. **Error loading** · "Retry in place".
    - Header: "PRJ-42" and a close button.
    - Body: 340px tall, column, centred vertically, left-aligned, gap 10px, `padding:0 28px`. Contents:
      - A 16px red circle with "!" (700 10px, `--bg` text on `--danger`).
      - "**Couldn’t load PRJ-42**" (15px/600).
      - "The request timed out. Nothing you changed was lost." (13px/20px `--text-2`).
      - "Retry" with kbd "**R**" (`.btn-sec`), followed by "ref 7f3a91" (mono cap; an error/trace reference id).
11. **Not found / no access** · "Stale link · way back".
    - Same layout, full height.
    - Contents: "PRJ-404" (mono cap); "**This task doesn’t exist anymore**" (15px/600); "It was permanently deleted, or moved to a project you can’t see." (13px/20px `--text-2`); "Back to board" with kbd "**G B**" (`.btn-sec`).
12. **Phone: full-height sheet** · "Full-height sheet below 760px".
    - The frame background is `--bg` with `padding-top:16px`. The phone is 250×440 with `border-radius:24px 24px 0 0` and a 1px `--line-2` border.
    - Header: 40px, `padding:0 8px 0 12px`. Contents: a back "‹" button, "PRJ-42", a spacer, and a more "···" button.
    - Body (`padding:12px; gap:8px`):
      - Title 15px/21px 600.
      - Chips at 28px height: In progress, High, Alex Kim.
      - Description 12px/18px `--text-2`.
      - Mini code block (10px/15px, padding 8).
      - Full-width "**Add comment**" button (`.btn-sec`, 44px tall, centred).
    - The v2 sheet instead uses the grab handle and the regular header, and shows no back button.

---

## 5. Interactions and keyboard (consolidated)
| Trigger | Behaviour | Source |
|---|---|---|
| Click card | Ghost morph 250ms → panel mounts at 260ms → content fade 160ms | 09 |
| Esc | Closes the open menu, else closes the panel (ignored while editing title, description or estimate) | 09/14 |
| ⌘⇧F | Expand/collapse full page (shown in tooltip) | 09/14 |
| ⌘⇧D | Mark done (tooltip) | 09/14 |
| ⌘L / ⌘D / ⌫ | Copy link / Duplicate / Delete (More menu hints) | 09/14 |
| 1–6 | Status options (menu kbd hints) | 09/10/14 |
| 0–4 | Priority options (menu kbd hints) | 09/14 |
| ⇧C | Add sub-task | 09/14 |
| ⌘↵ / Esc | Save / cancel description | 09/10/14 |
| ⌘/Ctrl+Enter | Send comment | 09/14 |
| @ | Mention picker (prefix match on name) | 09/10/14 |
| / | Slash command menu in description ("Code block", "Inline code") | 10 only |
| ⌘Z | Undo delete (toast) | 09/10 |
| R | Retry load | 10 |
| G B | Back to board | 10 |
| C | New task · ⌘K search · ⌘B collapse sidebar · ⌘, settings · ? shortcuts · G I inbox · G M my tasks · G P profile | 09 shell |

Timings:
- Copied feedback (key and code): 1400ms.
- Toast auto-hide: 4000ms.
- Upload tick: 140ms.
- Hover transitions: 120ms.
- Menu pop: 150ms (v2) or 160ms (v1).
- Plan collapse: 220ms. Chevron rotation: 200ms.
- Tab indicator: 200ms spring.
- Sub-task bar: 300ms.
- Checkbox tick: 150ms spring.

---

## 6. Board 10 vs v2 (14) copy and feature differences
| Item | Board 10 | v2 (09/14 code) |
|---|---|---|
| Estimate suffix | "points" | "pts" |
| Viewer note | "You have view access to this project. Ask a project admin to edit." | "View only" (with eye icon) |
| Deleted banner | "This task was deleted" / "Restorable for 30 days." | "Deleted · restorable for 30 days" |
| Dropzone sub | "Images or code · 10 MB max" | "≤ 10 MB" (idle text "Drop files or browse") |
| Type error | "Unsupported type. Images or code files only." | "Images or code files only" |
| Size error | "Too large (24.3 MB). Max 10 MB." | "Too large · 24.3 MB (max 10)" |
| Objective add | "+ Link" button plus search field plus "3 of 5 match" | "+" mini button, plain checkbox list (no search UI; `objQuery` state exists but nothing sets it) |
| Editor toolbar | B, I, </>, Link, 1., { } | B, I, </>, { }, 1. (no Link) |
| Due date editor | Calendar popover plus Tomorrow/Next week/Sprint end | Not implemented (field click no-op) |
| Property layout | Label/value rows (92px label col) | 3 chips + 2-col field grid + folded Planning |
| Title size | 18px/26px | 22px/30px |
| Mobile | Back "‹" + "···" header, "Add comment" button | Sheet with grab handle, same header as panel, no expand button |
| Loading / error / not found | Specified | Not in v2 code; use board-10 designs |

---

## 7. Backend / data-model implications
- **Task fields**:
  - `key` (project prefix plus number, e.g. PRJ-42)
  - `title` (max 200 chars)
  - `status` (enum: backlog | todo | progress | review | done | cancel)
  - `priority` (int 0–4: 0 none, 1 Low, 2 Medium, 3 High, 4 Urgent)
  - `assignee` (user, nullable, single)
  - `reporter` (user)
  - `type` (string enum seen: Bug, Feature, Chore)
  - `estimate` (int points 0–99)
  - `due` (date; UI derives the relative text "in N days" and a `soon` flag, which is ≤2 days in the sample)
  - `sprint`, `milestone`, `epic` (references)
  - `objectives` (many-to-many with objectives)
  - `labels` (many, each with a colour)
  - `description` (rich text with code blocks and language tag, inline code, lists, bold/italic, links per board 10)
  - `subtasks` (child tasks with key, title, assignee, done status)
  - `attachments` (name, size, kind img|code, ext; image thumbnails, code previews)
  - `comments` (author, created time, text with @mentions and inline code; max 2000 chars)
  - `activity` (actor, verb, object, time). Seen: "moved this to <status>", "linked <objective>", "created the task".
  - `deleted_at` (soft delete, restorable for 30 days; then "permanently deleted" → 404 state).
- **Permissions**:
  - Project roles are admin / member / viewer.
  - Viewers: read-only.
  - Members: edit but not delete.
  - Admins: delete, create projects, Members & roles, workspace settings.
  - A no-access task should render the same "doesn’t exist anymore / project you can’t see" page (do not leak existence).
- **Uploads**:
  - Images (png jpg jpeg gif webp svg) and code/text (ts tsx js jsx py go rs java rb json yml yaml md sql sh css html txt diff) only.
  - Max 10 MB per file, max 10 files per drop.
  - Per-file progress and cancel; server should validate the same rules.
- **Reopen semantics**: "Mark done" toggles to `done`, and reopen goes to `todo`.
- **Workflow behaviours implied**:
  - Clipboard copy of task key and link (link format not specified).
  - Duplicate task.
  - An error reference id surfaced to the user ("ref 7f3a91").
  - Retry that preserves unsaved local changes ("Nothing you changed was lost").
- **Mentions** should notify; they are tied to the project member list.
- **Feature flag** mentioned in sample copy (`board-reflow`); content only, not a product feature.

## 8. Not wired, v2-pending or "coming soon"
These items appear in the designs but have no behaviour in the prototype code:
- "+ Add sub-task" (no handler)
- "Duplicate"
- Label "+" add
- Sprint/Milestone/Epic value editors
- Reporter/Type/Due field editors
- Description toolbar actions
- Slash commands, Link button and the date picker (board 10 only)
- Objective search (state stub `objQuery` only)
- Arrow-key navigation in menus (caption in board 10 only)
- "Filter" on the board

Loading, error and not-found states exist only as static designs in board 10. Nothing is explicitly labelled "coming soon".

## 9. Legacy v1 panel CSS in 09 (superseded, for reference)
`.panel`:
- Width 560px, `--surface`, `border-left:1px solid --line-2`, `--shadow-modal`, `transition:width/border-radius 250ms`.
- `.full` → 100%.
- Enter: `pin` 220ms. Leave: `pout` 160ms.

Other v1 parts:
- Header `.ph`: 48px, `padding:0 10px 0 16px`.
- Body `.pbody`: `gap:20px; padding:20px 24px 40px; max-width:1180px`. In full mode: `1fr 300px`, column-gap 48px, `padding:32px 40px 60px`.
- Property rows `.prow`: `104px | 1fr`, min-height 34px.
- Menus: 240px wide at `top:34px; left:96px`, using the `pop` 160ms keyframe.
- Inputs: `--ring` shadow (instead of `--accent-s`).
- Comment input border: `--control`.
- Attachment tiles: thumbnail 84px, grid min 150px, gap 10px.
- Comments: padding 10px. Timeline: gap 14px.
- Main column gap: 28px.

Prefer the v2 values above.
