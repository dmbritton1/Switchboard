# Theme — design

Give Switchboard a theme system derived from the Claude cream-and-coral
design language: eight accent colors, four canvases, and a full port of the
type and shape scales that come with it.

This is the change the settings design deferred. It named the cost exactly —
`web/style.css` defines twelve custom properties and then hardcodes roughly
forty more colors past them, so a second palette means hoisting every one of
those into a token first
(`docs/superpowers/specs/2026-08-03-settings-design.md:60`). That hoist is
still the bulk of the work. Nothing below avoids it; the palette below is what
makes it worth doing once.

## The three layers

Accent, canvas, and status are independent. That is the whole reason the
palette stays small enough to verify: they compose at render time instead of
multiplying at authoring time.

**Accent** is what the user picks for chrome — buttons, focus rings, the
active-tab underline, links, selection. Eight of them.

**Canvas** is the surface and text ramp — page floor, cards, elevated
popovers, recessed fields, hairlines, and three text weights. Four of them,
two light and two dark.

**Status** is `working` / `needs-you` / `done` / `stopped` / `error`. It is
*not* customizable, and it keeps its hue identity under every accent. It
re-tunes only for light versus dark, which is two sets, not four — Cream and
Paper sit close enough in luminance to share one, as do Ink and Void.

Accent and canvas are two attributes on `<html>`, so all thirty-two
combinations exist without any of them being authored individually.

### Why status stays fixed

Today `--working` green does double duty: it is the "working" status color
*and* the primary button fill (`#new-btn`, `#create`, focus rings, the active
tab underline, `.combo-list mark`). Under a user-chosen accent that
double-duty has to end, because an accent the user picked for taste would be
carrying a meaning they did not pick.

So green retires to meaning "working" and nothing else, and the accent takes
the whole chrome role. This is the same rule the source system states for
coral — brand color is CTA-only — arrived at here for a different reason.

## The palette

66 values. Every one is a literal hex.

### Accent (24)

Three tokens each. `--accent` is the identity color — the swatch in the
picker, and the border/ring color on dark canvases. `--accent-deep` is the
button fill, and the link and ring color on light canvases; it clears 4.5:1
against both white and Cream. `--accent-lift` is the link color on dark
canvases and clears 4.5:1 against Ink.

| Accent | `--accent` | `--accent-deep` | `--accent-lift` |
|---|---|---|---|
| coral | `#cc785c` | `#a35333` | `#d38769` |
| amber | `#c69239` | `#936a25` | `#d8aa5a` |
| moss | `#7a9e47` | `#57742f` | `#a1c76b` |
| teal | `#3e9886` | `#287163` | `#64c4b1` |
| sky | `#4689b9` | `#32698f` | `#6da9d5` |
| indigo | `#7069bf` | `#574ebc` | `#8f88dd` |
| violet | `#a86bbd` | `#87439d` | `#c089d2` |
| rose | `#c46484` | `#9f385a` | `#da819e` |

Coral is `#cc785c` unchanged, and `--accent-deep` for coral lands at
`#a35333`, within a hair of the source system's own `primary-active`
(`#a9583e`). The other seven are placed at even intervals around the wheel
and pulled to coral's muteness — none is a saturated primary.

The split between `--accent` and `--accent-deep` exists because `#cc785c`
with white text is **3.28:1**, which fails AA. The source system ships that
combination on its marketing pages; Switchboard is an operations surface read
for hours, so the button fill darkens and white text passes.

Borders and focus rings need 3:1 against the floor they sit on, and the
identity hexes do not all clear it on the light canvases — amber `#c69239`
measures about 2.6:1 on Cream, and moss is only just over. So the canvas
blocks alias a fourth name rather than adding a fourth column of hexes: the
light canvases set `--accent-line: var(--accent-deep)`, the dark ones set
`--accent-line: var(--accent)`. Every rule that draws a ring or an edge reads
`--accent-line` and never `--accent` directly. The identity hex survives as
what it is — the color of the swatch.

### Canvas (32)

Eight tokens each: `--canvas` `--surface` `--surface-2` `--well`
`--hairline` `--ink` `--body` `--muted`.

| Token | Cream | Paper | Ink | Void |
|---|---|---|---|---|
| `--canvas` | `#faf9f5` | `#fbfbfc` | `#181715` | `#0f1012` |
| `--surface` | `#efe9de` | `#f0f1f3` | `#211f1c` | `#17191c` |
| `--surface-2` | `#fffdf8` | `#ffffff` | `#2b2825` | `#212429` |
| `--well` | `#f2ede4` | `#f5f6f8` | `#131211` | `#0b0c0e` |
| `--hairline` | `#e0d8cb` | `#e2e4e8` | `#35322d` | `#2a2d33` |
| `--ink` | `#141413` | `#14151a` | `#faf9f5` | `#ecedf0` |
| `--body` | `#3d3d3a` | `#3a3d45` | `#d9d5cc` | `#c8cad0` |
| `--muted` | `#6c6a64` | `#6b6f79` | `#a09d96` | `#8b8f98` |

