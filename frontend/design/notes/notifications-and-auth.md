# Lightex: Notifications (19) and Auth flow (21), build spec

Sources: `clean/19-Notifications.html`, `clean/21-Auth-flow.html`. Both are x-dc boards, 1440px wide, with a theme prop of `navy` (default), `dark` or `light`. Everything below comes from the markup, the CSS and the inline `text/x-dc` script logic. Where a value is computed, the result is given.

---

## 0. Shared foundations (both files)

### 0.1 Theme tokens (identical in both files)

| Token | navy (default) | dark | light |
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
| --av-l / --av-c | .40 / .10 | .40 / .10 | .90 / .06 |

Extra tokens defined only in **19-Notifications**:
- navy: `--pk-l:.32; --pk-c:.07; --pkt-l:.88; --pkt-c:.09; --logo:#3B7BFF; --danger-solid:#C23A30`
- dark: `--pk-l:.32; --pk-c:.06; --pkt-l:.88; --pkt-c:.08; --logo:#3B7BFF; --danger-solid:#C23A30`
- light: `--pk-l:.93; --pk-c:.04; --pkt-l:.42; --pkt-c:.12; --logo:#1D4ED8; --danger-solid:#B92F26`

Extra tokens defined only in **21-Auth**:
- navy and dark: `--logo:#3B7BFF; --grid:rgba(138,176,255,.07); --glow:rgba(43,103,245,.16); --dng-s:rgba(255,122,112,.10)`
- light: `--logo:#1D4ED8; --grid:rgba(18,18,23,.055); --glow:rgba(29,78,216,.08); --dng-s:rgba(185,47,38,.07)`

Motion: `--ease: cubic-bezier(.16,1,.3,1)`, `--spring: cubic-bezier(.34,1.56,.64,1)`.

Base `.ds`: font `'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif`, 13px, color var(--text), bg var(--bg), `-webkit-font-smoothing: antialiased`, `box-sizing: border-box` on all children. `.mono` = `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace`.

Avatar colour formula: `background: oklch(var(--av-l) var(--av-c) <hue>)`, initials in var(--text), weight 600.
People and hues: AK Alex Kim 285, JL Jordan Lee 200, SP Sam Patel 20, RC Riley Chen 150, MD Morgan Diaz 60, TN Taylor Ng 330.
Project badge formula (19 only): `background: oklch(var(--pk-l) var(--pk-c) hue); color: oklch(var(--pkt-l) var(--pkt-c) hue)`.

Reduced motion: 19 sets every animation and transition to .001ms and turns off the skeleton shimmer. 21 sets `animation:none; transition:none` on `.au *` but keeps the spinner running at 1.6s per turn.

Focus ring (both): `outline:none; box-shadow: 0 0 0 1px var(--accent), 0 0 0 4px var(--ring)`.

### 0.2 Board chrome (design canvas only, do not build)
- 19: page 1440×2700, padding 64px 80px, column gap 36px. Eyebrow `SCREENS · NOTIFICATIONS` (mono 12px, --text-3, letter-spacing .04em). H1 `Inbox` (48/54, weight 600, letter-spacing -.03em). Right-hand mono meta: `5 event types` · `E read / unread` · `⇧E mark all` · `In-app + Email live`. Frames sit in a 3-column grid with a 40px gap.
- 21: page 1440×5700, padding 64px 80px, gap 40px. Eyebrow `SCREENS · AUTH`. H1 `Auth flow`. Meta: `5 screens` · `validate on blur` · `navy + light` · `390 mobile` · `logo = transition`. Frames sit in a flex-wrap row 1280px wide with a 40px gap. Desktop frames are 620px wide (two per row) and phone frames are 390px (three per row).
- Frame caption (`figcaption`): 14px/600, followed by a mono 11px/500 --text-3 meta span. The gap between caption and device is 12px.
- Device shell: 1px solid var(--line-2), radius 14px (28px for phone), overflow hidden, background var(--bg).

### 0.3 Logo
The wordmark is the text "Lighte" followed by an SVG "X" glyph (viewBox `0 0 46 39`):
- Bar: `M-4 -4L50 43`, stroke var(--text). Stroke width 9.5 in auth (10 in the sidebar).
- Bolt: `M50 -5L27 17H38L-4 44`, stroke var(--logo), width 8.5, miter join, miterlimit 10.
- In auth the bar is masked by a black 13.5px stroke of the bolt path, so the bar has a knock-out gap where the bolt crosses it, and both are clipped to a 46×39 rect. The sidebar version gets the same knock-out effect by drawing a 17px var(--surface) bolt under a 10px var(--logo) bolt (path `M50 -5L26 18H39L-4 44`).
- `.wm`: 24px, weight 600, letter-spacing -.04em, line-height 1, inline-flex baseline. `.wx`: width .644em, height .546em, margin-left .02em.
- Logo tile in the sidebar and mobile inbox (`.sb-xt`): 24×24, radius 6, var(--raised), 1px var(--line-2), glyph 15×13.

---

## 1. NOTIFICATIONS (19-Notifications.html)

### 1.1 Frames on the board
| # | Caption | Meta | Size (w×h, radius) | Grid position | Config |
|---|---|---|---|---|---|
| A | Inbox | `click a row · hover for actions · ⇧E` | 1280×820, r14 | col 1/4, row 1 | Full sidebar 264px (admin, collapsible), tab width 112, preview as a side panel |
| P | Notification preferences | `autosaves · 3 channels coming soon` | 1280×560, r14 | col 1/4, row 2 | Settings nav plus matrix |
| M | Mobile | `390 · tap opens sheet` | 390×844, r28 | col 1, rows 3/5 | touch, phone, tab width 121, preview as a bottom sheet |
| E | Empty inbox | `all caught up` | 840×360, r14 | col 2/4, row 3 | items = [] |
| L | Loading | `skeleton` | 400×432, r14 | col 2, row 4 | phase loading |
| R | Error | `Retry works` | 400×432, r14 | col 3, row 4 | phase error, Retry goes to loading for 1100ms, then ready |

