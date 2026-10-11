import type { ReactNode } from 'react';

/**
 * A bar of actions pinned to the bottom of the window while the page
 * scrolls under it.
 *
 * Rendered as a sibling of the page's `max-w-7xl` column, never inside it:
 * bounded by the column, the bar left the report scrolling past it on both
 * sides of a wide window. It spans the whole main column instead, edge to
 * edge like the app footer, and the inner `max-w-7xl px-6` wrapper keeps
 * its buttons aligned with the page above.
 *
 * `glass-chrome`, not `glass-2`: the page scrolls UNDER this bar, and a 55%
 * film let its lines slide through as a blurred smear. `z-10` states what
 * document order already gives it, so a later positioned sibling cannot
 * land on top. Off paper: a printed sheet has no buttons.
 */
export const StickyActionBar = ({ children }: { children: ReactNode }) => (
  <div
    data-testid="action-bar"
    className="glass-chrome rim-t sticky bottom-0 z-10 w-full print:hidden"
  >
    <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-2 px-6 py-3">
      {children}
    </div>
  </div>
);
