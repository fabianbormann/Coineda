/**
 * The browser chrome's colour (`<meta name="theme-color">`), per theme.
 *
 * Android Chrome paints its address bar in this colour, and it was still
 * the green of the old brand - a green bar over Lumen's grey-white header.
 * These are the header's own colour, so the address bar and the app's
 * header read as one surface: `glass-chrome` on a phone is the page base
 * (`--lm-bg`) with the glass-1 film over it, worked out here because a
 * meta tag cannot read a CSS variable.
 *
 *   light: #f2f3f7 under rgb(255 255 255 / 0.35) -> #f7f7fa
 *   dark:  #0b0c10 under rgb(255 255 255 / 0.05) -> #17181c
 *
 * Keep in sync with public/theme-init.js (which sets it before first paint),
 * index.html and the manifest in vite.config.ts.
 */
export const THEME_COLORS = { light: '#f7f7fa', dark: '#17181c' } as const;

/** Points every theme-color meta at the resolved theme, whatever its
 *  `media`: a theme chosen in the app overrides the system's. */
export const applyThemeColor = (resolved: 'light' | 'dark'): void => {
  document
    .querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
    .forEach((meta) => {
      meta.content = THEME_COLORS[resolved];
    });
};
