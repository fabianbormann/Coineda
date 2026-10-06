import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import 'fake-indexeddb/auto';
import i18n from '@/i18n';
import { MemoryRouter } from 'react-router-dom';
import { TaxReportScreen } from '@/screens/TaxReportScreen';
import { taxRegistry } from '@/tax/registry';
import germanTax from '@/tax/jurisdictions/de';
import { openLedger, putEvents } from '@/ledger/db';
import { getSettings, putSettings } from '@/settings/settingsStore';
import type { LedgerEvent } from '@/ledger/types';
import { flatRange } from './priceRangeStub';
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
    expect(
      await screen.findByText(/no acquisition is on record for this disposal/i),
    ).toBeInTheDocument();
  });

  it('offers no resolution action for an unresolved item', async () => {
    taxRegistry.push(makeModule());
    await putEvents([acquisitionEvent, disposalEvent, unmatchedDisposalEvent]);

    renderScreen();
    await runReport('2025');

    await screen.findByText(/no acquisition is on record for this disposal/i);

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

  /** The reasons, in the order they are rendered. */
  const renderedOrder = (container: HTMLElement): string[] =>
    [...container.querySelectorAll('[role="alert"]')]
      .map((node) => node.textContent ?? '')
      .map((text) => /gap (\S+)/.exec(text)?.[1] ?? '')
      .filter(Boolean);

  const threeYears = [
    gap('c', Date.UTC(2026, 0, 5)),
    gap('a', Date.UTC(2023, 5, 1)),
    gap('b', Date.UTC(2025, 3, 9)),
  ];

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
