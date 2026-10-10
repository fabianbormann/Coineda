import { useEffect, useState } from 'react';
import { HashRouter, Route, Routes } from 'react-router-dom';
import { ThemeProvider } from '@/components/theme/ThemeProvider';
import { ConfirmProvider } from '@/components/confirm/ConfirmProvider';
import { AppShell } from '@/components/layout/AppShell';
import { Toaster } from '@/components/ui/sonner';
import { Skeleton } from '@/components/ui/skeleton';
import { OnboardingFlow } from '@/onboarding/OnboardingFlow';
import { MainScreen } from '@/screens/MainScreen';
import { TaxReportScreen } from '@/screens/TaxReportScreen';
import { isOnboarded } from '@/settings/settingsStore';
import { setActiveLedger } from '@/ledger/db';
import { ClientProvider, useClient } from '@/clients/ClientContext';
import {
  activeClient,
  setActiveClient,
  type ClientRecord,
} from '@/clients/registry';

type OnboardState = 'checking' | 'pending' | 'onboarded';

/**
 * Gates the whole app on `isOnboarded()`. Three states, not two: while the
 * IndexedDB read is in flight there is deliberately no shell and no
 * onboarding flow, only a Skeleton - rendering either of those optimistically
 * would flash it and then immediately swap to the other for every single
 * load, onboarded or not.
 */
const Gate = () => {
  const { client } = useClient();
  const [state, setState] = useState<OnboardState>('checking');

  useEffect(() => {
    let active = true;
    // The switch must land before the first read: isOnboarded() goes to
    // whichever database is active when it runs.
    void setActiveLedger(client.dbName)
      .then(() => isOnboarded())
      .then((done) => {
        if (active) {
          setState(done ? 'onboarded' : 'pending');
        }
      });
    return () => {
      active = false;
    };
  }, [client.dbName]);

  if (state === 'checking') {
    return (
      <ThemeProvider>
        <div className="flex min-h-svh items-center justify-center p-6">
          <Skeleton className="h-48 w-full max-w-md" />
        </div>
      </ThemeProvider>
    );
  }

  if (state === 'pending') {
    return (
      <ThemeProvider>
        <OnboardingFlow onComplete={() => setState('onboarded')} />
        <Toaster />
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider>
      <ConfirmProvider>
        <HashRouter>
          <AppShell>
            <Routes>
              <Route
                path="/"
                element={
                  /* The gate this component owns is also the way back from
                     a reset: an emptied ledger has no `onboarded` flag any
                     more, so the app has to show onboarding again - and
                     flipping the state here does it without a page
                     reload. */
                  <MainScreen onReset={() => setState('pending')} />
                }
              />
              {/* Its own route rather than a dialog over the overview. A
                  report is a long, wide document, and a dialog gave it
                  672px with the rest clipped behind a horizontal
                  scrollbar. A route also means the back button leaves the
                  report, and a run in progress is torn down by the unmount
                  rather than by a prop. */}
              <Route path="/tax" element={<TaxReportScreen />} />
            </Routes>
          </AppShell>
        </HashRouter>
        <Toaster />
      </ConfirmProvider>
    </ThemeProvider>
  );
};

/**
 * The provider is keyed on the client id, so picking another client remounts
 * the gate and the router: onboarding is re-checked against the new
 * database and no screen keeps state read from the previous one.
 */
const App = () => {
  const [client, setClient] = useState<ClientRecord>(() => activeClient());
  const switchTo = async (id: string) => {
    await setActiveClient(id);
    setClient(activeClient());
  };
  return (
    <ClientProvider key={client.id} client={client} onChange={switchTo}>
      <Gate />
    </ClientProvider>
  );
};

export default App;
