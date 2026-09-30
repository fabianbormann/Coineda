import { useState, useContext, useEffect } from 'react';
import { HashRouter as Router, Routes, Route } from 'react-router-dom';
import { Dashboard, Tracking, TaxReports, Settings, Wallets } from './pages';
import { SettingsContext, defaultSettings } from './SettingsContext';
import storage from './persistence/storage';
import Footer from './components/Footer';
import { AppShell } from '@/components/layout/AppShell';
import { CoinedaAccount, CoinedaSettings } from './global/types';

const Main = () => {
  const { setSettings } = useContext(SettingsContext);

  useEffect(() => {
    storage.accounts.getAll().then((accounts: Array<CoinedaAccount>) => {
      if (accounts.length === 0) {
        accounts = [{ id: 1, name: 'Coineda', pattern: 0 }];
        storage.accounts.add(accounts[0].name, accounts[0].pattern);
      }

      const activeAccount = localStorage.getItem('activeAccount');
      let selectedAccount = accounts[0];

      if (typeof activeAccount !== 'undefined') {
        selectedAccount =
          accounts.find((account) => account.name === activeAccount) ||
          selectedAccount;
      }

      setSettings(
        (previousSettings: CoinedaSettings) =>
          ({
            ...previousSettings,
            account: selectedAccount,
          }) as CoinedaSettings,
      );
    });
  }, [setSettings]);

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/tracking/*" element={<Tracking />} />
        <Route path="/reports/*" element={<TaxReports />} />
        <Route path="/wallets/*" element={<Wallets />} />
        <Route path="/settings/*" element={<Settings />} />
      </Routes>
      <Footer />
    </AppShell>
  );
};

const App = () => {
  const [settings, setSettings] = useState<CoinedaSettings>(defaultSettings);

  return (
    <SettingsContext.Provider value={{ settings, setSettings }}>
      <Router>
        <Main />
      </Router>
    </SettingsContext.Provider>
  );
};

export default App;