The board does **not** include a bell popover, an archive action, a snooze action or per-project filters. The only routes into the inbox are the sidebar "Inbox" item (`G I`) and the rail Inbox icon with its dot. Its only actions are mark read/unread, mark all read and open.

### 1.2 Inbox layout (desktop, frame A)
`[sidebar 264px] [nb-main flex:1] [nb-pv preview 0 → 380px]`, all inside the device shell (display:flex).

**Sidebar (shared app-shell component, summary).** `.sbw`: width 264 (64 when it collapses to a rail), var(--surface), border-right 1px var(--line), width transition 220ms ease. Workspace switcher shows "Platform team" with a 36px button. Search input placeholder `Search or jump…` with `⌘K`, height 34, radius 9. `New task` button with kbd `C`. List items: **Inbox** (active state `.on`, unread pill = current unread count, 6 at first load, which updates live as items are read), My tasks 7, the "Pinned views" section (My open bugs 4, Due this week 9, Blocked 2), Projects 5 (Platform Rebuild PR hue 255, Mobile App MO 175, Infra IN 75, Design System DS 300, Public API AP 25). Footer: Sprint 14 ring at 65% with `· 7d left`, Members & roles, Settings `⌘,`, shortcuts `?`, profile Alex Kim with "Admin · Platform team". Unread pill (`.sb-unread`): min-width 20, height 18, padding 0 6, radius 9, bg var(--accent-s), colour var(--accent-t), mono 600 11px. The rail variant shows an Inbox icon with a 7px var(--accent-t) dot (box-shadow 0 0 0 2px var(--surface)) at right 8 / top 7, and the tooltip `Inbox <n> G I`.

**nb-main**: flex column, bg var(--bg).

1. **Top bar `.nb-top`**: height 52, padding `0 12px 0 20px`, gap 8, border-bottom 1px var(--line).
   - Phone only: logo tile (24px, margin-right 2) comes first.
   - `h2.nb-h` "Inbox": 15px/600, letter-spacing -.01em.
   - Unread pill `.nb-unc` (shown when unread > 0): mono 500 11px, colour var(--accent-t), bg var(--accent-s), height 18, padding 0 6, radius 9. aria-label "`{n} unread`". Initial value **6**.
   - Spacer (flex:1).
   - **Mark all read** button (when unread > 0): `.btn.btn-ghost.sm` (height 28, padding 0 10, 12px/500, radius 6, colour --text-2, hover bg --hover and text --text). Contents: a 15px double-check icon (`M1.5 8.5l3 3 6.5-7M7.5 11.5l1 0 6-7`), the label "Mark all read" (class `nb-hide-sm`, hidden at viewport ≤760px) and kbd `⇧E` (not shown on phone).
   - When everything has been read (loaded, items > 0, unread 0), the button is replaced by the `.nb-allread` indicator: a 14px check in var(--ok) plus "All read", 12px, --text-3, padding 0 8, fade-in over 220ms.
   - Settings icon button `.btn.btn-ghost.sm.icon` (28×28), a link to `#prefs`, aria-label and title "Notification settings", 15px gear icon.

2. **Tabs `.nb-tabs`** (role=tablist, aria-label "Filter"): padding 0 12, border-bottom 1px var(--line), position relative.
   - Tabs: **All**, **Mentions**, **Assigned**, each followed by a mono 11px --text-3 count. Each tab is a fixed width: 112px on desktop, 121px on mobile. `.nb-tab`: height 38 (44 on touch), 13px/500, --text-2, hover and selected --text, radius 6 6 0 0, gap 7.
   - Counts with the demo data: All **10**, Mentions **2**, Assigned **3**. While loading or errored the count shows `–` (en dash).
   - Indicator `.nb-ind`: absolute, left 12, bottom -1, height 2, radius 2, bg var(--accent), width = tab width, `transform: translateX(index*tabW)`, transition transform 220ms var(--spring).
   - Filter logic: `all` shows everything, and the others match on `n.type` (`mention`, `assigned`).

3. **Body `.nb-body`** (role=tabpanel): flex 1, overflow-y auto, padding `4px 8px 24px`, thin scrollbar with thumb var(--line-2).
   - Groups: **Today** and **Earlier**. Empty groups are hidden.
   - Group header `h3.nb-gh`: mono 500 11px/1, letter-spacing .07em, uppercase, --text-3, padding `14px 12px 6px`, gap 8. The name is followed by a count (letter-spacing 0). Example: `TODAY 5`, `EARLIER 5`.

4. **Toast `.nb-toast`** (role=status), shown after Mark all read: absolute, centred horizontally, bottom 16, height 40, padding `0 6px 0 14px`, gap 12, radius 10, 1px var(--line-2), bg var(--raised), shadow var(--shadow-pop), 13px, z-index 6. Animation `toastin` 220ms: from opacity 0 and translate(-50%, 8px). Text `"{n} marked read"` (for example "6 marked read") followed by a ghost sm button **Undo** in colour var(--accent-t). It auto-hides after **4200ms** (token-guarded). Undo restores the previous read map.

### 1.3 Notification row anatomy (`.nb-row`)
- Grid `12px 36px minmax(0,1fr) auto`, align center, column-gap 10, min-height 60 (68 on touch and at ≤760px), padding `8px 14px 8px 10px`, radius 8, background transition 150ms.
- Hover: bg var(--hover). Selected (preview open on this row): `.sel`, bg var(--accent-s).
- Hit target `.nb-hit`: an absolutely positioned full-size transparent `<button>` (radius 8, z 0) with an aria-label such as `"Unread. Sam Patel mentioned you, PRJ-48 Token refresh race on cold start, 12m ago"`. Format: `(Unread. )? (Actor )? (verb | "Due tomorrow") ( status name if status)?, KEY Title, T ago`. `aria-current` is true when the row is selected. The other children have `pointer-events:none` and z 1.
- **Col 1, unread dot** `.nb-dot`: 8×8 circle in var(--accent-t), centred. When read it gets `transform: scale(0); opacity: 0` (transform 220ms, opacity 180ms). During Mark all read the dots get a staggered `transition-delay: index*45ms`, and the stagger flag clears after 900ms.
- **Col 2, who** `.nb-who` (30×30):
  - Actor case: a 30px avatar (11px initials) plus a type badge `.nb-badge` at right -5 / bottom -4. The badge is 17×17, a circle, bg var(--surface), 1px var(--line-2), with a 10px icon (stroke 1.8) in the event colour.
  - System case (no actor, for example Due soon): `.nb-sys`, a 30×30 **rounded square** (radius 8), bg var(--raised), 1px var(--line-2), with a 15px icon (stroke 1.5) in the event colour.
