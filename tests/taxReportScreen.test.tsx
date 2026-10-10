import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import 'fake-indexeddb/auto';
import i18n from '@/i18n';
import { MemoryRouter } from 'react-router-dom';
import { TaxReportScreen } from '@/screens/TaxReportScreen';
import { taxRegistry } from '@/tax/registry';
import germanTax from '@/tax/jurisdictions/de';
import { formatFiat } from '@/components/money/format';
import { openLedger, putEvents, putSource } from '@/ledger/db';
import * as settingsStore from '@/settings/settingsStore';
import type { Settings } from '@/settings/settingsStore';
import { getSettings, putSettings } from '@/settings/settingsStore';
import type { LedgerEvent } from '@/ledger/types';
import { ClientProvider } from '@/clients/ClientContext';
import {
  createClient,
  labelOf,
  listClients,
  type ClientRecord,
} from '@/clients/registry';
import { writeDeviceEgress, writeDeviceEndpoints } from '@/config/deviceConfig';
import { flatRange } from './priceRangeStub';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  AssessInput,
  TaxAssessment,
  TaxManifest,
  TaxModule,
  UnresolvedItem,
} from '@/tax/types';

/**
 * A fully controlled test jurisdiction, patterned after the stub module in
 * tests/taxPipeline.test.ts: `classify` maps ledger legs straight to tax
 * events (no network involved, since every fixture below uses `fiat:eur`
 * as the asset, which resolveValues prices at 1:1 without ever calling
 * fetch), and `assess` returns fixed, test-controlled figures rather than
 * deriving them from the matched amounts - the engine's own arithmetic is
 * covered by tests/taxGermany.test.ts and tests/taxAustria.test.ts, so this
 * file only has to prove the DIALOG renders whatever a module hands back,
 * honestly and in the required order.
 */
const classify: TaxModule['classify'] = (event) =>
  event.legs.map((leg, index) => ({
    sourceEventId: `${event.id}:${index}`,
    kind: leg.direction === 'in' ? 'acquisition' : 'disposal',
    assetId: leg.assetId,
    amount: leg.amount,
    timestamp: event.timestamp,
    venue: leg.venue,
  }));

const assess = (input: AssessInput): TaxAssessment => ({
  year: input.year,
  lines: input.matched.map((m) => ({
    disposalEventId: m.disposalEventId,
    assetId: m.assetId,
    timestamp: m.timestamp,
    proceeds: '500',
    costBasis: '300',
    gain: '200',
    exempt: '0',
    taxable: '200',
    reason: { key: 'Fully taxable test disposal' },
  })),
  totals: {
    taxableGain: input.matched.length > 0 ? '200' : '0',
    exemptGain: '0',
    income: '0',
    loss: '0',
    computedFrom: input.matched.length,
    omitted: 0,
  },
  thresholds: [
    {
      label: 'Test threshold',
      limit: '100',
      actual: input.matched.length > 0 ? '200' : '0',
      exceeded: input.matched.length > 0,
      kind: 'freigrenze',
    },
  ],
  estimatedLiability: input.rate !== undefined ? '42' : undefined,
  unresolved: [],
});

const baseManifest: TaxManifest = {
  id: 'test-jurisdiction',
  jurisdiction: 'Testland',
  contributor: 'Test Suite',
  rulesCheckedOn: '2025-01-01',
  rulesVersion: '1.0.0',
  changelog: [{ version: '1.0.0', date: '2025-01-01', summary: 'Initial.' }],
  partitionLabel: 'Test partition',
  references: ['Test Statute §1'],
  supportedYears: { from: 2020, to: 2030 },
};

const makeModule = (
  manifestOverrides: Partial<TaxManifest> = {},
): TaxModule => ({
  manifest: { ...baseManifest, ...manifestOverrides },
  handles: ['trade', 'transfer', 'reward', 'fiat-in', 'fiat-out'],
  defaultMatching: 'fifo',
  partitionBy: (event) => event.venue,
  classify,
  assess,
});

const ledgerEvent = (overrides: Partial<LedgerEvent>): LedgerEvent => ({
  id: 'acq',
  sourceId: 's1',
  externalId: 'x1',
  timestamp: Date.UTC(2025, 5, 1),
  kind: 'transfer',
  origin: 'derived',
  legs: [
    {
      assetId: 'fiat:eur',
      amount: '100',
      direction: 'in',
      venue: 'wallet-a',
      role: 'principal',
    },
  ],
  ...overrides,
});

const acquisitionEvent = ledgerEvent({ id: 'acq', externalId: 'acq' });
const disposalEvent = ledgerEvent({
  id: 'disp',
  externalId: 'disp',
  timestamp: Date.UTC(2025, 6, 1),
  legs: [
    {
      assetId: 'fiat:eur',
      amount: '100',
      direction: 'out',
      venue: 'wallet-a',
      role: 'principal',
    },
  ],
});
// No matching acquisition exists on 'wallet-x', so `match` reports a
// shortfall - the host turns that into an UnresolvedItem with
// kind: 'needs-cost-basis' and the literal reason string asserted below.
const unmatchedDisposalEvent = ledgerEvent({
  id: 'orphan',
  externalId: 'orphan',
  timestamp: Date.UTC(2025, 7, 1),
  legs: [
    {
      assetId: 'fiat:eur',
      amount: '20',
      direction: 'out',
      venue: 'wallet-x',
      role: 'principal',
    },
  ],
});

beforeEach(async () => {
  const db = await openLedger();
  for (const store of ['events', 'sources', 'cursors', 'settings'] as const) {
    await db.clear(store);
  }
  await putSettings({ language: 'en', baseCurrency: 'eur' });
  taxRegistry.length = 0;
});

/** The screen needs a router: it links back to the overview and navigates
 *  there from its footer. */
const renderScreen = () =>
  render(
    <MemoryRouter>
      <TaxReportScreen />
    </MemoryRouter>,
  );

/** Opens the dialog on the given module and runs the report for `year`,
 *  waiting for the result (or the error) to land. */
const runReport = async (year: string) => {
  await userEvent.click(
    await screen.findByRole('button', { name: /testland/i }),
  );
  const yearInput = await screen.findByLabelText(/tax year/i);
  await userEvent.clear(yearInput);
  await userEvent.type(yearInput, year);
  await userEvent.click(
    await screen.findByRole('button', { name: /run report/i }),
  );
  // Waits for the run to be OVER, not merely started. Clicking used to be
  // the whole helper, and the tests below that query the result
  // synchronously passed only because the report happened to settle inside
  // userEvent's own flush - one extra awaited read inside runTaxReport was
  // enough to make several of them fail at random under load. Waiting on
  // the loading line disappearing covers the error path too, where no
  // figures ever arrive.
  await waitFor(() =>
    expect(screen.queryByText(/running your tax report/i)).toBeNull(),
  );
};

describe('downloading the register', () => {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  afterEach(() => {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    vi.restoreAllMocks();
  });

  it('offers the register and the report as files, inside the print-hidden bar', async () => {
    taxRegistry.push(makeModule());
    await putEvents([acquisitionEvent, disposalEvent]);
    const blobs: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return 'blob:test';
    });
    // jsdom has no createObjectURL to spy on, so it is assigned and put
    // back (to absent) in afterEach.
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    renderScreen();
    await runReport('2025');

    const csvButton = await screen.findByRole('button', {
      name: /download register \(csv\)/i,
    });
    const jsonButton = screen.getByRole('button', {
      name: /download report \(json\)/i,
    });
    expect(csvButton.closest('.print\\:hidden')).not.toBeNull();
    expect(jsonButton.closest('.print\\:hidden')).not.toBeNull();
    expect(
      screen
        .getByText(/in excel, open the csv via data → from text\/csv/i)
        .closest('.print\\:hidden'),
    ).not.toBeNull();

    await userEvent.click(csvButton);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const bytes = new Uint8Array(await readBlob(blobs[0]));
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);

    await userEvent.click(jsonButton);
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    const json = JSON.parse(new TextDecoder().decode(await readBlob(blobs[1])));
    expect(json.register.length).toBeGreaterThan(0);
    expect(json.year).toBe(2025);
    expect(json.jurisdiction).toBe('test-jurisdiction');
    expect(Number.isNaN(Date.parse(json.generatedAt))).toBe(false);
    expect(Array.isArray(json.sourceDirectory)).toBe(true);
    expect(json.method.egress).toBe('public');
    for (const host of Object.values(json.method.endpoints as object)) {
      expect(host).not.toMatch(/[/?]/);
    }
  });
});

const readBlob = (blob: Blob): Promise<ArrayBuffer> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });

/** A buy for 100 EUR and a sale for 100 EUR with a 7 EUR fee. */
const putSaleWithFee = async (venue = 'wallet-a') => {
  await putEvents([
    ledgerEvent({
      id: 'buy',
      externalId: 'buy',
      kind: 'trade',
      timestamp: Date.UTC(new Date().getUTCFullYear(), 0, 2),
      legs: [
        {
          assetId: 'fiat:eur',
          amount: '100',
          direction: 'out',
          venue,
          role: 'principal',
        },
        {
          assetId: 'cardano:lovelace',
          amount: '100000000',
          direction: 'in',
          venue,
          role: 'principal',
        },
      ],
    }),
    ledgerEvent({
      id: 'sell',
      externalId: 'sell',
      kind: 'trade',
      timestamp: Date.UTC(new Date().getUTCFullYear(), 0, 3),
      legs: [
        {
          assetId: 'cardano:lovelace',
          amount: '100000000',
          direction: 'out',
          venue,
          role: 'principal',
        },
        {
          assetId: 'fiat:eur',
          amount: '100',
          direction: 'in',
          venue,
          role: 'principal',
        },
        {
          assetId: 'fiat:eur',
          amount: '7',
          direction: 'out',
          venue,
          role: 'fee',
        },
      ],
    }),
  ]);
};

