import { createContext } from 'react';
import { ApplicationSettings } from './global/types';

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
  setSettings: Function,
};

const SettingsContext = createContext<ApplicationSettings>(applicationSettings);
export { SettingsContext, defaultSettings };
