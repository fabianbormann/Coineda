import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './i18n';
import './index.css';
import * as serviceWorkerRegistration from './serviceWorkerRegistration';

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);

root.render(<App />);

if (process.env.REACT_APP_TARGET === 'SINGLE_PAGE_APPLICATION') {
  serviceWorkerRegistration.register();
} else {
  serviceWorkerRegistration.unregister();
}