- **Col 3, text** `.nb-txt` (column, gap 4):
  - Line 1 `.nb-l1`: 13px/17px, --text-2, nowrap, gap 6. Bold actor `<b>` is 600 in --text. Then the verb. For status events it is followed by an inline status `.nb-st`: a 12px status glyph in the status colour plus the status name in --text.
  - Line 2 `.nb-l2`: 12.5px/16px, gap 8. The mono key `.nb-key` is 11.5px --text-3 (for example `PRJ-48`), then the title `.nb-title` in --text with an ellipsis.
  - **Read state**: actor becomes weight 500 in --text-2, and the title becomes --text-2 (colour transitions 200ms).
- **Col 4, time** `.nb-time`: mono 11px --text-3 (for example `12m`, `1d`). It fades to opacity 0 on row hover or focus-within.
- **Hover actions** `.nb-act`: absolute at right 10, vertically centred (margin-top -15), gap 2, radius 8, bg var(--hover) (transparent when the row is selected). Hidden state is opacity 0 and translateX(4px). On hover or focus-within it moves to opacity 1 at 0 offset (opacity 120ms, transform 160ms). It is hidden entirely on touch and at ≤760px. It holds two `.nb-ib` buttons (30×30, radius 7, --text-2, hover bg --raised and text --text):
  1. Read toggle. When unread it shows a check icon (`M3.5 8.5l3 3 6-7`) labelled "Mark read". When read it shows a hollow circle (r 3.2) labelled "Mark unread". Title `"{label} (E)"`.
  2. Open. Arrow up-right icon (`M6 3.5h6.5V10M12.5 3.5l-9 9`), aria-label `Open PRJ-48`, title `Open task (↵)`.

### 1.4 Notification types (event registry `EV`)
| type | Pref row name | Verb in row | Badge colour | Icon path (16 viewBox) |
|---|---|---|---|---|
| assigned | Assigned to me | `assigned you` | var(--accent-t) | `M6.5 7.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM2 13.5c.5-2.4 2.2-3.8 4.5-3.8 1 0 1.9.3 2.6.8M10.5 11.5h4M12.8 9.7l1.8 1.8-1.8 1.8` |
| mention | Mentioned | `mentioned you` | var(--info) | `M10.6 8a2.6 2.6 0 11-5.2 0 2.6 2.6 0 015.2 0zM10.6 8v1.1a1.7 1.7 0 003.4 0V8A6 6 0 108 14c1.1 0 2.1-.3 3-.8` |
| status | Status change on my tasks | `moved to` + status chip | var(--text-2) | `M2.5 5.5h9M9.5 3.5l2 2-2 2M13.5 10.5h-9M6.5 8.5l-2 2 2 2` |
| comment | New comment | `commented` | var(--text-2) | `M2.5 3.5h11v7.5H7.5L4.5 13.5V11h-2z` |
| due | Due soon | (none). Bold actor text is `Due tomorrow` | var(--warn) | `M8 2.5a5.5 5.5 0 110 11 5.5 5.5 0 010-11zM8 5v3.2l2.2 1.4` |
| sprint | Sprint started | (none) | var(--accent-t) | `M12.5 6.5A4.8 4.8 0 004 5M3.5 9.5A4.8 4.8 0 0012 11M3.8 2.8v2.4h2.4M12.2 13.2v-2.4H9.8` |

The board header says "5 event types". Five types appear in inbox data. **Sprint started** appears only in the preferences matrix (6 rows) and has no inbox example.

Status registry: backlog `Backlog` --text-3 (dashed ring); todo `Todo` --todo (ring); progress `In progress` --warn (half-filled conic); review `In review` --info (270° conic); done `Done` --ok (filled with a check). Glyph `.tp-g`: 14px circle (12px inside rows), border 1.5px.
Priority registry: n4 Urgent --danger, n3 High --orange, n2 Medium --warn, n1 Low --low. Bars `.tp-bars`: 4 bars 3px wide with heights 4/7/10/12, gap 1.5. Filled bars use currentColor and unfilled bars use --line-2.

### 1.5 Demo data (verbatim)
| id | type | actor | time | group | unread | key | title | status (from) | pri | due | quote |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | mention | Sam Patel | 12m | Today | yes | PRJ-48 | Token refresh race on cold start | In progress | High | Oct 9 | can you check the retry path before the beta cut? |
| 2 | assigned | Jordan Lee | 38m | Today | yes | PRJ-52 | Rate-limit login attempts | Todo | Medium | Oct 14 | |
| 3 | status | Riley Chen | 1h | Today | yes | PRJ-41 | Virtualize board columns | In review (from In progress) | High | Oct 10 | |
| 4 | comment | Morgan Diaz | 2h | Today | yes | PRJ-37 | Sprint burndown off by one day | In progress | Medium | Oct 13 | Repro’d on Safari only. Timezone offset? |
| 5 | due | (system) "Due tomorrow" | 3h | Today | yes | PRJ-44 | Migrate sessions to Redis | In progress | Urgent | Oct 8 (dueSoon) | |
| 6 | status | Taylor Ng | 1d | Earlier | no | PRJ-29 | Board drag preview | Done (from In review) | Medium | Oct 6 | |
| 7 | assigned | Sam Patel | 1d | Earlier | yes | PRJ-55 | Invoice PDF export | Todo | Medium | Oct 20 | |
| 8 | mention | Riley Chen | 2d | Earlier | no | PRJ-31 | Cut p95 on board load | In progress | Urgent | Oct 12 | numbers after virtualization: 240ms p95. |
| 9 | comment | Jordan Lee | 3d | Earlier | no | PRJ-26 | OAuth scopes for API keys | In review | Medium | Oct 9 | Scope list looks right to me. |
| 10 | assigned | Morgan Diaz | 6d | Earlier | no | PRJ-19 | Audit log retention | Backlog | Low | Oct 28 | |

