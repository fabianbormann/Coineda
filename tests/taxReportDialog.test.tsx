import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import 'fake-indexeddb/auto';
import i18n from '@/i18n';
import { TaxReportDialog } from '@/screens/TaxReportDialog';
import { taxRegistry } from '@/tax/registry';
import germanTax from '@/tax/jurisdictions/de';
import { openLedger, putEvents } from '@/ledger/db';
import { putSettings } from '@/settings/settingsStore';
import type { LedgerEvent } from '@/ledger/types';
import { flatRange } from './priceRangeStub';
import type {
  AssessInput,
  TaxAssessment,
  TaxManifest,
  TaxModule,
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
    reason: 'Fully taxable test disposal',
  })),
  totals: {
    taxableGain: input.matched.length > 0 ? '200' : '0',
    exemptGain: '0',
    income: '0',
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

const renderDialog = () =>
  render(<TaxReportDialog open onOpenChange={() => {}} />);

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
};

describe('running a report', () => {
  it('runs a report and renders the totals', async () => {
    taxRegistry.push(makeModule());
    await putEvents([acquisitionEvent, disposalEvent]);

    renderDialog();
    await runReport('2025');

    // 200.00 is the fixed figure `assess` returns above - it appears more
    // than once (totals, the disposal line), so assert it from the totals
    // paragraph specifically rather than an ambiguous page-wide text query.
    const taxableGainLine = (await screen.findByText(/taxable gain/i)).closest(
      'p',
    );
    expect(taxableGainLine).toHaveTextContent(/200\.00/);
  });

  it('shows "N disposals could not be computed" right next to the total when omitted > 0', async () => {
    taxRegistry.push(makeModule());
    await putEvents([acquisitionEvent, disposalEvent, unmatchedDisposalEvent]);

    renderDialog();
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

  it('shows an unresolved item with its raw reason, verbatim', async () => {
    taxRegistry.push(makeModule());
    await putEvents([acquisitionEvent, disposalEvent, unmatchedDisposalEvent]);

    renderDialog();
    await runReport('2025');

    // The exact diagnostic sentence runTaxReport.ts hardcodes for a
    // shortfall - a raw string, not a translation key, framed in translated
    // wrapper text the same way SourceRow frames source.lastError.
    expect(
      await screen.findByText(/no acquisition on record for this disposal/i),
    ).toBeInTheDocument();
  });

  it('offers no resolution action for an unresolved item', async () => {
    taxRegistry.push(makeModule());
    await putEvents([acquisitionEvent, disposalEvent, unmatchedDisposalEvent]);

    renderDialog();
    await runReport('2025');

    await screen.findByText(/no acquisition on record for this disposal/i);

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

    renderDialog();
    await runReport('1900');

    expect(
      await screen.findByText(/2020-2021|2020 or later/i),
    ).toBeInTheDocument();
    // Nothing from a (nonexistent) assessment leaks through.
    expect(screen.queryByText(/taxable gain/i)).not.toBeInTheDocument();
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

      renderDialog();
      await userEvent.click(
        await screen.findByRole('button', { name: /germany/i }),
      );
      await userEvent.click(
        await screen.findByRole('button', { name: /run report/i }),
      );
      await screen.findByText(/other unresolved items are not disposals/i);

      // Two gaps on one event and one asset, both rendered.
      expect(
        await screen.findAllByText(/no price source is configured/i),
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

    renderDialog();
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
    expect(
      await screen.findByText(/no price source is configured/i),
    ).toBeInTheDocument();
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

    renderDialog();
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

    // Opened by a transition, the way MainScreen opens it: the stored
    // settings are read when `open` goes false -> true, so a dialog that
    // was mounted already-open never reads them at all.
    const { rerender } = render(
      <TaxReportDialog open={false} onOpenChange={() => {}} />,
    );
    rerender(<TaxReportDialog open onOpenChange={() => {}} />);

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

    // Close and reopen: the key must come back from storage, not from the
    // component state the reopen just reset.
    rerender(<TaxReportDialog open={false} onOpenChange={() => {}} />);
    rerender(<TaxReportDialog open onOpenChange={() => {}} />);
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

    renderDialog();
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

    renderDialog();
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

    renderDialog();
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

    renderDialog();
    await userEvent.click(
      await screen.findByRole('button', { name: /testland/i }),
    );

    await screen.findByText(/written by test suite/i);
    expect(
      screen.queryByText(/have not been checked/i),
    ).not.toBeInTheDocument();
  });
});
