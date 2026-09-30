import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useContext } from 'react';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';
import { ROUTES, matchRoute } from '@/lib/routes';
import { SettingsContext } from '@/SettingsContext';
import { APP_VERSION } from '@/global/version';

export const AppSidebar = () => {
  const { t } = useTranslation();
  const location = useLocation();
  const { settings } = useContext(SettingsContext);
  const { isMobile, setOpenMobile } = useSidebar();
  const active = matchRoute(location.pathname);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1.5">
          <div
            className="size-7 shrink-0 rounded-md bg-primary"
            style={{ filter: `hue-rotate(${settings.account.pattern}deg)` }}
            aria-hidden="true"
          />
          <span className="truncate font-medium group-data-[collapsible=icon]:hidden">
            {settings.account.name}
          </span>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {ROUTES.map(({ path, titleKey, Icon }) => (
                <SidebarMenuItem key={path}>
                  <SidebarMenuButton
                    asChild
                    isActive={active?.path === path}
                    tooltip={t(titleKey)}
                  >
                    <Link
                      to={path}
                      onClick={() => isMobile && setOpenMobile(false)}
                    >
                      <Icon aria-hidden="true" />
                      <span>{t(titleKey)}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

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
