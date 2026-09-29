import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './i18n';
import './index.css';
import { createTheme, ThemeProvider } from '@mui/material';
import { registerSW } from 'virtual:pwa-register';

const theme = createTheme({
  palette: {
    primary: {
      main: '#172242',
      light: '#5889f1',
      dark: '#00358d',
    },
    secondary: {
      main: '#0079d2',
      light: '#5da7ff',
      dark: '#004ea0',
    },
    error: { light: '#FFAA98', main: '#E5796A', dark: '#9A382F' },
    warning: { light: '#F9C842', main: '#F0C039', dark: '#906D00' },
    info: { light: '#5DA3CD', main: '#0088A3', dark: '#00486D' },
    success: { light: '#69C784', main: '#00B389', dark: '#006D49' },
  },
  typography: {
    fontFamily: ['PTSerif', 'serif'].join(','),
  },
});

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement,
);

root.render(
  <ThemeProvider theme={theme}>
    <App />
  </ThemeProvider>,
);

// Only register the service worker over http/https. Production Electron
// serves the build over the privileged `coineda://` scheme (registered as
// secure/standard, so it is a valid SW origin) - but the app there is
// already local, so a service worker would add nothing except a second,
// harder-to-clear cache layer in front of it.
if (location.protocol === 'http:' || location.protocol === 'https:') {
  registerSW({ immediate: true });
}
