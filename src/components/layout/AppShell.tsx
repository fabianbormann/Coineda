import { useTranslation } from 'react-i18next';
import { APP_VERSION } from '@/global/version';
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
      <AppHeader />
      <main className="flex min-h-0 flex-1 flex-col">{children}</main>
      <footer className="glass-1 rim-t flex shrink-0 items-center gap-3 px-4 py-2 print:hidden">
        <a
          href={`https://github.com/fabianbormann/Coineda/releases/tag/v${APP_VERSION}`}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          {`v${APP_VERSION}`}
        </a>
        <a
          href="https://github.com/fabianbormann/Coineda/blob/main/LICENSE"
          target="_blank"
          rel="noreferrer"
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          {t('GPLv3 License')}
        </a>
      </footer>
    </div>
  );
};
