# Lightex logo: "the cut x" (final)

Source: `clean/08-Logo-the-cut-x-final.html` (final). Context: `clean/07-Logo-round-1-directions.html`. Round 1 had four directions: A Strike tile, B Cut X, C LX monogram, D the cut x. **Direction D was picked.**

> "Wordmark is the logo. The lone x is the icon."

There is no separate symbol beside the name. The wordmark is "Lighte" set in Inter Semibold, plus a redrawn final **x**. One stroke of the x stays straight and neutral. The other is an electric-blue lightning bolt. Where the two strokes cross, a thin gap is cut out of the straight stroke. The lone x is also the symbol and the app icon.

Note: the design-canvas export mangles camelCase SVG attributes. `sc-camel-view-box` means `viewBox` and `sc-camel-mask-units` means `maskUnits`. The markup below uses the real attribute names. Everything else is verbatim.

---

## 1. Construction

- **Grid:** 46 × 39 units (`viewBox="0 0 46 39"`). The grid is clipped to that rectangle, so the stroke ends run off the edges and are cut flat by the clip.
- **Straight stroke** (`--b`, neutral): `M-4 -4L50 43`, top-left to bottom-right, stroke-width 9.5.
- **Bolt stroke** (`--a`, accent): `M50 -5L27 17H38L-4 44`, top-right to bottom-left with a horizontal jog (27→38 at y≈17). Stroke-width 8.5, miter joins, miterlimit 10.
- **Cut:** a mask removes from the straight stroke a bolt-shaped path 13.5 wide. The bolt is 8.5 wide, so the gap is (13.5 − 8.5) / 2 = **2.5 units** on each side. The spec says "Cut · 2.5 units on a 46 × 39 grid".
- **Bolt stroke ≈ 0.89 of the straight stroke** (8.5 / 9.5).
- Because the gap is a real mask cut and not an overlap, the mark also works in a **single flat color**.

### Two cuts (sizes)

| Symbol | Use | Bolt path | Bolt width | Straight width | Mask (cut) width |
|---|---|---|---|---|---|
| `#lx` "text cut" | Wordmark, standalone symbol, anything > 64px | `M50 -5L27 17H38L-4 44` | 8.5 | 9.5 | 13.5 |
| `#lxi` "icon cut" | App icons, favicons, loader tile (≤ 64px) | `M50 -5L26 18H39L-4 44` | 10 | 11 | 16 |

Spec note: "≤64px: icon cut, strokes +15%". The icon cut's bolt jog is also wider (26→39 instead of 27→38).

### Exact SVG markup (verbatim, viewBox and maskUnits restored)

```html
<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <defs>
    <symbol id="lx" viewBox="0 0 46 39">
      <clipPath id="lxc"><rect width="46" height="39"></rect></clipPath>
      <mask id="lxm" maskUnits="userSpaceOnUse" x="-10" y="-10" width="70" height="60"><rect x="-10" y="-10" width="70" height="60" fill="#fff"></rect><path d="M50 -5L27 17H38L-4 44" fill="none" stroke="#000" stroke-width="13.5" stroke-linejoin="miter" stroke-miterlimit="10"></path></mask>
      <g clip-path="url(#lxc)"><path d="M-4 -4L50 43" stroke="var(--b)" stroke-width="9.5" fill="none" mask="url(#lxm)"></path><path d="M50 -5L27 17H38L-4 44" stroke="var(--a)" stroke-width="8.5" fill="none" stroke-linejoin="miter" stroke-miterlimit="10"></path></g>
    </symbol>
    <symbol id="lxi" viewBox="0 0 46 39">
      <clipPath id="lxic"><rect width="46" height="39"></rect></clipPath>
      <mask id="lxim" maskUnits="userSpaceOnUse" x="-10" y="-10" width="70" height="60"><rect x="-10" y="-10" width="70" height="60" fill="#fff"></rect><path d="M50 -5L26 18H39L-4 44" fill="none" stroke="#000" stroke-width="16" stroke-linejoin="miter" stroke-miterlimit="10"></path></mask>
      <g clip-path="url(#lxic)"><path d="M-4 -4L50 43" stroke="var(--b)" stroke-width="11" fill="none" mask="url(#lxim)"></path><path d="M50 -5L26 18H39L-4 44" stroke="var(--a)" stroke-width="10" fill="none" stroke-linejoin="miter" stroke-miterlimit="10"></path></g>
    </symbol>
  </defs>
</svg>
```

Usage: `<svg><use href="#lx" width="100%" height="100%"/></svg>`. Colors come from the CSS custom properties `--a` (bolt) and `--b` (straight stroke).

---

## 2. Colors per theme