Rendered line 1 examples: "**Sam Patel** mentioned you", "**Jordan Lee** assigned you", "**Riley Chen** moved to ◔ In review", "**Morgan Diaz** commented", "**Due tomorrow**" (system tile with a clock icon in --warn).

### 1.6 Preview panel `.nb-pv` (task preview)
- Side mode (desktop): flex none, width 0 when closed and **380px** when open (width transition 250ms ease), bg var(--surface), border-left 1px var(--line). The inner `.nb-pvi` is a fixed 380px column. When closed, its visibility is set to hidden after 250ms.
- Sheet mode (mobile, loading and error frames): absolute bottom sheet (left 0, right 0, bottom 0), max-height 84%, border-top 1px var(--line-2), radius 18 18 0 0, shadow `0 -16px 48px rgba(0,0,0,.4)`. Closed state is translateY(105%) and open is none (transform 280ms ease). z 8. Shows a grab handle `.tp-grab`: 36×4, radius 2, var(--line-2), margin 8px auto 0. Scrim `.nb-scrim`: `rgba(2,5,14,.55)` with `backdrop-filter: blur(4px)`, z 7, fade-in 200ms. Clicking the scrim closes the sheet.
- At viewport ≤760px the side panel also becomes a bottom sheet.
- **Header `.nb-pvh`**: height 52, padding `0 10px 0 18px`, gap 8, border-bottom 1px var(--line). Contents: mono 12px --text-2 key (`PRJ-48`), 12px --text-3 project name `Platform Rebuild`, a spacer, a read-toggle icon button (hollow circle, label "Mark read" or "Mark unread", title `… (E)`), and a close button (14px X, aria-label "Close preview", title `Close (Esc)`).
- **Body `.nb-pvb`**: padding 18, gap 14, scrollable.
  - `h3` title: 17px/24px, 600, letter-spacing -.01em.
  - Chip row (wrap, gap 6). Chips `.tp-chip` are height 26, padding 0 9, radius 7, 1px var(--line-2), bg var(--raised), 12px/500, gap 7. The chips are, in order: status (glyph + name); priority (bars + name); assignee (20px avatar AK + "Alex Kim"); due chip in mono, `Due Oct 9`, coloured --warn when due soon and --text-2 otherwise.
  - **Event card `.nb-ev`**: 1px var(--line), radius 10, bg var(--bg), padding 12, column gap 10.
    - Header `.nb-evh` (12.5px --text-2, gap 8): 24px avatar, or for system events a 24px sys tile (radius 6, 13px icon); then "**Actor** verb", where the verb for status events is `changed status`; then a spacer and a mono 11px --text-3 time `12m ago`. System variant reads "**Due tomorrow** Oct 8".
    - Quote `.nb-q` (13px/20px --text), shown when a quote exists. Mention events prefix the quote with a mention pill `.tp-mention`: "@Alex Kim", colour --accent-t, bg --accent-s, padding 0 3, radius 4, weight 500.
    - Status events show a move row `.nb-move` (gap 8, 12.5px): from chip, a 14px arrow in --text-3, then the to chip.
- **Footer `.nb-pvf`**: padding `12px 18px 16px`, gap 8, border-top 1px var(--line). Primary button **Open task** (link to Task Detail) with kbd `↵` (hidden on phone; the kbd sits on a white-tinted background, `rgba(255,255,255,.16)` with a `.3` border). Ghost button labelled "Mark read" or "Mark unread".
- Default buttons: `.btn` height 32, padding 0 12, radius 6, 13px/500. Primary bg --accent, text #fff; on hover bg --accent-h with shadow `0 0 0 4px var(--accent-s)`. Active state is scale(.97).

### 1.7 Interactions and keyboard
- Clicking a row (or the Open action) marks it read, selects it and opens the preview.
- `E` (without Shift) on a focused row toggles read/unread.
- `Shift+E` anywhere in main runs Mark all read. If unread count is 0 nothing happens. Otherwise every item is set read, the dot fade is staggered, and the toast "{n} marked read" with Undo appears for 4.2s.
- `Esc` closes the preview. Inside the panel, the event stops propagating.
- Switching tabs moves the indicator with the spring easing.
- The unread count drives the `.nb-unc` pill, the sidebar Inbox pill and the "All read" swap.
- Touch (`.touch`): rows have min-height 68, tabs 44, and the hover action cluster is hidden. Read toggling on touch happens through the preview sheet.

### 1.8 States
- **Loading** (aria-busy, label "Loading inbox"): a group-header skeleton 52×10 with padding `14px 12px 8px`, then 6 skeleton rows `.nb-skr` (grid `12px 36px 1fr 28px`, height 60, padding as for real rows). Each row has an 8px dot (opacity 1,1,0,1,0,0), a 30px avatar (radius 50%, except row 4 which uses 8px to stand for a system tile), two lines at 11px and 10px high with gap 7 and widths (w1%/w2%) of 46/70, 38/58, 52/64, 30/74, 44/52, 36/66, and a 24×9 time stub. Shimmer `.sk`: linear-gradient(90deg, raised, hover, raised) at size 200%, 1.4s linear infinite. Tab counts show `–`.
- **Empty** (`.nb-center`: min-height 240, centred column, gap 10, padding 24): a 52px circle icon `.nb-emic` (1.5px --line-2 border, bg --surface, 22px check in --ok). It pops in with `tppop` over 320ms spring (scale .6 → 1.12 → 1) and shows a spark burst: six 4px --spark dots at offsets (0,-34), (30,-16), (30,17), (0,34), (-30,17), (-30,-16), animated by `tpspark` over 640ms after a 120ms delay (scale .3 → 1.5, fade out). H3 **"All caught up"** (15px/600, margin-top 6). Text **"New activity on your tasks lands here."** (13px --text-3). Button `.btn-sec.sm` **"Notification settings"** (bg --raised, border --control). An empty filtered tab shows the same empty state.
- **Error** (role=alert): a 52px circle with a 22px alert icon in --danger. H3 **"Couldn’t load inbox"**, then mono 11px **"503 · notifications service"**, then button **Retry**. Retry switches to loading, and after 1100ms the inbox is ready.

