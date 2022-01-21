import React from 'react';
import App from '../App';
import {webViewRender} from 'react-native-react-bridge/lib/web';

const WebApp = () => {
  return <App />;
};

export default webViewRender(<WebApp />);
