import { useTranslation } from 'react-i18next';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
} from '@/components/ui/sidebar';
import { APP_VERSION } from '@/global/version';

/**
 * Milestone 1 trims this to the shell chrome that survives the demolition:
 * an empty header slot and content area for later tasks to fill (the
 * account switcher and the route-driven nav both went with the deleted
 * persistence/routing layers), plus the version and licence links. The
 * collapse control itself lives in AppShell/AppHeader, untouched here.
 */
export const AppSidebar = () => {
  const { t } = useTranslation();

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader />

      <SidebarContent />

      <SidebarFooter>
        <div className="flex items-center gap-2 px-2 py-1 group-data-[collapsible=icon]:hidden">
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
        </div>
      </SidebarFooter>
    </Sidebar>
  );
};