describe('running a report', () => {
  it('runs a report and renders the totals', async () => {
    taxRegistry.push(makeModule());
    await putEvents([acquisitionEvent, disposalEvent]);

    renderScreen();
    await runReport('2025');

    // 200.00 is the fixed figure `assess` returns above - it appears more
    // than once (totals, the disposal line), so assert it from the totals
    // paragraph specifically rather than an ambiguous page-wide text query.
    const taxableGainLine = (await screen.findByText(/taxable gain/i)).closest(
      'p',
    );
    expect(taxableGainLine).toHaveTextContent(/200\.00/);
    // No fee came off this disposal, so the line keeps its one figure and
    // names no deduction.
    expect(screen.getAllByText(/proceeds/i)).not.toHaveLength(0);
    expect(screen.queryByText(/fees deducted/i)).toBeNull();
    expect(screen.queryByText(/sale value/i)).toBeNull();
  });

  it('shows "N disposals could not be computed" right next to the total when omitted > 0', async () => {
    taxRegistry.push(makeModule());
    await putEvents([acquisitionEvent, disposalEvent, unmatchedDisposalEvent]);

    renderScreen();
    await runReport('2025');

    const taxableGainLine = (await screen.findByText(/taxable gain/i)).closest(
      'p',
    );
    expect(taxableGainLine).not.toBeNull();
    // The dangerous failure this screen exists to prevent: a plausible
    // total that silently drops a disposal. The omitted count must live in
    // the SAME paragraph as the total, not just somewhere on the page.
    expect(taxableGainLine).toHaveTextContent(
      /1 disposals could not be computed/i,
    );
  });

  it('shows an unresolved item with its reason, translated', async () => {
    taxRegistry.push(makeModule());
    await putEvents([acquisitionEvent, disposalEvent, unmatchedDisposalEvent]);

    renderScreen();
    await runReport('2025');

    // The shortfall reason runTaxReport.ts emits, resolved THROUGH i18n
    // and framed in the translated wrapper. Asserting the rendered sentence
    // rather than the key is what proves the key actually reaches `t`: a
    // reason that never got translated would render identically to one that
    // did only while the locale under test is English, so this pairs with
    // the conformance gate, which is what catches a key missing from de.json.
    // Scoped to the screen list: the document renders a second, unfiltered
    // copy of every unresolved item for print, so an unscoped query now
    // matches both.
    const list = await screen.findByTestId('unresolved-screen');
    expect(list.textContent).toMatch(
      /no acquisition is on record for this disposal/i,
    );
  });

  it('offers no resolution action for an unresolved item', async () => {
    taxRegistry.push(makeModule());
    await putEvents([acquisitionEvent, disposalEvent, unmatchedDisposalEvent]);

    renderScreen();
    await runReport('2025');

    await screen.findByTestId('unresolved-screen');

    // Resolving an unresolved item (recording a purchase, adding a source
    // for the venue) is explicitly a later milestone - this screen must
    // only ever show the gap, never an action to close it.
    expect(
      screen.queryByRole('button', { name: /record a purchase/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /add.*source/i }),
    ).not.toBeInTheDocument();
  });

  it('shows the error, not a blank report, for a year outside supportedYears', async () => {
    taxRegistry.push(makeModule({ supportedYears: { from: 2020, to: 2021 } }));

    renderScreen();
    await runReport('1900');

    expect(
      await screen.findByText(/2020-2021|2020 or later/i),
    ).toBeInTheDocument();
    // Nothing from a (nonexistent) assessment leaks through.
    expect(screen.queryByText(/taxable gain/i)).not.toBeInTheDocument();
  });

  it('prints the fees deducted from a disposal', async () => {
    vi.stubGlobal('fetch', flatRange(1));
    taxRegistry.push(germanTax);
    await putSaleWithFee();
    vi.stubGlobal('fetch', flatRange(1));

    renderScreen();
    await userEvent.click(
      await screen.findByRole('button', { name: /germany/i }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /run report/i }),
    );

    // Rendered twice, once for the screen and once in the print copy, so
    // "all", not "by". Three figures, gross first: "Proceeds: 93 - of which
    // fees: 7" told a reader the 7 was part of the 93, when the 93 is
    // already net of it.
    expect(await screen.findAllByText(/proceeds after fees/i)).not.toHaveLength(
      0,
    );
    expect(screen.getAllByText(/fees deducted/i)).not.toHaveLength(0);
    expect(screen.getAllByText(/sale value/i)).not.toHaveLength(0);
    // Who priced the figure is printed on the row, here the fiat paid.
    expect(
      screen.getAllByText(/priced by consideration · base currency/i),
    ).not.toHaveLength(0);
  });

  it('names the price source in German on a German sheet', async () => {
    vi.stubGlobal('fetch', flatRange(1));
    taxRegistry.push(germanTax);
    await putSaleWithFee();
    await i18n.changeLanguage('de');
    try {
      renderScreen();
      await userEvent.click(
        await screen.findByRole('button', { name: /deutschland/i }),
      );
      await userEvent.click(
        await screen.findByRole('button', { name: /report erstellen/i }),
      );
      expect(
        await screen.findAllByText(
          /bewertet über Gegenleistung · Basiswährung/,
        ),
      ).not.toHaveLength(0);
      expect(screen.queryByText(/base currency/i)).toBeNull();
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('labels a transfer fee disposal and states the count on the method sheet', async () => {
    // A withdrawal from bitpanda to the user's own wallet, with a network
    // fee leg on top. The fee coins come back as a residual disposal; a
    // reader must be able to tell why an unexplained few satoshi left
    // bitpanda, and tie it to the method sheet's count.
    vi.stubGlobal('fetch', flatRange(1));
    taxRegistry.push(germanTax);
    const year = new Date().getUTCFullYear();
    const hash = 'beef'.repeat(16);
    await putEvents([
      ledgerEvent({
        id: 'buy',
        externalId: 'buy',
        kind: 'trade',
        timestamp: Date.UTC(year, 0, 2),
        legs: [
          {
            assetId: 'fiat:eur',
            amount: '100',
            direction: 'out',
            venue: 'bitpanda',
            role: 'principal',
          },
          {
            assetId: 'bitcoin:native',
            amount: '50000000',
            direction: 'in',
            venue: 'bitpanda',
            role: 'principal',
          },
        ],
      }),
      ledgerEvent({
        id: 'withdraw',
        externalId: 'withdraw',
        sourceId: 'bitpanda',
        txHash: hash,
        timestamp: Date.UTC(year, 0, 3),
        legs: [
          {
            assetId: 'bitcoin:native',
            amount: '49995000',
            direction: 'out',
            venue: 'bitpanda',
            role: 'principal',
          },
          {
            assetId: 'bitcoin:native',
            amount: '5000',
            direction: 'out',
            venue: 'bitpanda',
            role: 'fee',
          },
        ],
      }),
      ledgerEvent({
        id: 'arrive',
        externalId: 'arrive',
        sourceId: 'bitcoin',
        txHash: hash,
        timestamp: Date.UTC(year, 0, 3, 1),
        legs: [
          {
            assetId: 'bitcoin:native',
            amount: '49995000',
            direction: 'in',
            venue: 'bc1qwallet',
            role: 'principal',
          },
        ],
      }),
    ]);

    renderScreen();
    await userEvent.click(
      await screen.findByRole('button', { name: /germany/i }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /run report/i }),
    );

    expect(
      await screen.findAllByText(/network fee on a transfer between/i),
    ).not.toHaveLength(0);
    expect(screen.getAllByText(hash)).not.toHaveLength(0);
    expect(
      screen.getAllByText(/treated as disposals|treated as a disposal/i),
    ).not.toHaveLength(0);
  });
});

describe('the rule-set version', () => {
  it('prints on the method sheet and in the disclaimer after a German run', async () => {
    vi.stubGlobal('fetch', flatRange(1));
    taxRegistry.push(germanTax);
    renderScreen();
    await userEvent.click(
      await screen.findByRole('button', { name: /germany/i }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /run report/i }),
    );

    // The jurisdiction's name, not the module id: "de" means nothing to a
    // reader at the Finanzamt. The disclaimer prints at once, the method
    // sheet only once the run is over - so wait for both.
    await waitFor(() =>
      expect(screen.getAllByText(/rule set germany 1\.6\.0/i)).toHaveLength(2),
    );
    expect(
      screen.getByText(/rule set germany 1\.6\.0, checked on/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/rule set de\b/i)).toBeNull();
  });

  it('prints the ledger fingerprint on the method sheet', async () => {
    vi.stubGlobal('fetch', flatRange(1));
    taxRegistry.push(germanTax);
    renderScreen();
    await userEvent.click(
      await screen.findByRole('button', { name: /germany/i }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /run report/i }),
    );
    expect(await screen.findByText(/ledger fingerprint/i)).toBeInTheDocument();
    expect(await screen.findByText(/^[0-9a-f]{64}$/)).toBeInTheDocument();
  });

  it('names the jurisdiction in German on a German sheet', async () => {
    vi.stubGlobal('fetch', flatRange(1));
    taxRegistry.push(germanTax);
    await i18n.changeLanguage('de');
    try {
      renderScreen();
      await userEvent.click(
        await screen.findByRole('button', { name: /deutschland/i }),
      );
      expect(
        await screen.findByText(/regelwerk deutschland 1\.6\.0, geprüft am/i),
      ).toBeInTheDocument();
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});

describe('the unresolved list', () => {
  it('gives every item its own key, even two gaps on one event and asset', async () => {
    // resolveValues emits one item per TAX EVENT, and one ledger event can
    // produce several tax events for the same asset - here the net
    // principal leg and the fee leg of a single transaction, both of the
    // same native token. Keyed on sourceEventId + assetId those two
    // collide: the recorded report had 56 items and 30 distinct keys, so
    // React silently dropped rows the user is supposed to read.
    const errors: unknown[][] = [];
    const spy = vi
      .spyOn(console, 'error')
      .mockImplementation((...args: unknown[]) => {
        errors.push(args);
      });

    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 404 })),
      );

      // The REAL German module, because the stub module above gives each
      // leg its own sourceEventId and so cannot produce the collision.
      taxRegistry.push(germanTax);
      await putEvents([
        ledgerEvent({
          id: 'one-tx',
          externalId: 'one-tx',
          timestamp: Date.UTC(2025, 2, 1),
          legs: [
            {
              assetId: 'cardano:1234abcd.MyToken',
              amount: '500',
              direction: 'out',
              venue: 'wallet-a',
              role: 'principal',
            },
            {
              assetId: 'cardano:1234abcd.MyToken',
              amount: '398',
              direction: 'in',
              venue: 'wallet-a',
              role: 'principal',
            },
            {
              assetId: 'cardano:1234abcd.MyToken',
              amount: '3',
              direction: 'out',
              venue: 'wallet-a',
              role: 'fee',
            },
          ],
        }),
      ]);

      renderScreen();
      await userEvent.click(
        await screen.findByRole('button', { name: /germany/i }),
      );
      await userEvent.click(
        await screen.findByRole('button', { name: /run report/i }),
      );
      await screen.findByText(/other unresolved items are not disposals/i);

      // This test is about React keys, not about years: its fixture is
      // dated 2025 while the form defaults to the current year, so the
      // unresolved list would hide the very items whose keys are under
      // test. Showing everything keeps it rendering exactly what it did
      // before the filter existed.
      await userEvent.click(
        screen.getByRole('checkbox', { name: /outside the tax year/i }),
      );

      // Two gaps on one event and one asset, both rendered. Counted in the
      // screen list alone: the document renders a second, unfiltered copy
      // for print, and an unscoped count would be 4 whether or not React
      // dropped a row from each.
      const list = await screen.findByTestId('unresolved-screen');
      expect(
        [...list.querySelectorAll('[role="alert"]')].filter((node) =>
          /no price source is configured/i.test(node.textContent ?? ''),
        ),
      ).toHaveLength(2);
      const keyWarnings = errors
        .map((args) => args.map(String).join(' '))
        .filter((text) => /same key/i.test(text));
      expect(keyWarnings).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('unresolved items that are not disposals', () => {
  it('names them separately instead of counting them as omitted disposals', async () => {
    // A native token with no CoinGecko mapping, ARRIVING: a real gap, and
    // not a disposal. Counting it in `omitted` made the screen say "1
    // disposals could not be computed" about an acquisition - the recorded
    // one-wallet report said 56, which is how a warning that exists to be
    // read gets ignored.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 404 })),
    );

    taxRegistry.push(makeModule());
    await putEvents([
      ledgerEvent({
        id: 'token-in',
        externalId: 'token-in',
        timestamp: Date.UTC(2025, 2, 1),
        legs: [
          {
            assetId: 'cardano:1234abcd.MyToken',
            amount: '5',
            direction: 'in',
            venue: 'wallet-a',
            role: 'principal',
          },
        ],
      }),
    ]);

    renderScreen();
    await runReport('2025');

    await screen.findByText(/taxable gain/i);
    // Not called a disposal...
    expect(
      screen.queryByText(/disposals could not be computed/i),
    ).not.toBeInTheDocument();
    // ...but still reported, with copy that says what it is, and still
    // listed in full below.
    expect(
      await screen.findByText(/other unresolved items are not disposals/i),
    ).toBeInTheDocument();
    // Scoped: the same item is rendered a second time in the print-only
    // copy of the list, so an unscoped query matches both.
    const list = await screen.findByTestId('unresolved-screen');
    expect(list.textContent).toMatch(/no price source is configured/i);
  });
});

describe('the CoinGecko API key', () => {
  /** A crypto disposal, so running the report really does need a
   *  historical price and really does call the provider. */
  const cryptoDisposal = ledgerEvent({
    id: 'crypto-disp',
    externalId: 'crypto-disp',
    timestamp: Date.UTC(2025, 6, 1),
    legs: [
      {
        assetId: 'cardano:lovelace',
        amount: '1000000',
        direction: 'out',
        venue: 'wallet-a',
        role: 'principal',
      },
    ],
  });

  it('sends a key entered here to the provider, as a header', async () => {
    // The key was read by resolveValues and typed in settingsStore, but
    // nothing anywhere wrote it and its help string was keyed in both
    // locales and rendered nowhere - so every price older than 365 days
    // was permanently unresolvable while the unresolved item's own reason
    // named a remedy the app offered no way to apply.
    const calls: { url: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({
          url: String(url),
          headers: (init?.headers ?? {}) as Record<string, string>,
        });
        return flatRange(1)(String(url), init);
      }),
    );

    taxRegistry.push(makeModule());
    await putEvents([cryptoDisposal]);

    renderScreen();
    await userEvent.click(
      await screen.findByRole('button', { name: /testland/i }),
    );
    await userEvent.type(
      await screen.findByLabelText(/coingecko api key/i),
      'CG-secret-key',
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /run report/i }),
    );
    await screen.findByText(/taxable gain/i);

    // The batched endpoint is /market_chart/range, not the per-day /history
    // this replaced - so a filter on the old path matched nothing and the
    // assertion below passed over an empty list.
    const historyCalls = calls.filter((call) =>
      call.url.includes('/market_chart/range'),
    );
    expect(historyCalls.length).toBeGreaterThan(0);
    for (const call of historyCalls) {
      expect(call.headers['x-cg-demo-api-key']).toBe('CG-secret-key');
      // A credential in a query string lands in the provider's own logs
      // and in any proxy in between.
      expect(call.url).not.toContain('CG-secret-key');
    }
  });

  it('persists the key and shows it again on the next report', async () => {
    vi.stubGlobal('fetch', flatRange(1));

    taxRegistry.push(makeModule());
    await putEvents([cryptoDisposal]);

    // Mounting IS the open, now that this is a route rather than a dialog:
    // the stored settings are read once, in a mount effect.
    const first = renderScreen();

    await userEvent.click(
      await screen.findByRole('button', { name: /testland/i }),
    );
    await userEvent.type(
      await screen.findByLabelText(/coingecko api key/i),
      'CG-secret-key',
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /run report/i }),
    );
    await screen.findByText(/taxable gain/i);

    // Leave and come back: the key must come back from storage, not from
    // component state. Navigating away unmounts the screen, which is a
    // stronger reset than the hand-written one the dialog needed.
    first.unmount();
    renderScreen();
    await userEvent.click(
      await screen.findByRole('button', { name: /testland/i }),
    );
    // The settings read on reopen is async, so the input starts empty and
    // fills once it lands - wait for the value rather than racing it.
    const reopened = await screen.findByLabelText(/coingecko api key/i);
    await waitFor(() => expect(reopened).toHaveValue('CG-secret-key'));
  });

  it('masks the key, because it is a credential', async () => {
    taxRegistry.push(makeModule());

    renderScreen();
    await userEvent.click(
      await screen.findByRole('button', { name: /testland/i }),
    );

    expect(await screen.findByLabelText(/coingecko api key/i)).toHaveAttribute(
      'type',
      'password',
    );
  });
});

describe('the disclaimer', () => {
  it('names the contributor and the date the rules were checked', async () => {
    const rulesCheckedOn = new Date().toISOString().slice(0, 10);
    taxRegistry.push(makeModule({ rulesCheckedOn }));

    renderScreen();
    await userEvent.click(
      await screen.findByRole('button', { name: /testland/i }),
    );

    expect(
      await screen.findByText(/written by test suite/i),
    ).toBeInTheDocument();
    const expectedDate = new Intl.DateTimeFormat(i18n.language, {
      dateStyle: 'medium',
    }).format(Date.parse(rulesCheckedOn));
    expect(
      screen.getByText(new RegExp(expectedDate.replace(/[.,]/g, '.?'))),
    ).toBeInTheDocument();
  });

  it('says how many months stale rules have gone unchecked', async () => {
    taxRegistry.push(makeModule({ rulesCheckedOn: '2000-01-01' }));

    renderScreen();
    await userEvent.click(
      await screen.findByRole('button', { name: /testland/i }),
    );

    // "last checked N months ago" - the actual age, not a fixed warning.
    expect(
      await screen.findByText(/have not been checked in \d+ months/i),
    ).toBeInTheDocument();
  });

  it('does not show a staleness warning for freshly checked rules', async () => {
    const rulesCheckedOn = new Date().toISOString().slice(0, 10);
    taxRegistry.push(makeModule({ rulesCheckedOn }));

    renderScreen();
    await userEvent.click(
      await screen.findByRole('button', { name: /testland/i }),
    );

    await screen.findByText(/written by test suite/i);
    expect(
      screen.queryByText(/have not been checked/i),
    ).not.toBeInTheDocument();
  });
});

