import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './i18n';
import './index.css';
import * as serviceWorkerRegistration from './serviceWorkerRegistration';
import { createTheme, ThemeProvider } from '@mui/material';

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
  document.getElementById('root') as HTMLElement
);

root.render(
  <ThemeProvider theme={theme}>
    <App />
  </ThemeProvider>
);

if (process.env.REACT_APP_TARGET === 'SINGLE_PAGE_APPLICATION') {
  serviceWorkerRegistration.register();
} else {
  serviceWorkerRegistration.unregister();
}
