import React from 'react';
import WebView from 'react-native-webview';
import WebApp from './WebApp';

import {webViewRender} from 'react-native-react-bridge/lib/web';

const Main = () => {
  return <WebView source={{html: webViewRender(<WebApp />)}} />;
};

export default Main;
