// Applied before first paint so a returning user never sees a flash of
// the wrong theme. Mirrors ThemeProvider's resolution order; keep the
// storage key in sync with THEME_STORAGE_KEY.
(function () {
  try {
    var stored = localStorage.getItem('coineda.theme');
    // Anything other than an explicit 'light' or 'dark' - including
    // 'system', nothing stored, and a corrupted/unrecognised value -
    // follows the OS, matching ThemeProvider.readStoredTheme's
    // fallback to 'system'.
    var dark =
      stored === 'dark' ||
      (stored !== 'light' &&
        stored !== 'dark' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (dark) document.documentElement.classList.add('dark');
  } catch {
    // no stored preference available - leave the default light theme
  }
})();
