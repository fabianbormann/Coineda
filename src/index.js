import React from 'react';
import ReactDOM from 'react-dom';
import App from './App';
import './i18n';
import 'antd/dist/antd.less';
import './index.css';
import * as serviceWorkerRegistration from './serviceWorkerRegistration';

ReactDOM.render(<App />, document.getElementById('root'));

if (process.env.REACT_APP_TARGET === 'single-page-application') {
  serviceWorkerRegistration.register();
} else {
  serviceWorkerRegistration.unregister();
}
