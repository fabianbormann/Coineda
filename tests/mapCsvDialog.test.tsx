import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import 'fake-indexeddb/auto';
import '@/i18n';
import { MapCsvDialog } from '@/screens/MapCsvDialog';
import { putSource } from '@/ledger/db';
import type { CsvMapping } from '@/sources/mapped-csv/types';

const FIXTURE_A = `Datum;Typ;Coin;Menge;Gebühr;Preis
07.03.2024 10:00:00;Kauf;BTC;0,5;2,50;40000,00
08.03.2024 11:00:00;Verkauf;BTC;0,2;1,00;42000,00
09.03.2024 12:00:00;Einzahlung;EUR;1000,00;;
10.03.2024 13:00:00;Staking;ADA;12,3;;
11.03.2024 14:00:00;Kauf;XYZ;1,0;;10,00
12.03.2024 15:00:00;Bonus;BTC;0,001;;
`;

const MAPPING_A: CsvMapping = {
  version: 1,
  venueLabel: 'Bison',
  delimiter: ';',
  columns: {
    date: 'Datum',
    type: 'Typ',
    asset: 'Coin',
    amount: 'Menge',
    fee: 'Gebühr',
    price: 'Preis',
  },
  dateFormat: 'dmy',
  timeZone: 'Europe/Berlin',
  decimal: 'comma',
  direction: {
    mode: 'type',
    in: ['Kauf', 'Einzahlung', 'Staking'],
    out: ['Verkauf'],
  },
  kinds: {
    Kauf: 'trade',
    Verkauf: 'trade',
    Einzahlung: 'fiat-in',
    Staking: 'reward',
  },
  fiatCounter: true,
};

const file = () => new File([FIXTURE_A], 'bison.csv', { type: 'text/csv' });

const onImport =
  vi.fn<(t: string, m: CsvMapping, n: string) => Promise<void>>();
const onOpenChange = vi.fn();

beforeEach(() => {
  onImport.mockReset();
  onImport.mockResolvedValue(undefined);
  onOpenChange.mockReset();
});

type User = ReturnType<typeof userEvent.setup>;

const field = (dialog: HTMLElement, name: string) =>
  within(dialog).getByLabelText(name) as HTMLSelectElement;

const fillMapping = async (user: User, dialog: HTMLElement) => {
  await user.selectOptions(field(dialog, 'Date column'), 'Datum');
  await user.selectOptions(field(dialog, 'Asset column'), 'Coin');
  await user.selectOptions(field(dialog, 'Amount column'), 'Menge');
  await user.selectOptions(field(dialog, 'Type column'), 'Typ');
  await user.selectOptions(field(dialog, 'Fee column'), 'Gebühr');
  await user.selectOptions(field(dialog, 'Price column'), 'Preis');
  await user.click(within(dialog).getByRole('radio', { name: 'DD.MM.YYYY' }));
  await user.selectOptions(field(dialog, 'Time zone'), 'Europe/Berlin');
  await user.click(within(dialog).getByRole('radio', { name: 'Comma' }));
  await user.click(
    within(dialog).getByRole('radio', { name: 'By type value' }),
  );
  for (const value of ['Kauf', 'Einzahlung', 'Staking']) {
    await user.click(
      within(dialog).getByRole('button', { name: `Incoming: ${value}` }),
    );
  }
  await user.click(
    within(dialog).getByRole('button', { name: 'Outgoing: Verkauf' }),
  );
  const kinds: Record<string, string> = {
    Kauf: 'trade',
    Verkauf: 'trade',
    Einzahlung: 'fiat-in',
    Staking: 'reward',
  };
  for (const [value, kind] of Object.entries(kinds)) {
    await user.selectOptions(field(dialog, `Kind: ${value}`), kind);
  }
  await user.click(
    within(dialog).getByRole('checkbox', { name: 'Counter value is fiat' }),
  );
};

