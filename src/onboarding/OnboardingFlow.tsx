import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { StartFresh } from './StartFresh';
import { ImportCheckpoint } from './ImportCheckpoint';

type Screen = 'choice' | 'fresh' | 'import';

/**
 * The very first thing a new install shows. There is no backend and no
 * server-side copy of anything, so this is also the ONLY place
 * `restoreCheckpoint` is ever reachable from - see the module doc on
 * `restoreCheckpoint` in src/checkpoint/format.ts for why that matters:
 * it writes with a plain `put`, not an identity-based upsert, which is
 * only safe onto an empty ledger. `App.tsx` gates on `isOnboarded()` so
 * this component is never rendered again once onboarding completes.
 */
export const OnboardingFlow = ({ onComplete }: { onComplete: () => void }) => {
  const { t } = useTranslation();
  const [screen, setScreen] = useState<Screen>('choice');

  const content = (() => {
    switch (screen) {
      case 'fresh':
        return (
          <StartFresh
            onComplete={onComplete}
            onBack={() => setScreen('choice')}
          />
        );
      case 'import':
        return (
          <ImportCheckpoint
            onComplete={onComplete}
            onBack={() => setScreen('choice')}
          />
        );
      default:
        return (
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle>{t('Welcome to Coineda')}</CardTitle>
              <CardDescription>
                {t(
                  'Set up this device by restoring a checkpoint from another one, or start fresh.',
                )}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Button type="button" onClick={() => setScreen('fresh')}>
                {t('Start fresh')}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setScreen('import')}
              >
                {t('I have a checkpoint')}
              </Button>
            </CardContent>
          </Card>
        );
    }
  })();

  return (
    <div className="relative flex min-h-svh w-full items-center justify-center p-6">
      {/* Top right, where the shell keeps it once onboarding is done - this
          is the only screen the shell does not wrap, so without it here
          the very first thing a dark-mode user sees is the one screen they
          cannot change. */}
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      {content}
    </div>
  );
};