describe('the report is a page, not a dialog', () => {
  it('is not rendered inside a dialog at all', async () => {
    // The report is a long, wide document - per disposal a date, a venue,
    // an amount, a cost basis, a gain and a sentence of reasoning. A dialog
    // capped it at sm:max-w-2xl, 672px, and everything past that was
    // clipped behind a horizontal scrollbar.
    taxRegistry.push(makeModule());
    const { container } = renderScreen();
    await screen.findByRole('button', { name: /testland/i });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(container.querySelector('[data-slot="dialog-content"]')).toBeNull();
  });

  it('pads its edges and caps itself at a page width, not a dialog width', async () => {
    // Asserted on the SCREEN'S OWN root rather than by banning strings
    // anywhere in the tree, which is what an earlier version of this test
    // did - and that version could not see `max-w-md`, the exact width the
    // jurisdiction picker inside it legitimately uses.
    //
    // The shell adds no padding of its own, so a screen that forgets it
    // renders flush against the viewport edge. This one did.
    taxRegistry.push(makeModule());
    const { container } = renderScreen();
    await screen.findByRole('button', { name: /testland/i });

    const root = container.firstElementChild as HTMLElement;
    const classes = (root.getAttribute('class') ?? '').split(/\s+/);
    expect(classes).toContain('p-6');

    // A cap is fine and desirable; a DIALOG-scale cap is the regression.
    // 2xl is 672px, the width the report was moved off.
    const cap = classes.find((name) => name.startsWith('max-w-'));
    expect(cap).toBeDefined();
    for (const tooNarrow of [
      'max-w-sm',
      'max-w-md',
      'max-w-lg',
      'max-w-xl',
      'max-w-2xl',
      'max-w-3xl',
    ]) {
      expect(cap).not.toBe(tooNarrow);
    }
  });

  it('keeps the jurisdiction picker in its own narrow column', async () => {
    // A two-item list stretched across the whole page reads as a layout
    // fault. The report below keeps the full width it was moved here for,
    // so this is a cap on the picker only.
    taxRegistry.push(makeModule());
    renderScreen();
    const choice = await screen.findByRole('button', { name: /testland/i });
    const column = choice.parentElement as HTMLElement;
    expect(column.getAttribute('class')).toMatch(/\bmax-w-(xs|sm|md|lg)\b/);
  });

  it('offers a way back to the overview', async () => {
    // A dialog had Escape and a close button for free; a route has to carry
    // its own exit.
    renderScreen();
    expect(
      await screen.findByRole('link', { name: /back to overview/i }),
    ).toHaveAttribute('href', '/');
  });

  /**
   * A MATCHED pair, both in ADA and on the same venue.
   *
   * The pairing is the point: a lone disposal has no cost basis, so the
   * engine reports it as an unresolved item and no disposal LINE is
   * rendered at all - and the line is the thing that printed the raw asset
   * id. An earlier version of this test used a lone disposal and passed
   * against both the fix and the defect.
   */
  const adaLeg = (direction: 'in' | 'out') => ({
    assetId: 'cardano:lovelace',
    amount: '1000000',
    direction,
    venue: 'wallet-a',
    role: 'principal' as const,
  });
  // Dated inside the last 365 days, and reported for the current year.
  // Older than that and historical pricing needs a CoinGecko key, so both
  // events land under "events missing a price" and NO disposal line is
  // rendered - which is how the first draft of this test passed against
  // the defect it was written for.
  const thisYear = new Date().getUTCFullYear();
  const adaAcquisition = ledgerEvent({
    id: 'ada-acq',
    externalId: 'ada-acq',
    timestamp: Date.UTC(thisYear, 0, 15),
    legs: [adaLeg('in')],
  });
  const adaDisposal = ledgerEvent({
    id: 'ada-disp',
    externalId: 'ada-disp',
    timestamp: Date.UTC(thisYear, 1, 15),
    legs: [adaLeg('out')],
  });

  it('names the asset by its symbol, never by its raw id', async () => {
    // "cardano:lovelace" sat beside every disposal. The same defect
    // CryptoAmount was changed to prevent - it survived here because this
    // line shows an asset WITHOUT an amount, so it never went through it.
    vi.stubGlobal('fetch', flatRange(1));
    taxRegistry.push(makeModule());
    await putEvents([adaAcquisition, adaDisposal]);

    const { container } = renderScreen();
    await userEvent.click(
      await screen.findByRole('button', { name: /testland/i }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /run report/i }),
    );
    await screen.findByText(/taxable gain/i);

    // Anchored on the disposal line itself: the page carries amounts
    // elsewhere that already go through CryptoAmount, so a page-wide query
    // for "ADA" would pass without the line being fixed. "Cost basis" is
    // split across elements by its Money child, so this matches on the
    // card's text rather than on a single node.
    const line = [
      ...container.querySelectorAll('[data-slot="card-content"]'),
    ].find((node) => /Cost basis/.test(node.textContent ?? ''));
    expect(line).toBeDefined();
    expect(line?.textContent).toContain('ADA');
    expect(line?.textContent).not.toContain('cardano:lovelace');
  });
});

describe('printing the report', () => {
  const runAndPrint = async () => {
    taxRegistry.push(makeModule());
    await putEvents([acquisitionEvent, disposalEvent]);
    const rendered = renderScreen();
    await runReport('2025');
    return rendered;
  };

  it('offers no print control until there is a report to print', async () => {
    // A blank form sent to a printer is pure waste, and the browser's own
    // dialog gives no hint that the page is empty.
    taxRegistry.push(makeModule());
    renderScreen();
    await userEvent.click(
      await screen.findByRole('button', { name: /testland/i }),
    );
    expect(screen.queryByRole('button', { name: /print/i })).toBeNull();
  });

  it('hands the page to the browser print dialog', async () => {
    // Which is where "Save as PDF" lives on every platform this app runs
    // on, so one button covers both.
    const print = vi.fn();
    vi.stubGlobal('print', print);
    await runAndPrint();

    await userEvent.click(screen.getByRole('button', { name: /print/i }));
    expect(print).toHaveBeenCalledTimes(1);
  });

  it('does not throw where printing is unavailable', async () => {
    // jsdom has none, and an Electron window without a print handler would
    // otherwise throw straight into the click.
    vi.stubGlobal('print', undefined);
    await runAndPrint();
    await userEvent.click(screen.getByRole('button', { name: /print/i }));
    expect(screen.getByRole('button', { name: /print/i })).toBeInTheDocument();
  });

  it('keeps the controls off the page but never the disclaimer', async () => {
    // The disclaimer is the one element this screen exists to keep
    // attached to its figures - a printed tax document that drops it is
    // the worst outcome here, worse than printing a stray button.
    const { container } = await runAndPrint();

    const printButton = screen.getByRole('button', { name: /print/i });
    expect(printButton.closest('.print\\:hidden')).not.toBeNull();

    const disclaimer = screen.getByText(/not advice from a lawyer/i);
    expect(disclaimer.closest('.print\\:hidden')).toBeNull();

    // And the figures themselves stay.
    const gain = screen.getByText(/taxable gain/i);
    expect(gain.closest('.print\\:hidden')).toBeNull();
    expect(container.querySelector('.print\\:hidden')).not.toBeNull();
  });

  it('states the year, the date and the software on paper, where the screen cannot', async () => {
    // A sheet outlives the screen it came from, so it has to say what it
    // is, when it was made and what made it. Print-only, because on screen
    // the year is in the form right above and the date is today.
    const { container } = await runAndPrint();
    // Scoped by testid rather than by a Tailwind class: "Tax year" is also
    // the label of the form field above, so an unscoped query matches both
    // and the assertion would hold without the header existing at all - and
    // the previous version of this test, which scoped by `.print:block`,
    // broke the moment the header became a flex column without anything
    // about its behaviour changing.
    const header = container.querySelector('[data-testid="report-header"]');
    expect(header).not.toBeNull();
    expect(header?.textContent).toContain('2025');
    expect(header?.textContent).toMatch(/2026/); // the date it was made
    expect(header?.textContent).toMatch(/Coineda/);
    // Hidden on screen, where the year is already in the form above.
    expect(header?.className).toContain('hidden');
  });
});

describe('reading the unresolved list', () => {
  /** A module whose assessment carries a fixed set of unresolved items, so
   *  their years and order are the test's to choose. */
  const withUnresolved = (items: UnresolvedItem[]): TaxModule => {
    const base = makeModule();
    return {
      ...base,
      assess: (input) => ({ ...base.assess(input), unresolved: items }),
    };
  };

  const gap = (
    label: string,
    timestamp: number,
    overrides: Partial<UnresolvedItem> = {},
  ): UnresolvedItem => ({
    kind: 'needs-price',
    sourceEventId: label,
    assetId: 'cardano:lovelace',
    amount: '1000000',
    venue: 'wallet-a',
    timestamp,
    reason: { key: `gap ${label}` },
    taxEventKind: 'acquisition',
    resolutions: [],
    ...overrides,
  });

  /** The reasons, in the order the SCREEN renders them.
   *
   *  Scoped to the screen list on purpose: the document renders a second,
   *  unfiltered copy for print, so an unscoped query returns both and every
   *  assertion about the filter's effect would read the two concatenated. */
  const renderedOrder = (container: HTMLElement): string[] =>
    [
      ...(container
        .querySelector('[data-testid="unresolved-screen"]')
        ?.querySelectorAll('[role="alert"]') ?? []),
    ]
      .map((node) => node.textContent ?? '')
      .map((text) => /gap (\S+)/.exec(text)?.[1] ?? '')
      .filter(Boolean);

  const threeYears = [
    gap('c', Date.UTC(2026, 0, 5)),
    gap('a', Date.UTC(2023, 5, 1)),
    gap('b', Date.UTC(2025, 3, 9)),
  ];

  it('accounts on paper for every item the heading counts', async () => {
    // The heading states a TOTAL, and the recorded report stated 65 while
    // the printed list showed 1, because the screen's filter reached the
    // page. Nothing may be silently absent from the sheet.
    //
    // Listed in full is not the same as accounted for, though. Of 65 items
    // in that report, 60 were acquisitions from earlier years that could
    // not be priced - no disposal, nothing inside the tax year, no bearing
    // on any figure - and printing them ran to six pages that buried the
    // two items which did matter. So the page lists what moved a figure
    // and states an exact count and span for the rest.
    taxRegistry.push(
      withUnresolved([
        gap('in-year', Date.UTC(2025, 0, 1)),
        gap('older', Date.UTC(2023, 0, 1)),
        gap('oldest', Date.UTC(2022, 0, 1)),
      ]),
    );
    await putEvents([acquisitionEvent, disposalEvent]);

    const { container } = renderScreen();
    await runReport('2025');

    const screenList = container.querySelector(
      '[data-testid="unresolved-screen"]',
    );
    const printList = container.querySelector(
      '[data-testid="unresolved-print"]',
    );

    // The screen's filter is on by default and hides the two older ones.
    expect(screenList?.querySelectorAll('[data-slot="card"]')).toHaveLength(1);
    expect(screenList?.className).toContain('print:hidden');

    // On paper: the in-year item in full, and the other two counted.
    expect(printList?.querySelectorAll('[data-slot="card"]')).toHaveLength(1);
    const summary = container.querySelector(
      '[data-testid="unresolved-summary"]',
    );
    expect(summary?.textContent).toMatch(/\b2\b/);

    // 1 listed + 2 counted = the 3 the heading claims. The arithmetic is
    // the point: a page that lists fewer than it counts is the defect.
    expect(
      (printList?.querySelectorAll('[data-slot="card"]').length ?? 0) + 2,
    ).toBe(3);
  });

  it('lists them in date order, not in the order the engine produced them', async () => {
    // A wallet's whole history lands here, and the engine's own order is
    // not one a reader can follow.
    taxRegistry.push(withUnresolved(threeYears));
    await putEvents([acquisitionEvent, disposalEvent]);
    const { container } = renderScreen();
    await runReport('2025');
    // All three visible, so the order is observable at all.
    await userEvent.click(
      screen.getByRole('checkbox', { name: /outside the tax year/i }),
    );

    expect(renderedOrder(container)).toEqual(['a', 'b', 'c']);
  });

  it('hides the other years by default, and says how many', async () => {
    // The list is otherwise O(the whole ledger) and grows every year: the
    // pipeline reads the ENTIRE history - a lot acquired years ago must
    // still match a disposal now - and never filters `unresolved` by year.
    // Only `omitted` is year-scoped.
    //
    // Never silently, though: a list that shrank from three entries to one
    // with nothing explaining it is worse than the noise it replaced.
    taxRegistry.push(withUnresolved(threeYears));
    await putEvents([acquisitionEvent, disposalEvent]);
    const { container } = renderScreen();
    await runReport('2025');

    expect(renderedOrder(container)).toEqual(['b']);
    expect(
      screen.getByRole('checkbox', { name: /outside the tax year/i }),
    ).toBeChecked();

    // Nothing disappears silently: the heading states the whole count and
    // how much of it the year accounts for, so a list showing one row out
    // of three still says so.
    const heading = screen.getByText(/not included in the figures above/i);
    expect(heading.textContent).toMatch(/3/);
    expect(heading.textContent).toMatch(/1/);
    expect(heading.textContent).toMatch(/2025/);
  });

  it('states the plain total when every item is inside the year', async () => {
    // "3 total, 3 in 2025" says the same thing twice, so the breakdown
    // appears only when there is one to make.
    taxRegistry.push(
      withUnresolved([
        gap('x', Date.UTC(2025, 1, 1)),
        gap('y', Date.UTC(2025, 7, 2)),
      ]),
    );
    await putEvents([acquisitionEvent, disposalEvent]);
    renderScreen();
    await runReport('2025');

    const heading = screen.getByText(/not included in the figures above/i);
    expect(heading.textContent).toMatch(/2/);
    expect(heading.textContent).not.toMatch(/in 2025/);
  });

  it('brings every year back in one click', async () => {
    // Hiding is a default, not a decision taken for the user: an
    // out-of-year entry says WHICH acquisition could not be priced, which
    // is the detail behind an in-year cost-basis gap.
    taxRegistry.push(withUnresolved(threeYears));
    await putEvents([acquisitionEvent, disposalEvent]);
    const { container } = renderScreen();
    await runReport('2025');

    await userEvent.click(
      screen.getByRole('checkbox', { name: /outside the tax year/i }),
    );

    expect(renderedOrder(container)).toEqual(['a', 'b', 'c']);
  });

  it('judges the year in UTC, where the boundary actually is', async () => {
    // 2026-01-01T00:30 UTC is still 2025 in any timezone west of London. A
    // local reading moves an event across the year boundary - which is
    // precisely the boundary this filter is about.
    taxRegistry.push(
      withUnresolved([
        gap('newyear', Date.UTC(2026, 0, 1, 0, 30)),
        gap('inyear', Date.UTC(2025, 6, 1)),
      ]),
    );
    await putEvents([acquisitionEvent, disposalEvent]);
    const { container } = renderScreen();
    await runReport('2025');

    expect(renderedOrder(container)).toEqual(['inyear']);
  });
});

describe('the threshold line', () => {
  it('does not put a dash where a minus sign would be read', async () => {
    // "Nicht erreicht - 144,47 €" reads as minus 144,47. The figure is a
    // distance below the limit and is positive.
    taxRegistry.push(makeModule());
    renderScreen();
    await runReport('2025');

    const line = await screen.findByText(/under the limit/i);
    expect(line.textContent).not.toMatch(/-\s*€/);
    expect(line.textContent).not.toMatch(/-\s*\d/);
  });
});

