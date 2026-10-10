import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import '@/i18n';
import { RollingMoney } from '@/components/money/RollingMoney';

/**
 * The headline figure, arriving.
 *
 * Navigating to the tax report and back unmounts the overview, so `total`
 * falls back to its initial 0 and the effect that prices the holdings runs
 * again - which is why the balance visibly shows 0 before snapping to the
 * real number. This component does not remove that window; nothing can,
 * because the figure is genuinely unknown until the prices resolve. It
 * covers it, by letting the number arrive as a counter settling rather
 * than as a jump.
 *
 * jsdom runs no CSS animations, so what is asserted here is the structure
 * the animation rests on and the state it ends in - how many columns, which
 * digit each lands on, how far each one travels, and when the whole thing
 * is over. The motion itself has to be judged in a browser.
 */
const reducedMotion = (reduce: boolean) => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: reduce && query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
};

/** The digit each column comes to rest on, left to right. */
const landedDigits = (): string =>
  screen
    .queryAllByTestId('rolling-digit')
    .map((column) => column.getAttribute('data-digit'))
    .join('');

/** How far each column travels, in whole digit-heights. */
const travel = (): number[] =>
  screen
    .queryAllByTestId('rolling-digit')
    .map((column) => Number(column.getAttribute('data-travel')));

beforeEach(() => {
  reducedMotion(false);
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('a balance arriving', () => {
  it('reads as one clean figure, whatever the digits are doing', () => {
    // A screen reader must not be handed ten spinning columns, and a test
    // must not have to reassemble the number from them. Both read this.
    render(<RollingMoney value={28491.37} currency="eur" />);

    expect(screen.getByTestId('rolling-value').textContent).toBe(
      new Intl.NumberFormat('en', {
        style: 'currency',
        currency: 'EUR',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(28491.37),
    );
  });

  it('does not roll a figure that has nowhere to roll from', () => {
    // The first render after a mount IS zero - that is the state the
    // overview starts in. Rolling 0 into 0 would be a two-second animation
    // of nothing.
    render(<RollingMoney value={0} currency="eur" />);

    expect(screen.queryAllByTestId('rolling-digit')).toHaveLength(0);
  });

  it('rolls once the first real figure arrives', () => {
    const { rerender } = render(<RollingMoney value={0} currency="eur" />);
    rerender(<RollingMoney value={28491.37} currency="eur" />);

    // One column per digit: 2 8 4 9 1 3 7. The grouping separator, the
    // decimal separator and the currency symbol stand still.
    expect(landedDigits()).toBe('2849137');
  });

  it('spins the right-hand columns further than the left', () => {
    // What makes it read as a counter rather than as seven numbers
    // changing at once: the low digits keep turning after the high ones
    // have settled.
    const { rerender } = render(<RollingMoney value={0} currency="eur" />);
    rerender(<RollingMoney value={28491.37} currency="eur" />);

    const distances = travel();
    expect(distances).toHaveLength(7);
    for (let i = 1; i < distances.length; i += 1) {
      expect(distances[i]).toBeGreaterThan(distances[i - 1]);
    }
  });

  it('is over within two seconds, and leaves nothing behind', () => {
    const { rerender } = render(<RollingMoney value={0} currency="eur" />);
    rerender(<RollingMoney value={28491.37} currency="eur" />);
    expect(screen.queryAllByTestId('rolling-digit').length).toBeGreaterThan(0);

    act(() => vi.advanceTimersByTime(2000));

    // Back to plain text: the columns exist only while they are moving.
    expect(screen.queryAllByTestId('rolling-digit')).toHaveLength(0);
    expect(screen.getByTestId('rolling-value').textContent).toContain('28');
  });

  it('leaves a later correction alone', () => {
    // A sync that nudges the total by a fraction of a percent must not
    // restage the whole counter. The arrival is the event worth animating,
    // not every subsequent price tick.
    const { rerender } = render(<RollingMoney value={0} currency="eur" />);
    rerender(<RollingMoney value={28491.37} currency="eur" />);
    act(() => vi.advanceTimersByTime(2000));

    rerender(<RollingMoney value={28502.11} currency="eur" />);

    expect(screen.queryAllByTestId('rolling-digit')).toHaveLength(0);
  });

  it('skips the whole thing when motion is reduced', () => {
    reducedMotion(true);
    const { rerender } = render(<RollingMoney value={0} currency="eur" />);
    rerender(<RollingMoney value={28491.37} currency="eur" />);

    expect(screen.queryAllByTestId('rolling-digit')).toHaveLength(0);
    expect(screen.getByTestId('rolling-value').textContent).toContain('28');
  });
});

describe('the live region', () => {
  const region = () =>
    screen.getByTestId('rolling-value').closest('[aria-live]');

  it('announces politely and atomically once settled', () => {
    render(<RollingMoney value={28491.37} currency="eur" />);
    expect(region()).toHaveAttribute('aria-live', 'polite');
    expect(region()).toHaveAttribute('aria-atomic', 'true');
  });

  it('keeps announcing while the digits roll', () => {
    const { rerender } = render(<RollingMoney value={0} currency="eur" />);
    rerender(<RollingMoney value={28491.37} currency="eur" />);
    expect(screen.queryAllByTestId('rolling-digit').length).toBeGreaterThan(0);
    expect(region()).toHaveAttribute('aria-live', 'polite');
    expect(region()).toHaveAttribute('aria-atomic', 'true');
  });
});
