import { createContext } from 'react';

const settings = {
  backendUrl: 'http://localhost:5208',
  account: {
    id: 1,
    name: 'Coineda',
    pattern: 'DEFAULT7',
  },
};

const SettingsContext = createContext([settings, () => {}]);
export { SettingsContext, settings as defaultSettings };
