import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import 'fake-indexeddb/auto';
import '@/i18n';
import { ThemeProvider } from '@/components/theme/ThemeProvider';
import { ConfirmProvider } from '@/components/confirm/ConfirmProvider';
import { MainScreen } from '@/screens/MainScreen';
import { openLedger, putSource, putEvents } from '@/ledger/db';
import { putSettings } from '@/settings/settingsStore';
import { registry } from '@/sources/registry';
import { shortVenue, EVENT_PAGE } from '@/screens/sourceEvents';
import type { LedgerEvent } from '@/ledger/types';

/**
 * Per-source amounts and the per-source event log.
 *
 * Before this, a configured source showed a label, a status and an event
 * count - and nothing about what it actually held or what it had recorded.
 * The two defects these tests exist to hold down are both about units and
 * both silent: a figure rendered in base units reads as a position a
 * hundred million times too large, and a source's folded euro balance is
 * an artifact of a log with no deposits in it.
 */
const exchangeModule = {
  manifest: {
    id: 'test-exchange',
    kind: 'exchange' as const,
    label: 'Test Exchange',
    fields: [],
    requiredScopes: ['Read Info'],
    needsRelay: false,
    emits: ['trade' as const],
    docsUrl: 'https://example.invalid/docs',
  },
  probe: vi.fn(async () => ({ ok: true, readOnly: true })),
  fetchEvents: vi.fn(async () => ({ events: [], cursor: null })),
};

/** One buy: 0.5 BTC in, 10000 euro out. Both legs at the same venue, which
 *  is what an exchange module emits. */
const buy = (overrides: Partial<LedgerEvent> = {}): LedgerEvent => ({
  id: crypto.randomUUID(),
  sourceId: 'cfg-1',
  externalId: 'trade-1',
  timestamp: 1_700_000_000_000,
  kind: 'trade',
  origin: 'derived',
  legs: [
    {
      assetId: 'bitcoin:native',
      amount: '50000000', // 0.5 BTC in satoshis
      direction: 'in',
      venue: 'testexchange',
      role: 'principal',
    },
    {
      assetId: 'fiat:eur',
      amount: '10000',
      direction: 'out',
      venue: 'testexchange',
      role: 'principal',
    },
  ],
  ...overrides,
});

/**
 * A UTXO spend as a chain really reports it: 5 BTC of inputs consumed and
 * 4 BTC of change returned, both at the user's own address. The net is a
 * disposal of 1 BTC, and the raw legs say nothing a reader can use.
 */
const utxoSpend = (): LedgerEvent => ({
  id: crypto.randomUUID(),
  sourceId: 'cfg-2',
  externalId: 'abcdef0123456789#0',
  timestamp: 1_700_100_000_000,
  kind: 'transfer',
  origin: 'derived',
  legs: [
    {
      assetId: 'bitcoin:native',
      amount: '500000000',
      direction: 'out',
      venue: 'bc1qownaddressone',
      role: 'principal',
    },
    {
      assetId: 'bitcoin:native',
      amount: '400000000',
      direction: 'in',
      venue: 'bc1qownaddressone',
      role: 'principal',
    },
  ],
});

const PRICES = { bitcoin: { eur: 20000 } };

beforeEach(async () => {
  const db = await openLedger();
  for (const store of [
    'events',
    'sources',
    'cursors',
    'settings',
    'prices',
  ] as const) {
    await db.clear(store);
  }
  await putSettings({ language: 'en', baseCurrency: 'eur' });
  registry.length = 0;
  registry.push(exchangeModule);
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
    vi.fn(async () => new Response(JSON.stringify(PRICES), { status: 200 })),
  );
});

const renderScreen = () =>
  render(
    <ThemeProvider>
      <ConfirmProvider>
        <MainScreen />
      </ConfirmProvider>
    </ThemeProvider>,
  );

