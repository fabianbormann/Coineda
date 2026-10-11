import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import 'fake-indexeddb/auto';
import i18n from '@/i18n';
import { MemoryRouter } from 'react-router-dom';
import { TaxReportScreen } from '@/screens/TaxReportScreen';
import { taxRegistry } from '@/tax/registry';
import germanTax from '@/tax/jurisdictions/de';
import austrianTax from '@/tax/jurisdictions/at';
import { openLedger } from '@/ledger/db';
import { getSettings, putSettings } from '@/settings/settingsStore';
import { ClientProvider } from '@/clients/ClientContext';
import { flatRange } from './priceRangeStub';
import type {
  AssessInput,
  TaxAssessment,
  TaxManifest,
  TaxModule,
} from '@/tax/types';

/**
 * The form and navigation of the tax report screen: breadcrumbs, the
 * full-width action bar, the grouped form and its defaults, the advanced
 * section, and the Bundesland-aware tax number. The report body itself is
 * covered by tests/taxReportScreen.test.tsx.
 */

const thisYear = new Date().getUTCFullYear();

/** What the last `assess` call was given, to see what the run passed on. */
let lastInput: AssessInput | null = null;

const assess = (input: AssessInput): TaxAssessment => {
  lastInput = input;
  return {
    year: input.year,
    lines: [],
    totals: {
      taxableGain: '200',
      exemptGain: '0',
      income: '0',
      loss: '0',
      computedFrom: 0,
      omitted: 0,
    },
    thresholds: [],
    estimatedLiability: input.rate !== undefined ? '42' : undefined,
    unresolved: [],
  };
};

const baseManifest: TaxManifest = {
  id: 'test-jurisdiction',
  jurisdiction: 'Testland',
  contributor: 'Test Suite',
  rulesCheckedOn: '2025-01-01',
  rulesVersion: '1.0.0',
  changelog: [{ version: '1.0.0', date: '2025-01-01', summary: 'Initial.' }],
  partitionLabel: 'Test partition',
  references: ['Test Statute §1'],
  supportedYears: { from: 2020 },
};

const makeModule = (over: Partial<TaxManifest> = {}): TaxModule => ({
  manifest: { ...baseManifest, ...over },
  handles: ['trade', 'transfer', 'reward', 'fiat-in', 'fiat-out'],
  defaultMatching: 'fifo',
  partitionBy: (event) => event.venue,
  classify: () => [],
  assess,
});

