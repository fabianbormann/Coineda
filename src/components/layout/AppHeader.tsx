import { ThemeToggle } from '@/components/theme/ThemeToggle';

/**
 * The sidebar trigger that used to sit at the left is gone with the
 * sidebar itself - see AppShell. A toggle for a panel with nothing in it
 * was worse than no toggle.
 *
 * glass-2 rather than a tinted background: `bg-background/95` resolved to
 * Lumen's near-black base in dark mode, so the bar read as a solid black
 * panel sitting on top of a coloured page. The glass tier brings its own
 * translucency and blur, so the wash behind it shows through.
 *
 * The edge is rim-b rather than Lumen's `rim`: a full perimeter is right for
 * a floating card and wrong for a bar running to both screen edges, where it
 * drew a faint line down the left and right of the viewport.
 */
export const AppHeader = () => (
  <header className="glass-2 rim-b sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 px-4">
    <h1 className="truncate font-serif text-lg">Coineda</h1>
    <div className="flex-1" />
    <ThemeToggle />
  </header>
);
