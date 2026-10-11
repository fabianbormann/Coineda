import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DownloadIcon, ShareIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { INSTALL_DISMISSED_KEY, useInstallOffer } from './installPrompt';

const readDismissed = (): boolean => {
  try {
    return localStorage.getItem(INSTALL_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
};

/**
 * The app's own install offer, on the overview.
 *
 * Shown only where installing is possible and has not happened: in a
 * Chromium browser that has offered the app (see installPrompt.ts), and in
 * Safari on iOS, where it explains the Share-sheet route because no
 * dialog exists. "Not now" is remembered on this device - an offer that
 * comes back on every visit would be nagging - and the browser's own
 * install menu entry stays available regardless.
 */
export const InstallAppCard = () => {
  const { t } = useTranslation();
  const offer = useInstallOffer();
  const [dismissed, setDismissed] = useState(readDismissed);

  if (offer.kind === 'none' || dismissed) {
    return null;
  }

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(INSTALL_DISMISSED_KEY, '1');
    } catch {
      // still hidden for this session
    }
  };

  return (
    <Card data-testid="install-app">
      <CardContent className="flex flex-col gap-3 text-sm">
        <div className="flex flex-col gap-1">
          <h2 className="font-semibold">{t('Install Coineda')}</h2>
          <p className="text-muted-foreground">
            {offer.kind === 'prompt'
              ? t(
                  'Install Coineda on this device: it opens like any other app and works offline.',
                )
              : t(
                  'To install Coineda, tap Share in Safari, then “Add to Home Screen”. It then opens like any other app and works offline.',
                )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {offer.kind === 'prompt' ? (
            <Button type="button" onClick={() => void offer.install()}>
              <DownloadIcon aria-hidden="true" />
              {t('Install')}
            </Button>
          ) : (
            <ShareIcon
              className="size-5 self-center text-muted-foreground"
              aria-hidden="true"
            />
          )}
          <Button type="button" variant="ghost" onClick={dismiss}>
            {t('Not now')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};
