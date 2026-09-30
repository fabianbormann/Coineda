import { useCallback, useState } from 'react';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { AppSidebar } from './AppSidebar';
import { AppHeader } from './AppHeader';

const SIDEBAR_OPEN_STORAGE_KEY = 'coineda.sidebarOpen';

/**
 * Reads the last collapse state defensively, the same way
 * ThemeProvider.readStoredTheme does: localStorage can throw in private
 * windows or when site data is blocked, and this is never worth failing
 * the shell over.
 */
const readStoredSidebarOpen = (): boolean => {
  try {
    const stored = localStorage.getItem(SIDEBAR_OPEN_STORAGE_KEY);
    if (stored === 'true' || stored === 'false') {
      return stored === 'true';
    }
  } catch {
    // ignore - fall through to the default
  }
  return true;
};

export const AppShell = ({ children }: { children: React.ReactNode }) => {
  const [open, setOpen] = useState<boolean>(readStoredSidebarOpen);

  // SidebarProvider writes a `sidebar_state` cookie on every toggle, but
  // never reads it back on mount - this app has no backend for that cookie
  // to reach anyway. We seed our own state from localStorage above and
  // persist it here instead. Note this must be full controlled mode (both
  // `open` and `onOpenChange`): passing `onOpenChange` alone would make
  // SidebarProvider route every toggle through it and skip its own
  // internal state update, so the sidebar would silently stop responding.
  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    try {
      localStorage.setItem(SIDEBAR_OPEN_STORAGE_KEY, String(next));
    } catch {
      // ignore - the choice still applies for this session
    }
  }, []);

  return (
    <SidebarProvider open={open} onOpenChange={handleOpenChange}>
      <AppSidebar />
      <SidebarInset>
        <AppHeader />
        <main className="flex min-h-0 flex-1 flex-col">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
};