const sourceRow = async (label: string): Promise<HTMLElement> => {
  const name = await screen.findByText(label);
  const card = name.closest('[data-slot="card"]');
  if (card === null) {
    throw new Error(`no card around the row for ${label}`);
  }
  return card as HTMLElement;
};

describe('what a source holds', () => {
  /**
   * TWO sources, always. With one, a per-source fold and a whole-ledger
   * fold produce the same numbers, so every assertion below would hold
   * just as well against code that ignored the source entirely. The
   * second source nets -1 BTC, so a whole-ledger fold would put -0.5 BTC
   * and -10,000.00 on both rows - which is why the assertions are
   * anchored rather than substring matches: /0\.5 BTC/ matches
   * "-0.5 BTC" too.
   */
  beforeEach(async () => {
    await putSource({
      id: 'cfg-1',
      moduleId: 'test-exchange',
      label: 'My Exchange',
      config: {},
    });
    await putSource({
      id: 'cfg-2',
      moduleId: 'test-exchange',
      label: 'My Wallet',
      config: {},
    });
    await putEvents([buy(), utxoSpend()]);
  });

  it('shows the position in whole units, not in base units', async () => {
    renderScreen();
    const row = await sourceRow('My Exchange');
    // Anchored on the value slot, which is still exactly one figure - so
    // this continues to tell 0.5 from -0.5, which a substring match on the
    // row's whole text could not.
    await waitFor(() =>
      expect(within(row).getByText(/^0\.5$/)).toBeInTheDocument(),
    );
    expect(row.textContent).toContain('BTC');
    // The two shapes of the bug this replaces: the raw satoshi figure, and
    // the technical asset id standing in for a symbol.
    expect(within(row).queryByText(/50000000|50,000,000/)).toBeNull();
    expect(within(row).queryByText(/bitcoin:native/)).toBeNull();
    // The other source's own, different position.
    const other = await sourceRow('My Wallet');
    expect(within(other).getByText(/^-1$/)).toBeInTheDocument();
  });

  it('prices the position without the euro leg a trade leaves behind', async () => {
    // 0.5 BTC at 20000/BTC is 10000. The same fold also leaves
    // `fiat:eur -10000` at this venue, because the module emits the trade's
    // payment leg but nothing ever funded the account - no module emits
    // fiat deposits. Priced at 1 and added in, that artifact takes the row
    // to exactly 0, and a slightly different fixture would take it
    // negative. So this asserts the figure, not merely that one is shown.
    renderScreen();
    const row = await sourceRow('My Exchange');
    await waitFor(() =>
      expect(within(row).getByText(/^€10,000\.00$/)).toBeInTheDocument(),
    );
  });

  it('counts its OWN events, not every event in the ledger', async () => {
    // Three events in the ledger, one of which belongs to this row. With a
    // single source the scoped count and the ledger-wide count are the same
    // number and the assertion cannot tell them apart.
    await putEvents([{ ...utxoSpend(), externalId: 'second#0' }]);

    renderScreen();
    const row = await sourceRow('My Exchange');
    await waitFor(() =>
      expect(within(row).getByText(/\b1 event\b/)).toBeInTheDocument(),
    );
    expect(within(row).queryByText(/\b3 events\b/)).toBeNull();
    const other = await sourceRow('My Wallet');
    expect(within(other).getByText(/\b2 events\b/)).toBeInTheDocument();
  });
});