### 1.9 Mobile (frame M, 390×844)
No sidebar. The top bar shows the logo tile, "Inbox", the unread pill, Mark all read (no kbd; in the real app the label is hidden at ≤760px, leaving the icon only) and the settings gear. Tabs are 121px each. Rows are 68px with no hover actions. Tapping a row opens the bottom sheet over the scrim.

### 1.10 Notification preferences (frame P, 1280×560)
**Settings nav `.st-nav`**: width 220, border-right 1px var(--line), bg --surface, padding `16px 10px`, gap 2.
- Back link `.st-back`: chevron plus "Settings", height 30, margin-bottom 10, --text-2.
- Section labels `.st-sec`: mono 11px uppercase, letter-spacing .07em, --text-3, padding `12px 8px 6px`. Sections: **Account** and **Workspace**.
- Items `.st-it` (height 30, radius 7, gap 10, 16px icons): Profile; **Notifications** (current: bg --accent-s, text --text, icon --accent-t); Workspace; Members; **Danger zone** (`.dng`, icon in --danger).

**Main `.st-main`, inner `.st-wrap`**: max-width 900, padding `28px 40px 40px` (16 at ≤760px), gap 20.
- Header: h2 **"Notifications"** (20/28, 600, -.015em), a spacer, then the autosave status `.st-saved` (12px --text-3, fade 160ms). States are **"Saving"** with a 12px spinner (`.spin`: 2px --line-2 border, top colour --text-2, .7s) and **"Saved"** with a 14px --ok check. After any change it shows "Saving", switches to "Saved" at 550ms and clears at 2600ms (token-guarded).
- **Matrix `.pm`** (role=table, aria-label "Notification preferences"): 1px --line, radius 12, bg --surface, overflow hidden (overflow-x auto on mobile).
  - Row grid `minmax(0,1fr) repeat(5,108px)`, border-top 1px --line between rows.
  - Header row `.pm-hd` has bg --bg. Header cells `.pm-hc` have min-height 52, padding 8 6, 12px/600 --text, centred, column gap 5. The first cell is **"Event"**: left-aligned, padding-left 16, --text-3, weight 500.
  - Columns: **In-app** (live), **Email** (live), **Telegram**, **SMS**, **Push**. The last three are **coming soon**: their header text is --text-3 with a `.pm-soon` badge below reading "COMING SOON" (mono 500 9.5px, uppercase, letter-spacing .04em, --text-3, 1px **dashed** --line-2, radius 5, padding 3 5).
  - Coming-soon columns, both header and body cells, get a hatch background `repeating-linear-gradient(135deg, transparent 0 7px, var(--raised) 7px 8px)`.
  - Event row header `.pm-ev`: min-height 50, padding 0 16, gap 10, weight 500. Icon tile `.pm-ic` is 26×26, radius 7, bg --raised, 1px --line, with a 14px event icon in the event colour.
  - Live cells use the toggle `.tg`: 32×18, radius 9, 1px --control, bg --raised. Knob 12px in --text-2 at top 2, left 2. Checked: bg and border --accent, knob #fff, translateX(14px) with 180ms spring. role="switch", aria-label `"{Event}, {Channel}"`.
  - Coming-soon cells use `.tg-soon`: 32×18, 1px dashed --line-2, opacity .7, cursor not-allowed, knob in --line-2, role img, aria-label `"{Event}, {Channel}: coming soon"`, title "Coming soon". They are not interactive.
  - **Rows and defaults (In-app / Email):**
    | Event | In-app | Email |
    |---|---|---|
    | Assigned to me | on | on |
    | Mentioned | on | on |
    | Status change on my tasks | on | off |
    | New comment | on | off |
    | Due soon | on | on |
    | Sprint started | on | off |
- **Footer `.pm-foot`**: flex, gap 14, wrap, padding 14 16, 1px --line, radius 12, bg --surface. Label **"Email delivery"** (500), then a segmented control `.seg` (padding 3, gap 2, radius 8, bg --raised, 1px --line). Segment buttons are height 26, padding 0 12, radius 6, 12px/500 --text-2. Pressed: bg --hover, text --text, `inset 0 0 0 1px var(--line-2)`. Options: **Instant** (default), **Hourly**, **Daily**. Then a spacer and the mono 11px --text-3 delivery address `alex@team.dev`. Changing the digest option also triggers autosave.

### 1.11 Backend and data implications (notifications)
- Notification record: `id, type (assigned|mention|status|comment|due|sprint), actorId | null (system), taskKey, taskTitle, projectName, createdAt (relative display: 12m, 38m, 1h, 1d…), readAt | unread flag, payload {quote?, fromStatus?, toStatus?, dueDate?}`. The preview also needs the task's current status, priority, assignee and due date.
- Grouping: Today versus Earlier, based on createdAt. Counts are needed per tab (all, mention, assigned) and as a total unread.
- Endpoints: list (filterable by type), PATCH read/unread per item, POST mark-all-read that returns the affected ids so Undo can restore them (or Undo sends the previous read map back), and an unread count for the sidebar badge. The error copy references a "notifications service" returning 503.
- Preferences: a per-user matrix of `event × channel` booleans, of which only `inApp` and `email` are live. Telegram, SMS and Push are v2 (coming soon). Also `emailDigest: instant|hourly|daily`. Autosave happens on each toggle (debounced and optimistic). Email is sent to the user's account email.
- Sprint started events must be produced even though the inbox has no sample of them.
- Not in the design (v2 or out of scope): archive or delete, snooze, bell popover, a full-page inbox search, per-project mute.

---

## 2. AUTH FLOW (21-Auth-flow.html)