describe('the lots behind a disposal', () => {
  it('names the acquisition date, quantity and holding period of each lot', async () => {
    taxRegistry.push(makeModule());
    await putEvents([acquisitionEvent, disposalEvent]);

    renderScreen();
    await runReport('2025');

    // Acquired 2025-06-01, disposed 2025-07-01: 30 days. A §23 holding
    // period is a claim about WHEN something was bought, and this is the
    // only thing on the sheet a reader can check that claim against.
    expect(await screen.findByText(/Acquired/)).toBeInTheDocument();
    expect(screen.getByText(/30 days/)).toBeInTheDocument();
  });

  it('labels a fork lot so a cost basis of 0 is explained', async () => {
    taxRegistry.push({
      ...makeModule(),
      classify: (event, ...rest) =>
        classify(event, ...rest).map((taxEvent) =>
          taxEvent.kind === 'acquisition'
            ? { ...taxEvent, origin: { key: 'fork-at-zero' } }
            : taxEvent,
        ),
    });
    await putEvents([acquisitionEvent, disposalEvent]);

    renderScreen();
    await runReport('2025');

    expect(
      await screen.findByText(/Hard fork — acquired at 0 \(BMF 06\.03\.2025\)/),
    ).toBeInTheDocument();
  });

  it('shows the fee share of a lot, and leaves the gain where it was', async () => {
    taxRegistry.push({
      ...makeModule(),
      classify: (event, ...rest) =>
        classify(event, ...rest).map((taxEvent) =>
          taxEvent.kind === 'acquisition'
            ? {
                ...taxEvent,
                costs: [{ assetId: 'fiat:eur', amount: '2' }],
              }
            : taxEvent,
        ),
    });
    await putEvents([acquisitionEvent, disposalEvent]);

    renderScreen();
    await runReport('2025');

    expect(await screen.findByText(/of which fees/)).toBeInTheDocument();
  });

  it('prints no fee share for a lot bought without a fee', async () => {
    taxRegistry.push(makeModule());
    await putEvents([acquisitionEvent, disposalEvent]);

    renderScreen();
    await runReport('2025');

    expect(await screen.findByText(/Acquired/)).toBeInTheDocument();
    expect(screen.queryByText(/of which fees/)).not.toBeInTheDocument();
  });

  it('never prints an acquisition date for an averaged pool', async () => {
    // matchMovingAverage gives its synthetic lot the DISPOSAL's own
    // timestamp as acquiredAt and heldDays 0, because an averaged pool has
    // no acquisition date. Printing that as "Acquired 01.07.2025" on a
    // disposal dated 01.07.2025 would put a falsehood in a document filed
    // with an authority.
    taxRegistry.push({ ...makeModule(), defaultMatching: 'moving-average' });
    await putEvents([acquisitionEvent, disposalEvent]);

    renderScreen();
    await runReport('2025');

    expect(await screen.findByText(/pooled cost/i)).toBeInTheDocument();
    expect(screen.queryByText(/Acquired/)).not.toBeInTheDocument();
  });
});

describe('who the report is for', () => {
  it('prints the taxpayer and labels what was not given', async () => {
    await putSettings({ taxpayer: { name: 'Erika Mustermann' } });
    taxRegistry.push(makeModule());
    await putEvents([acquisitionEvent, disposalEvent]);

    renderScreen();
    await runReport('2025');

    // A sheet nobody can assign to a Steuerfall is worthless, and a field
    // left out silently reads as a field that does not exist - so an
    // unstated tax number prints as a labelled blank the taxpayer can fill
    // in by hand, not as nothing at all.
    expect(await screen.findByText(/Erika Mustermann/)).toBeInTheDocument();
    expect(screen.getByText(/not stated/i)).toBeInTheDocument();
  });

  it('keeps what it has been told, so it need only be typed once', async () => {
    taxRegistry.push(makeModule());
    renderScreen();

    await userEvent.click(
      await screen.findByRole('button', { name: /testland/i }),
    );
    const nameInput = await screen.findByLabelText(/your name/i);
    await userEvent.type(nameInput, 'Erika Mustermann');
    await userEvent.tab();

    await waitFor(async () => {
      const settings = await getSettings();
      expect(settings?.taxpayer?.name).toBe('Erika Mustermann');
    });
  });
});

describe('where the figures come from', () => {
  it('names each source, its wallets and how much it contributed', async () => {
    await putSource({
      id: 's1',
      moduleId: 'kraken-csv',
      label: 'My Kraken account',
      config: { apiKey: 'cg-secret-value' },
    });
    taxRegistry.push(makeModule());
    await putEvents([acquisitionEvent, disposalEvent]);

    renderScreen();
    await runReport('2025');

    // Scoped to the directory: the venue now also appears on every
    // disposal line, so an unscoped /wallet-a/ matches several elements and
    // would hold whether or not the directory rendered at all.
    const directory = await screen.findByTestId('source-directory');
    expect(directory.textContent).toContain('My Kraken account');
    expect(directory.textContent).toContain('kraken-csv');
    expect(directory.textContent).toContain('wallet-a');
    expect(directory.textContent).toMatch(/2 events/);
  });

  it('prints a chain source address but nothing for a CSV source', async () => {
    await putSource({
      id: 's1',
      moduleId: 'cardano-blockfrost',
      label: 'My wallet',
      config: {
        projectId: 'proj-secret-value',
        address: 'addr1qpublicidentity',
      },
    });
    taxRegistry.push(makeModule());
    await putEvents([acquisitionEvent, disposalEvent]);

    renderScreen();
    await runReport('2025');

    const directory = await screen.findByTestId('source-directory');
    expect(directory.textContent).toMatch(/addresses and keys/i);
    expect(directory.textContent).toContain('addr1qpublicidentity');
    expect(directory.textContent).not.toContain('proj-secret-value');
  });

  it('warns that an xpub reveals every address, only when one is printed', async () => {
    await putSource({
      id: 's1',
      moduleId: 'bitcoin-esplora',
      label: 'My bitcoin',
      config: { xpub: 'zpub6publickey' },
    });
    taxRegistry.push(makeModule());
    await putEvents([acquisitionEvent, disposalEvent]);

    renderScreen();
    await runReport('2025');

    const directory = await screen.findByTestId('source-directory');
    expect(directory.textContent).toContain('zpub6publickey');
    expect(directory.textContent).toMatch(
      /an extended public key reveals every address of the wallet/i,
    );
  });

  it('gives no xpub warning for a plain address', async () => {
    await putSource({
      id: 's1',
      moduleId: 'cardano-blockfrost',
      label: 'My wallet',
      config: { projectId: 'p', address: 'addr1qpublicidentity' },
    });
    taxRegistry.push(makeModule());
    await putEvents([acquisitionEvent, disposalEvent]);

    renderScreen();
    await runReport('2025');

    const directory = await screen.findByTestId('source-directory');
    expect(directory.textContent).toContain('addr1qpublicidentity');
    expect(directory.textContent).not.toMatch(/extended public key/i);
  });

  it('prints no identities line for a CSV source', async () => {
    await putSource({
      id: 's1',
      moduleId: 'kraken-csv',
      label: 'My Kraken account',
      config: { apiKey: 'cg-secret-value' },
    });
    taxRegistry.push(makeModule());
    await putEvents([acquisitionEvent, disposalEvent]);

    renderScreen();
    await runReport('2025');

    const directory = await screen.findByTestId('source-directory');
    expect(directory.textContent).not.toMatch(/addresses and keys/i);
  });

  it('never prints a source credential', async () => {
    await putSource({
      id: 's1',
      moduleId: 'kraken-csv',
      label: 'My Kraken account',
      config: { apiKey: 'cg-secret-value' },
    });
    taxRegistry.push(makeModule());
    await putEvents([acquisitionEvent, disposalEvent]);

    const { container } = renderScreen();
    await runReport('2025');

    expect(container.textContent).not.toContain('cg-secret-value');
  });
});

describe('what reaches the paper', () => {
  it('keeps the input form off the printed page', async () => {
    // An empty API-key box, its help text and a tax-rate field printed in
    // the middle of a document handed to a tax office.
    //
    // This used to assert the form carried `print:hidden`. It no longer
    // carries anything, because the form and the report are separate steps
    // and the form is not rendered at all once the report is showing -
    // which is the same guarantee reached structurally rather than by a
    // class that a later edit could drop. Asserted over the whole tree, so
    // a field reintroduced anywhere on this step fails it.
    taxRegistry.push(makeModule());
    await putEvents([acquisitionEvent, disposalEvent]);

    const { container } = renderScreen();
    await runReport('2025');

    expect(container.querySelector('[data-testid="report-form"]')).toBeNull();
    expect(container.querySelectorAll('input')).toHaveLength(0);
    expect(screen.queryByLabelText(/coingecko/i)).toBeNull();
    // And the document itself is there.
    expect(screen.getByText(/taxable gain/i)).toBeInTheDocument();
  });

  it('says so when the tax year has not ended yet', async () => {
    taxRegistry.push(makeModule());
    await putEvents([acquisitionEvent, disposalEvent]);

    renderScreen();
    // 2026 is the current year under the system clock these tests run on.
    await runReport(String(new Date().getUTCFullYear()));

    expect(await screen.findByText(/has not ended yet/i)).toBeInTheDocument();
  });

  it('does not call a year that has ended an interim figure', async () => {
    taxRegistry.push(makeModule());
    await putEvents([acquisitionEvent, disposalEvent]);

    renderScreen();
    await runReport('2025');

    expect(screen.queryByText(/has not ended yet/i)).not.toBeInTheDocument();
  });
});

describe('labels that match their sign and their scope', () => {
  /** A module whose exempt side is a LOSS: lots held past the holding
   *  period that lost money. Printing that under the word "gain" is what
   *  produced "Steuerfreier Gewinn: -9,10 EUR" on the recorded report. */
  const withExemptLoss = (): TaxModule => {
    const base = makeModule();
    return {
      ...base,
      assess: (input) => ({
        ...base.assess(input),
        totals: {
          ...base.assess(input).totals,
          exemptGain: '-9.1',
        },
      }),
    };
  };

  it('calls a negative tax-free figure a loss, not a gain', async () => {
    taxRegistry.push(withExemptLoss());
    await putEvents([acquisitionEvent, disposalEvent]);

    renderScreen();
    await runReport('2025');

    expect(await screen.findByText(/tax-free loss/i)).toBeInTheDocument();
    expect(screen.queryByText(/tax-free gain/i)).not.toBeInTheDocument();
  });

  it('prints a threshold scope note only where the jurisdiction supplies one', async () => {
    // "1.000,00 EUR under the limit" reads as "nothing to declare", so a
    // limit wider than crypto has to say so. But the note belongs to the
    // THRESHOLD, not to the screen: Germany returns two thresholds and only
    // §23's is about private sales - printed under the §22 Nr. 3 staking
    // Freigrenze the same sentence claims staking income consumes a
    // private-sale allowance. This asserts the screen renders what it is
    // given, and nothing where it is given nothing.
    const base = makeModule();
    taxRegistry.push({
      ...base,
      assess: (input) => {
        const assessed = base.assess(input);
        return {
          ...assessed,
          thresholds: [
            { ...assessed.thresholds[0], scopeNote: 'Covers more than crypto' },
            { ...assessed.thresholds[0], label: 'Second threshold' },
          ],
        };
      },
    });
    await putEvents([acquisitionEvent, disposalEvent]);

    const { container } = renderScreen();
    await runReport('2025');

    expect(
      await screen.findByText(/covers more than crypto/i),
    ).toBeInTheDocument();
    // Exactly one, not one per threshold card.
    expect(
      [...container.querySelectorAll('p')].filter((node) =>
        /covers more than crypto/i.test(node.textContent ?? ''),
      ),
    ).toHaveLength(1);
  });
});

/** A module whose unresolved items sit outside the tax year, so the
 *  screen's default filter hides them while the totals card still counts
 *  them. */
const gapAt = (timestamp: number, label: string): UnresolvedItem => ({
  kind: 'needs-price',
  sourceEventId: label,
  assetId: 'cardano:lovelace',
  amount: '1000000',
  venue: 'wallet-a',
  timestamp,
  reason: { key: `gap ${label}` },
  taxEventKind: 'acquisition',
  resolutions: [],
});

const withUnresolvedOutsideYear = (items: UnresolvedItem[]): TaxModule => {
  const base = makeModule();
  return {
    ...base,
    assess: (input) => ({ ...base.assess(input), unresolved: items }),
  };
};

describe('what the totals card promises about the list below it', () => {
  it('does not promise every item is listed while the filter hides some', async () => {
    // The printed half of this was fixed by rendering a complete list for
    // paper. On screen the filter is ON by default, so the same sentence
    // promised 64 rows above a list showing none of them - the recorded
    // report's own contradiction, surviving in the medium it was found in.
    taxRegistry.push(
      withUnresolvedOutsideYear([
        gapAt(Date.UTC(2023, 0, 1), 'older'),
        gapAt(Date.UTC(2022, 0, 1), 'oldest'),
      ]),
    );
    await putEvents([acquisitionEvent, disposalEvent]);

    renderScreen();
    await runReport('2025');

    await screen.findByText(/other unresolved items/i);
    expect(
      screen.queryByText(/each one is listed below/i),
    ).not.toBeInTheDocument();
  });

  it('promises it once nothing is hidden', async () => {
    taxRegistry.push(
      withUnresolvedOutsideYear([
        gapAt(Date.UTC(2023, 0, 1), 'older'),
        gapAt(Date.UTC(2022, 0, 1), 'oldest'),
      ]),
    );
    await putEvents([acquisitionEvent, disposalEvent]);

    renderScreen();
    await runReport('2025');
    await userEvent.click(
      screen.getByRole('checkbox', { name: /outside the tax year/i }),
    );

    expect(
      await screen.findByText(/each one is listed below/i),
    ).toBeInTheDocument();
  });
});

describe('the taxpayer identity survives a slow or failed settings read', () => {
  it('does not overwrite a stored name before settings have loaded', async () => {
    await putSettings({
      taxpayer: { name: 'Erika Mustermann', taxNumber: '12/345/67890' },
    });
    taxRegistry.push(makeModule());

    // The read is held open for the whole interaction, which is the state
    // the screen is genuinely in on a slow device - and the state a failed
    // read leaves it in permanently. Without a guard, blurring the field
    // while `taxpayerName` is still '' writes two empty strings over a
    // stored identity, and `putSettings` replaces the taxpayer object
    // wholesale rather than merging into it.
    let release: (value: Settings | null) => void = () => {};
    const held = new Promise<Settings | null>((resolve) => {
      release = resolve;
    });
    const spy = vi
      .spyOn(settingsStore, 'getSettings')
      .mockReturnValueOnce(held);

    try {
      renderScreen();
      await userEvent.click(
        await screen.findByRole('button', { name: /testland/i }),
      );

      // Focus and blur without typing - what a user does tabbing through
      // the form.
      const nameInput = await screen.findByLabelText(/your name/i);
      await userEvent.click(nameInput);
      await userEvent.tab();

      release(null);
    } finally {
      spy.mockRestore();
    }

    const settings = await getSettings();
    expect(settings?.taxpayer?.name).toBe('Erika Mustermann');
    expect(settings?.taxpayer?.taxNumber).toBe('12/345/67890');
  });
});