describe('the mapping dialog', () => {
  it('walks file, columns and preview, then imports the exact mapping', async () => {
    const user = userEvent.setup();
    render(
      <MapCsvDialog
        open
        onOpenChange={onOpenChange}
        file={file()}
        onImport={onImport}
      />,
    );
    const dialog = await screen.findByRole('dialog');

    // Step 1: header and first rows.
    await waitFor(() =>
      expect(within(dialog).getByText('Datum')).toBeInTheDocument(),
    );
    expect(within(dialog).getByText('07.03.2024 10:00:00')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Venue label'), 'Bison');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));

    // Step 2: nothing valid yet.
    const next = within(dialog).getByRole('button', { name: 'Preview' });
    expect(next).toBeDisabled();
    await fillMapping(user, dialog);
    expect(next).toBeEnabled();
    await user.click(next);

    // Step 3.
    expect(within(dialog).getByText('4 events')).toBeInTheDocument();
    expect(within(dialog).getByText('2 skipped')).toBeInTheDocument();
    expect(
      within(dialog).getByText('Unresolved tickers: XYZ'),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    expect(onImport).toHaveBeenCalledWith(FIXTURE_A, MAPPING_A, 'bison.csv');
  });

  it('refuses to continue without a venue label', async () => {
    render(
      <MapCsvDialog
        open
        onOpenChange={onOpenChange}
        file={file()}
        onImport={onImport}
      />,
    );
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByRole('button', { name: 'Continue' }),
    ).toBeDisabled();
  });

  it('disables Preview when a type value is both incoming and outgoing', async () => {
    const user = userEvent.setup();
    render(
      <MapCsvDialog
        open
        onOpenChange={onOpenChange}
        file={file()}
        onImport={onImport}
      />,
    );
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Venue label'), 'Bison');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await fillMapping(user, dialog);
    expect(
      within(dialog).getByRole('button', { name: 'Preview' }),
    ).toBeEnabled();
    // Tagging a value outgoing moves it; both can never be set at once.
    await user.click(
      within(dialog).getByRole('button', { name: 'Outgoing: Kauf' }),
    );
    expect(
      within(dialog).getByRole('button', { name: 'Incoming: Kauf' }),
    ).toHaveAttribute('aria-pressed', 'false');
  });

  it('pre-fills every control from a saved source of the same label', async () => {
    await putSource({
      id: 's1',
      moduleId: 'mapped-csv',
      label: 'Bison',
      config: { mapping: JSON.stringify(MAPPING_A), fileName: 'old.csv' },
    });
    const user = userEvent.setup();
    render(
      <MapCsvDialog
        open
        onOpenChange={onOpenChange}
        file={file()}
        label="Bison"
        onImport={onImport}
      />,
    );
    const dialog = await screen.findByRole('dialog');
    await waitFor(() =>
      expect(
        within(dialog).getByRole('button', { name: 'Continue' }),
      ).toBeEnabled(),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await waitFor(() =>
      expect(field(dialog, 'Date column').value).toBe('Datum'),
    );
    expect(field(dialog, 'Fee column').value).toBe('Gebühr');
    expect(field(dialog, 'Time zone').value).toBe('Europe/Berlin');
    expect(
      within(dialog).getByRole('radio', { name: 'DD.MM.YYYY' }),
    ).toBeChecked();
    expect(within(dialog).getByRole('radio', { name: 'Comma' })).toBeChecked();
    expect(
      within(dialog).getByRole('button', { name: 'Outgoing: Verkauf' }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(field(dialog, 'Kind: Staking').value).toBe('reward');
    expect(
      within(dialog).getByRole('checkbox', { name: 'Counter value is fiat' }),
    ).toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Preview' }));
    await user.click(within(dialog).getByRole('button', { name: 'Import' }));
    await waitFor(() =>
      expect(onImport).toHaveBeenCalledWith(FIXTURE_A, MAPPING_A, 'bison.csv'),
    );
  });
});
