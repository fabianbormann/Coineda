import markOnDark from '@/assets/logo/coineda-mark-on-dark.svg';
import markOnLight from '@/assets/logo/coineda-mark-on-light.svg';
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
 *
 * The mark ships in two files rather than one recoloured through
 * `currentColor`, because it is not a single-colour glyph: its slices carry
 * the brand spectrum, and only the top slice flips between light and dark.
 * Both are rendered and CSS picks one, rather than reading the resolved
 * theme in JavaScript - a themed `<img src>` chosen during render swaps the
 * file after paint, which is a visible flicker on every load.
 *
 * `aria-hidden` on both: the mark says "Coineda" and so does the heading
 * beside it, so announcing it would read the name twice.
 */
export const AppHeader = () => (
  <header className="glass-2 rim-b sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 px-4">
    <img
      src={markOnLight}
      alt=""
      aria-hidden="true"
      className="h-6 w-auto dark:hidden"
    />
    <img
      src={markOnDark}
      alt=""
      aria-hidden="true"
      className="hidden h-6 w-auto dark:block"
    />
    <h1 className="truncate font-serif text-lg">Coineda</h1>
    <div className="flex-1" />
    <ThemeToggle />
  </header>
);