Cream and Ink are the source system's own floors. Paper is the cool-neutral
light for people who dislike the warm tint, and Void is the cool dark closest
to today's `#111`, kept so the change is not a forced migration of taste.

Note the direction of `--surface` on the light canvases: cards sit *darker*
than the floor (`#efe9de` under `#faf9f5`), which is how the source system
builds feature cards, while `--surface-2` — menus, combo lists, dialogs —
floats lighter. On the dark canvases both go lighter. `--well`, the recessed
field background, is darker than `--surface` on all four, preserving the
intent already recorded at `web/style.css:5`.

Each canvas also sets `color-scheme`, so native scrollbars, form controls,
and the `<dialog>` backdrop follow rather than staying dark under Cream.

There is deliberately no third grey. The source system has a `muted-soft`
for captions and fine print, but it lands near 3.5:1 on Cream, and the app
has only ever had one dim tone (`--dim`). Two greys, both legible.

### Status (10)

| Status | Light canvases | Dark canvases |
|---|---|---|
| working | `#2f7d4f` | `#4fc27f` |
| needs-you | `#9c5a0c` | `#e2953c` |
| done | `#2b6cb0` | `#6aa9f0` |
| stopped | `#6c6a64` | `#a09d96` |
| error | `#b3261e` | `#f08a80` |

`needs-you` on light is `#9c5a0c` rather than a more obvious `#a8620f`
because the latter measures 4.51:1 on Cream — passing, but with no margin for
a later canvas tweak.

The commit graph's six lane colors (`web/style.css:150`) reuse status where
they can and keep their two extras (`#9d7bff`, `#22b3a4`) as two more
light/dark pairs. The comment there is right that the app should keep one set
of colors, not two.

## Type

Copernicus and StyreneB are licensed and unavailable. **EB Garamond** takes
the display role at weight 500 — not 400, which is too light on screen for
the weight Copernicus carries — with `-0.02em` tracking. **Inter** takes body
and UI. Both ship as variable woff2.

| Role | Today | Becomes |
|---|---|---|
| `#grid-empty`, usage headline | 15px | 28px Garamond 500, `-0.3px` |
| `#session h2`, `#new h2`, `#del h2`, `#when-dialog h2` | 16.8px 700 sans | 22px Garamond 500 |
| `#panel h3`, `.branch` | 15px 700 sans | 18px Garamond 500 |
| body, `#brand`, buttons | 15px | 16px Inter 400 / 500 |
| `.meta`, `.wt`, `.hint` | 13.5px | 14px |
| `.field > label` | 12.8px 600, `.04em` | 12px 500, `1.5px` |

JetBrains Mono is out. Commit hashes (`.hash`), repo paths
(`.repo-path`), and tool output (`.msg.tool`) keep `ui-monospace` — a third
face for three selectors is not worth another ~80KB on a localhost tool.

`.branch` renders slash-separated identifiers in the serif. It reads
correctly, but it is the one type decision in this document that is a matter
of taste rather than measurement; moving it to mono is a one-token change if
it starts looking like costume.

### Serving the fonts

`src/server.ts:851` serves an exact-match allowlist of four filenames and
deliberately never joins a user-controlled path segment. The two font files
therefore sit **flat in `web/`**, not in `web/fonts/`, and are added as two
more literal entries. `MIME` (`src/server.ts:84`) gains
`'.woff2': 'font/woff2'`. The allowlist stays exact-match, so the property
that comment protects is unchanged.

`font-display: swap`. No `unicode-range` — these are Latin subsets already.

## Shape and density

Radii adopt the 4 / 6 / 8 / 12 / 16 / 999 hierarchy: cards 14 → 12, dialogs
14 → 16, menus and combo lists 10 → 12, buttons stay 8, pills stay 999.

Spacing adopts the 4px scale: body padding 24 → 32, grid gap 16 → 24, card
padding 16 → **24**. Not 32. A 260px session tile is the analogue of the
source system's connector tile and code-window card, both of which are 24;
32 is the feature-card value and would leave under 200px of content in a
minimum-width column.

The cost, stated plainly: `#grid` goes from `minmax(260px, 1fr)` to
`minmax(300px, 1fr)` to hold the larger type and padding. On a 1440px window
that is four cards per row where five fit today. This was accepted
deliberately, not overlooked.

