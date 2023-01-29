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
