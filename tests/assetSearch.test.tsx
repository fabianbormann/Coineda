import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import 'fake-indexeddb/auto';
import axios from 'axios';
// Without initializing the real i18n instance, react-i18next's default
// fallback returns translation keys uninterpolated (e.g. literal
// '{{name}}'), same as tests/accounts.test.tsx.
import '@/i18n';
import { toast } from 'sonner';
import { StorageDataProvider } from '@/components/data/StorageDataProvider';
import { Toaster } from '@/components/ui/sonner';
import { ThemeProvider } from '@/components/theme/ThemeProvider';
import { AssetSearch } from '@/components/assets/AssetSearch';

vi.mock('axios');

// The mock stands in for the CoinGecko coin list. Note 'coineda-test-coin':
// src/persistence/assets.json seeds 107 assets on first DB open, including
// bitcoin, wrapped-bitcoin, cardano and dogecoin, so any coin used to test
// the ADD path has to be one the seed list does not already contain -
// otherwise the first add takes the already-tracked branch.
const COINS = [
  { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin' },
  { id: 'wrapped-bitcoin', symbol: 'btc', name: 'Wrapped Bitcoin' },
  { id: 'cardano', symbol: 'ada', name: 'Cardano' },
  { id: 'coineda-test-coin', symbol: 'ctc', name: 'Coineda Test Coin' },
  // Mixed case on purpose: storage.assets.add lowercases the id on write,
  // so the already-tracked lookup has to lowercase too. Every other id here
  // is already lowercase, which would let that fix be reverted unnoticed.
  { id: 'Coineda-MixedCase', symbol: 'cmc', name: 'Coineda MixedCase' },
];

beforeEach(() => {
  localStorage.clear();
  // sonner keeps its toast queue in a module-level store outside React, so
  // a toast from a previous test can still be mounted (its auto-dismiss
  // duration outlives one test) when the next test's <Toaster /> renders -
  // dismiss() clears it so '/already/i' etc. only ever matches this test's
  // own toast.
  toast.dismiss();
  (axios as unknown as { get: ReturnType<typeof vi.fn> }).get = vi
    .fn()
    .mockResolvedValue({ data: COINS });
});

// <Toaster /> must be mounted or sonner renders nothing and every assertion
// on toast copy fails. Same pattern as tests/notify.test.tsx - which is also
// why ThemeProvider wraps it here: Toaster calls useTheme() internally and
// throws without a ThemeProvider ancestor.
const renderSearch = () =>
  render(
    <ThemeProvider>
      <StorageDataProvider>
        <AssetSearch />
        <Toaster />
      </StorageDataProvider>
    </ThemeProvider>,
  );

describe('asset search', () => {
  it('searches when Enter is pressed, not only when the button is clicked', async () => {
    // The old code checked `event.code === '13'`. KeyboardEvent.code is
    // never numeric - it is 'Enter' - so the keyboard path never worked.
    renderSearch();
    await userEvent.type(await screen.findByLabelText(/symbol/i), 'ada{Enter}');

    expect(await screen.findByText(/Cardano/)).toBeInTheDocument();
  });

  it('offers every match when a symbol is ambiguous', async () => {
    renderSearch();
    await userEvent.type(await screen.findByLabelText(/symbol/i), 'btc{Enter}');

    expect(await screen.findByText(/^Bitcoin$/)).toBeInTheDocument();
    expect(await screen.findByText(/Wrapped Bitcoin/)).toBeInTheDocument();
  });

  it('says so, distinctly, when a symbol matches nothing', async () => {
    renderSearch();
    await userEvent.type(await screen.findByLabelText(/symbol/i), 'zzz{Enter}');

    expect(await screen.findByText(/no coin/i)).toBeInTheDocument();
  });

  it('distinguishes an asset already tracked from one newly added', async () => {
    // 'ctc' deliberately: not in the seeded asset list, so the first add
    // really is new. See the note on COINS above.
    const storage = (await import('@/persistence/storage')).default;
    renderSearch();

    await userEvent.type(await screen.findByLabelText(/symbol/i), 'ctc{Enter}');
    await userEvent.click(await screen.findByRole('button', { name: /^Add$/ }));
    expect(
      await screen.findByText(/added Coineda Test Coin/i),
    ).toBeInTheDocument();
    expect(await storage.assets.get('coineda-test-coin')).toBeDefined();

    await userEvent.type(await screen.findByLabelText(/symbol/i), 'ctc{Enter}');
    await userEvent.click(await screen.findByRole('button', { name: /^Add$/ }));
    // A no-op must not read like a success.
    expect(await screen.findByText(/already/i)).toBeInTheDocument();
  });

  it('stores a mixed-case CoinGecko id lowercased, and then knows it is tracked', async () => {
    const storage = (await import('@/persistence/storage')).default;
    renderSearch();

    await userEvent.type(await screen.findByLabelText(/symbol/i), 'cmc{Enter}');
    await userEvent.click(await screen.findByRole('button', { name: /^Add$/ }));
    expect(
      await screen.findByText(/added Coineda MixedCase/i),
    ).toBeInTheDocument();

    // Written lowercased, and under no other spelling.
    expect(await storage.assets.get('coineda-mixedcase')).toBeDefined();
    expect(await storage.assets.get('Coineda-MixedCase')).toBeUndefined();
    // The stored row carries a human-readable name, like the 107 seeded
    // ones - it is not a structurally different kind of row.
    expect((await storage.assets.get('coineda-mixedcase')).name).toBe(
      'Coineda MixedCase',
    );

    // And the second attempt takes the already-tracked branch rather than
    // missing the check and failing the unique constraint.
    await userEvent.type(await screen.findByLabelText(/symbol/i), 'cmc{Enter}');
    await userEvent.click(await screen.findByRole('button', { name: /^Add$/ }));
    expect(await screen.findByText(/already/i)).toBeInTheDocument();
  });

  it('reports an asset already present in the seeded list as already added', async () => {
    // Cardano ships in src/persistence/assets.json, so this exercises the
    // already-tracked branch against real seeded data rather than a row the
    // test wrote itself.
    renderSearch();
    await userEvent.type(await screen.findByLabelText(/symbol/i), 'ada{Enter}');
    await userEvent.click(await screen.findByRole('button', { name: /^Add$/ }));

    expect(await screen.findByText(/already/i)).toBeInTheDocument();
  });
});