### 2.1 Frames on the board
| id | Caption | Meta | Size | Theme | Initial state |
|---|---|---|---|---|---|
| li | Login | `interactive · blur + submit` | 620×680 | page | email `alex@team.dev` |
| le | Login · error | `wrong credentials` | 620×680 | page | email + password `sprint-14`, error banner |
| ll | Login · loading | `button spinner` | 620×680 | page | busy (frozen) |
| lt | Post-login | `logo animation · ~1.1s` | 620×680 | page | transition shown, Replay button |
| rg | Register | `live strength · 4 rules` | 620×820 | page | Sam Patel / sam@team.dev / `Sprint14` |
| ac | Accept invitation | `email locked` | 620×820 | page | taylor@team.dev / Taylor Ng |
| fp | Forgot password | `interactive` | 620×520 | page | empty |
| fs | Forgot · sent | `resend countdown` | 620×520 | page | sent, countdown at 24s |
| rp | Reset password | `mismatch` | 620×600 | page | `Beta-launch21` / `Beta-launch2`, both touched |
| rs | Reset · success | `done` | 620×600 | page | done |
| lgl | Login | `light · focus` | 620×820 | **light forced** | email focused (`.fk`) |
| acl | Accept invitation | `light · weak password` | 620×820 | **light forced** | newpw `orbit` |
| mli | Mobile · Login | `390` | 390×844 r28 | page | empty |
| mrg | Mobile · Register | `390 · errors` | 390×844 r28 | page | email `sam@team`, pw `beta`, touched |
| mac | Mobile · Invitation | `390` | 390×844 r28 | page | name empty |

The auth flow has **no split branding panel**. Every screen is a centred single column on a decorative backdrop. Screens: login, register, forgot (with a sent state), reset (with a success state), accept invite, plus the post-login transition and the app placeholder.

### 2.2 Frame shell and backdrop
- `.au`: relative, overflow hidden, 1px --line-2, radius 14 (28 phone), bg --bg, `isolation: isolate`. At ≤760px viewport it has no radius and no border (full-bleed).
- Backdrop `.bd` (absolute inset 0, pointer-events none, z 0):
  - `.bd-glow`: left 50%, top -30%, width 120%, height 80%, translateX(-50%), `radial-gradient(closest-side, var(--glow), transparent)`.
  - `.bd-grid`: inset -40px, 1px lines on a 40×40 grid in var(--grid), masked by `radial-gradient(ellipse 70% 60% at 50% 45%, #000 20%, transparent 80%)`. Animation `audrift` 28s linear infinite, moving translate(0,0) to (40px,40px) for a seamless drift.
  - Three outline bolts (`M50 -5L27 17H38L-4 44`, no fill, miter):
    1. 180×152, opacity .07, at right -30 / top 60, stroke var(--logo) width 2, `aufloat` 16s ease-in-out infinite alternate.
    2. `.b2` 110×93, opacity .05, at left -20 / bottom 90, var(--logo) width 2.5, 21s, delay -6s.
    3. `.b3` 70×59, opacity .06, at left 18% / top 36, var(--text-3) width 3, 13s, delay -3s.
    - `aufloat`: translate(0,0) rotate(0) to translate(-18px,26px) rotate(-4deg).
- Scroll column `.au-scroll`: z 1, height 100%, overflow auto, flex column, centred, `justify-content: safe center`, padding 40 24. Phone: `flex-start` with padding `48px 0 28px` (56/0/32 at ≤760px viewport).
- Order inside: **logo wordmark `.wm` (24px)**, then the card, then the footer line.

### 2.3 Card and form primitives
- `.au-card`: width 400 (max 100%), margin-top 28, padding 32, 1px --line, radius 14, bg --surface, column gap 20. **Phone**: width 100%, margin-top 24, padding 0 20, **no border and transparent background**, gap 16.
- Title `.au-h`: 20px/28px, 600, letter-spacing -.015em. Subtitle `.au-sub`: margin-top 4, 13px/20px, --text-2.
- Form `.au-form`: column gap 16, `noValidate`, aria-labelledby the title.
- Field `.au-f`: column gap 6. Label row `.au-lr` spaces label and link apart. Label `.au-l`: 12.5px/500 --text-2.
- Input `.au-in`: height 40, padding 0 12, radius 8, 1px --line-2, bg --bg, --text, 400 14px Inter. Placeholder in --text-3. Hover border --control. Focus: border --accent with `0 0 0 3px var(--accent-s)`. **Phone: height 44 and font-size 16px**, which prevents iOS zoom. Inputs with a trailing icon get padding-right 44 (`.pr`).
  - Invalid (`aria-invalid=true`): border --danger. Invalid and focused: ring `0 0 0 3px var(--dng-s)`.
  - Read-only (locked invite email): text --text-2, bg --raised, **dashed** border, default cursor. On focus the border stays --line-2 with an --accent-s ring.
- Trailing icon button `.au-ia`: right 4, 34×32, radius 6, --text-3, hover bg --hover and text --text.
  - Password show toggle: aria-label "Show password", `aria-pressed`. Eye icon (`M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z` with a circle r2) switches to eye-off (`M2 2l12 12M6.6 4.7A6 6 0 0 1 8 3.5c4 0 6.5 4.5 6.5 4.5a11 11 0 0 1-1.9 2.4M4.2 5.5A11 11 0 0 0 1.5 8S4 12.5 8 12.5a6 6 0 0 0 2.4-.5`). Toggling flips the input type between password and text. Available on every password field.
  - Lock (`.lk`, decorative): a 14px padlock on the locked email field, no hover effect.