describe('what the sheet says about its own origin', () => {
  it('prints a letterhead and a colophon, neither of them on screen', async () => {
    taxRegistry.push(makeModule());
    await putEvents([acquisitionEvent, disposalEvent]);

    const { container } = renderScreen();
    await runReport('2025');

    // A sheet that arrives at a tax office with no issuer reads as an
    // anonymous printout, and Rn. 29b of the BMF letter this report cites
    // makes the point that such a report carries no authority of its own -
    // so it has to say what produced it and where that can be checked.
    const letterhead = container.querySelector('[data-print="letterhead"]');
    const colophon = container.querySelector('[data-print="colophon"]');
    expect(letterhead?.className).toContain('print:flex');
    expect(letterhead?.className).toContain('hidden');
    expect(colophon?.className).toContain('print:flex');
    expect(colophon?.className).toContain('hidden');
  });

  it('names the project, its licence and where to find the source', async () => {
    taxRegistry.push(makeModule());
    await putEvents([acquisitionEvent, disposalEvent]);

    const { container } = renderScreen();
    await runReport('2025');

    const colophon = container.querySelector('[data-print="colophon"]');
    // Written out, not linked: a hyperlink on paper is not one.
    expect(colophon?.textContent).toContain('github.com/fabianbormann/Coineda');
    expect(colophon?.textContent).toMatch(/GPLv3/);
    expect(colophon?.textContent).toMatch(/open-source|quelloffen/i);
  });

  it('carries the mark as document content, so it does not need background graphics', async () => {
    // The gradient rule beside it is a background image and the print
    // dialog drops those by default; the mark is an <img> in the flow and
    // prints either way, which is why the issuer is identified by the mark
    // and not by the gradient.
    taxRegistry.push(makeModule());
    await putEvents([acquisitionEvent, disposalEvent]);

    const { container } = renderScreen();
    await runReport('2025');

    const mark = container.querySelector('[data-print="mark"]');
    expect(mark?.tagName).toBe('IMG');
    expect(mark?.getAttribute('src')).toMatch(/coineda-mark/);
  });
});

describe('the form and the report are separate steps', () => {
  it('replaces the form with the report once the run finishes', async () => {
    taxRegistry.push(makeModule());
    await putEvents([acquisitionEvent, disposalEvent]);

    renderScreen();
    await runReport('2025');

    // Appending a document under a form it does not belong to is what made
    // the screen read as "content suddenly appeared": the controls that
    // produced the figures stayed above them, and a stale result sat under
    // a form showing different inputs.
    expect(screen.queryByLabelText(/^steuerjahr$|^tax year$/i)).toBeNull();
    expect(screen.queryByLabelText(/coingecko/i)).toBeNull();
    expect(screen.getByText(/taxable gain/i)).toBeInTheDocument();
  });

  it('returns to the form with the values still in it', async () => {
    taxRegistry.push(makeModule());
    await putEvents([acquisitionEvent, disposalEvent]);

    renderScreen();
    await runReport('2025');
    await userEvent.click(
      screen.getByRole('button', {
        name: /change your answers|eingaben ändern/i,
      }),
    );

    expect(await screen.findByLabelText(/^tax year$/i)).toHaveValue(2025);
    expect(screen.queryByText(/taxable gain/i)).toBeNull();
  });

  it('offers the finished report again without recomputing it', async () => {
    // A run takes minutes - one historical price lookup per disposal - so
    // stepping back to read an input must not cost one.
    taxRegistry.push(makeModule());
    await putEvents([acquisitionEvent, disposalEvent]);

    renderScreen();
    await runReport('2025');
    await userEvent.click(
      screen.getByRole('button', {
        name: /change your answers|eingaben ändern/i,
      }),
    );
    await userEvent.click(
      await screen.findByRole('button', {
        name: /view the report|zum report/i,
      }),
    );

    expect(await screen.findByText(/taxable gain/i)).toBeInTheDocument();
  });

  it('discards the result when an input that feeds it changes', async () => {
    taxRegistry.push(makeModule());
    await putEvents([acquisitionEvent, disposalEvent]);

    renderScreen();
    await runReport('2025');
    await userEvent.click(
      screen.getByRole('button', {
        name: /change your answers|eingaben ändern/i,
      }),
    );

    const year = await screen.findByLabelText(/^tax year$/i);
    await userEvent.clear(year);
    await userEvent.type(year, '2024');

    // No way forward to a report computed for a different year.
    expect(
      screen.queryByRole('button', { name: /view the report|zum report/i }),
    ).toBeNull();
  });

  it('keeps the result when only the printed identity changes', async () => {
    // The name and the tax number appear on the sheet and in no figure, so
    // correcting a typo must not cost a recomputation.
    taxRegistry.push(makeModule());
    await putEvents([acquisitionEvent, disposalEvent]);

    renderScreen();
    await runReport('2025');
    await userEvent.click(
      screen.getByRole('button', {
        name: /change your answers|eingaben ändern/i,
      }),
    );
    await userEvent.type(
      await screen.findByLabelText(/your name/i),
      'Erika Mustermann',
    );

    expect(
      screen.getByRole('button', { name: /view the report|zum report/i }),
    ).toBeInTheDocument();
  });

  it('lists each income event under its own heading', async () => {
    taxRegistry.push(germanTax);
    await putEvents([
      ledgerEvent({
        id: 'reward',
        externalId: 'reward',
        kind: 'reward',
        rewardKind: 'leader',
        timestamp: Date.UTC(new Date().getUTCFullYear(), 0, 2),
        // A leader reward, so the module's note is on the row as well.
        raw: { epoch: 1, type: 'leader' },
        legs: [
          {
            assetId: 'fiat:eur',
            amount: '5',
            direction: 'in',
            venue: 'stake-venue',
            role: 'principal',
          },
        ],
      }),
    ]);

    renderScreen();
    await userEvent.click(
      await screen.findByRole('button', { name: /germany/i }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /run report/i }),
    );

    const section = await screen.findByTestId('income-lines');
    expect(within(section).getByText(/stake-venue/)).toBeInTheDocument();
    expect(within(section).getByText(/value at receipt/i)).toBeInTheDocument();
    expect(
      within(section).getByText(/pool operator reward/i),
    ).toBeInTheDocument();
    expect(
      within(section).getByText(/gewerbliche Einkünfte/),
    ).toBeInTheDocument();
  });

  it('shows the expenses of an income event that had a fee', async () => {
    taxRegistry.push(germanTax);
    await putEvents([
      ledgerEvent({
        id: 'reward',
        externalId: 'reward',
        kind: 'reward',
        rewardKind: 'staking',
        timestamp: Date.UTC(new Date().getUTCFullYear(), 0, 2),
        legs: [
          {
            assetId: 'fiat:eur',
            amount: '1',
            direction: 'out',
            venue: 'stake-venue',
            role: 'fee',
          },
          {
            assetId: 'fiat:eur',
            amount: '5',
            direction: 'in',
            venue: 'stake-venue',
            role: 'principal',
          },
        ],
      }),
    ]);

    renderScreen();
    await userEvent.click(
      await screen.findByRole('button', { name: /germany/i }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /run report/i }),
    );

    const section = await screen.findByTestId('income-lines');
    expect(within(section).getByText(/^expenses/i)).toBeInTheDocument();
  });
});

