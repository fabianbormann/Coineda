import ReactDOM from 'react-dom/client';
import App from './App';
import './i18n';
import './index.css';
import { registerSW } from 'virtual:pwa-register';

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement,
);

// App.tsx owns ThemeProvider itself now that MUI (and the bridge this file
// used to need) is gone, so this just renders it directly.
root.render(<App />);

// Only register the service worker over http/https. Production Electron
// serves the build over the privileged `coineda://` scheme (registered as
// secure/standard, so it is a valid SW origin) - but the app there is
// already local, so a service worker would add nothing except a second,
// harder-to-clear cache layer in front of it.
if (location.protocol === 'http:' || location.protocol === 'https:') {
  registerSW({ immediate: true });
}