describe('the event log', () => {
  it('shows only the events of the source it was opened for', async () => {
    await putSource({
      id: 'cfg-1',
      moduleId: 'test-exchange',
      label: 'My Exchange',
      config: {},
    });
    await putSource({
      id: 'cfg-2',
      moduleId: 'test-exchange',
      label: 'My Wallet',
      config: {},
    });
    await putEvents([buy(), utxoSpend()]);

    renderScreen();
    const row = await sourceRow('My Exchange');
    await userEvent.click(
      within(row).getByRole('button', {
        name: /show events from My Exchange/i,
      }),
    );

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('trade-1')).toBeInTheDocument();
    // The other source's event, which shares the same asset and would be
    // indistinguishable without the filter.
    expect(within(dialog).queryByText('abcdef0123456789#0')).toBeNull();
  });

  it('nets a UTXO spend instead of listing its inputs and change', async () => {
    await putSource({
      id: 'cfg-2',
      moduleId: 'test-exchange',
      label: 'My Wallet',
      config: {},
    });
    await putEvents([utxoSpend()]);

    renderScreen();
    const row = await sourceRow('My Wallet');
    await userEvent.click(
      within(row).getByRole('button', { name: /show events from My Wallet/i }),
    );

    const dialog = await screen.findByRole('dialog');
    // 5 out, 4 back in, so what the user actually parted with is 1 BTC.
    // Showing the raw legs would print both 5 and 4 and neither would be
    // the answer.
    const amounts = [
      ...dialog.querySelectorAll('[data-slot="crypto-amount-value"]'),
    ].map((node) => node.textContent);
    expect(amounts).toEqual(['1']);
    expect(dialog.textContent).toContain('BTC');
  });

  it('keeps both ends of an address so two from one wallet stay distinct', () => {
    // Every address derived from one account shares its prefix, so a
    // prefix-only trim renders two different addresses identically.
    const a = `bc1qprefixshared${'a'.repeat(40)}tailone`;
    const b = `bc1qprefixshared${'a'.repeat(40)}tailtwo`;
    expect(shortVenue(a)).not.toBe(shortVenue(b));
    expect(shortVenue(a).endsWith('tailone')).toBe(true);
    // Short venues - an exchange name - are left whole.
    expect(shortVenue('bitpanda')).toBe('bitpanda');
  });

  it('pages a long history instead of mounting every row', async () => {
    await putSource({
      id: 'cfg-1',
      moduleId: 'test-exchange',
      label: 'My Exchange',
      config: {},
    });
    const many = Array.from({ length: EVENT_PAGE + 7 }, (_, index) =>
      buy({
        externalId: `trade-${index}`,
        timestamp: 1_700_000_000_000 + index * 1000,
      }),
    );
    await putEvents(many);

    renderScreen();
    const row = await sourceRow('My Exchange');
    await userEvent.click(
      within(row).getByRole('button', {
        name: /show events from My Exchange/i,
      }),
    );

    const dialog = await screen.findByRole('dialog');
    const more = within(dialog).getByRole('button', { name: /7 more/i });
    // Newest first, so the last-numbered trade is on the first page and the
    // oldest is not.
    expect(
      within(dialog).getByText(`trade-${EVENT_PAGE + 6}`),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText('trade-0')).toBeNull();

    await userEvent.click(more);
    expect(within(dialog).getByText('trade-0')).toBeInTheDocument();
  });

  it('offers no event log for a source that has recorded nothing', async () => {
    await putSource({
      id: 'cfg-1',
      moduleId: 'test-exchange',
      label: 'Fresh',
      config: {},
    });
    renderScreen();
    const row = await sourceRow('Fresh');
    expect(
      within(row).getByRole('button', { name: /show events from Fresh/i }),
    ).toBeDisabled();
  });
});

