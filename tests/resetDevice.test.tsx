import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import 'fake-indexeddb/auto';
import '@/i18n';
import { MemoryRouter } from 'react-router-dom';
import {
  ThemeProvider,
  THEME_STORAGE_KEY,
} from '@/components/theme/ThemeProvider';
import { ConfirmProvider } from '@/components/confirm/ConfirmProvider';
import { Toaster } from '@/components/ui/sonner';
import { MainScreen } from '@/screens/MainScreen';
import {
  openLedger,
  putEvents,
  putSource,
  putCursor,
  getSources,
} from '@/ledger/db';
import { putManualLink } from '@/ledger/manualLinks';
import {
  isOnboarded,
  putSettings,
  setOnboarded,
} from '@/settings/settingsStore';
import { resetDevice } from '@/settings/resetDevice';
import type { LedgerEvent } from '@/ledger/types';

/**
 * Starting over.
 *
 * Nothing in this app leaves the device, so a reset is the one action with
 * no undo of any kind - which is why it is confirmed, why the confirmation
 * names the checkpoint, and why the wipe is a single transaction.
 */
const heldEvent = (n: number): LedgerEvent => ({
  id: `event-${n}`,
  sourceId: 'cfg-1',
  externalId: `ext-${n}`,
  timestamp: 1_700_000_000_000 + n,
  kind: 'trade',
  origin: 'derived',
  legs: [
    {
      assetId: 'cardano:lovelace',
      amount: '1000000',
      direction: 'in',
      venue: 'addr_mine',
      role: 'principal',
    },
  ],
});

/** Something in every store a reset is meant to empty. */
const seedEverything = async () => {
  const db = await openLedger();
  await putSource({
    id: 'cfg-1',
    moduleId: 'test-exchange',
    label: 'Main',
    config: { apiKey: 'secret' },
  });
  await putEvents([heldEvent(1), heldEvent(2)]);
  await putCursor('cfg-1', 'page-2');
  await db.put('prices', {
    key: 'cardano:lovelace|eur|2024-01-01',
    price: '1',
  });
  await db.put('tokenMeta', {
    subject: 'abc',
    fetchedAt: 1_700_000_000_000,
    found: false,
  });
  await putManualLink({
    sourceId: 'cfg-1',
    externalId: 'ext-1',
    txHash: 'deadbeef',
  });
  await putSettings({ language: 'en', baseCurrency: 'eur' });
  await setOnboarded();
};

const countEverything = async () => {
  const db = await openLedger();
  const counts: Record<string, number> = {};
  for (const store of [
    'events',
    'sources',
    'cursors',
    'prices',
    'settings',
    'tokenMeta',
    'transferLinks',
  ] as const) {
    counts[store] = await db.count(store);
  }
  return counts;
};

beforeEach(async () => {
  const db = await openLedger();
  for (const store of [
    'events',
    'sources',
    'cursors',
    'prices',
    'settings',
    'tokenMeta',
    'transferLinks',
  ] as const) {
    await db.clear(store);
  }
  localStorage.clear();
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches: false,
      media: '',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
});

describe('resetDevice', () => {
  it('empties every store, not only the ones holding transactions', async () => {
    // A store left behind is a half-reset install: stale prices under a
    // new portfolio, a cursor resuming a sync for a source that is gone,
    // or - worst - the onboarded flag outliving the data it describes,
    // which boots the app into an empty overview with no way to set
    // itself up again.
    await seedEverything();
    expect(Object.values(await countEverything()).every((n) => n > 0)).toBe(
      true,
    );

    await resetDevice();

    expect(await countEverything()).toEqual({
      events: 0,
      sources: 0,
      cursors: 0,
      prices: 0,
      settings: 0,
      tokenMeta: 0,
      transferLinks: 0,
    });
    expect(await isOnboarded()).toBe(false);
  });

  it('leaves the theme alone - a device preference, not portfolio data', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    await seedEverything();

    await resetDevice();

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });
});

const renderScreen = (onReset = vi.fn()) => {
  render(
    <ThemeProvider>
      <ConfirmProvider>
        <MemoryRouter>
          <MainScreen onReset={onReset} />
        </MemoryRouter>
        <Toaster />
      </ConfirmProvider>
    </ThemeProvider>,
  );
  return onReset;
};

describe('the reset button', () => {
  it('states what is lost and that only a checkpoint brings it back', async () => {
    // The label alone gives no hint that this is unrecoverable, and
    // someone who has never made a checkpoint has to be told HERE - after
    // the click there is nothing left to tell them about.
    await seedEverything();
    renderScreen();

    await userEvent.click(
      await screen.findByRole('button', { name: /reset this device/i }),
    );

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/every data source/i);
    expect(dialog).toHaveTextContent(/checkpoint/i);
  });

  it('does nothing at all when the confirmation is declined', async () => {
    await seedEverything();
    const onReset = renderScreen();

    await userEvent.click(
      await screen.findByRole('button', { name: /reset this device/i }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /cancel/i }),
    );

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(onReset).not.toHaveBeenCalled();
    expect(await getSources()).toHaveLength(1);
    expect(await isOnboarded()).toBe(true);
  });

  it('wipes the device and hands back to onboarding once confirmed', async () => {
    await seedEverything();
    const onReset = renderScreen();

    await userEvent.click(
      await screen.findByRole('button', { name: /reset this device/i }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /reset everything/i }),
    );

    await waitFor(() => expect(onReset).toHaveBeenCalled());
    expect(await isOnboarded()).toBe(false);
    expect(await getSources()).toHaveLength(0);
  });
});
