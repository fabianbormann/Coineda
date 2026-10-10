# Accessibility

Coineda targets **WCAG 2.1 level AA**, which is what BITV 2.0 requires. This page records how
that is checked; it is not a certificate.

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
| light | Destructive text on page | `--destructive` | `--background` | 4.65:1 | 4.5:1 | pass |
| light | Destructive text on card | `--destructive` | `--background` + `--card` | 4.92:1 | 4.5:1 | pass |
| light | White text on destructive button | `white` | `--background` + `--destructive` | 5.15:1 | 4.5:1 | pass |
| light | Gain on page | `--gain` | `--background` | 4.55:1 | 4.5:1 | pass |
| light | Loss on page | `--loss` | `--background` | 5.52:1 | 4.5:1 | pass |
| light | Gain on card | `--gain` | `--background` + `--card` | 4.81:1 | 4.5:1 | pass |
| light | Loss on card | `--loss` | `--background` + `--card` | 5.84:1 | 4.5:1 | pass |
| light | Primary button text on primary | `--primary-foreground` | `--background` + `--primary` | 10.25:1 | 4.5:1 | pass |
| light | Focus ring on page | `--ring` | `--background` | 3.83:1 | 3.0:1 | pass |
| light | Input border on page | `--input` | `--background` | 3.41:1 | 3.0:1 | pass |
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
| dark | Focus ring on page | `--ring` | `--background` | 8.91:1 | 3.0:1 | pass |
| dark | Input border on page | `--input` | `--background` | 3.55:1 | 3.0:1 | pass |

### Method

- **Ratio.** WCAG 2.x relative luminance (sRGB channels linearised, `0.2126 R + 0.7152 G +
  0.0722 B`) and `(L1 + 0.05) / (L2 + 0.05)`. Ratios are compared unrounded: 4.49:1 fails 4.5:1.
- **Thresholds.** 4.5:1 for text (1.4.3), 3:1 for the focus ring and for the input border, which
  is the only visible boundary an input or select has (1.4.11).
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

- **The backdrop wash.** `lumen-backdrop` paints soft radial blobs of Lumen's spectrum behind the
  page. They are decorative, vary across the viewport and fade to the plain background, so they are
  not in the table. At a blob's centre in light mode the coloured text sits lower than the table
  shows (gain about 3.4-3.6:1, destructive about 3.5-3.7:1, ring about 2.9-3.1:1, muted text stays
  above 6:1); most such text sits on a card, which lifts it again. Worth checking by eye when the
  backdrop changes.
- **The focus halo.** Buttons show focus as the 3px `ring-ring/50` halo; inputs and selects also
  turn their border to `--ring`, which is what the table measures.

### Token changes made for this table

| Token | Theme | Before | After | Pair | Ratio before -> after |
| --- | --- | --- | --- | --- | --- |
| `--lm-stroke` (`--input`) | light | `rgb(18 19 24 / 0.3)` | `rgb(18 19 24 / 0.5)` | Input border on page | 1.96:1 -> 3.41:1 |
| `--lm-stroke` (`--input`) | dark | `rgb(243 244 248 / 0.32)` | `rgb(243 244 248 / 0.4)` | Input border on page | 2.68:1 -> 3.55:1 |
| `--ring` | light | `var(--lm-g2)` = `oklch(0.73 0.22 278)` | `oklch(0.6 0.22 278)` | Focus ring on page | 2.48:1 -> 3.83:1 |
| `--ring` | dark | `var(--lm-g2)` | `var(--lm-g2)` (restated in `.dark`) | Focus ring on page | 8.91:1, unchanged |
| `--destructive` | light | `oklch(0.577 0.245 27.3)` | `oklch(0.55 0.245 27.3)` | Destructive text on page | 4.30:1 -> 4.65:1 |

Hues are unchanged; `--sidebar-ring` now follows `--ring`.
