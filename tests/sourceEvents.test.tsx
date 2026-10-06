import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import 'fake-indexeddb/auto';
import '@/i18n';
import { ThemeProvider } from '@/components/theme/ThemeProvider';
import { ConfirmProvider } from '@/components/confirm/ConfirmProvider';
import { MemoryRouter } from 'react-router-dom';
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

/** The deposit that funds the buy above. Without it the euro leg has
 *  nothing behind it and the fold shows minus everything ever spent - the
 *  artifact that made the headline and the sum of its sources disagree. */
const deposit = (overrides: Partial<LedgerEvent> = {}): LedgerEvent => ({
  id: crypto.randomUUID(),
  sourceId: 'cfg-1',
  externalId: 'fiat:deposit-1',
  timestamp: 1_699_000_000_000,
  kind: 'fiat-in',
  origin: 'derived',
  legs: [
    {
      assetId: 'fiat:eur',
      amount: '10000',
      direction: 'in',
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
        <MemoryRouter>
          <MainScreen onReset={vi.fn()} />
        </MemoryRouter>
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
    await putEvents([deposit(), buy(), utxoSpend()]);
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

  it('prices a funded position at what it is worth', async () => {
    // 10,000 deposited, 10,000 spent on 0.5 BTC, BTC at 20,000. The euro
    // nets to zero and drops out of the fold, so the row is the BTC alone.
    renderScreen();
    const row = await sourceRow('My Exchange');
    await waitFor(() =>
      expect(within(row).getByText(/^€10,000\.00$/)).toBeInTheDocument(),
    );
  });

  it('counts a euro balance the ledger actually has', async () => {
    // Fiat is a holding like any other now. It was filtered out of this
    // figure once, to hide an exchange module that emitted a trade's euro
    // leg without the deposit funding it - but the headline kept counting
    // that artifact, so the balance and the sum of its own sources differed
    // by exactly it, with nothing on screen to explain the gap.
    await putEvents([deposit({ externalId: 'fiat:deposit-2' })]);

    renderScreen();
    const row = await sourceRow('My Exchange');
    // 10,000 deposited twice, 10,000 spent: 10,000 of euro left, plus
    // 10,000 of BTC.
    await waitFor(() =>
      expect(within(row).getByText(/^€20,000\.00$/)).toBeInTheDocument(),
    );
  });

  it('adds up to the headline, which is what the screen promises', async () => {
    // The invariant a user can check by eye, and the one that was broken:
    // the balance at the top read EUR 27,651.60 while its three sources
    // came to EUR 31,421.60 - short by exactly the unfunded euro legs.
    //
    // A deposit that is NOT spent, so the ledger carries a real euro
    // balance. Without it the euro nets to zero and the invariant holds
    // just as well against code that leaves fiat out of the rows while the
    // headline counts it - which is the very divergence being tested.
    await putEvents([deposit({ externalId: 'fiat:deposit-unspent' })]);

    renderScreen();

    const headline = await screen.findByTestId('balance-total');
    await waitFor(() => expect(headline.textContent).toMatch(/€/));

    // The sign is part of the figure. Matching only `€…` reads
    // "-€20,000.00" as +20,000 and turns a wallet that is down into one
    // that is up - which is exactly the kind of error this invariant is
    // here to catch, so the test must not make it itself.
    const euros = (text: string): number[] =>
      [...text.matchAll(/(-?)€([\d,]+\.\d{2})/g)].map(
        (match) =>
          (match[1] === '-' ? -1 : 1) * Number(match[2].replace(/,/g, '')),
      );

    await waitFor(() => {
      const total = euros(headline.textContent ?? '')[0];
      const rows = [...document.querySelectorAll('[data-slot="card"]')].flatMap(
        (card) =>
          card === headline.closest('[data-slot="card"]')
            ? []
            : euros(card.textContent ?? ''),
      );
      expect(rows.length).toBeGreaterThan(0);
      const summed = rows.reduce((a, b) => a + b, 0);
      expect(summed).toBeCloseTo(total, 2);
    });
  });

  it('counts its OWN events, not every event in the ledger', async () => {
    // Five events in the ledger: two belong to this row and three to the
    // other. With a single source the scoped count and the ledger-wide
    // count are the same number and the assertion cannot tell them apart,
    // and distinct per-row counts keep it from passing on a coincidence.
    await putEvents([
      { ...utxoSpend(), externalId: 'second#0' },
      { ...utxoSpend(), externalId: 'third#0' },
    ]);

    renderScreen();
    const row = await sourceRow('My Exchange');
    await waitFor(() =>
      expect(within(row).getByText(/\b2 events\b/)).toBeInTheDocument(),
    );
    expect(within(row).queryByText(/\b5 events\b/)).toBeNull();
    const other = await sourceRow('My Wallet');
    expect(within(other).getByText(/\b3 events\b/)).toBeInTheDocument();
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

describe('showing an internal transfer for what it is', () => {
  /** A withdrawal and the wallet receipt it caused: two sources, one chain
   *  transaction. Apart, the first looks exactly like a sale. */
  const HASH = 'beef'.repeat(16);

  const withdrawal = (): LedgerEvent => ({
    id: 'withdraw',
    sourceId: 'cfg-1',
    externalId: 'withdraw',
    txHash: HASH,
    timestamp: 1_700_000_000_000,
    kind: 'transfer',
    origin: 'derived',
    legs: [
      {
        assetId: 'bitcoin:native',
        amount: '50000000',
        direction: 'out',
        venue: 'testexchange',
        role: 'principal',
      },
    ],
  });

  const arrival = (): LedgerEvent => ({
    id: 'arrive',
    sourceId: 'cfg-2',
    externalId: 'arrive',
    txHash: HASH,
    timestamp: 1_700_000_100_000,
    kind: 'transfer',
    origin: 'derived',
    legs: [
      {
        assetId: 'bitcoin:native',
        amount: '49995000',
        direction: 'in',
        venue: 'bc1qwallet',
        role: 'principal',
      },
    ],
  });

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
  });

  it('labels both sides as a move between the user\u2019s own venues', async () => {
    await putEvents([withdrawal(), arrival()]);
    renderScreen();

    const row = await sourceRow('My Exchange');
    await userEvent.click(
      within(row).getByRole('button', {
        name: /show events from My Exchange/i,
      }),
    );
    const dialog = await screen.findByRole('dialog');
    // The figure beside it looks exactly like a sale; only the pairing
    // knows where the value went.
    expect(
      within(dialog).getByText(/between your own venues|eigenen Wallets/i),
    ).toBeInTheDocument();
  });

  it('says nothing of the sort for a payment to somebody else', async () => {
    // The guard that matters: a real disposal must not be dressed up as a
    // transfer. Same withdrawal, with no matching arrival anywhere.
    await putEvents([withdrawal()]);
    renderScreen();

    const row = await sourceRow('My Exchange');
    await userEvent.click(
      within(row).getByRole('button', {
        name: /show events from My Exchange/i,
      }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).queryByText(/between your own venues|eigenen Wallets/i),
    ).toBeNull();
  });
});
