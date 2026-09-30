import { useMemo } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './i18n';
import './index.css';
import { createTheme, ThemeProvider } from '@mui/material';
import {
  ThemeProvider as CoinedaThemeProvider,
  useTheme,
} from '@/components/theme/ThemeProvider';
import { registerSW } from 'virtual:pwa-register';

const sharedPalette = {
  secondary: {
    main: '#0079d2',
    light: '#5da7ff',
    dark: '#004ea0',
  },
  error: { light: '#FFAA98', main: '#E5796A', dark: '#9A382F' },
  warning: { light: '#F9C842', main: '#F0C039', dark: '#906D00' },
  info: { light: '#5DA3CD', main: '#0088A3', dark: '#00486D' },
  success: { light: '#69C784', main: '#00B389', dark: '#006D49' },
};

/**
 * Bridges the Tailwind/shadcn token theme (`CoinedaThemeProvider`) into
 * MUI's own theme. This exists only because MUI still coexists with the
 * Tailwind shell - the five page bodies under src/pages/ are still MUI
 * (Phase 2b rewrites them, Phase 2c deletes MUI and this bridge with it).
 *
 * Without `palette.mode` MUI defaults to light-mode text/background colors
 * regardless of the `dark` class Tailwind is applying to <html>, which
 * makes MUI components that set (rather than inherit) color unreadable
 * against the dark token background.
 */
const MuiThemeBridge = ({ children }: { children: React.ReactNode }) => {
  const { resolved } = useTheme();

  const theme = useMemo(
    () =>
      createTheme({
        palette: {
          mode: resolved,
          primary:
            resolved === 'dark'
              ? {
                  // sRGB hex equivalent of the token layer's dark
                  // `--primary` (oklch(0.765 0.177 163.2)) - MUI's palette
                  // parser does not accept oklch(). Without this, MUI's
                  // text Buttons keep the light-mode navy primary, which is
                  // low-contrast against MUI's own dark Paper background.
                  main: '#00d492',
                  light: '#5889f1',
                  dark: '#00358d',
                }
              : {
                  main: '#172242',
                  light: '#5889f1',
                  dark: '#00358d',
                },
          ...sharedPalette,
        },
        typography: {
          fontFamily: [
            'Inter Variable',
            'ui-sans-serif',
            'system-ui',
            'sans-serif',
          ].join(','),
        },
      }),
    [resolved],
  );

  return <ThemeProvider theme={theme}>{children}</ThemeProvider>;
};

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement,
);

root.render(
  <CoinedaThemeProvider>
    <MuiThemeBridge>
      <App />
    </MuiThemeBridge>
  </CoinedaThemeProvider>,
);

// Only register the service worker over http/https. Production Electron
// serves the build over the privileged `coineda://` scheme (registered as
// secure/standard, so it is a valid SW origin) - but the app there is
// already local, so a service worker would add nothing except a second,
// harder-to-clear cache layer in front of it.
if (location.protocol === 'http:' || location.protocol === 'https:') {
  registerSW({ immediate: true });
}
