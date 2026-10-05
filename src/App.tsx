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

type OnboardState = 'checking' | 'pending' | 'onboarded';

/**
 * Gates the whole app on `isOnboarded()`. Three states, not two: while the
 * IndexedDB read is in flight there is deliberately no shell and no
 * onboarding flow, only a Skeleton - rendering either of those optimistically
 * would flash it and then immediately swap to the other for every single
 * load, onboarded or not.
 */
const App = () => {
  const [state, setState] = useState<OnboardState>('checking');

  useEffect(() => {
    let active = true;
    void isOnboarded().then((done) => {
      if (active) {
        setState(done ? 'onboarded' : 'pending');
      }
    });
    return () => {
      active = false;
    };
  }, []);

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
              <Route path="/" element={<MainScreen />} />
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

export default App;