describe('the derivatives section', () => {
  const capitalModule = (withCapital: boolean): TaxModule => ({
    ...makeModule(),
    assess: (input) => ({
      ...assess(input),
      ...(withCapital
        ? {
            capital: {
              gains: '500',
              losses: '200',
              notDeducted: '5',
              net: '300',
              allowance: '1000',
              taxable: '0',
              carryForwardUsed: '0',
              loss: '0',
              note: 'Test capital note',
            },
          }
        : {}),
    }),
  });

  it('renders the figures and the note when the assessment carries capital', async () => {
    taxRegistry.push(capitalModule(true));
    await putEvents([acquisitionEvent, disposalEvent]);

    renderScreen();
    await runReport('2025');

    expect(await screen.findByText(/derivatives/i)).toBeInTheDocument();
    expect(screen.getByText(/allowance applied/i)).toBeInTheDocument();
    expect(screen.getByText('Test capital note')).toBeInTheDocument();
    expect(screen.getByText(/^not deducted/i)).toBeInTheDocument();
    expect(screen.getByTestId('capital-lines')).toHaveTextContent(
      /no derivative settlements/i,
    );
  });

  const capitalCarryModule = (): TaxModule => {
    const base = capitalModule(true);
    return {
      ...base,
      assess: (input) => {
        const result = base.assess(input);
        return {
          ...result,
          capital: {
            ...result.capital!,
            gains: '1500',
            losses: '0',
            net: '1500',
            carryForwardUsed: '600',
          },
          carryForward: {
            capital: { declared: '600', used: '600', remaining: '0' },
          },
        };
      },
    };
  };

  it('prints the §20 carry-forward line between the net result and the allowance', async () => {
    taxRegistry.push(capitalCarryModule());
    await putEvents([acquisitionEvent, disposalEvent]);

    renderScreen();
    await runReport('2025');

    const section = await screen.findByTestId('capital');
    const line = within(section).getByTestId('carry-forward-capital');
    expect(line).toHaveTextContent(/as stated by the Finanzamt/);
    expect(line).toHaveTextContent(/€600\.00 used this year/);
    expect(line).toHaveTextContent(/€0\.00 remaining/);
    // Read top to bottom: net, minus the carry, then the allowance.
    const net = within(section).getByText(/^net result/i);
    const allowance = within(section).getByText(/^allowance applied/i);
    expect(
      net.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      line.compareDocumentPosition(allowance) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('notes under the taxable line that the Finanzamt applies a §20 carry-forward', async () => {
    taxRegistry.push(capitalCarryModule());
    await putEvents([acquisitionEvent, disposalEvent]);

    renderScreen();
    await runReport('2025');

    const section = await screen.findByTestId('capital');
    expect(
      within(section).getByText(
        /the finanzamt applies the carry-forward it has recorded; declare the gain before it\./i,
      ),
    ).toBeInTheDocument();
  });

  it('prints no carry-forward note in the derivatives card without one', async () => {
    taxRegistry.push(capitalModule(true));
    await putEvents([acquisitionEvent, disposalEvent]);

    renderScreen();
    await runReport('2025');

    const section = await screen.findByTestId('capital');
    expect(
      within(section).queryByText(/declare the gain before it/i),
    ).toBeNull();
  });

  it('renders no such section when the assessment has no capital', async () => {
    taxRegistry.push(capitalModule(false));
    await putEvents([acquisitionEvent, disposalEvent]);

    renderScreen();
    await runReport('2025');

    await screen.findByText(/taxable gain/i);
    expect(screen.queryByText(/derivatives/i)).toBeNull();
    expect(screen.queryByTestId('capital-lines')).toBeNull();
  });

  it('renders a gain and a loss from one settlement as two rows, each keyed', async () => {
    // One derivative event can produce two capital events - a principal
    // profit and the fee charged on it - with the same sourceEventId.
    // Keyed on that id alone, React warned and could drop one of them.
    const errors: unknown[][] = [];
    const spy = vi
      .spyOn(console, 'error')
      .mockImplementation((...args: unknown[]) => {
        errors.push(args);
      });
    try {
      taxRegistry.push({
        ...capitalModule(true),
        handles: [...makeModule().handles, 'derivative'],
        classify: (event) =>
          event.kind === 'derivative'
            ? event.legs.map((leg) => ({
                sourceEventId: event.id,
                kind:
                  leg.role === 'fee'
                    ? ('capital-loss' as const)
                    : ('capital-gain' as const),
                assetId: leg.assetId,
                amount: leg.amount,
                timestamp: event.timestamp,
                venue: leg.venue,
                ...(leg.role === 'fee'
                  ? { deductible: false, note: 'Test row note' }
                  : {}),
              }))
            : classify(event),
      });
      await putEvents([
        ledgerEvent({
          id: 'settle',
          externalId: 'settle',
          kind: 'derivative',
          derivative: { kind: 'pnl' },
          legs: [
            {
              assetId: 'fiat:eur',
              amount: '50',
              direction: 'in',
              venue: 'futures',
              role: 'principal',
            },
            {
              assetId: 'fiat:eur',
              amount: '1',
              direction: 'out',
              venue: 'futures',
              role: 'fee',
            },
          ],
        }),
      ]);

      renderScreen();
      await runReport('2025');

      const lines = await screen.findByTestId('capital-lines');
      expect(lines).toHaveTextContent(/· Profit/);
      expect(lines).toHaveTextContent(/· Loss/);
      // Each row names what the settlement was.
      expect(lines).toHaveTextContent(/· Realised P&L/);
      // The fee's caveat and its undeducted state, from the tax event.
      expect(within(lines).getByText('Test row note')).toBeInTheDocument();
      expect(within(lines).getByText(/\(not deducted\)/i)).toBeInTheDocument();
      const keyWarnings = errors
        .map((args) => args.map(String).join(' '))
        .filter((text) => /same key/i.test(text));
      expect(keyWarnings).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the loss carry-forward inputs', () => {
  const thisYear = new Date().getUTCFullYear();

  const openGermany = async () => {
    taxRegistry.push(germanTax);
    renderScreen();
    await userEvent.click(
      await screen.findByRole('button', { name: /germany/i }),
    );
  };

  const leg = (
    assetId: string,
    amount: string,
    direction: 'in' | 'out',
  ): LedgerEvent['legs'][number] => ({
    assetId,
    amount,
    direction,
    venue: 'wallet-a',
    role: 'principal',
  });

  it('renders for Germany and not for a module without support', async () => {
    await openGermany();
    // Named as the Bescheid names it: the remaining figure as at the end of
    // the PREVIOUS year.
    expect(
      await screen.findByLabelText(
        new RegExp(
          `^Remaining loss carry-forward under §23 EStG as at 31 Dec ${thisYear - 1} \\(Verlustfeststellungsbescheid\\)$`,
        ),
      ),
    ).toBeInTheDocument();
    // The share-loss pot (§20 Abs. 6 S. 4) is excluded in the label itself:
    // it offsets only share gains, which this app never computes.
    expect(
      screen.getByLabelText(
        new RegExp(
          `^Remaining loss carry-forward under §20 EStG as at 31 Dec ${thisYear - 1}, excluding losses from selling shares \\(§20 Abs\\. 6 S\\. 4\\)$`,
        ),
      ),
    ).toBeInTheDocument();
  });

  it('does not render for a module that ignores it', async () => {
    taxRegistry.push(makeModule());
    renderScreen();
    await userEvent.click(
      await screen.findByRole('button', { name: /testland/i }),
    );
    await screen.findByLabelText(/tax year/i);
    expect(screen.queryByLabelText(/under §23 EStG/i)).toBeNull();
  });

  it('persists the figure by year and shows a blank for another year', async () => {
    await openGermany();
    const input = await screen.findByLabelText(/under §23 EStG/i);
    await userEvent.type(input, '500');
    await userEvent.tab();
    await waitFor(async () => {
      const settings = await getSettings();
      expect(settings?.lossCarryForward?.[String(thisYear)]?.privateSales).toBe(
        '500',
      );
    });

    const yearInput = screen.getByLabelText(/tax year/i);
    await userEvent.clear(yearInput);
    // No year, no "as at" date to name - so no input to label.
    expect(screen.queryByLabelText(/under §23 EStG/i)).toBeNull();
    await userEvent.type(yearInput, String(thisYear - 1));
    expect(screen.getByLabelText(/under §23 EStG/i)).toHaveValue('');
    expect(
      screen.getByLabelText(new RegExp(`as at 31 Dec ${thisYear - 2} \\(`)),
    ).toBeInTheDocument();

    await userEvent.clear(yearInput);
    await userEvent.type(yearInput, String(thisYear));
    expect(screen.getByLabelText(/under §23 EStG/i)).toHaveValue('500');
  });

  it('seeds the inputs for the year showing when a slow settings read lands', async () => {
    await putSettings({
      lossCarryForward: { [String(thisYear - 1)]: { privateSales: '700' } },
    });
    const stored = await getSettings();
    let release: (value: Settings | null) => void = () => {};
    const held = new Promise<Settings | null>((resolve) => {
      release = resolve;
    });
    const spy = vi
      .spyOn(settingsStore, 'getSettings')
      .mockReturnValueOnce(held);

    try {
      await openGermany();
      // The year changes while the read is still out...
      const yearInput = await screen.findByLabelText(/tax year/i);
      await userEvent.clear(yearInput);
      await userEvent.type(yearInput, String(thisYear - 1));
      expect(screen.getByLabelText(/under §23 EStG/i)).toHaveValue('');

      // ...so the read must seed the year now showing, not the one the
      // screen mounted with.
      release(stored);
    } finally {
      spy.mockRestore();
    }

    await waitFor(() =>
      expect(screen.getByLabelText(/under §23 EStG/i)).toHaveValue('700'),
    );
  });

  it('does not persist an invalid amount on blur, and says why', async () => {
    await putSettings({
      lossCarryForward: { [String(thisYear)]: { privateSales: '500' } },
    });
    await openGermany();
    const input = await screen.findByLabelText(/under §23 EStG/i);
    await waitFor(() => expect(input).toHaveValue('500'));
    await userEvent.clear(input);
    await userEvent.type(input, '1.000,50');
    await userEvent.tab();

    expect(await screen.findByText(/enter an amount like/i)).toBeVisible();
    expect(input).toHaveValue('1.000,50');
    const settings = await getSettings();
    expect(settings?.lossCarryForward?.[String(thisYear)]?.privateSales).toBe(
      '500',
    );
  });

  it('blocks the run on a European-formatted amount', async () => {
    await openGermany();
    const input = await screen.findByLabelText(/under §23 EStG/i);
    await userEvent.type(input, '1.000,50');
    await userEvent.click(
      await screen.findByRole('button', { name: /run report/i }),
    );
    expect(await screen.findByText(/enter an amount like/i)).toBeVisible();
    expect(screen.queryByText(/running your tax report/i)).toBeNull();
  });

  it('prints the carry-forward line after a run', async () => {
    vi.stubGlobal('fetch', flatRange(1));
    await putEvents([
      ledgerEvent({
        id: 'buy',
        externalId: 'buy',
        kind: 'trade',
        timestamp: Date.UTC(thisYear, 0, 2),
        legs: [
          leg('fiat:eur', '1000', 'out'),
          leg('cardano:lovelace', '1000000000', 'in'),
        ],
      }),
      ledgerEvent({
        id: 'sell',
        externalId: 'sell',
        kind: 'trade',
        timestamp: Date.UTC(thisYear, 0, 3),
        legs: [
          leg('cardano:lovelace', '1000000000', 'out'),
          leg('fiat:eur', '3000', 'in'),
        ],
      }),
    ]);
    await openGermany();
    await userEvent.type(
      await screen.findByLabelText(/under §23 EStG/i),
      '500',
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /run report/i }),
    );

    const line = await screen.findByTestId('carry-forward-private');
    // "Declared" is what the user does with "Loss to declare"; the carry is
    // the Finanzamt's figure and says so.
    expect(line).toHaveTextContent(/as stated by the Finanzamt/);
    expect(line).not.toHaveTextContent(/declared/i);
    expect(line).toHaveTextContent(/€500\.00 used this year/);
    expect(line).toHaveTextContent(/€0\.00 remaining/);
    expect(screen.getAllByText(/1,500\.00/).length).toBeGreaterThan(0);

    // The return takes the year's own gain; the reduced figure is labelled
    // as the estimate it is, with the reason underneath.
    const before = screen.getByTestId('gain-before-carry');
    expect(before).toHaveTextContent(
      /gain to declare \(before loss carry-forward\)/i,
    );
    expect(before).toHaveTextContent(/2,000\.00/);
    expect(
      screen.getByText(/taxable gain after carry-forward \(estimate\)/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /the finanzamt applies the carry-forward it has recorded; declare the gain before it\./i,
      ),
    ).toBeInTheDocument();
  });

  it('says under a loss that the Finanzamt adds the remaining carry-forward', async () => {
    vi.stubGlobal('fetch', flatRange(1));
    await putEvents([
      ledgerEvent({
        id: 'buy',
        externalId: 'buy',
        kind: 'trade',
        timestamp: Date.UTC(thisYear, 0, 2),
        legs: [
          leg('fiat:eur', '1000', 'out'),
          leg('cardano:lovelace', '1000000000', 'in'),
        ],
      }),
      ledgerEvent({
        id: 'sell',
        externalId: 'sell',
        kind: 'trade',
        timestamp: Date.UTC(thisYear, 0, 3),
        legs: [
          leg('cardano:lovelace', '1000000000', 'out'),
          leg('fiat:eur', '600', 'in'),
        ],
      }),
    ]);
    await openGermany();
    await userEvent.type(
      await screen.findByLabelText(/under §23 EStG/i),
      '500',
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /run report/i }),
    );

    await screen.findByTestId('carry-forward-private');
    expect(screen.getByText(/^loss to declare/i)).toBeInTheDocument();
    expect(
      screen.getByText(
        /the finanzamt adds the remaining carry-forward to this itself\./i,
      ),
    ).toBeInTheDocument();
  });

  it('leaves the Result card unchanged without a carry-forward', async () => {
    taxRegistry.push(makeModule());
    await putEvents([acquisitionEvent, disposalEvent]);
    renderScreen();
    await runReport('2025');

    expect(screen.getByText(/^taxable gain/i)).toBeInTheDocument();
    expect(screen.queryByTestId('gain-before-carry')).toBeNull();
    expect(screen.queryByText(/after carry-forward/i)).toBeNull();
    expect(screen.queryByText(/declare the gain before it/i)).toBeNull();
  });
});

describe('the filing aid', () => {
  const filingModule = (filing: TaxAssessment['filing']): TaxModule => ({
    ...makeModule(),
    assess: (input) => ({ ...assess(input), filing }),
  });
  const verified: TaxAssessment['filing'] = {
    year: 2025,
    linesVerified: true,
    sections: [
      {
        title: 'Private sales - crypto assets',
        form: 'Anlage SO',
        entries: [
          {
            label: 'Total proceeds',
            amount: '1500.50',
            reference: { form: 'Anlage SO', line: 48 },
          },
          {
            label: 'Total proceeds',
            amount: '-20',
            reference: { form: 'Anlage SO', line: 50 },
          },
          {
            label: 'Total proceeds',
            text: 'Kryptowerte',
            reference: { form: 'Anlage SO', line: 41 },
          },
        ],
      },
    ],
  };

  it('prints the line labels and the threshold sentence for a verified year', async () => {
    taxRegistry.push(filingModule(verified));
    await putEvents([acquisitionEvent, disposalEvent]);
    renderScreen();
    await runReport('2025');

    expect(
      screen.getByRole('heading', {
        name: /filing aid — anlage so and anlage kap 2025/i,
      }),
    ).toBeInTheDocument();
    const section = screen.getByTestId('filing-aid');
    expect(within(section).getByText(/line 48/i)).toBeInTheDocument();
    expect(within(section).getByText(/1,500\.50/)).toBeInTheDocument();
    // A loss to declare keeps its sign.
    expect(
      within(section).getByText(formatFiat(-20, 'en', 'eur')),
    ).toBeInTheDocument();
    expect(
      within(section).getByText(formatFiat(1500.5, 'en', 'eur')),
    ).toBeInTheDocument();
    expect(within(section).getByText('Kryptowerte')).toBeInTheDocument();
    expect(
      within(section).getByText(/the finanzamt applies the freigrenzen/i),
    ).toBeInTheDocument();
    expect(within(section).queryByText(/not verified/i)).toBeNull();
    expect(section.className).not.toMatch(/print:hidden/);
  });

  it('says the lines are not verified and prints no line label', async () => {
    taxRegistry.push(
      filingModule({
        year: 2024,
        linesVerified: false,
        sections: [
          {
            title: 'Private sales - crypto assets',
            form: 'Anlage SO',
            entries: [{ label: 'Total proceeds', amount: '100' }],
          },
        ],
      }),
    );
    await putEvents([acquisitionEvent, disposalEvent]);
    renderScreen();
    await runReport('2024');

    const section = screen.getByTestId('filing-aid');
    expect(
      within(section).getByText(
        /the line numbers of the 2024 form are not verified; use the section names\./i,
      ),
    ).toBeInTheDocument();
    expect(within(section).queryByText(/line \d/i)).toBeNull();
    expect(within(section).getByText(/total proceeds/i)).toBeInTheDocument();
  });

  it('names the source the line numbers were verified against', async () => {
    taxRegistry.push(
      filingModule({
        ...verified!,
        verifiedBy: { source: 'Test form guide', checkedOn: '2026-10-10' },
      }),
    );
    await putEvents([acquisitionEvent, disposalEvent]);
    renderScreen();
    await runReport('2025');

    const section = screen.getByTestId('filing-aid');
    // A calendar date, so it reads the same in every time zone.
    expect(
      within(section).getByText(
        'Line numbers verified against Test form guide on Oct 10, 2026.',
      ),
    ).toBeInTheDocument();
  });

  const withGapAt = (timestamp: number): TaxModule => {
    const base = filingModule(verified);
    return {
      ...base,
      assess: (input) => ({
        ...base.assess(input),
        unresolved: [
          {
            kind: 'needs-price',
            sourceEventId: 'gap',
            assetId: 'cardano:lovelace',
            amount: '1',
            venue: 'wallet-a',
            timestamp,
            reason: { key: 'gap' },
            taxEventKind: 'income',
            resolutions: [],
          },
        ],
      }),
    };
  };

  it('warns that the figures are incomplete when items are unresolved', async () => {
    taxRegistry.push(withGapAt(Date.UTC(2025, 3, 1)));
    await putEvents([acquisitionEvent, disposalEvent]);
    renderScreen();
    await runReport('2025');

    const section = screen.getByTestId('filing-aid');
    expect(
      within(section).getByText(
        'These figures are incomplete: 1 items were omitted or left unresolved (see the Result card). Resolve them before you type anything in.',
      ),
    ).toBeInTheDocument();
    // The figures are still shown beside the warning.
    expect(within(section).getByText(/line 48/i)).toBeInTheDocument();
  });

  it('does not count a gap from another year', async () => {
    taxRegistry.push(withGapAt(Date.UTC(2023, 3, 1)));
    await putEvents([acquisitionEvent, disposalEvent]);
    renderScreen();
    await runReport('2025');

    const section = screen.getByTestId('filing-aid');
    expect(
      within(section).queryByText(/these figures are incomplete/i),
    ).toBeNull();
  });

  it('prints no incompleteness warning for a complete report', async () => {
    taxRegistry.push(filingModule(verified));
    await putEvents([acquisitionEvent, disposalEvent]);
    renderScreen();
    await runReport('2025');

    const section = screen.getByTestId('filing-aid');
    expect(
      within(section).queryByText(/these figures are incomplete/i),
    ).toBeNull();
  });

  it('shows no figures when the report is not in euros', async () => {
    await putSettings({ language: 'en', baseCurrency: 'usd' });
    vi.stubGlobal('fetch', flatRange(1));
    taxRegistry.push(filingModule(verified));
    await putEvents([acquisitionEvent, disposalEvent]);
    renderScreen();
    await runReport('2025');

    const section = screen.getByTestId('filing-aid');
    expect(
      within(section).getByRole('heading', {
        name: /filing aid — anlage so and anlage kap 2025/i,
      }),
    ).toBeInTheDocument();
    expect(
      within(section).getByText(
        'The German forms take euros; this report is in USD, so no filing figures are shown.',
      ),
    ).toBeInTheDocument();
    expect(within(section).queryByText(/line 48/i)).toBeNull();
    expect(within(section).queryByText(/total proceeds/i)).toBeNull();
    expect(within(section).queryByText('Kryptowerte')).toBeNull();
    expect(within(section).queryByText(/the finanzamt applies/i)).toBeNull();
  });

  it('shows no filing aid when the module supplies none', async () => {
    taxRegistry.push(makeModule());
    await putEvents([acquisitionEvent, disposalEvent]);
    renderScreen();
    await runReport('2025');

    expect(screen.queryByTestId('filing-aid')).toBeNull();
    expect(screen.queryByText(/filing aid/i)).toBeNull();
  });
});

describe('the client on the screen and the printout', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const record = (over: Partial<ClientRecord> = {}): ClientRecord => ({
    id: 'c-1',
    label: 'Müller GmbH',
    dbName: 'db-1',
    kind: 'client',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  });
  const reviewRecord = record({
    kind: 'review',
    review: {
      fingerprint: 'abcdef0123456789abcdef',
      omittedEventCount: 0,
      file: 'mueller.coineda',
      verdict: 'match',
    },
  });

  const renderFor = (client: ClientRecord) =>
    render(
      <MemoryRouter>
        <ClientProvider client={client} onChange={vi.fn()}>
          <TaxReportScreen />
        </ClientProvider>
      </MemoryRouter>,
    );

  it('disables the persisted inputs, never writes settings, and still runs', async () => {
    taxRegistry.push(makeModule());
    await putEvents([acquisitionEvent, disposalEvent]);
    await putSettings({
      taxpayer: { name: 'Hans Müller', taxNumber: '12/345' },
    });
    const spy = vi.spyOn(settingsStore, 'putSettings');
    renderFor(reviewRecord);
    await userEvent.click(
      await screen.findByRole('button', { name: /testland/i }),
    );
    const name = await screen.findByLabelText(/your name/i);
    await waitFor(() => expect(name).toHaveValue('Hans Müller'));
    expect(name).toBeDisabled();
    expect(screen.getByLabelText(/^tax number/i)).toBeDisabled();
    expect(screen.getByLabelText(/^tax number/i)).toHaveValue('12/345');
    const key = screen.getByLabelText(/coingecko api key/i);
    expect(key).not.toBeDisabled();
    await userEvent.type(key, 'secret-key');
    const yearInput = await screen.findByLabelText(/tax year/i);
    await userEvent.clear(yearInput);
    await userEvent.type(yearInput, '2025');
    await userEvent.click(
      await screen.findByRole('button', { name: /run report/i }),
    );
    await waitFor(() =>
      expect(screen.queryByText(/running your tax report/i)).toBeNull(),
    );
    expect(screen.getByTestId('report-header')).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it('disables the carry-forward inputs showing the restored values', async () => {
    taxRegistry.push(makeModule({ supportsCarryForward: true }));
    await putSettings({
      lossCarryForward: { '2025': { privateSales: '12.50', capital: '7' } },
    });
    const spy = vi.spyOn(settingsStore, 'putSettings');
    renderFor(reviewRecord);
    await userEvent.click(
      await screen.findByRole('button', { name: /testland/i }),
    );
    const yearInput = await screen.findByLabelText(/tax year/i);
    await userEvent.clear(yearInput);
    await userEvent.type(yearInput, '2025');
    const priv = await screen.findByLabelText(/§23 EStG/);
    expect(priv).toBeDisabled();
    await waitFor(() => expect(priv).toHaveValue('12.50'));
    expect(screen.getByLabelText(/§20 EStG/)).toBeDisabled();
    expect(spy).not.toHaveBeenCalled();
  });

  it('names neither the client nor its label for a sole client', async () => {
    // The migrated single user: their only client still carries the seeded
    // 'My portfolio'. Naming it would add an untranslated line and footer
    // prefix to every existing user's tax document.
    taxRegistry.push(makeModule());
    await putEvents([acquisitionEvent, disposalEvent]);
    await putSettings({ taxpayer: { name: 'Max Mustermann', taxNumber: '' } });
    const { container } = renderFor(listClients()[0]);
    await runReport('2025');
    const header = await screen.findByTestId('report-header');
    await waitFor(() => expect(header).toHaveTextContent('Max Mustermann'));
    expect(header).not.toHaveTextContent('Client:');
    const footer = container.querySelector('[data-print="page-footer"]');
    expect(footer).not.toHaveTextContent('My portfolio');
    expect(footer).toHaveTextContent(/^Tax year: 2025 · [0-9a-f]{12}$/);
  });

  it('prints a client line, with the translated label, when there are several', async () => {
    taxRegistry.push(makeModule());
    await putEvents([acquisitionEvent, disposalEvent]);
    await putSettings({ taxpayer: { name: 'Hans Müller', taxNumber: '' } });
    const seeded = listClients()[0];
    createClient('Müller GmbH');
    const { container } = renderFor(seeded);
    await runReport('2025');
    const header = await screen.findByTestId('report-header');
    await waitFor(() => expect(header).toHaveTextContent('Hans Müller'));
    expect(header).toHaveTextContent('Client: My portfolio');
    expect(
      container.querySelector('[data-print="page-footer"]'),
    ).toHaveTextContent(/^My portfolio · Tax year: 2025/);
  });

  it('translates the seeded label and leaves a chosen one alone', () => {
    const de = i18n.getFixedT('de');
    expect(labelOf(record({ label: 'My portfolio' }), de)).toBe(
      'Mein Portfolio',
    );
    expect(labelOf(record(), de)).toBe('Müller GmbH');
  });

  it('omits the client line when the label is the taxpayer name', async () => {
    taxRegistry.push(makeModule());
    await putEvents([acquisitionEvent, disposalEvent]);
    await putSettings({ taxpayer: { name: 'Hans Müller', taxNumber: '' } });
    listClients();
    const second = createClient('Hans Müller');
    renderFor(second);
    await runReport('2025');
    const header = await screen.findByTestId('report-header');
    await waitFor(() => expect(header).toHaveTextContent('Hans Müller'));
    expect(header).not.toHaveTextContent('Client:');
  });

  it('puts the client, the year and the short fingerprint in the page footer', async () => {
    taxRegistry.push(makeModule());
    await putEvents([acquisitionEvent, disposalEvent]);
    const { container } = renderFor(reviewRecord);
    await runReport('2025');
    const footer = container.querySelector('[data-print="page-footer"]');
    expect(footer).not.toBeNull();
    expect(footer).toHaveClass('print:block');
    expect(footer).toHaveTextContent('Müller GmbH');
    expect(footer).toHaveTextContent('2025');
    // The report's own fingerprint, never the registry's.
    expect(footer).toHaveTextContent(/2025 · [0-9a-f]{12}$/);
    expect(footer).not.toHaveTextContent('abcdef012345');
  });

  it('still renders without a client provider', async () => {
    taxRegistry.push(makeModule());
    await putEvents([acquisitionEvent, disposalEvent]);
    const { container } = renderScreen();
    await runReport('2025');
    expect(
      container.querySelector('[data-print="page-footer"]'),
    ).not.toBeNull();
  });
});

describe('the DATEV settings card', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const openModule = async (mod: TaxModule, name: RegExp) => {
    taxRegistry.push(mod);
    renderScreen();
    await userEvent.click(await screen.findByRole('button', { name }));
  };

  /** The card's inputs stay disabled until the stored values are read. */
  const openGermanyReady = async () => {
    await openModule(germanTax, /germany/i);
    const advisor = await screen.findByLabelText(/^advisor number/i);
    await waitFor(() => expect(advisor).toBeEnabled());
  };

  const labels = [
    /^advisor number/i,
    /^client number/i,
    /^account number length/i,
    /^clearing account/i,
    /^account for §23 gains/i,
    /^account for §23 losses/i,
    /^account for §22 nr\. 3 income/i,
  ];

  it('appears for Germany', async () => {
    await openModule(germanTax, /germany/i);
    expect(await screen.findByText('DATEV')).toBeInTheDocument();
    for (const label of labels) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    expect(screen.getByLabelText(/^account number length/i)).toHaveValue('4');
  });

  it('is absent for Austria', async () => {
    const { default: austrianTax } = await import('@/tax/jurisdictions/at');
    await openModule(austrianTax, /austria/i);
    await screen.findByLabelText(/tax year/i);
    expect(screen.queryByText('DATEV')).toBeNull();
    expect(screen.queryByLabelText(/^advisor number/i)).toBeNull();
  });

  it('writes the whole object on each blur', async () => {
    await openGermanyReady();
    const spy = vi.spyOn(settingsStore, 'putSettings');
    await userEvent.type(
      await screen.findByLabelText(/^advisor number/i),
      '1234567',
    );
    await userEvent.type(screen.getByLabelText(/^client number/i), '12345');
    await userEvent.type(screen.getByLabelText(/^clearing account/i), '1200');
    await userEvent.type(
      screen.getByLabelText(/^account for §23 gains/i),
      '2300',
    );
    await userEvent.type(
      screen.getByLabelText(/^account for §23 losses/i),
      '2310',
    );
    await userEvent.type(
      screen.getByLabelText(/^account for §22 nr\. 3 income/i),
      '2320',
    );
    await userEvent.tab();
    expect(spy.mock.calls.at(-1)?.[0]).toEqual({
      datev: {
        beraternummer: '1234567',
        mandantennummer: '12345',
        sachkontenlaenge: 4,
        konten: {
          verrechnung: '1200',
          gewinn23: '2300',
          verlust23: '2310',
          einkuenfte22: '2320',
        },
      },
    });
    // One write per blur: five fields were left by clicking the next, plus
    // the final tab.
    expect(spy).toHaveBeenCalledTimes(6);
    await waitFor(async () =>
      expect((await getSettings())?.datev?.konten.gewinn23).toBe('2300'),
    );
  });

  it('flags an account of the wrong length once the field is left', async () => {
    await openGermanyReady();
    const field = await screen.findByLabelText(/^clearing account/i);
    await userEvent.type(field, '12');
    expect(screen.queryByText('Must be 4 digits')).toBeNull();
    await userEvent.tab();
    expect(await screen.findByText('Must be 4 digits')).toBeInTheDocument();
  });

  it('lets a review edit the values for the session without writing them', async () => {
    await putSettings({
      datev: {
        beraternummer: '99',
        mandantennummer: '1',
        sachkontenlaenge: 5,
        konten: {
          verrechnung: '12000',
          gewinn23: '23000',
          verlust23: '23100',
          einkuenfte22: '23200',
        },
      },
    });
    taxRegistry.push(germanTax);
    const spy = vi.spyOn(settingsStore, 'putSettings');
    render(
      <MemoryRouter>
        <ClientProvider
          client={{
            id: 'c-1',
            label: 'Müller GmbH',
            dbName: 'db-1',
            kind: 'review',
            createdAt: '2026-01-01T00:00:00.000Z',
            review: {
              fingerprint: 'abcdef0123456789abcdef',
              omittedEventCount: 0,
              file: 'mueller.coineda',
              verdict: 'match',
            },
          }}
          onChange={vi.fn()}
        >
          <TaxReportScreen />
        </ClientProvider>
      </MemoryRouter>,
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /germany/i }),
    );
    const advisor = await screen.findByLabelText(/^advisor number/i);
    await waitFor(() => expect(advisor).toHaveValue('99'));
    await waitFor(() => expect(advisor).toBeEnabled());
    for (const label of labels) {
      expect(screen.getByLabelText(label)).toBeEnabled();
    }
    expect(
      screen.getByText(
        'In a review these values are kept for this session only and not saved.',
      ),
    ).toBeInTheDocument();
    await userEvent.type(advisor, '1');
    await userEvent.tab();
    expect(advisor).toHaveValue('991');
    expect(spy).not.toHaveBeenCalled();
  });

  const stored = {
    beraternummer: '99',
    mandantennummer: '00123',
    sachkontenlaenge: 5,
    konten: {
      verrechnung: '12000',
      gewinn23: '23000',
      verlust23: '23100',
      einkuenfte22: '23200',
    },
  };

  it('loads the stored values into the inputs', async () => {
    await putSettings({ datev: stored });
    await openGermanyReady();
    expect(screen.getByLabelText(/^advisor number/i)).toHaveValue('99');
    expect(screen.getByLabelText(/^account number length/i)).toHaveValue('5');
    expect(screen.getByLabelText(/^clearing account/i)).toHaveValue('12000');
  });

  it('keeps a leading zero all the way to the payload', async () => {
    await putSettings({ datev: stored });
    await openGermanyReady();
    const spy = vi.spyOn(settingsStore, 'putSettings');
    await userEvent.click(screen.getByLabelText(/^client number/i));
    await userEvent.tab();
    expect(spy.mock.calls.at(-1)?.[0]?.datev?.mandantennummer).toBe('00123');
  });

  it('persists a changed account length as a number', async () => {
    await openGermanyReady();
    const spy = vi.spyOn(settingsStore, 'putSettings');
    await userEvent.selectOptions(
      screen.getByLabelText(/^account number length/i),
      '6',
    );
    await userEvent.tab();
    expect(spy.mock.calls.at(-1)?.[0]?.datev?.sachkontenlaenge).toBe(6);
  });

  it('keeps the card disabled when the stored values cannot be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(settingsStore, 'getSettings')
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('x'));
    await openModule(germanTax, /germany/i);
    expect(await screen.findByLabelText(/^advisor number/i)).toBeDisabled();
  });

  it('shows the messages in German', async () => {
    await i18n.changeLanguage('de');
    try {
      await openModule(germanTax, /deutschland/i);
      const field = await screen.findByLabelText(/^verrechnungskonto/i);
      await waitFor(() => expect(field).toBeEnabled());
      await userEvent.type(field, '12');
      await userEvent.tab();
      expect(
        await screen.findByText('Muss 4 Ziffern haben'),
      ).toBeInTheDocument();
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});

describe('downloading the DATEV Buchungsstapel', () => {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const validDatev = {
    beraternummer: '1234567',
    mandantennummer: '12345',
    sachkontenlaenge: 4,
    konten: {
      verrechnung: '1200',
      gewinn23: '2300',
      verlust23: '2310',
      einkuenfte22: '2320',
    },
  };
  const blobs: Blob[] = [];

  beforeEach(() => {
    localStorage.clear();
    blobs.length = 0;
    URL.createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return 'blob:test';
    });
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });
  afterEach(() => {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const runGermany = async (
    draw: () => unknown = renderScreen,
    venue?: string,
  ) => {
    taxRegistry.push(germanTax);
    await putSaleWithFee(venue);
    vi.stubGlobal('fetch', flatRange(1));
    draw();
    await userEvent.click(
      await screen.findByRole('button', { name: /germany/i }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /run report/i }),
    );
    return screen.findByRole('button', {
      name: /download datev \(buchungsstapel\)/i,
    });
  };

  const confirm = async () => {
    const dialog = await screen.findByRole('dialog');
    const buttons = within(dialog).getAllByRole('button', {
      name: /download datev \(buchungsstapel\)/i,
    });
    await userEvent.click(buttons[buttons.length - 1]);
  };

  it('stays disabled and names the missing settings', async () => {
    const button = await runGermany();
    expect(button).toBeDisabled();
    expect(
      screen.getByText(/complete the datev settings first: advisor number/i),
    ).toBeInTheDocument();
  });

  it('downloads a windows-1252 EXTF file after confirming', async () => {
    await putSettings({ datev: validDatev });
    const button = await runGermany(renderScreen, 'händler');
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    expect(await screen.findByText('1 posting')).toBeInTheDocument();
    expect(
      screen.getByText(
        'The postings are the figures before the Freigrenzen and any loss carry-forward; the tax return applies those.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Each posting is rounded to cents on its own.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/by a few cents/i)).toBeNull();
    await confirm();
    expect(blobs).toHaveLength(1);
    expect(blobs[0].type).toBe('text/csv;charset=windows-1252');
    const bytes = new Uint8Array(await readBlob(blobs[0]));
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe('"EXTF');
    // The venue's 'ä' is the single cp1252 byte 0xE4, never UTF-8's C3 A4.
    const prefix = Array.from('Verkauf 100 ADA H', (c) => c.charCodeAt(0));
    const at = bytes.findIndex((_, i) =>
      prefix.every((byte, k) => bytes[i + k] === byte),
    );
    expect(at).toBeGreaterThan(0);
    expect(bytes[at + prefix.length]).toBe(0xe4);
    expect(
      bytes.some((byte, i) => byte === 0xc3 && bytes[i + 1] === 0xa4),
    ).toBe(false);
    // Three lines: header, columns, one posting.
    const text = new TextDecoder('windows-1252').decode(bytes);
    expect(text.split('\r\n').filter(Boolean)).toHaveLength(3);
  });

  it('enables the button for settings completed without leaving the last field', async () => {
    // A write that never lands: only the live values can enable the button.
    vi.spyOn(settingsStore, 'putSettings').mockResolvedValue(undefined);
    taxRegistry.push(germanTax);
    await putSaleWithFee();
    vi.stubGlobal('fetch', flatRange(1));
    renderScreen();
    await userEvent.click(
      await screen.findByRole('button', { name: /germany/i }),
    );
    const advisor = await screen.findByLabelText(/^advisor number/i);
    await waitFor(() => expect(advisor).toBeEnabled());
    await userEvent.type(advisor, '1234567');
    await userEvent.type(screen.getByLabelText(/^client number/i), '12345');
    await userEvent.type(screen.getByLabelText(/^clearing account/i), '1200');
    await userEvent.type(
      screen.getByLabelText(/^account for §23 gains/i),
      '2300',
    );
    await userEvent.type(
      screen.getByLabelText(/^account for §23 losses/i),
      '2310',
    );
    await userEvent.type(
      screen.getByLabelText(/^account for §22 nr\. 3 income/i),
      '2320',
    );
    await userEvent.click(screen.getByRole('button', { name: /run report/i }));
    const button = await screen.findByRole('button', {
      name: /download datev \(buchungsstapel\)/i,
    });
    await waitFor(() => expect(button).toBeEnabled());
  });

  it('says in the dialog when the figures are incomplete', async () => {
    await putSettings({ datev: validDatev });
    const withGap: TaxModule = {
      ...germanTax,
      assess: (input) => ({
        ...germanTax.assess(input),
        unresolved: [
          {
            kind: 'needs-price',
            sourceEventId: 'gap',
            assetId: 'cardano:lovelace',
            amount: '1',
            venue: 'wallet-a',
            timestamp: Date.UTC(new Date().getUTCFullYear(), 0, 4),
            reason: { key: 'gap' },
            taxEventKind: 'income',
            resolutions: [],
          },
        ],
      }),
    };
    taxRegistry.push(withGap);
    await putSaleWithFee();
    vi.stubGlobal('fetch', flatRange(1));
    renderScreen();
    await userEvent.click(
      await screen.findByRole('button', { name: /germany/i }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /run report/i }),
    );
    const button = await screen.findByRole('button', {
      name: /download datev \(buchungsstapel\)/i,
    });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(
        'These figures are incomplete: 1 items in this year were omitted or left unresolved (see the Result card). Postings for them are missing.',
      ),
    ).toBeInTheDocument();
  });

  it('is disabled with a note when the report is not in euros', async () => {
    await putSettings({ datev: validDatev, baseCurrency: 'usd' });
    const button = await runGermany();
    expect(button).toBeDisabled();
    expect(
      screen.getByText('The DATEV export needs a report in euros.'),
    ).toBeInTheDocument();
  });

  it('downloads for a review client with session-only settings', async () => {
    taxRegistry.push(germanTax);
    await putSaleWithFee();
    vi.stubGlobal('fetch', flatRange(1));
    const spy = vi.spyOn(settingsStore, 'putSettings');
    render(
      <MemoryRouter>
        <ClientProvider
          client={{
            id: 'c-1',
            label: 'Müller GmbH',
            dbName: 'db-1',
            kind: 'review',
            createdAt: '2026-01-01T00:00:00.000Z',
            review: {
              fingerprint: 'abcdef0123456789abcdef',
              omittedEventCount: 0,
              file: 'mueller.coineda',
              verdict: 'match',
            },
          }}
          onChange={vi.fn()}
        >
          <TaxReportScreen />
        </ClientProvider>
      </MemoryRouter>,
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /germany/i }),
    );
    const advisor = await screen.findByLabelText(/^advisor number/i);
    await waitFor(() => expect(advisor).toBeEnabled());
    await userEvent.type(advisor, '7654321');
    await userEvent.type(screen.getByLabelText(/^client number/i), '54321');
    await userEvent.type(screen.getByLabelText(/^clearing account/i), '1200');
    await userEvent.type(
      screen.getByLabelText(/^account for §23 gains/i),
      '2300',
    );
    await userEvent.type(
      screen.getByLabelText(/^account for §23 losses/i),
      '2310',
    );
    await userEvent.type(
      screen.getByLabelText(/^account for §22 nr\. 3 income/i),
      '2320',
    );
    await userEvent.click(screen.getByRole('button', { name: /run report/i }));
    const button = await screen.findByRole('button', {
      name: /download datev \(buchungsstapel\)/i,
    });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    await confirm();
    expect(blobs).toHaveLength(1);
    const text = new TextDecoder('windows-1252').decode(
      await readBlob(blobs[0]),
    );
    expect(text.split('\r\n')[0]).toContain(';7654321;54321;');
    expect(spy).not.toHaveBeenCalled();
    expect((await getSettings())?.datev).toBeUndefined();
  });
});

