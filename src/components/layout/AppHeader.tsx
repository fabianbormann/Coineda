import { ThemeToggle } from '@/components/theme/ThemeToggle';

/**
 * The sidebar trigger that used to sit at the left is gone with the
 * sidebar itself - see AppShell. A toggle for a panel with nothing in it
 * was worse than no toggle.
 *
 * glass-2 rather than a tinted background: `bg-background/95` resolved to
 * Lumen's near-black base in dark mode, so the bar read as a solid black
 * panel sitting on top of a coloured page. The glass tier brings its own
 * translucency and blur, so the wash behind it shows through, and the rim
 * supplies the iridescent edge in place of the flat bottom border.
 */
export const AppHeader = () => (
  <header className="glass-2 rim rim-soft sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 px-4">
    <h1 className="truncate font-serif text-lg">Coineda</h1>
    <div className="flex-1" />
    <ThemeToggle />
  </header>
);
