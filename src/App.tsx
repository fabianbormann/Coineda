import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
import { setActiveLedger, setLedgerReadOnly } from '@/ledger/db';
import { notify } from '@/lib/notify';
import { ClientProvider, useClient } from '@/clients/ClientContext';
import {
  activeClient,
  listClients,
  removeClient,
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
  const { client, switchTo } = useClient();
  const { t } = useTranslation();
  const [state, setState] = useState<OnboardState>('checking');

  useEffect(() => {
    let active = true;
    const isReview = client.kind === 'review';
    // A review entry over a database that never finished restoring (a tab
    // closed mid-restore, a failed rollback). Onboarding there would write
    // into a ledger meant to be read-only, so it is dropped and a real
    // client takes over.
    const dropIncompleteReview = async () => {
      await removeClient(client.id);
      notify.warning(
        t('The review ledger was incomplete and has been removed.'),
      );
      const next = listClients().find((c) => c.kind === 'client');
      if (next) await switchTo(next.id);
    };
    // The switch must land before the first read: isOnboarded() goes to
    // whichever database is active when it runs.
    void setActiveLedger(client.dbName)
      .then(() => {
        // setActiveLedger clears the flag; a review stays read-only at the
        // store, not only in the screens.
        setLedgerReadOnly(isReview);
        return isOnboarded();
      })
      .then((done) => {
        if (!active) return;
        if (!done && isReview) return dropIncompleteReview();
        setState(done ? 'onboarded' : 'pending');
      })
      .catch((error: unknown) => {
        console.error(error);
        if (!active) return;
        if (isReview) {
          void dropIncompleteReview().catch(console.error);
          return;
        }
        // Never leave the app on the skeleton: onboarding is the safe
        // fallback, and it can be retried from there.
        setState('pending');
      });
    return () => {
      active = false;
    };
  }, [client.dbName, client.id, client.kind, switchTo, t]);

  if (state === 'checking') {
    return (
      <div className="flex min-h-svh items-center justify-center p-6">
        <Skeleton className="h-48 w-full max-w-md" />
      </div>
    );
  }

  if (state === 'pending') {
    return <OnboardingFlow onComplete={() => setState('onboarded')} />;
  }

  return (
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
    </ConfirmProvider>
  );
};

/**
 * The provider is keyed on the client id, so picking another client remounts
 * the gate and the router: onboarding is re-checked against the new
 * database and no screen keeps state read from the previous one.
 */
const App = () => {
  const [client, setClient] = useState<ClientRecord>(() => activeClient());
  // Stable, so the gate's effect does not re-run on every render.
  const switchTo = useCallback(async (id: string) => {
    await setActiveClient(id);
    setClient(activeClient());
  }, []);
  // Theme and Toaster sit outside the keyed provider, so they survive a
  // client switch: a notice raised while switching (the gate dropping an
  // incomplete review) still has a Toaster to land in.
  return (
    <ThemeProvider>
      <ClientProvider key={client.id} client={client} onChange={switchTo}>
        <Gate />
      </ClientProvider>
      <Toaster />
    </ThemeProvider>
  );
};

export default App;