describe('accessibility of the report steps', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps the route h1 off paper, where the letterhead names the report', async () => {
    renderScreen();
    const h1 = await screen.findByRole('heading', { level: 1 });
    expect(h1).toHaveClass('sr-only');
    expect(h1).toHaveClass('print:hidden');
    expect(h1).not.toHaveClass('print:not-sr-only');
  });

  it('moves focus to the step heading on choosing, going back and finishing a run', async () => {
    taxRegistry.push(makeModule());
    await putEvents([acquisitionEvent, disposalEvent]);
    renderScreen();

    await userEvent.click(
      await screen.findByRole('button', { name: /testland/i }),
    );
    const chosen = await screen.findByRole('heading', {
      level: 2,
      name: 'Testland',
    });
    await waitFor(() => expect(document.activeElement).toBe(chosen));

    await userEvent.click(
      screen.getByRole('button', { name: /^choose a jurisdiction$/i }),
    );
    const picker = await screen.findByRole('heading', {
      level: 2,
      name: /create tax report/i,
    });
    await waitFor(() => expect(document.activeElement).toBe(picker));

    await runReport('2025');
    await screen.findAllByText(/test threshold/i);
    const reportHeading = screen.getByRole('heading', {
      level: 2,
      name: 'Testland',
    });
    await waitFor(() => expect(document.activeElement).toBe(reportHeading));
  });

  it('announces the running line as a status', async () => {
    taxRegistry.push(makeModule());
    // A coin, not euros, so the run has to look up a historical price; a
    // lookup that never answers keeps it on its loading line.
    await (await openLedger()).clear('prices');
    await putEvents([
      ledgerEvent({
        id: 'btc-in',
        externalId: 'btc-in',
        legs: [
          {
            assetId: 'bitcoin:native',
            amount: '100000000',
            direction: 'in',
            venue: 'wallet-a',
            role: 'principal',
          },
        ],
      }),
    ]);
    const hanging = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', hanging);
    renderScreen();
    await userEvent.click(
      await screen.findByRole('button', { name: /testland/i }),
    );
    const yearInput = await screen.findByLabelText(/tax year/i);
    await userEvent.clear(yearInput);
    await userEvent.type(yearInput, '2025');
    await userEvent.click(
      await screen.findByRole('button', { name: /run report/i }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      /running your tax report/i,
    );
    // The loading line shows before the lookup is issued. Ending the test
    // there let the lookup fire after afterEach restored the real fetch,
    // reaching DefiLlama and Frankfurter from the NEXT test.
    await waitFor(() => expect(hanging).toHaveBeenCalled());
  });

  it('tells the browser what the taxpayer fields hold', async () => {
    taxRegistry.push(makeModule());
    renderScreen();
    await userEvent.click(
      await screen.findByRole('button', { name: /testland/i }),
    );
    expect(await screen.findByLabelText('Your name')).toHaveAttribute(
      'autocomplete',
      'name',
    );
    expect(screen.getByLabelText('Tax number')).toHaveAttribute(
      'autocomplete',
      'off',
    );
  });
});

