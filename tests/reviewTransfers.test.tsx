import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import 'fake-indexeddb/auto';
import '@/i18n';
import { ThemeProvider } from '@/components/theme/ThemeProvider';
import { ConfirmProvider } from '@/components/confirm/ConfirmProvider';
import { MemoryRouter } from 'react-router-dom';
import { MainScreen } from '@/screens/MainScreen';
import { openLedger, putEvents, putSource } from '@/ledger/db';
import { getManualLinks } from '@/ledger/manualLinks';
import { putSettings } from '@/settings/settingsStore';
import { registry } from '@/sources/registry';
import type { LedgerEvent } from '@/ledger/types';

/**
 * Confirming a transfer whose exchange side reports no chain transaction.
 *
 * The screen must offer the pair and must NOT decide for the user: the
 * confirmation is what records the chain hash against the exchange's row,
 * and the rest of the program then treats the two as one movement through
 * the ordinary exact path.
 */
const HASH = 'a1b2'.repeat(16);
const BTC = 'bitcoin:native';

const stubModule = {
  manifest: {
    id: 'test-module',
    kind: 'exchange' as const,
    label: 'Test Exchange',
    fields: [],
    requiredScopes: [],
    needsRelay: false,
    emits: ['transfer' as const],
    docsUrl: 'https://example.invalid/docs',
  },
  probe: vi.fn(async () => ({ ok: true, readOnly: true })),
  fetchEvents: vi.fn(async () => ({ events: [], cursor: null })),
};

/** Kraken's row: its own ledger id, an amount, and no hash anywhere. */
const krakenDeposit: LedgerEvent = {
  id: 'kraken-in',
  sourceId: 'kraken',
  externalId: 'LLSN5F-UR5OY-DD6KMV',
  timestamp: Date.UTC(2025, 2, 1, 13),
  kind: 'transfer',
  origin: 'derived',
  legs: [
    {
      assetId: BTC,
      amount: '7545306',
      direction: 'in',
      venue: 'kraken',
      role: 'principal',
    },
  ],
};

/** The wallet side, as a chain reports it: an input spent whole, change
 *  back. The net out is 0.075455, 194 sats more than Kraken credited. */
const walletSpend: LedgerEvent = {
  id: 'wallet-out',
  sourceId: 'bitcoin',
  externalId: HASH,
  txHash: HASH,
  timestamp: Date.UTC(2025, 2, 1, 12, 40),
  kind: 'transfer',
  origin: 'derived',
  legs: [
    {
      assetId: BTC,
      amount: '40000000',
      direction: 'out',
      venue: 'bc1qown',
      role: 'principal',
    },
    {
      assetId: BTC,
      amount: '32454500',
      direction: 'in',
      venue: 'bc1qown',
      role: 'principal',
    },
  ],
};

beforeEach(async () => {
  const db = await openLedger();
  for (const store of [
    'events',
    'sources',
    'cursors',
    'settings',
    'prices',
    'transferLinks',
  ] as const) {
    await db.clear(store);
  }
  await putSettings({ language: 'en', baseCurrency: 'eur' });
  registry.length = 0;
  registry.push(stubModule);
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches: false,
      media: '',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
  );
  await putSource({
    id: 'kraken',
    moduleId: 'test-module',
    label: 'Kraken',
    config: {},
  });
  await putSource({
    id: 'bitcoin',
    moduleId: 'test-module',
    label: 'My Wallet',
    config: {},
  });
});

const renderScreen = () =>
  render(
    <ThemeProvider>
      <ConfirmProvider>
        <MemoryRouter>
          <MainScreen />
        </MemoryRouter>
      </ConfirmProvider>
    </ThemeProvider>,
  );

const openReview = async () => {
  const button = await screen.findByRole('button', {
    name: /possible transfer/i,
  });
  await userEvent.click(button);
};

describe('confirming a transfer by hand', () => {
  it('offers nothing when no pair looks like one movement', async () => {
    // The button has to stay hidden, not merely open an empty dialog: a
    // control that is almost always empty teaches people to ignore it.
    await putEvents([walletSpend]);
    renderScreen();

    await screen.findByText('My Wallet');
    expect(
      screen.queryByRole('button', { name: /possible transfer/i }),
    ).toBeNull();
  });

  it('names both sides and the fee between them', async () => {
    await putEvents([krakenDeposit, walletSpend]);
    renderScreen();
    await openReview();

    const dialog = await screen.findByRole('dialog');
    // Both sources by name, so the user can tell WHICH two rows this is
    // about rather than being asked to trust a hash.
    expect(dialog).toHaveTextContent('Kraken');
    expect(dialog).toHaveTextContent('My Wallet');
    // 0.00000194 BTC - the miner fee, in whole units rather than sats.
    expect(dialog).toHaveTextContent('0.00000194');
    expect(dialog).toHaveTextContent(HASH);
  });

  it('records the hash against the exchange row when the user confirms', async () => {
    await putEvents([krakenDeposit, walletSpend]);
    renderScreen();
    await openReview();

    await userEvent.click(
      await screen.findByRole('button', { name: /yes, this is one transfer/i }),
    );

    await waitFor(async () => {
      const links = await getManualLinks();
      expect(links).toEqual([
        expect.objectContaining({
          sourceId: 'kraken',
          // The identity the source reproduces, not the row id - a resync
          // regenerates ids and would orphan the confirmation.
          externalId: 'LLSN5F-UR5OY-DD6KMV',
          txHash: HASH,
        }),
      ]);
    });
  });

  it('stops offering the pair once it is confirmed', async () => {
    await putEvents([krakenDeposit, walletSpend]);
    renderScreen();
    await openReview();

    await userEvent.click(
      await screen.findByRole('button', { name: /yes, this is one transfer/i }),
    );

    // The overlay is applied when the log is read, so the reload the
    // confirmation triggers is what makes the pair exact - and an exact
    // pair is no longer a proposal. Asserted INSIDE the open dialog
    // first: an open Radix dialog marks the rest of the page
    // aria-hidden, so a page-wide query for the button that opened it
    // comes back null whether or not anything was recorded.
    await screen.findByText(/every transfer is already accounted for/i);

    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: /possible transfer/i }),
      ).toBeNull(),
    );
  });

  it('records nothing until the user says so', async () => {
    // THE property. Opening the list must not change the ledger: a
    // confirmation removes a disposal from a tax report, and that is the
    // user's call, not a heuristic's.
    await putEvents([krakenDeposit, walletSpend]);
    renderScreen();
    await openReview();
    await screen.findByRole('dialog');

    expect(await getManualLinks()).toEqual([]);
  });
});