| Theme (tile class) | Background | `--b` straight stroke | `--a` bolt | Wordmark ink | Border |
|---|---|---|---|---|---|
| **Deep navy (primary)** `.dk` | `#060B18` | `#EAF0FF` | `#3B7BFF` | `#EAF0FF` | `#2B3A5E` |
| **Light** `.lt` | `#FFFFFF` | `#0C1326` | `#1D4ED8` | `#0C1326` | `#E4E4EA` |
| **Near-black** `.nv` | `#0B0B0F` | `#ECECF1` | `#3B7BFF` | `#ECECF1` | `#2A2A34` |
| **On brand blue (white only)** `.bl` | `#2662EE` | `#FFFFFF` | `#FFFFFF` | `#FFFFFF` | — |
| **Mono black** `.mb` | `#FFFFFF` | `#0C1326` | `#0C1326` | `#0C1326` | — |
| **Mono white** `.mw` | `#000000` | `#FFFFFF` | `#FFFFFF` | `#FFFFFF` | — |

Spec summary: "Bolt · #3B7BFF dark, #1D4ED8 light".

App-icon tiles:
- Dark tile `#0F1830` with stroke `#2B3A5E` (128 and 96 sizes; 64/32/16 have no stroke). Mark colors are the dark theme's (`#EAF0FF` / `#3B7BFF`).
- Blue tile `#2662EE`, or `#1D4ED8` for the stacked-light 96px tile and the 16px blue favicon. The mark is a **single white color** (`--a = --b = #FFFFFF`).

Motion accent: cyan flash/sparks `#5BE0FF`. The completion check is green `#4ADE80`.

---

## 3. Sizes used

**Wordmark** (font-size): 132px (hero), 96 (motion), 80 (clear-space demo), 64 (theme tiles), 40 (stacked lockup), 24, 16.
- **Minimum:** "Min size: 16px cap height, 72px wide" (demonstrated at font-size 16px).

**Symbol (lone x, `#lx`):** 150 × 128 standalone.

**App icon (tile + `#lxi`):**

| Tile | rx | Mark placement (x, y, w, h) |
|---|---|---|
| 128 | 28 | 24, 30, 80, 68 |
| 96 (stacked lockup) | 22 | 18, 22, 60, 51 |
| 72 (splash/loader) | 16 | 13, 17, 46, 39 |
| 64 | 14 | 11, 15, 42, 36 |
| 32 | 7 | 5, 7, 22, 18.6 |
| 16 (favicon) | 3.5 | 2, 3, 12, 10.2 |

The mark fills about 62% of the tile width. It sits slightly below optical center (bigger top inset than side inset, e.g. 30 vs 24 at 128).

**Sidebar / auth:** the final logo file does not give specific sidebar or auth-screen sizes. Suggested mapping from the shown sizes:
- Sidebar: the wordmark at 16–24px (min 16px), or the 32px app icon when collapsed.
- Auth: the stacked lockup (96 icon + 40px wordmark, 22px gap), or the wordmark at 40–64px.

---

## 4. Wordmark typography (text + inline SVG, not a single SVG)

The wordmark is live text "Lighte" followed by an inline SVG x. CSS (verbatim):

```css
.wm{font-weight:600;letter-spacing:-.04em;line-height:1;color:var(--ink);display:inline-flex;align-items:baseline;white-space:nowrap}
.wx{width:.644em;height:.546em;margin-left:.02em;overflow:visible;flex:none}
```
```html
<span class="wm" style="font-size:132px">Lighte<svg class="wx" role="img" aria-label="x"><use href="#lx" width="100%" height="100%"></use></svg></span>
```

- **Font:** Inter (fallback `system-ui, -apple-system, 'Segoe UI', sans-serif`), **Semibold 600**.
- **Tracking:** −0.04em. Line-height 1.
- **x relative to type:** **0.644em wide × 0.546em tall**, which is Inter's x-height. Left margin 0.02em. The x sits on the baseline (inline-flex, baseline-aligned, so the SVG bottom lands on the text baseline).
- Case: "Lighte" + x. Capital L, everything else lowercase.
- "Lightex" wordmark text color = `--ink` per theme (table above).
- No standalone wordmark SVG file is made, because the wordmark depends on live Inter text. To get one, outline "Lighte" in Inter Semibold at −0.04em and append `logo-mark.svg`, scaled to 0.546em tall, with a 0.02em gap.

**Stacked lockup:** a 96px app-icon tile above the wordmark at 40px, 22px gap, centered.

---

## 5. Clear space