- Field error `.au-err`: flex, gap 6, 12px/16px, --danger, with a 12px circled-! icon. Animation `auin` 160ms: from opacity 0 and translateY(-3px).
- Hint `.au-hint`: 12px/16px --text-3 (for example "From your invite").
- Link `.au-lk`: --accent-t, 500, no underline. Hover adds underline with offset 3px. `.sm` is 12px.
- Primary button `.au-btn.pri`: full width, height 40 (**46 / 15px on phone**), padding 0 14, radius 8, 500 14px, bg --accent, text #fff, hover --accent-h, active scale(.985). Busy state: `aria-busy=true`, progress cursor, plus a spinner `.spin` (15px, 2px `rgba(255,255,255,.35)` ring with #fff top, 700ms linear).
- Secondary `.au-btn.sec`: bg --raised, 1px --line-2, --text, hover border --control and bg --hover. `aria-disabled=true` makes the text --text-3 and removes hover.
- Divider `.au-or`: the text "OR", mono 500 11px uppercase, letter-spacing .06em, --text-3, with 1px --line rules on each side and a 12px gap.
- Footer `.au-foot`: margin-top 20 (24 on phone), 13px --text-3, the text followed by a link.
- Checkbox `.au-cb`: 16×16, 1.5px --control border, radius 4. When checked, bg and border become --accent, with a white check (8×4 L-shape rotated -45°, popping in from scale 0 over 150ms spring). Invalid: border --danger. Row `.au-cbr` has gap 10, 13px --text-2.
- **Error banner `.au-banner`** (role=alert): flex, gap 10, padding 10 12, radius 8, **1px solid --danger**, bg --dng-s, 13px/18px. 16px circled-! icon in --danger (margin-top 1). Bold line **"Incorrect email or password"** (600, block), then 12px --text-2 **"Try again or reset your password."** Animation `auin` 180ms. While the banner shows, the email and password inputs are aria-invalid with a red border and are described by the banner. Typing in any field dismisses it.

### 2.4 SSO
Login and Register show a `.au-btn.sec` button **"Continue with Google"** with a 16px stylised G icon (path `M13.6 7.1H8.2v2.2h3.1A3.5 3.5 0 1 1 10.4 5.2`, plus a circle r6.2 at opacity .35), monochrome in currentColor. The `OR` divider follows it. The handler is a no-op in the design. Google is the only SSO provider shown. There is no SSO on forgot, reset or accept.

### 2.5 Screen specs (copy verbatim)
Field tuple format: label, input type, autocomplete, placeholder. Email placeholder is `you@team.dev`, name placeholder is `First Last`, password fields have none.

