import { ThemeToggle } from '@/components/theme/ThemeToggle';

/**
 * The sidebar trigger that used to sit at the left is gone with the
 * sidebar itself - see AppShell. A toggle for a panel with nothing in it
 * was worse than no toggle.
 */
export const AppHeader = () => (
  <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background/95 px-4 backdrop-blur">
    <h1 className="truncate text-base font-semibold">Coineda</h1>
    <div className="flex-1" />
    <ThemeToggle />
  </header>
);
