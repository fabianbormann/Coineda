import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PanelLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSidebar } from '@/components/ui/sidebar';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { matchRoute } from '@/lib/routes';

export const AppHeader = () => {
  const { t } = useTranslation();
  const location = useLocation();
  const { toggleSidebar } = useSidebar();
  const active = matchRoute(location.pathname);

  return (
    <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background/95 px-4 backdrop-blur">
      <Button
        variant="ghost"
        size="icon"
        onClick={toggleSidebar}
        aria-label={t('Toggle navigation')}
      >
        <PanelLeft className="size-4" aria-hidden="true" />
      </Button>
      <h1 className="truncate text-base font-semibold">
        {active ? t(active.titleKey) : 'Coineda'}
      </h1>
      <div className="flex-1" />
      <ThemeToggle />
    </header>
  );
};