describe('which holdings a row shows, and in what order', () => {
  /**
   * The row is the owner's only glance at what a source holds, and a real
   * Cardano wallet makes that hard: it carries a long tail of NFTs and
   * airdropped tokens with no market price. Ordered by asset id, as this
   * row used to be, they bury the position that matters - the owner's own
   * wallet led with "1 APAVIA · 1 LACIE5113 · 1 LACIE5180 +38 more" and
   * never showed its 507 ADA.
   */
  const NFT_POLICY = 'b'.repeat(56);
  const nft = (name: string) =>
    `cardano:${NFT_POLICY}${Buffer.from(name).toString('hex')}`;

  /** Chosen so the correct order differs from BOTH orders it could be
   *  confused with. By value: ETH, BTC, ADA. By asset id: BTC, ADA, ETH.
   *  By quantity: ADA, ETH, BTC. Only one of the three is right. */
  const PRICED = {
    bitcoin: { eur: 20000 },
    cardano: { eur: 0.5 },
    ethereum: { eur: 2000 },
  };

  const holding = (
    assetId: string,
    amount: string,
    id: string,
  ): LedgerEvent => ({
    id: crypto.randomUUID(),
    sourceId: 'cfg-1',
    externalId: id,
    timestamp: 1_700_000_000_000,
    kind: 'transfer',
    origin: 'derived',
    legs: [
      {
        assetId,
        amount,
        direction: 'in',
        venue: 'wallet',
        role: 'principal',
      },
    ],
  });

  const amountsShown = (row: HTMLElement): (string | null)[] =>
    [...row.querySelectorAll('[data-slot="crypto-amount-value"]')].map(
      (node) => node.textContent,
    );

  beforeEach(async () => {
    await putSource({
      id: 'cfg-1',
      moduleId: 'test-exchange',
      label: 'My Wallet',
      config: {},
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(PRICED), { status: 200 })),
    );
  });

  it('orders by value, not by asset id and not by quantity', async () => {
    await putEvents([
      holding('eth:native', '1000000000000000000', 'e1'), // 1 ETH  = EUR 2000
      holding('bitcoin:native', '5000000', 'e2'), //        0.05 BTC = EUR 1000
      holding('cardano:lovelace', '1000000000', 'e3'), //   1000 ADA = EUR 500
    ]);

    renderScreen();
    const row = await sourceRow('My Wallet');
    await waitFor(() => expect(amountsShown(row)).toHaveLength(3));
    // 1 ETH, 0.05 BTC, 1000 ADA - descending by euro value.
    expect(amountsShown(row)).toEqual(['1', '0.05', '1,000']);
  });

  it('leaves out an asset with no price and says how many', async () => {
    await putEvents([
      holding('cardano:lovelace', '1000000000', 'e1'),
      holding(nft('APAVIA'), '1', 'e2'),
      holding(nft('LACIE5113'), '1', 'e3'),
      holding(nft('LACIE5180'), '1', 'e4'),
    ]);

    renderScreen();
    const row = await sourceRow('My Wallet');
    await waitFor(() => expect(amountsShown(row)).toEqual(['1,000']));
    // Left out, but not silently: a figure that quietly covered only part
    // of a wallet would be worse than the clutter it replaced.
    expect(row.textContent).toMatch(/3 (without a price|ohne Kurs)/);
    expect(row.textContent).not.toContain('APAVIA');
  });

  it('still prices what it can when some assets have no price', async () => {
    // The behaviour this replaces: `value` was null whenever ANY holding
    // was unpriced, so a wallet with a single NFT in it showed no figure at
    // all - which is every real Cardano wallet.
    await putEvents([
      holding('cardano:lovelace', '1000000000', 'e1'),
      holding(nft('APAVIA'), '1', 'e2'),
    ]);

    renderScreen();
    const row = await sourceRow('My Wallet');
    await waitFor(() => expect(row.textContent).toContain('500'));
  });

  it('shows no figure at all when nothing could be priced', async () => {
    // Null rather than zero. A wallet of NFTs is not worth EUR 0.00, it is
    // worth an amount this app cannot determine, and printing 0 would be a
    // claim rather than an absence.
    await putEvents([
      holding(nft('APAVIA'), '1', 'e1'),
      holding(nft('LACIE5113'), '1', 'e2'),
    ]);

    renderScreen();
    const row = await sourceRow('My Wallet');
    await waitFor(() =>
      expect(row.textContent).toMatch(/2 (without a price|ohne Kurs)/),
    );
    expect(row.textContent).not.toMatch(/€\s*0[.,]00/);
    expect(amountsShown(row)).toEqual([]);
  });
});