### The measured value that will silently break

`--bar-h: 3.476rem` (`web/style.css:12`) is measured, not assumed, and both
`#selection-bar` and `#session-sticky` stick to it. Growing `#bar`'s padding
and font size invalidates it, and the failure mode is a few pixels of overlap
rather than an error — nothing throws, nothing logs, and it is easy to ship.
It gets re-measured in the browser and written back as an explicit step.

## Storage and application

The choice lives in `localStorage` under `switchboard.theme`, as
`{"accent":"coral","canvas":"ink"}`. Not in the `settings` block: theme is the
one preference with no server-side consumer, and routing it through SSE means
the page paints in the default and repaints once the connection lands. It is
also independent of the settings dialog, which is still in flight on
`worktree-settings`.

A five-line inline `<script>` in `<head>`, above the stylesheet link, reads
the key and sets `data-accent` and `data-canvas` on `<html>`. Inline because
an external file is a second request that can lose the race with first paint.
It is the only inline script in `index.html`. `:root` carries the defaults, so
a browser with JS broken still gets a complete theme.

**Defaults are Ink and Coral.** Not Void — Void exists for people who want
today's cool dark, but the shipped default is the warm one, because that is
the point of the change. This means `+ New`, `Create`, and `Resume` stop
being green.

## The picker

A `#theme-btn` in `#bar` beside `+ New`, showing the current accent as a
filled dot. It opens a `.menu` — the class the `⋯` overflow menus already
use, closed by the same outside-click handler at `web/app.js:516`. Inside: a
row of eight accent swatches, then four canvas rows.

Clicking applies immediately and writes `localStorage`. No Save, no Cancel:
the feedback is the entire page, and undo is one more click.

One change is needed in the existing machinery. `menuFor` (`web/app.js:402`)
holds a session id, and the outside-click closer is guarded on it. It grows a
`'theme'` sentinel rather than acquiring a second parallel closer — otherwise
a session menu and the theme menu can be open simultaneously, which is
exactly the stale-node class of bug the comment at `web/app.js:411` records
having already been fixed once.

## What is out

- **A custom hex field.** Eight curated accents, no escape hatch. Contrast
  cannot be guaranteed on a pasted value, and the alternative is either
  shipping an illegible theme or building a live contrast check for a
  preference nobody has asked to exceed.
- **Following `prefers-color-scheme`.** An explicit four-way choice already
  covers "I want light"; an Auto mode adds a fifth state whose value is a
  strict subset of the four.
- **Per-canvas status tuning.** Two sets, not four. Cream and Paper differ by
  0.02 in luminance; a separate set for each is four more colors to verify
  for a difference nothing can see.
- **Theming the commit graph's lane assignment.** The lanes take the themed
  status colors; which lane gets which color is unchanged.
- **Syncing the theme across browsers.** It is per-browser, like every other
  browser-local preference. Moving it into `state.json` later is a small
  change if two machines ever disagree annoyingly.

## Testing

Two tests, in the existing offline suite, no new fixtures.

**`readTheme(raw)` in `web/lib.js`.** `null`, malformed JSON, an unknown
accent name, and a half-filled object all fall back to defaults; a valid pair
passes through. `localStorage` is user-editable and this value is read before
any stylesheet applies, so an unvalidated one produces an unstyled page.
`lib.js` is where browser logic that has tests already lives
(`test/ui.test.ts`).

**A palette contrast test.** It parses `web/style.css` for the
`[data-accent=…]` and `[data-canvas=…]` blocks and asserts, across all
thirty-two combinations:

- `--accent-deep` against white ≥ 4.5 (button labels)
- `--accent-deep` against each light `--canvas` ≥ 4.5 (links)
- `--accent-lift` against each dark `--canvas` ≥ 4.5 (links)
- `--accent-line` against each `--canvas` ≥ 3.0 (focus rings, borders)
- `--body` and `--muted` against their `--canvas` ≥ 4.5
- each status color against its canvases ≥ 4.5

About thirty lines including the WCAG relative-luminance function. This is
the check that catches the actual failure mode of the whole change — a theme
nobody can read — and it is the reason every value in the palette is a
literal hex rather than a `color-mix()`. `color-mix` would have collapsed the
accent table from 24 values to 8, but nothing in Node can resolve it, so the
guarantee would have rested on someone remembering to look.

## Not in this change

Per-session theming, a theme that follows the account, and any surface that
is not the existing app chrome. The picker sets two attributes on `<html>`
and that is the entire mechanism; anything scoped narrower than the document
is a different design.