"Clear space = x-height on every side." The demo uses 44px padding around an 80px wordmark (≈ 0.55em, matching the x's 0.546em height). So: keep at least the **height of the x** free on all sides.

---

## 6. Do / Don't

Do:
- Use the deep navy version (`#060B18` bg) as the primary.
- Keep the accent on the bolt only. The straight stroke and "Lighte" stay neutral.
- On brand blue, black or white backgrounds, use the single-color version (white or `#0C1326`). On brand blue the logo is **white only**.
- Switch to the icon cut (`#lxi`, strokes +15%) at 64px and below.
- Use the lone x (on a tile) as the icon or favicon. Don't put the full wordmark in small square spaces.
- Respect the minimum size (16px, 72px wide) and the clear space.

Don't (derived from the spec; the file shows no explicit "don'ts" panel):
- Don't set "Lightex" with a plain typed x. The x is always the cut-x SVG.
- Don't place a separate symbol beside the wordmark. "Wordmark is the logo."
- Don't recolor the bolt outside `#3B7BFF` (dark) / `#1D4ED8` (light), or make the straight stroke blue.
- Don't use the two-color version on brand blue.
- Don't remove the gap (cut) or let the strokes overlap. Don't change the 0.89 stroke ratio, the tracking or the weight.
- Don't use the text cut (`#lx`) at icon sizes ≤ 64px.

---

## 7. Motion

Shared tokens: `--ease: cubic-bezier(.16,1,.3,1)`, `--spring: cubic-bezier(.34,1.56,.64,1)`. Utility `.sv{transform-box:fill-box;transform-origin:center}`.

**Loading / splash (~1s):**

| t | Element | Animation |
|---|---|---|
| 0ms | straight stroke (`.a-bar`) | draws in via clip-path wipe, 260ms ease |
| 140ms | bolt (`.a-bolt`) | strikes in from upper right: `translate(14px,-18px) scale(1.15)` → none, opacity 0→1, 320ms spring |
| 300ms | cyan flash ring (`.a-flash`, `#5BE0FF`, stroke 1.5) | scale .4→1.8, opacity peaks .7 at 30%, 460ms ease |
| 460ms | whole x (`.a-x`) | settles scale 1.08→1, 260ms ease |
| 520ms | "Lighte" (`.a-word`) | slides in from translateX(10px), opacity 0→1, 300ms |
| — | icon tile (`.a-icon`) | scale .86→1 + fade, 300ms spring |

```css
.play .a-bar{animation:barIn 260ms var(--ease) both}
.play .a-bolt{animation:strike 320ms var(--spring) 140ms both}
.play .a-flash{animation:flash 460ms var(--ease) 300ms both}
.play .a-x{animation:settle 260ms var(--ease) 460ms both}
.play .a-word{animation:wordIn 300ms var(--ease) 520ms both}
.play .a-icon{animation:iconIn 300ms var(--spring) both}
@keyframes barIn{from{clip-path:inset(0 100% 100% 0)}to{clip-path:inset(0 0 0 0)}}
@keyframes strike{from{opacity:0;transform:translate(14px,-18px) scale(1.15)}to{opacity:1;transform:none}}
@keyframes flash{0%{opacity:0;transform:scale(.4)}30%{opacity:.7}100%{opacity:0;transform:scale(1.8)}}
@keyframes settle{0%{transform:scale(1.08)}100%{transform:scale(1)}}
@keyframes wordIn{from{opacity:0;transform:translateX(10px)}to{opacity:1;transform:none}}
@keyframes iconIn{from{opacity:0;transform:scale(.86)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.play *,.cmp *{animation:none!important}}
```

Flash ring geometry:
- On the wordmark x: `<circle cx="23" cy="19.5" r="24">` in the 46×39 grid.
- On the 72px tile: `cx="36" cy="36" r="30"`.

**Splash / loader tile:** a 72×72 tile, `rx 16`, fill `#0F1830`, with the icon cut at x13 y17 (46×39).

**Task-complete "spark" (460ms):** clicking the ring does four things:
1. The ring fills green `#4ADE80` with a pop (scale .7→1.18→1, 260ms spring).
2. A bolt-only glyph flies in from the upper right and fades away. It is the path `M50 -5L27 17H38L-4 44`, stroke `#3B7BFF`, width 9, 24×20. Animation `bz`: translate(10px,-12px) scale 1.4 → in place → scale .5 fade.
3. The check draws in (200ms, starting at 200ms).
4. Six cyan `#5BE0FF` sparks burst (scale .3→1.5, starting at 120ms).

Reduced motion turns all animation off. The round-1 note also said: "shows the final mark with a 100ms fade".

---

## 8. Files

- `notes/logo-mark.svg`: primary two-color mark (dark theme colors: `#EAF0FF` / `#3B7BFF`), text cut.
- `notes/logo-mark-light.svg`: light theme (`#0C1326` / `#1D4ED8`).
- `notes/logo-mark-mono.svg`: single color, `currentColor`, for mono black/white and white-on-blue.
- `notes/favicon.svg`: 32px app icon, dark tile `#0F1830`, icon cut, two-color.
- `notes/favicon-blue.svg`: 32px app icon, blue tile `#2662EE`, icon cut, white.
- No `logo-wordmark.svg`: the wordmark is live text (see §4).