**Login** (`#login`)
- Title **"Welcome back"** (no subtitle).
- Continue with Google, then OR.
- (Banner when credentials are wrong.)
- Email: `Email`, email, `email`.
- Password: `Password`, password, `current-password`, with **"Forgot password?"** (`.au-lk.sm`, link to #forgot) right-aligned in the label row, and a show toggle.
- Button **"Sign in"**, busy **"Signing in…"**.
- Footer: "New to Lightex? **Create account**" (link to #register).
- No "remember me" checkbox.

**Register** (`#register`)
- Title **"Create your account"**.
- Continue with Google, then OR.
- `Full name` (text, `name`), `Work email` (email), `Password` (password, `new-password`) with the strength meter and rules.
- Checkbox **"I agree to the [Terms]"**. Error: **"Accept the terms to continue"**.
- Button **"Create account"**, busy **"Creating account…"**.
- Footer: "Have an account? **Sign in**".

**Forgot password** (`#forgot`)
- Title **"Reset your password"**, subtitle **"We’ll email you a link."**
- `Email`.
- Button **"Send reset link"**, busy **"Sending…"**.
- Footer: "**Back to sign in**" (link only, no lead text).
- **Sent state** (`.au-done`, role=status, centred column, gap 16, `auin` 220ms):
  - Icon tile `.au-ico`: 52×52, radius 14, bg --raised, 1px --line-2, colour --accent-t, with a 22px envelope.
  - **"Check your inbox"**.
  - "Link sent to `<email>`", where the email is `.au-mail` mono 12.5px --text.
  - Secondary button. During cooldown it is aria-disabled with the label **"Resend in 0:24"** (`.au-cd` mono 12.5px, ticking every second). After cooldown it reads **"Resend email"**. Clicking restarts a 30s cooldown and shows the hint **"Sent again"** while the countdown runs.
  - The footer "Back to sign in" stays visible.
  - The cooldown after first submit is **30s** and the format is `0:SS`.

**Reset password** (from the email link)
- Title **"Set a new password"**.
- `New password` (new-password, with meter and rules) and `Confirm password`.
- Button **"Update password"**, busy **"Updating…"**.
- No footer.
- **Success**: icon tile `.au-ico.ok` with a 22px check in --ok and the spark burst (six --spark dots at ±26/±30 offsets, `auspark` 520ms after an 80ms delay). Text **"Password updated"**, then **"Other sessions were signed out."**, then a primary link button **"Sign in"** (to #login). This implies the backend revokes other sessions on reset.

**Accept invitation**
- Invite header `.au-inv` (centred column, gap 12, padding-bottom 20, border-bottom 1px --line):
  - Workspace tile `.au-ws`: 48×48, radius 12, 600 16px with letter-spacing -.02em, bg `oklch(var(--av-l) var(--av-c) 255)`, 1px --line-2. Text **"PT"**.
  - Title **"Join Platform team"**.
  - Inviter `.au-by` (13px --text-2, gap 8): a 22px avatar JL (hue 200, 9.5px font) followed by "**Jordan Lee** invited you" (the name in 500 --text).
  - Role pill `.au-role`: height 24, padding 0 9, radius 999, 1px --line-2, bg --raised, 12px/500. It starts with a 6px --accent-t dot. Text **"Role: Member"**, tooltip "Create and edit tasks".
- Fields: `Email` (**locked**, read-only with padlock and the hint **"From your invite"**, never validated); `Full name`; `Set a password` (with meter and rules).
- No terms checkbox and no SSO.
- Button **"Join workspace"**, busy **"Joining…"**.
- Footer: "Not Taylor? **Sign in**" (the invitee's first name is interpolated; the board hard-codes Taylor).

### 2.6 Validation rules (exact)
Errors appear on **blur**, but only if the field has a value (it is then marked touched), or after a submit attempt. On submit with errors, all errors show and focus moves to the first invalid field (or to the terms checkbox).
| Field | Empty message | Invalid message |
|---|---|---|
| name | `Enter your name` (trimmed) | |
| email | `Enter your email` | `Enter a valid email` (regex `^[^\s@]+@[^\s@]+\.[^\s@]+$`) |
| password (login) | `Enter your password` | (any non-empty value passes) |
| newpw | `Create a password` | `Use a stronger password` (when score < 3) |
| confirm | `Confirm your password` | `Passwords don’t match` |
| terms (register) | `Accept the terms to continue` | |

Input `aria-describedby` combines the banner, the error id, the rules list id and the hint id as applicable.

### 2.7 Password strength meter and rules
- Rules, shown in a 2-column grid with gap 4px 12px:
  1. `8+ characters`: length ≥ 8
  2. `A number`: matches `\d`
  3. `Upper + lower`: has both a-z and A-Z
  4. `A symbol`: matches `[^A-Za-z0-9]`
- Score: the number of rules met. If length < 8, score is capped at 1. If any input exists, the minimum is 1. Empty input scores 0.
- Labels: 1 **Weak** (--danger), 2 **Fair** (--orange), 3 **Good** (--warn), 4 **Strong** (--ok). Passing requires **≥ 3 (Good)**.
- Meter `.au-meter` (gap 10): 4 segments, each height 4, radius 2, gap 4, unfilled --line-2. The first `score` segments are filled in that score's colour (all filled segments use the same colour), with a 200ms transition. The right-hand label `.au-ml` is mono 500 11px, min-width 44, right-aligned, coloured by score, aria-live polite. ARIA: role meter, values 0–4, valuetext set to the label.
- Rule row `.au-rule`: 12px/18px, gap 6. An unmet rule shows a 1.6px-radius dot in --text-3. A met rule turns the text --text-2 and shows a 12px check in --ok. Screen-reader suffix ", met" or ", not met".
- Worked examples: `Sprint14` scores 3 (Good; no symbol). `beta` scores 1 (Weak; shows "Use a stronger password" once touched). `orbit` is Weak. `Beta-launch21` scores 4 (Strong).
- The meter shows on the `newpw` field only: Register "Password", Reset "New password", Accept "Set a password".

### 2.8 Submit flow and post-login transition
- Submit with no errors: phase becomes busy (spinner and busy label) for **900ms**. Then:
  - forgot goes to the sent state with a 30s cooldown;
  - reset goes to the success state;
  - login, register and accept go to the **transition** for 1300ms, then the **app placeholder**.
- **Transition `.au-tr`** (role=status, aria-label "Signing you in"): absolute, inset 0, z 5, centred column, gap 28, bg --bg, `aufade` 200ms. The wordmark is **56px** (44px on phone):
  - `.a-bar`: the bar wipes in with `barIn` over 260ms (clip-path inset(0 100% 100% 0) to inset(0)).
  - `.a-bolt`: `strike` over 320ms spring, starting at 140ms (from opacity 0, translate(14px,-18px) and scale 1.15).
  - `.a-flash`: a circle r24 at (23, 19.5) with a 1.5px --spark stroke runs `flash` over 460ms, starting at 300ms (scale .4, peak opacity .7 at 30%, ending at scale 1.8 and opacity 0).
  - `.a-x`: `settle` over 260ms, starting at 460ms (scale 1.08 to 1). Uses `transform-box: fill-box; transform-origin: center`.
  - `.a-word` "Lighte": `wordIn` over 300ms, starting at 520ms (from opacity 0 and translateX(10px)).
  - `.a-ws` workspace name **"PLATFORM TEAM"** (mono 500 11px uppercase, letter-spacing .06em, --text-3): `wordIn` starting at 760ms. Total about 1.06s.
  - Board-only **Replay** ghost button (`.au-ghost`: height 28, padding 0 10, radius 6, 1px --line-2, bg --raised, 12px/500 --text-2) centred 28px from the bottom.
- **App placeholder `.app`** (z 4, `aufade` 360ms): a left rail 184px wide (--surface, border-right, padding 14 12, gap 10) with a workspace row (22px "PT" tile and "Platform team") and five skeleton bars at 70/56/64/48/60% width. Main area (padding 18 20, gap 14) has a top row with h2 "Platform team" (15px/600; padding-right 96 to clear the ghost button), two 96px skeleton cards (radius 10), and three 34px skeleton rows. Sign out is a ghost button pinned top-right (14/14), and it resets the frame. Phone: no rail, main padding `56px 16px 16px`, cards stack in one column. In production this would be the real app route. The skeleton shimmer is `aushim` 1.4s.

### 2.9 Theme notes (auth)
Frames without a forced theme inherit the page theme (navy by default). The `lgl` and `acl` frames force `.t-light`: grid lines become rgba(18,18,23,.055), the glow rgba(29,78,216,.08), --dng-s rgba(185,47,38,.07), and the logo bolt #1D4ED8. The `lgl` frame shows the focused-input look: border --accent with a 3px rgba(29,78,216,.10) ring.

### 2.10 Backend and data implications (auth)
- Endpoints:
  - `POST login {email, password}` returns a generic 401 that drives the single banner (it does not say whether the email exists).
  - `POST register {name, email (work email), password, acceptedTerms}`.
  - `POST forgot {email}`, which should always appear to succeed. The UI enforces a 30s resend cooldown, so mirror it with a server rate limit.
  - `POST reset {token, newPassword}`, which revokes other sessions ("Other sessions were signed out.").
  - `GET invite/:token` returns `{workspaceName, workspaceInitials, inviterName, inviterInitials, role, roleDescription, email}`.
  - `POST invite/:token/accept {name, password}`, with the email fixed from the invite.
  - Google OAuth for login and register.
- Server-side password policy should mirror the client: score ≥ 3 out of the 4 rules, with at least 8 characters required to get past Weak.
- After login, auth redirects into the last or default workspace, whose name is shown in the transition.
- Invite roles are labelled "Role: Member" with the description "Create and edit tasks" (other roles exist elsewhere: Admin, Viewer).
- Not present: MFA/2FA, magic-link login, email verification screen, SSO providers other than Google, a "remember me" checkbox, a branding side panel. Treat these as v2 or out of scope.
