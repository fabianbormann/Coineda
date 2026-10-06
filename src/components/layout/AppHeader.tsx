import markOnDark from '@/assets/logo/coineda-mark-on-dark.svg';
import markOnLight from '@/assets/logo/coineda-mark-on-light.svg';
import { Link } from 'react-router-dom';
import { ThemeToggle } from '@/components/theme/ThemeToggle';

/**
 * The sidebar trigger that used to sit at the left is gone with the
 * sidebar itself - see AppShell. A toggle for a panel with nothing in it
 * was worse than no toggle.
 *
 * glass-chrome rather than a tinted background: `bg-background/95` resolved
 * to Lumen's near-black base in dark mode, so the bar read as a solid black
 * panel sitting on top of a coloured page. Nor one of Lumen's own tiers:
 * `glass-2` is sheer enough that the page's body text slid visibly through
 * this bar as it scrolled under it, blurred into a smear that moved with
 * the scroll. `glass-chrome` (src/index.css) is the surface for exactly
 * this - near-opaque, and still tinted by the wash behind it.
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
  <header className="glass-chrome rim-b sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 px-4 print:hidden">
    {/* The mark and the wordmark are ONE link, the way a site's masthead
        conventionally is: the whole thing is the way home, not a small
        image beside a title that is not. Its accessible name comes from
        the heading inside it, which is why the marks stay aria-hidden -
        otherwise the link would announce the name twice. */}
    <Link
      to="/"
      className="flex min-w-0 items-center gap-2 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
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
    </Link>
    <div className="flex-1" />
    <ThemeToggle />
  </header>
);
