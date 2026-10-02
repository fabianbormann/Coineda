import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import 'fake-indexeddb/auto';
import '@/i18n';
import { TaxReportDialog } from '@/screens/TaxReportDialog';
import { taxRegistry } from '@/tax/registry';
import { openLedger } from '@/ledger/db';
import { putSettings } from '@/settings/settingsStore';
import germanTax from '@/tax/jurisdictions/de';
import austrianTax from '@/tax/jurisdictions/at';
import type { TaxAssessment } from '@/tax/types';

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

const germanAssessment: TaxAssessment = {
  year: 2024,
  lines: [],
  totals: {
    taxableGain: GERMAN_TAXABLE_GAIN,
    exemptGain: '0',
    income: '0',
    computedFrom: 1,
    omitted: 0,
  },
  thresholds: [],
  unresolved: [],
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
  it('does not render a German result under Austria after a close and reopen', async () => {
    let resolveGerman: (value: TaxAssessment) => void = () => {};
    runTaxReport.mockImplementation(
      () =>
        new Promise<TaxAssessment>((resolve) => {
          resolveGerman = resolve;
        }),
    );

    const { rerender } = render(
      <TaxReportDialog open onOpenChange={() => {}} />,
    );

    // Run Germany, and leave the run hanging.
    await userEvent.click(
      await screen.findByRole('button', { name: /germany/i }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /run report/i }),
    );
    await screen.findByText(/running your tax report/i);

    // Close mid-flight - what Escape does; only Back and Run are disabled.
    rerender(<TaxReportDialog open={false} onOpenChange={() => {}} />);
    // Reopen: the reset-on-reopen block clears the state back to the
    // jurisdiction picker.
    rerender(<TaxReportDialog open onOpenChange={() => {}} />);

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

    render(<TaxReportDialog open onOpenChange={() => {}} />);

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
