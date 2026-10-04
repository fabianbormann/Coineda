import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@/i18n';
import { BalanceHeader } from '@/screens/BalanceHeader';

/**
 * The headline figure, and the one piece of chrome that has to be honest
 * rather than merely handsome.
 *
 * A holding with no price is never folded into the total as zero (see
 * src/prices/priceStore.ts), so a total shown beside an unpriced asset is
 * understated. The pill is what says so, which makes it a correctness
 * signal and not decoration - and worth a test, where the rest of the
 * styling is not.
 */
const props = {
  total: 1234.5,
  currency: 'eur',
  missingCount: 0,
  lastSyncedAt: Date.UTC(2026, 0, 15, 9, 30),
  assetCount: 3,
  sourceCount: 2,
};

describe('BalanceHeader', () => {
  it('says so when every holding could be priced', () => {
    render(<BalanceHeader {...props} />);
    expect(screen.getByText(/every holding priced/i)).toBeInTheDocument();
  });

  it('warns beside the number when a holding has no price', () => {
    // The total is understated in this state, so the warning has to sit with
    // the figure rather than somewhere further down the page.
    render(<BalanceHeader {...props} missingCount={2} />);
    expect(screen.queryByText(/every holding priced/i)).not.toBeInTheDocument();
    expect(screen.getByText(/no price/i)).toBeInTheDocument();
  });

  it('shows the facts behind the figure', () => {
    render(<BalanceHeader {...props} />);
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('says a source has never synced rather than showing an epoch', () => {
    render(<BalanceHeader {...props} lastSyncedAt={null} />);
    expect(screen.getByText(/not synced yet/i)).toBeInTheDocument();
    // 1970 is what a null reaching the date formatter looks like.
    expect(screen.queryByText(/1970/)).not.toBeInTheDocument();
  });
});
