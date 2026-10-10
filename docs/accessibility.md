# Accessibility

Coineda targets **WCAG 2.1 level AA**, which is what BITV 2.0 requires. This page records how
that is checked; it is not a certificate.

## What is in place

- **Language and page names.** `<html lang>` follows the chosen interface language; each route sets
  `document.title` and renders one `h1`.
- **Keyboard.** A "Skip to content" link is the first focusable element and targets
  `<main id="main">`; after a navigation (not on first load) focus moves to the new page's `h1`.
- **Forms.** One accessible name per control, a `legend` in every `fieldset`, required fields
  marked once, the file input outside the drop-zone button, and dialog headings below the `h2`
  that Radix gives `DialogTitle`.
- **Motion.** `prefers-reduced-motion: reduce` stops the rolling figures and the Tailwind
  enter/exit animations; the journey video has a pause button and a text alternative.
- **Announcements.** The balance sits in an `aria-live="polite"` region; sync progress and import
  results use the toast region.
- **Visible focus.** Every button, link, input, select and toggle chip draws a 2px `--ring`
  outline 2px off the control on `:focus-visible` (unlayered rules in `src/index.css`, so they win
  over the components' `outline-none`); the highlighted menu or select item inverts onto
  `--lm-highlight`, and a checked item that is not highlighted carries an inset `--ring` bar.
- **Toggle state.** Toggle buttons (the theme switch, the journey's Shareable / Full detail and
  pause, the CSV mapping's direction chips) always carry `aria-pressed="true"` or `"false"`.
- **Contrast.** Measured from the tokens, below, including coloured text over the page wash.

## The gate

`tests/axe.test.tsx` runs [axe-core](https://github.com/dequelabs/axe-core) over `document.body`
for every screen and dialog, with the WCAG 2.0 and 2.1 A and AA rules (tags `wcag2a`, `wcag2aa`,
`wcag21a`, `wcag21aa`), and fails on any violation, printing the rule id, its help text and the
first offending element. It is part of `npx vitest run`, so it runs in CI with everything else.

Each screen or dialog is a **recipe** in `tests/helpers/recipes.tsx`: a name and an async
`render()` that prepares a clean device (fake IndexedDB, English, stubbed `matchMedia` and
`fetch`), renders inside the providers that screen needs, opens the dialog it names and resolves
once the content is in the DOM. A second test lists `src/**/*Dialog.tsx` and fails if a file's
base name does not appear in some recipe's name.

**Adding a screen or dialog:** add a recipe whose name contains the component's name (for a
dialog, the file's base name, e.g. `FooDialog`), reusing the setup from that component's own test.
Wait for something only the finished state shows (a field in the open step, the result of a
run), not just the first paint, or axe scans a loading state. If axe then reports a violation, fix
it in the component; do not disable the rule.

**Rules that are off:**

- `color-contrast`: jsdom does no layout or painting, so axe cannot work out the colours it would
  compare. Contrast is covered by the measured table below and `tests/contrast.test.ts`.

Nothing else is disabled. axe also reports Radix's focus-guard `span`s (`aria-hidden` with
`tabindex="0"`) as "needs review" (`aria-hidden-focus`), not as a violation. They are how Radix
keeps focus inside an open dialog, and focus that lands on one is sent straight back in.

**What it cannot see:** anything that needs a real browser: rendered contrast, visible focus,
reflow at 400% zoom, text spacing, target size, and how a screen reader actually reads it all.
Before a procurement or a BITV declaration, have someone audit in a browser with a screen reader
(NVDA or VoiceOver) and the keyboard alone.

## Colour contrast

Measured **2026-10-10** from the tokens in `src/styles/lumen.css` and `src/index.css`, in both
themes. Regenerate with `npm run contrast`; `tests/contrast.test.ts` fails if any pair drops below
its threshold, and also fails if the table below no longer matches what the tokens produce.

| Theme | Pair | Foreground | Over | Ratio | Needs | Result |
| --- | --- | --- | --- | ---: | ---: | --- |
| light | Text on page | `--foreground` | `--background` | 16.73:1 | 4.5:1 | pass |
| light | Muted text on page | `--muted-foreground` | `--background` | 7.06:1 | 4.5:1 | pass |
| light | Muted text on glass-1 (inputs, chips) | `--muted-foreground` | `--background` + `--lm-glass-1` | 7.19:1 | 4.5:1 | pass |
| light | Placeholder on input field | `--muted-foreground` | `--background` + `--lm-glass-1` | 7.19:1 | 4.5:1 | pass |
| light | Muted text on card (glass-2) | `--muted-foreground` | `--background` + `--card` | 7.27:1 | 4.5:1 | pass |
| light | Muted text on popover (glass-3) | `--muted-foreground` | `--background` + `--popover` | 7.33:1 | 4.5:1 | pass |
| light | Destructive text on page | `--destructive` | `--background` | 5.88:1 | 4.5:1 | pass |
| light | Destructive text on card | `--destructive` | `--background` + `--card` | 6.22:1 | 4.5:1 | pass |
| light | White text on destructive button | `white` | `--background` + `--destructive` | 6.52:1 | 4.5:1 | pass |
| light | Gain on page | `--gain` | `--background` | 6.03:1 | 4.5:1 | pass |
| light | Loss on page | `--loss` | `--background` | 6.64:1 | 4.5:1 | pass |
| light | Gain on card | `--gain` | `--background` + `--card` | 6.38:1 | 4.5:1 | pass |
| light | Loss on card | `--loss` | `--background` + `--card` | 7.03:1 | 4.5:1 | pass |
| light | Primary button text on primary | `--primary-foreground` | `--background` + `--primary` | 10.25:1 | 4.5:1 | pass |
| light | Focus outline on page | `--ring` | `--background` | 3.83:1 | 3.0:1 | pass |
| light | Focus outline on card | `--ring` | `--background` + `--card` | 4.05:1 | 3.0:1 | pass |
| light | Focus outline on popover | `--ring` | `--background` + `--popover` | 4.13:1 | 3.0:1 | pass |
| light | Focus outline over the lilac wash | `--ring` | `--background` + `--lm-g2 / 0.55 * --lm-blob` | 3.04:1 | 3.0:1 | pass |
| light | Highlighted menu item on popover | `--lm-highlight` | `--background` + `--popover` | 10.67:1 | 3.0:1 | pass |
| light | Text on highlighted menu item | `--lm-on-highlight` | `--background` + `--popover` + `--lm-highlight` | 10.25:1 | 4.5:1 | pass |
| light | Highlighted destructive item on popover | `--lm-highlight-destructive` | `--background` + `--popover` | 6.33:1 | 3.0:1 | pass |
| light | Text on highlighted destructive item | `--lm-on-highlight-destructive` | `--background` + `--popover` + `--lm-highlight-destructive` | 6.52:1 | 4.5:1 | pass |
| light | Checked item marker on popover | `--ring` | `--background` + `--popover` | 4.13:1 | 3.0:1 | pass |
| light | Input border on page | `--input` | `--background` | 3.41:1 | 3.0:1 | pass |
| light | Gain over the seaglass wash | `--gain` | `--background` + `--lm-g1 / 0.6 * --lm-blob` | 5.02:1 | 4.5:1 | pass |
| light | Gain over the lilac wash | `--gain` | `--background` + `--lm-g2 / 0.55 * --lm-blob` | 4.79:1 | 4.5:1 | pass |
| light | Gain over the blush wash | `--gain` | `--background` + `--lm-g3 / 0.45 * --lm-blob` | 4.84:1 | 4.5:1 | pass |
| light | Loss over the seaglass wash | `--loss` | `--background` + `--lm-g1 / 0.6 * --lm-blob` | 5.53:1 | 4.5:1 | pass |
| light | Loss over the lilac wash | `--loss` | `--background` + `--lm-g2 / 0.55 * --lm-blob` | 5.28:1 | 4.5:1 | pass |
| light | Loss over the blush wash | `--loss` | `--background` + `--lm-g3 / 0.45 * --lm-blob` | 5.34:1 | 4.5:1 | pass |
| light | Destructive text over the seaglass wash | `--destructive` | `--background` + `--lm-g1 / 0.6 * --lm-blob` | 4.90:1 | 4.5:1 | pass |
| light | Destructive text over the lilac wash | `--destructive` | `--background` + `--lm-g2 / 0.55 * --lm-blob` | 4.67:1 | 4.5:1 | pass |
| light | Destructive text over the blush wash | `--destructive` | `--background` + `--lm-g3 / 0.45 * --lm-blob` | 4.72:1 | 4.5:1 | pass |
| dark | Text on page | `--foreground` | `--background` | 17.79:1 | 4.5:1 | pass |
| dark | Muted text on page | `--muted-foreground` | `--background` | 10.86:1 | 4.5:1 | pass |
| dark | Muted text on glass-1 (inputs, chips) | `--muted-foreground` | `--background` + `--lm-glass-1` | 10.13:1 | 4.5:1 | pass |
| dark | Placeholder on input field | `--muted-foreground` | `--background` + `--input / 0.3` | 8.74:1 | 4.5:1 | pass |
| dark | Muted text on card (glass-2) | `--muted-foreground` | `--background` + `--card` | 9.30:1 | 4.5:1 | pass |
| dark | Muted text on popover (glass-3) | `--muted-foreground` | `--background` + `--popover` | 8.15:1 | 4.5:1 | pass |
| dark | Destructive text on page | `--destructive` | `--background` | 6.76:1 | 4.5:1 | pass |
| dark | Destructive text on card | `--destructive` | `--background` + `--card` | 5.50:1 | 4.5:1 | pass |
| dark | White text on destructive button | `white` | `--background` + `--destructive / 0.6` | 6.41:1 | 4.5:1 | pass |
| dark | Gain on page | `--gain` | `--background` | 10.45:1 | 4.5:1 | pass |
| dark | Loss on page | `--loss` | `--background` | 7.00:1 | 4.5:1 | pass |
| dark | Gain on card | `--gain` | `--background` + `--card` | 8.51:1 | 4.5:1 | pass |
| dark | Loss on card | `--loss` | `--background` + `--card` | 5.70:1 | 4.5:1 | pass |
| dark | Primary button text on primary | `--primary-foreground` | `--background` + `--primary` | 16.48:1 | 4.5:1 | pass |
| dark | Focus outline on page | `--ring` | `--background` | 8.91:1 | 3.0:1 | pass |
| dark | Focus outline on card | `--ring` | `--background` + `--card` | 7.26:1 | 3.0:1 | pass |
| dark | Focus outline on popover | `--ring` | `--background` + `--popover` | 6.18:1 | 3.0:1 | pass |
| dark | Focus outline over the lilac wash | `--ring` | `--background` + `--lm-g2 / 0.55 * --lm-blob` | 6.82:1 | 3.0:1 | pass |
| dark | Highlighted menu item on popover | `--lm-highlight` | `--background` + `--popover` | 11.72:1 | 3.0:1 | pass |
| dark | Text on highlighted menu item | `--lm-on-highlight` | `--background` + `--popover` + `--lm-highlight` | 16.89:1 | 4.5:1 | pass |
| dark | Highlighted destructive item on popover | `--lm-highlight-destructive` | `--background` + `--popover` | 4.69:1 | 3.0:1 | pass |
| dark | Text on highlighted destructive item | `--lm-on-highlight-destructive` | `--background` + `--popover` + `--lm-highlight-destructive` | 6.13:1 | 4.5:1 | pass |
| dark | Checked item marker on popover | `--ring` | `--background` + `--popover` | 6.18:1 | 3.0:1 | pass |
| dark | Input border on page | `--input` | `--background` | 3.55:1 | 3.0:1 | pass |
| dark | Gain over the seaglass wash | `--gain` | `--background` + `--lm-g1 / 0.6 * --lm-blob` | 7.41:1 | 4.5:1 | pass |
| dark | Gain over the lilac wash | `--gain` | `--background` + `--lm-g2 / 0.55 * --lm-blob` | 7.99:1 | 4.5:1 | pass |
| dark | Gain over the blush wash | `--gain` | `--background` + `--lm-g3 / 0.45 * --lm-blob` | 8.49:1 | 4.5:1 | pass |
| dark | Loss over the seaglass wash | `--loss` | `--background` + `--lm-g1 / 0.6 * --lm-blob` | 4.97:1 | 4.5:1 | pass |
| dark | Loss over the lilac wash | `--loss` | `--background` + `--lm-g2 / 0.55 * --lm-blob` | 5.35:1 | 4.5:1 | pass |
| dark | Loss over the blush wash | `--loss` | `--background` + `--lm-g3 / 0.45 * --lm-blob` | 5.69:1 | 4.5:1 | pass |
| dark | Destructive text over the seaglass wash | `--destructive` | `--background` + `--lm-g1 / 0.6 * --lm-blob` | 4.80:1 | 4.5:1 | pass |
| dark | Destructive text over the lilac wash | `--destructive` | `--background` + `--lm-g2 / 0.55 * --lm-blob` | 5.17:1 | 4.5:1 | pass |
| dark | Destructive text over the blush wash | `--destructive` | `--background` + `--lm-g3 / 0.45 * --lm-blob` | 5.49:1 | 4.5:1 | pass |

### Method

- **Ratio.** WCAG 2.x relative luminance (sRGB channels linearised, `0.2126 R + 0.7152 G +
  0.0722 B`) and `(L1 + 0.05) / (L2 + 0.05)`. Ratios are compared unrounded: 4.49:1 fails 4.5:1.
- **Thresholds.** 4.5:1 for text (1.4.3), 3:1 for the focus outline, the highlighted menu item,
  the checked-item marker and the input border, which is the only visible boundary an input or
  select has (1.4.11).
- **The wash.** `lumen-backdrop` paints radial blobs of Lumen's spectrum behind the page. Each blob
  runs from `color-mix(in oklch, <blob> N%, transparent)` to transparent and the whole layer is
  drawn at `--lm-blob` opacity, so a blob's centre is measured as the blob colour at
  `N% * --lm-blob` over the page (written `--lm-g2 / 0.55 * --lm-blob` in the "Over" column).
  Gain, loss and destructive text are measured there because they also appear straight on the
  page, not only on cards.
- **Translucency.** Lumen's surfaces and its muted text are translucent. Every layer is
  alpha-composited, bottom first, over the theme's opaque page background (`--background`), and the
  foreground is composited over the result - the "Over" column lists the stack. Tailwind opacity
  modifiers such as `dark:bg-destructive/60` are measured as the token at that opacity.
- **Colour spaces.** `oklch()` is converted OKLCH -> OKLab -> linear sRGB -> sRGB with the CSS
  Color 4 matrices, clipping out-of-gamut channels to the sRGB cube (what an sRGB display shows).
  Hex, `rgb()`/`rgba()` in both syntaxes and `hsl()` are read directly.
- **Tokens.** The light theme is every `:root` rule; the dark theme is `:root` plus `.dark` in
  source order (both sit on `<html>` with equal specificity). `var()` references are resolved
  across both files. At-rules such as `@media print` are not part of either theme.
- **Code.** `src/a11y/contrastCore.mjs` (plain JavaScript, so the Node script and the test run
  the same maths), typed by `src/a11y/contrast.ts`; `scripts/contrast.mjs` prints the table.
- **Why not axe.** The jsdom axe gate runs with axe's `color-contrast` rule disabled: jsdom does no
  layout or painting, so axe cannot compute the colours it would compare. This table is what
  covers contrast.

### What it does not cover

- **Blob edges and overlaps.** The wash pairs measure each blob colour at its centre, at the
  strongest stop it is drawn with. Where two blobs overlap, the composite can sit slightly darker
  than either centre; the margins left above (4.67:1 at the tightest text pair, 3.04:1 for the
  focus outline) are what absorbs that, but a browser audit should still sample the top-left
  corner of a tall page in light mode.
- **The vendored focus halo.** Buttons, inputs and selects still draw shadcn's 3px `ring-ring/50`
  halo; it measures 1.87:1 (light) and 2.99:1 (dark) on the page, so it is not what satisfies
  1.4.11. The 2px `:focus-visible` outline in `src/index.css` is, and that is what the table
  measures as "Focus outline".

### Token changes made for this table

| Token | Theme | Before | After | Pair | Ratio before -> after |
| --- | --- | --- | --- | --- | --- |
| `--lm-stroke` (`--input`) | light | `rgb(18 19 24 / 0.3)` | `rgb(18 19 24 / 0.5)` | Input border on page | 1.96:1 -> 3.41:1 |
| `--lm-stroke` (`--input`) | dark | `rgb(243 244 248 / 0.32)` | `rgb(243 244 248 / 0.4)` | Input border on page | 2.68:1 -> 3.55:1 |
| `--ring` | light | `var(--lm-g2)` = `oklch(0.73 0.22 278)` | `oklch(0.6 0.22 278)` | Focus outline on page | 2.48:1 -> 3.83:1 |
| `--ring` | dark | `var(--lm-g2)` | `var(--lm-g2)` (restated in `.dark`) | Focus outline on page | 8.91:1, unchanged |
| `--destructive` | light | `oklch(0.577 0.245 27.3)` | `oklch(0.55 0.245 27.3)` | Destructive text on page | 4.30:1 -> 4.65:1 |
| `--destructive` | light | `oklch(0.55 0.245 27.3)` | `oklch(0.47 0.245 27.3)` | Destructive text over the lilac wash | 3.49:1 -> 4.67:1 |
| `--gain` | light | `oklch(0.52 0.13 163.2)` | `oklch(0.45 0.13 163.2)` | Gain over the lilac wash | 3.41:1 -> 4.79:1 |
| `--loss` | light | `oklch(0.52 0.2 25.3)` | `oklch(0.47 0.2 25.3)` | Loss over the lilac wash | 4.14:1 -> 5.28:1 |
| `--lm-blob` | light | `0.62` | `0.5` | (all wash pairs) | part of the three rows above |
| `--lm-blob` | dark | `0.35` | `0.3` | Destructive text over the seaglass wash | 4.44:1 -> 4.80:1 |
| `--lm-highlight` (new) | both | `bg-accent` = glass-2 | `var(--lm-fill)` | Highlighted menu item on popover | 1.02:1 -> 10.67:1 (light), 1.33:1 -> 11.72:1 (dark) |

Hues are unchanged; `--sidebar-ring` now follows `--ring`.
