import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import 'fake-indexeddb/auto';
import '@/i18n';
import { MemoryRouter } from 'react-router-dom';
import { TaxReportScreen } from '@/screens/TaxReportScreen';
import { taxRegistry } from '@/tax/registry';
import { openLedger } from '@/ledger/db';
import { putSettings } from '@/settings/settingsStore';
import germanTax from '@/tax/jurisdictions/de';
import austrianTax from '@/tax/jurisdictions/at';
import type { TaxReport } from '@/tax/types';

/**
 * A report computed for one jurisdiction must never render under another.
 *
 * A real run takes minutes (one historical price lookup per disposal), and
 * only Back and Run are disabled while it is in flight - Escape and the
 * close button still work. Closing the dialog mid-run and reopening it
 * resets the state to the jurisdiction picker, and the abandoned run's
 * continuation then landed in that fresh state: a German `taxableGain`
 * rendered under Austria's heading, with Austria's disclaimer, year and
 * rate labels around it. The figure a user would have filed.
 *
 * `runTaxReport` is mocked with a deferred promise because the window to
 * reproduce this is "while the run is in flight", which is not a state a
 * real run can be held in deterministically.
 */
const { runTaxReport } = vi.hoisted(() => ({ runTaxReport: vi.fn() }));
vi.mock('@/tax/runTaxReport', () => ({
  runTaxReport,
  taxYearOf: (timestamp: number) => new Date(timestamp).getUTCFullYear(),
}));

/** A deliberately unmistakable German figure: if this number appears
 *  anywhere on screen after the switch to Austria, the leak happened. */
const GERMAN_TAXABLE_GAIN = '999999';

const germanAssessment: TaxReport = {
  year: 2024,
  lines: [],
  totals: {
    taxableGain: GERMAN_TAXABLE_GAIN,
    exemptGain: '0',
    income: '0',
    loss: '0',
    computedFrom: 1,
    omitted: 0,
  },
  thresholds: [],
  unresolved: [],
  // Typed as the host's own return value rather than a jurisdiction's
  // TaxReport: this mock stands in for runTaxReport, and the screen
  // reads the method sheet off it. `vi.fn()` takes any argument, so
  // nothing but this annotation makes the mock keep up with the contract
  // it is impersonating.
  method: {
    matching: 'fifo',
    partitionLabel: 'Test partition',
    baseCurrency: 'eur',
    valuation: 'utc-day',
    priceSources: ['DefiLlama', 'ECB', 'CoinGecko'],
    appVersion: '0.0.0-test',
    eventsConsidered: 1,
    internalTransfersNetted: 0,
  },
};

beforeEach(async () => {
  const db = await openLedger();
  for (const store of ['events', 'sources', 'cursors', 'settings'] as const) {
    await db.clear(store);
  }
  await putSettings({ language: 'en', baseCurrency: 'eur' });
  runTaxReport.mockReset();
  taxRegistry.length = 0;
  taxRegistry.push(germanTax, austrianTax);
});

describe('a tax report abandoned mid-flight', () => {
  it('does not render a German result under Austria after switching mid-run', async () => {
    let resolveGerman: (value: TaxReport) => void = () => {};
    runTaxReport.mockImplementation(
      () =>
        new Promise<TaxReport>((resolve) => {
          resolveGerman = resolve;
        }),
    );

    render(
      <MemoryRouter>
        <TaxReportScreen />
      </MemoryRouter>,
    );

    // Run Germany, and leave the run hanging.
    await userEvent.click(
      await screen.findByRole('button', { name: /germany/i }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /run report/i }),
    );
    await screen.findByText(/running your tax report/i);

    // Go BACK to the jurisdiction picker mid-flight, which is the hazard
    // that still exists on a screen: it keeps the same component instance
    // alive, so the abandoned run's continuation can still reach this
    // state. Navigating away cannot be tested this way any more and does
    // not need to be - React discards updates to an unmounted tree - but
    // this path has no such protection and relies entirely on the guard.
    await userEvent.click(screen.getByRole('button', { name: /^back$/i }));

    // Pick Austria this time.
    await userEvent.click(
      await screen.findByRole('button', { name: /austria/i }),
    );
    expect(await screen.findByText('ÖkoStRefG 2022')).toBeInTheDocument();

    // Now let the abandoned German run finish.
    resolveGerman(germanAssessment);

    // It must land nowhere. Austria's own screen is still waiting to be
    // run, so no totals of any kind should appear.
    await waitFor(() => {
      expect(screen.queryByText(/999,999|999999/)).not.toBeInTheDocument();
    });
    expect(screen.queryByText(/taxable gain/i)).not.toBeInTheDocument();
  });

  it('still renders a result that was not abandoned', async () => {
    // The companion proof: the guard must not swallow the ordinary case.
    runTaxReport.mockResolvedValue(germanAssessment);

    render(
      <MemoryRouter>
        <TaxReportScreen />
      </MemoryRouter>,
    );

    await userEvent.click(
      await screen.findByRole('button', { name: /germany/i }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /run report/i }),
    );

    const taxableGainLine = (await screen.findByText(/taxable gain/i)).closest(
      'p',
    );
    expect(taxableGainLine).toHaveTextContent(/999,999/);
  });
});
