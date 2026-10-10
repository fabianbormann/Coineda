import { useTranslation } from 'react-i18next';
import { APP_VERSION } from '@/global/version';
import { ExternalLink } from '@/components/ExternalLink';
import { AppHeader } from './AppHeader';

/**
 * The shell: a header, the page, and a footer.
 *
 * There is deliberately no sidebar. One existed through milestone 1 as a
 * placeholder, but the navigation it was built for went with the deleted
 * routing layer, so it rendered an empty panel and a toggle that revealed
 * nothing - which reads as a broken app rather than an unfinished one.
 * Re-adding a shadcn sidebar is cheap once there are routes to put in it;
 * until then its collapse state, its localStorage persistence and its
 * header trigger were all machinery serving nothing.
 *
 * The version and licence links were the sidebar's only real content, so
 * they moved here rather than being lost with it.
 */
export const AppShell = ({ children }: { children: React.ReactNode }) => {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-svh flex-col">
      {/* HashRouter owns the hash, so a plain #main href would navigate
          away; focus the landmark programmatically instead. */}
      <a
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('main')?.focus();
        }}
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:ring-2 focus:ring-ring"
      >
        {t('Skip to content')}
      </a>
      <AppHeader />
      <main
        id="main"
        tabIndex={-1}
        className="flex min-h-0 flex-1 flex-col outline-none"
      >
        {children}
      </main>
      <footer className="glass-1 rim-t flex shrink-0 items-center gap-3 px-4 py-2 print:hidden">
        <ExternalLink
          href={`https://github.com/fabianbormann/Coineda/releases/tag/v${APP_VERSION}`}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          {`v${APP_VERSION}`}
        </ExternalLink>
        <ExternalLink
          href="https://github.com/fabianbormann/Coineda/blob/main/LICENSE"
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          {t('GPLv3 License')}
        </ExternalLink>
      </footer>
    </div>
  );
};