describe('the egress line on the method sheet', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('states the public mode without a host list', async () => {
    taxRegistry.push(makeModule());
    await putEvents([acquisitionEvent, disposalEvent]);
    renderScreen();
    await runReport('2025');

    expect(screen.getByText('Egress: public')).toBeInTheDocument();
    expect(screen.queryByText(/yaci|blockstream/i)).toBeNull();
  });

  /** A crypto acquisition in mid-2025: priced by a provider, and older
   *  than CoinGecko's keyless free tier, which declines it locally. */
  const adaEvent = ledgerEvent({
    id: 'ada',
    externalId: 'ada',
    legs: [
      {
        assetId: 'cardano:lovelace',
        amount: '1000000',
        direction: 'in',
        venue: 'wallet-a',
        role: 'principal',
      },
    ],
  });

  it('states the restricted mode and lists only the configured hosts the run used', async () => {
    writeDeviceEgress('restricted');
    // Price history and FX are asked. Spot prices is configured but never
    // reached (the day is older than the keyless free tier, declined
    // locally), and a tax run never contacts an indexer.
    writeDeviceEndpoints({
      priceHistory: 'https://prices.example.gov',
      fx: 'https://fx.example.gov/v1',
      spotPrices: 'https://cg.example.gov/api/v3',
      ethereumBlockscout: 'https://indexer.example.gov',
    });
    vi.stubGlobal('fetch', flatRange(1));
    taxRegistry.push(makeModule());
    await putEvents([adaEvent]);
    renderScreen();
    await runReport('2025');

    const line = screen.getByText('Egress: restricted');
    expect(line.parentElement).toHaveTextContent('prices.example.gov');
    expect(line.parentElement).toHaveTextContent('fx.example.gov');
    expect(line.parentElement).not.toHaveTextContent('/v1');
    expect(line.parentElement).not.toHaveTextContent('cg.example.gov');
    expect(line.parentElement).not.toHaveTextContent('indexer.example.gov');
  });

  it('names a shared gateway once', async () => {
    writeDeviceEgress('restricted');
    writeDeviceEndpoints({
      priceHistory: 'https://gw.example.gov/llama',
      fx: 'https://gw.example.gov/fx',
    });
    vi.stubGlobal('fetch', flatRange(1));
    taxRegistry.push(makeModule());
    await putEvents([adaEvent]);
    renderScreen();
    await runReport('2025');

    const line = screen.getByText('Egress: restricted');
    expect(
      line.parentElement?.textContent?.match(/gw\.example\.gov/g),
    ).toHaveLength(1);
  });
});

describe('the egress line in German', () => {
  it('translates the mode', async () => {
    taxRegistry.push(makeModule());
    await putEvents([acquisitionEvent, disposalEvent]);
    await i18n.changeLanguage('de');
    try {
      renderScreen();
      await userEvent.click(
        await screen.findByRole('button', { name: /testland/i }),
      );
      await userEvent.click(
        await screen.findByRole('button', { name: /report erstellen/i }),
      );
      expect(
        await screen.findByText('Ausgehende Verbindungen: öffentlich'),
      ).toBeInTheDocument();
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});

describe('the DAC8 / CARF reconciliation', () => {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  afterEach(() => {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    vi.restoreAllMocks();
  });

  const carfXml = () =>
    readFileSync(path.join(__dirname, 'assets', 'carf', 'plain.xml'), 'utf8');

  const seedBitpanda = async () => {
    await putSource({
      id: 's-bitpanda',
      moduleId: 'bitpanda',
      label: 'Bitpanda',
      config: {},
    });
    await putEvents([
      ledgerEvent({
        id: 'carf-in',
        externalId: 'carf-in',
        sourceId: 's-bitpanda',
        kind: 'fiat-in',
        timestamp: Date.UTC(2026, 1, 1),
        legs: [
          {
            assetId: 'fiat:eur',
            amount: '100',
            direction: 'in',
            venue: 'bitpanda',
            role: 'principal',
          },
        ],
      }),
    ]);
  };

  /** Opens the dialog from the action bar, drops the fixture and compares. */
  const reconcileWithFixture = async () => {
    await userEvent.click(
      await screen.findByRole('button', {
        name: 'Reconcile with a CARF report',
      }),
    );
    const box = await screen.findByRole('dialog');
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    await userEvent.upload(
      input,
      new File([carfXml()], 'carf.xml', { type: 'text/xml' }),
    );
    await within(box).findByRole('radio', { name: /erika mustermann/i });
    await userEvent.click(within(box).getByRole('button', { name: 'Compare' }));
    return screen.findByTestId('carf-reconciliation');
  };

  it('offers the reconciliation in the action bar and prints the section', async () => {
    taxRegistry.push(makeModule());
    await seedBitpanda();
    renderScreen();
    await runReport('2026');

    const button = await screen.findByRole('button', {
      name: 'Reconcile with a CARF report',
    });
    expect(button.closest('.print\\:hidden')).not.toBeNull();

    const section = await reconcileWithFixture();
    expect(section.closest('[data-print="document"]')).not.toBeNull();
    expect(section.closest('.print\\:hidden')).toBeNull();
    expect(
      within(section).getByRole('heading', {
        name: 'DAC8 / CARF reconciliation',
      }),
    ).toBeInTheDocument();
    expect(section.textContent).toContain('Bitpanda GmbH');
    expect(section.textContent).toContain('DE2026BITPANDA0001');
    expect(section.textContent).toContain('Erika Mustermann');
    expect(section.textContent).toMatch(
      /\d+ match, \d+ differ, \d+ missing on one side, \d+ not compared, 1 not recognised/,
    );
    const btcRow = within(section)
      .getAllByRole('row')
      .find((row) => /^BTC/.test(row.textContent ?? ''));
    expect(btcRow).toBeDefined();
    expect(btcRow?.textContent).toContain('Not in the ledger');
    expect(section.textContent).toContain(
      'Only the figures above were read from the file; the file itself is not stored.',
    );
    // The user's address and birth date are never shown.
    expect(section.textContent).not.toContain('Heidestraße');
    expect(section.textContent).not.toContain('1964-08-12');
  });

  it('downloads the reconciliation as CSV from a print-hidden button', async () => {
    taxRegistry.push(makeModule());
    await seedBitpanda();
    const blobs: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return 'blob:test';
    });
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = vi.fn();
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
    renderScreen();
    await runReport('2026');
    const section = await reconcileWithFixture();

    const csvButton = within(section).getByRole('button', {
      name: 'Download reconciliation (CSV)',
    });
    expect(csvButton.closest('.print\\:hidden')).not.toBeNull();
    await userEvent.click(csvButton);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(names[0]).toMatch(/^carf-reconciliation-2026-[0-9a-f]{12}\.csv$/);
    const text = new TextDecoder().decode(await readBlob(blobs[0]));
    expect(text.split('\r\n')[0]).toMatch(/^asset,category,verdict,/);
    expect(text).toContain('BTC,fiat-in,missing-own');
  });

  it('clears the section when the report is run again', async () => {
    taxRegistry.push(makeModule());
    await seedBitpanda();
    renderScreen();
    await runReport('2026');
    await reconcileWithFixture();

    await userEvent.click(
      screen.getByRole('button', { name: /change your answers/i }),
    );
    expect(screen.queryByTestId('carf-reconciliation')).toBeNull();
    await userEvent.click(
      await screen.findByRole('button', { name: /run report/i }),
    );
    await waitFor(() =>
      expect(screen.queryByText(/running your tax report/i)).toBeNull(),
    );
    await screen.findByRole('button', {
      name: 'Reconcile with a CARF report',
    });
    expect(screen.queryByTestId('carf-reconciliation')).toBeNull();
  });
});
