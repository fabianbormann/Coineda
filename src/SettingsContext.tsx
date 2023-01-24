import { createContext } from 'react';
import { ApplicationSettings, CoinedaSettings } from './global/types';

const defaultSettings = {
  backendUrl: 'http://localhost:5208',
  account: {
    id: 1,
    name: 'Coineda',
    pattern: 0,
  },
};

const applicationSettings: ApplicationSettings = {
  settings: defaultSettings,
  setSettings: () => {},
};

const SettingsContext = createContext<ApplicationSettings>(applicationSettings);
export { SettingsContext, defaultSettings };