beforeEach(async () => {
  const db = await openLedger();
  for (const store of ['events', 'sources', 'cursors', 'settings'] as const) {
    await db.clear(store);
  }
  await putSettings({ language: 'en', baseCurrency: 'eur' });
  taxRegistry.length = 0;
  localStorage.clear();
  lastInput = null;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const renderScreen = () =>
  render(
    <MemoryRouter>
      <TaxReportScreen />
    </MemoryRouter>,
  );

const choose = async (name: RegExp) =>
  userEvent.click(await screen.findByRole('button', { name }));

const run = async () => {
  await userEvent.click(
    await screen.findByRole('button', { name: /run report/i }),
  );
  await waitFor(() =>
    expect(screen.queryByText(/running your tax report/i)).toBeNull(),
  );
};

const trail = () => screen.getByRole('navigation', { name: 'Breadcrumb' });

const crumbTexts = () =>
  within(trail())
    .getAllByRole('listitem')
    .map((item) => item.textContent);

const yearInput = () => screen.getByLabelText(/^tax year$/i);

describe('the breadcrumbs', () => {
  it('show only the steps reached, the current one marked and not a control', async () => {
    taxRegistry.push(makeModule());
    renderScreen();
    await screen.findByRole('heading', { name: /create tax report/i });
    expect(crumbTexts()).toEqual(['Overview', 'Tax country']);
    expect(within(trail()).getByText('Tax country')).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(
      within(trail()).getByRole('link', { name: 'Overview' }),
    ).toHaveAttribute('href', '/');

    await choose(/testland/i);
    expect(crumbTexts()).toEqual(['Overview', 'Tax country', 'Details']);
    expect(within(trail()).getByText('Details')).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(
      within(trail()).getByRole('button', { name: 'Tax country' }),
    ).toBeInTheDocument();

    await run();
    expect(crumbTexts()).toEqual([
      'Overview',
      'Tax country',
      'Details',
      'Report',
    ]);
    expect(within(trail()).getByText('Report')).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(trail()).toHaveClass('print:hidden');
  });

  it('go back to the form keeping the report, and to the jurisdiction picker', async () => {
    taxRegistry.push(makeModule());
    renderScreen();
    await choose(/testland/i);
    await run();

    await userEvent.click(
      within(trail()).getByRole('button', { name: 'Details' }),
    );
    expect(await screen.findByTestId('report-form')).toBeInTheDocument();
    // Kept, as "Change your answers" kept it: offered again, not rerun.
    expect(
      screen.getByRole('button', { name: /view the report/i }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('heading', { level: 2, name: 'Testland' }),
      ),
    );

    await userEvent.click(
      within(trail()).getByRole('button', { name: 'Tax country' }),
    );
    expect(
      await screen.findByRole('heading', { name: /create tax report/i }),
    ).toBeInTheDocument();
  });

  it('replace every back button, on the page and in the bar', async () => {
    taxRegistry.push(makeModule());
    renderScreen();
    await screen.findByRole('heading', { name: /create tax report/i });
    expect(
      screen.queryByRole('link', { name: /back to overview/i }),
    ).toBeNull();
    await choose(/testland/i);
    expect(screen.queryByRole('button', { name: /^back$/i })).toBeNull();
    expect(
      screen.queryByRole('button', { name: /choose a jurisdiction/i }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: /back to overview/i }),
    ).toBeNull();
    await run();
    expect(
      screen.queryByRole('button', { name: /change your answers/i }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: /back to overview/i }),
    ).toBeNull();
  });

  it('are translated', async () => {
    taxRegistry.push(makeModule());
    await i18n.changeLanguage('de');
    try {
      renderScreen();
      await choose(/testland/i);
      await userEvent.click(
        await screen.findByRole('button', { name: /report erstellen/i }),
      );
      // The German UI says "Report" throughout ("Report erstellen",
      // "Steuerreport"), so the trail does too.
      await waitFor(() =>
        expect(
          within(
            screen.getByRole('navigation', { name: 'Navigationspfad' }),
          ).getByText('Report'),
        ).toHaveAttribute('aria-current', 'page'),
      );
      expect(
        within(screen.getByRole('navigation', { name: 'Navigationspfad' }))
          .getAllByRole('listitem')
          .map((item) => item.textContent),
      ).toEqual(['Übersicht', 'Steuerland', 'Angaben', 'Report']);
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});

describe('the action bar', () => {
  it('spans the main column beside the document, its content kept to the page width', async () => {
    taxRegistry.push(makeModule());
    const { container } = renderScreen();
    await choose(/testland/i);
    const document_ = container.querySelector(
      '[data-print="document"]',
    ) as HTMLElement;
    const bar = screen.getByTestId('action-bar');
    // A sibling of the document column, not inside it.
    expect(bar.parentElement).toBe(document_.parentElement);
    expect(document_.contains(bar)).toBe(false);
    expect(bar.className).not.toMatch(/\bmax-w-/);
    expect(bar).toHaveClass('sticky', 'bottom-0', 'w-full', 'print:hidden');
    const inner = bar.firstElementChild as HTMLElement;
    expect(inner).toHaveClass('mx-auto', 'max-w-7xl', 'px-6');
    expect(
      within(bar).getByRole('button', { name: /run report/i }),
    ).toBeInTheDocument();
  });

  it('carries the report actions only', async () => {
    taxRegistry.push(makeModule());
    renderScreen();
    await choose(/testland/i);
    await run();
    const bar = screen.getByTestId('action-bar');
    expect(
      within(bar)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual([
      'Print or save as PDF',
      'Download register (CSV)',
      'Download report (JSON)',
      'Reconcile with a CARF report',
    ]);
  });

  it('is not shown on the jurisdiction picker', async () => {
    taxRegistry.push(makeModule());
    renderScreen();
    await screen.findByRole('heading', { name: /create tax report/i });
    expect(screen.queryByTestId('action-bar')).toBeNull();
  });
});

describe('the defaults', () => {
  it('open on the previous UTC year', async () => {
    taxRegistry.push(makeModule());
    renderScreen();
    await choose(/testland/i);
    expect(yearInput()).toHaveValue(thisYear - 1);
  });

  it('move the year into the years the jurisdiction supports', async () => {
    taxRegistry.push(
      makeModule({ supportedYears: { from: 2020, to: 2022 } }),
      makeModule({
        id: 'later',
        jurisdiction: 'Laterland',
        supportedYears: { from: thisYear },
      }),
    );
    renderScreen();
    await choose(/testland/i);
    expect(yearInput()).toHaveValue(2022);
    await userEvent.click(
      within(trail()).getByRole('button', { name: 'Tax country' }),
    );
    await choose(/laterland/i);
    expect(yearInput()).toHaveValue(thisYear);
  });

  it('prefill the personal rate for Germany and show no rate field for Austria', async () => {
    taxRegistry.push(germanTax, austrianTax);
    renderScreen();
    await choose(/germany/i);
    expect(
      screen.getByLabelText(/your personal tax rate \(optional\)/i),
    ).toHaveValue('42');
    await userEvent.click(
      within(trail()).getByRole('button', { name: 'Tax country' }),
    );
    await choose(/austria/i);
    await screen.findByLabelText(/^tax year$/i);
    expect(screen.queryByLabelText(/personal tax rate/i)).toBeNull();
  });

  it('pass the prefilled rate and name it on the estimate line', async () => {
    taxRegistry.push(makeModule({ personalRate: { default: '30' } }));
    renderScreen();
    await choose(/testland/i);
    await run();
    expect(lastInput?.rate).toBe('30');
    expect(
      screen.getAllByText(/estimated tax liability at 30 %/i).length,
    ).toBeGreaterThan(0);
  });

  it('give no estimate when the rate is cleared', async () => {
    taxRegistry.push(makeModule({ personalRate: { default: '30' } }));
    renderScreen();
    await choose(/testland/i);
    await userEvent.clear(screen.getByLabelText(/personal tax rate/i));
    await run();
    expect(lastInput).not.toBeNull();
    expect(lastInput?.rate).toBeUndefined();
    expect(screen.queryByText(/estimated tax liability/i)).toBeNull();
  });

  it('never pass a rate to a jurisdiction that takes none', async () => {
    taxRegistry.push(makeModule());
    renderScreen();
    await choose(/testland/i);
    expect(screen.queryByLabelText(/personal tax rate/i)).toBeNull();
    await run();
    expect(lastInput).not.toBeNull();
    expect(lastInput?.rate).toBeUndefined();
  });

  it('name the rate in German', async () => {
    taxRegistry.push(makeModule({ personalRate: { default: '42.5' } }));
    await i18n.changeLanguage('de');
    try {
      renderScreen();
      await choose(/testland/i);
      await userEvent.click(
        await screen.findByRole('button', { name: /report erstellen/i }),
      );
      expect(
        (await screen.findAllByText(/geschätzte steuerlast bei 42,5 %/i))
          .length,
      ).toBeGreaterThan(0);
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('show 0 carry-forwards, which are neither stored nor passed to the run', async () => {
    taxRegistry.push(makeModule({ supportsCarryForward: true }));
    renderScreen();
    await choose(/testland/i);
    const privateSales = screen.getByLabelText(/under §23 EStG/i);
    const capital = screen.getByLabelText(/under §20 EStG/i);
    await waitFor(() => expect(privateSales).toHaveValue('0'));
    expect(capital).toHaveValue('0');

    await userEvent.click(privateSales);
    await userEvent.tab();
    await run();
    expect(lastInput).not.toBeNull();
    expect(lastInput?.carryForward).toBeUndefined();
    expect(screen.queryByText(/after carry-forward/i)).toBeNull();
    expect((await getSettings())?.lossCarryForward).toBeUndefined();
  });

  it('remove a stored carry-forward set back to 0', async () => {
    const year = String(thisYear - 1);
    await putSettings({
      lossCarryForward: {
        [year]: { privateSales: '500' },
        '2020': { capital: '7' },
      },
    });
    taxRegistry.push(makeModule({ supportsCarryForward: true }));
    renderScreen();
    await choose(/testland/i);
    const privateSales = screen.getByLabelText(/under §23 EStG/i);
    await waitFor(() => expect(privateSales).toHaveValue('500'));
    await userEvent.clear(privateSales);
    await userEvent.type(privateSales, '0');
    await userEvent.tab();
    await waitFor(async () =>
      expect((await getSettings())?.lossCarryForward).toEqual({
        '2020': { capital: '7' },
      }),
    );
  });
});

describe('the form', () => {
  it('groups the fields under titled headings, in order', async () => {
    taxRegistry.push(germanTax);
    renderScreen();
    await choose(/germany/i);
    const form = screen.getByTestId('report-form');
    expect(
      within(form)
        .getAllByRole('heading', { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual([
      'Taxpayer',
      'Calculation',
      'Prices',
      expect.stringMatching(/^Advanced settings/),
    ]);
    const taxpayer = screen.getByRole('group', { name: 'Taxpayer' });
    expect(
      within(taxpayer).getByLabelText('Your name (optional)'),
    ).toBeVisible();
    expect(
      within(taxpayer).getByRole('combobox', {
        name: 'Federal state (optional)',
      }),
    ).toBeInTheDocument();
    expect(
      within(taxpayer).getByLabelText('Tax number (optional)'),
    ).toBeInTheDocument();
    const calculation = screen.getByRole('group', { name: 'Calculation' });
    expect(within(calculation).getByLabelText(/^tax year$/i)).toBeVisible();
    expect(
      within(calculation).getByLabelText(/personal tax rate/i),
    ).toBeVisible();
    expect(within(calculation).getByLabelText(/under §23 EStG/i)).toBeVisible();
    const prices = screen.getByRole('group', { name: 'Prices' });
    expect(
      within(prices).getByLabelText('CoinGecko API key (optional)'),
    ).toBeInTheDocument();
  });

  it('keeps a free-text tax number outside Germany', async () => {
    taxRegistry.push(austrianTax);
    renderScreen();
    await choose(/austria/i);
    expect(screen.queryByRole('combobox')).toBeNull();
    const number = screen.getByLabelText('Tax number (optional)');
    expect(number).toBeEnabled();
    await userEvent.type(number, 'AT 12-345/6789');
    expect(number).toHaveValue('AT 12-345/6789');
  });

  it('puts the rule-set notice last on the form, and first on the report', async () => {
    taxRegistry.push(makeModule());
    renderScreen();
    await choose(/testland/i);
    const notice = screen.getByTestId('rule-set-notice');
    const step = screen.getByTestId('report-form').parentElement as HTMLElement;
    expect(step.lastElementChild).toBe(notice);

    await run();
    const onReport = screen.getByTestId('rule-set-notice');
    const firstFigure = screen.getAllByText(/taxable gain/i)[0];
    expect(
      onReport.compareDocumentPosition(firstFigure) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe('the advanced settings', () => {
  const advanced = () =>
    screen.getByRole('button', { name: /advanced settings/i });

  it('are closed by default and state where each setting stands', async () => {
    taxRegistry.push(germanTax);
    renderScreen();
    await choose(/germany/i);
    expect(advanced()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText(/^advisor number/i)).toBeNull();
    expect(screen.queryByText('Data endpoints')).toBeNull();
    expect(
      await within(advanced()).findByText(
        'DATEV: not set up · Endpoints: public',
      ),
    ).toBeInTheDocument();

    await userEvent.click(advanced());
    expect(advanced()).toHaveAttribute('aria-expanded', 'true');
    expect(
      await screen.findByLabelText(/^advisor number/i),
    ).toBeInTheDocument();
    expect(screen.getByText('Data endpoints')).toBeInTheDocument();
  });

  it('call a complete DATEV configuration complete', async () => {
    await putSettings({
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
    taxRegistry.push(germanTax);
    renderScreen();
    await choose(/germany/i);
    expect(
      await within(advanced()).findByText(
        'DATEV: complete · Endpoints: public',
      ),
    ).toBeInTheDocument();
  });

  it('name no DATEV status outside Germany', async () => {
    taxRegistry.push(makeModule());
    renderScreen();
    await choose(/testland/i);
    expect(
      within(advanced()).getByText('Endpoints: public'),
    ).toBeInTheDocument();
  });

  it('open from the report\'s "Set up DATEV", with focus on the DATEV heading', async () => {
    vi.stubGlobal('fetch', flatRange(1));
    taxRegistry.push(germanTax);
    renderScreen();
    await choose(/germany/i);
    await run();
    expect(
      screen.getByRole('button', { name: /download datev/i }),
    ).toBeDisabled();
    const setUp = screen.getByRole('button', { name: 'Set up DATEV' });
    expect(setUp).toHaveAccessibleDescription(
      /complete the datev settings first: advisor number/i,
    );
    await userEvent.click(setUp);

    expect(await screen.findByTestId('report-form')).toBeInTheDocument();
    expect(advanced()).toHaveAttribute('aria-expanded', 'true');
    const heading = screen.getByRole('heading', { level: 4, name: 'DATEV' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });
});

describe('the tax number for Germany', () => {
  const chooseState = async (name: string) => {
    fireEvent.keyDown(
      screen.getByRole('combobox', { name: 'Federal state (optional)' }),
      { key: 'ArrowDown' },
    );
    await userEvent.click(await screen.findByRole('option', { name }));
  };

  it('waits for a Bundesland, then takes its format and stores both', async () => {
    taxRegistry.push(germanTax);
    renderScreen();
    await choose(/germany/i);
    const number = screen.getByLabelText('Tax number (optional)');
    expect(number).toBeDisabled();
    expect(screen.getByText('Choose your state first')).toBeInTheDocument();

    await chooseState('Bavaria');
    await waitFor(() => expect(number).toBeEnabled());
    expect(screen.getByText('Format 123/456/78901')).toBeInTheDocument();
    await userEvent.type(number, '12345678901');
    await userEvent.tab();
    expect(number).toHaveValue('123/456/78901');
    await waitFor(async () =>
      expect((await getSettings())?.taxpayer).toEqual({
        name: '',
        taxNumber: '123/456/78901',
        state: 'BY',
      }),
    );
  });

  it('names the states in German', async () => {
    taxRegistry.push(germanTax);
    await i18n.changeLanguage('de');
    try {
      renderScreen();
      await choose(/deutschland/i);
      fireEvent.keyDown(
        screen.getByRole('combobox', { name: 'Bundesland (optional)' }),
        { key: 'ArrowDown' },
      );
      for (const name of [
        'Bayern',
        'Hessen',
        'Nordrhein-Westfalen',
        'Thüringen',
      ]) {
        expect(await screen.findByRole('option', { name })).toBeInTheDocument();
      }
      expect(screen.getAllByRole('option')).toHaveLength(16);
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('reformats a stored number whose digits fit the chosen state', async () => {
    await putSettings({ taxpayer: { name: 'Erika', taxNumber: '1234567890' } });
    taxRegistry.push(germanTax);
    renderScreen();
    await choose(/germany/i);
    const number = screen.getByLabelText('Tax number (optional)');
    await waitFor(() => expect(number).toHaveValue('1234567890'));
    await chooseState('Berlin');
    expect(number).toHaveValue('12/345/67890');
    expect(screen.queryByText(/does not match the format/i)).toBeNull();
    await waitFor(async () =>
      expect((await getSettings())?.taxpayer).toEqual({
        name: 'Erika',
        taxNumber: '12/345/67890',
        state: 'BE',
      }),
    );
  });

  it('keeps a stored number that does not fit, with a note', async () => {
    await putSettings({ taxpayer: { taxNumber: '123/456/78901' } });
    taxRegistry.push(germanTax);
    renderScreen();
    await choose(/germany/i);
    const number = screen.getByLabelText('Tax number (optional)');
    await waitFor(() => expect(number).toHaveValue('123/456/78901'));
    await chooseState('Berlin');
    expect(number).toHaveValue('123/456/78901');
    expect(
      screen.getByText('Does not match the format for Berlin'),
    ).toBeInTheDocument();
  });

  it('prints the formatted number on the sheet', async () => {
    await putSettings({
      taxpayer: { name: 'Erika', taxNumber: '12/345/67890', state: 'BE' },
    });
    vi.stubGlobal('fetch', flatRange(1));
    taxRegistry.push(germanTax);
    renderScreen();
    await choose(/germany/i);
    await waitFor(() =>
      expect(screen.getByLabelText('Tax number (optional)')).toHaveValue(
        '12/345/67890',
      ),
    );
    await run();
    expect(await screen.findByTestId('report-header')).toHaveTextContent(
      'Tax number: 12/345/67890',
    );
  });

  it('is read-only in a review for the stored state and tax number, but not for the rate', async () => {
    taxRegistry.push(germanTax);
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
    await choose(/germany/i);
    expect(
      screen.getByRole('combobox', { name: 'Federal state (optional)' }),
    ).toBeDisabled();
    expect(screen.getByLabelText('Tax number (optional)')).toBeDisabled();
    // The rate is never stored, so an advisor reviewing a copy can still
    // estimate at the client's own rate.
    expect(screen.getByLabelText(/personal tax rate/i)).toBeEnabled();
  });
});
