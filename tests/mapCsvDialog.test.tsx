import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import 'fake-indexeddb/auto';
import '@/i18n';
import { MapCsvDialog } from '@/screens/MapCsvDialog';
import { putEvents, putSource } from '@/ledger/db';
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

const KEEP = { replaceExisting: false };

const file = () => new File([FIXTURE_A], 'bison.csv', { type: 'text/csv' });

const onImport =
  vi.fn<
    (
      t: string,
      m: CsvMapping,
      n: string,
      o: { replaceExisting: boolean },
    ) => Promise<void>
  >();
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
    expect(onImport).toHaveBeenCalledWith(
      FIXTURE_A,
      MAPPING_A,
      'bison.csv',
      KEEP,
    );
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
    // Kauf is already incoming; tag it outgoing too.
    await user.click(
      within(dialog).getByRole('button', { name: 'Outgoing: Kauf' }),
    );
    expect(
      within(dialog).getByText(
        'A type value cannot be both incoming and outgoing',
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole('button', { name: 'Preview' }),
    ).toBeDisabled();
    // Untagging the conflict makes it usable again.
    await user.click(
      within(dialog).getByRole('button', { name: 'Outgoing: Kauf' }),
    );
    expect(
      within(dialog).getByRole('button', { name: 'Preview' }),
    ).toBeEnabled();
  });

  it('shows a conflicting saved mapping as a conflict', async () => {
    await putSource({
      id: 's2',
      moduleId: 'mapped-csv',
      label: 'Conflict',
      config: {
        mapping: JSON.stringify({
          ...MAPPING_A,
          venueLabel: 'Conflict',
          direction: { mode: 'type', in: ['Kauf'], out: ['Kauf'] },
        }),
        fileName: 'old.csv',
      },
    });
    const user = userEvent.setup();
    render(
      <MapCsvDialog
        open
        onOpenChange={onOpenChange}
        file={file()}
        label="Conflict"
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
      expect(
        within(dialog).getByText(
          'A type value cannot be both incoming and outgoing',
        ),
      ).toBeInTheDocument(),
    );
    expect(
      within(dialog).getByRole('button', { name: 'Preview' }),
    ).toBeDisabled();
  });

  it('names a mapped column the file does not have and blocks the preview', async () => {
    await putSource({
      id: 's3',
      moduleId: 'mapped-csv',
      label: 'Gone',
      config: {
        mapping: JSON.stringify({
          ...MAPPING_A,
          venueLabel: 'Gone',
          columns: { ...MAPPING_A.columns, fee: 'Fee' },
        }),
        fileName: 'old.csv',
      },
    });
    const user = userEvent.setup();
    render(
      <MapCsvDialog
        open
        onOpenChange={onOpenChange}
        file={file()}
        label="Gone"
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
      expect(
        within(dialog).getByText('Column Fee is not in the file'),
      ).toBeInTheDocument(),
    );
    expect(
      within(dialog).getByRole('button', { name: 'Preview' }),
    ).toBeDisabled();
  });

  it('shows the failure, stays open and re-enables Import when the import rejects', async () => {
    onImport.mockRejectedValue(new Error('the store refused it'));
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
    await user.click(within(dialog).getByRole('button', { name: 'Preview' }));
    await user.click(within(dialog).getByRole('button', { name: 'Import' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'the store refused it',
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(
      within(dialog).getByRole('button', { name: 'Import' }),
    ).toBeEnabled();
  });

  describe('a plain sign-based file', () => {
    const PLAIN = 'Date,Asset,Amount\n2024-01-01,BTC,1\n2024-01-02,BTC,2\n';
    const plain = () => new File([PLAIN], 'plain.csv', { type: 'text/csv' });

    const toStepTwo = async (user: User) => {
      render(
        <MapCsvDialog
          open
          onOpenChange={onOpenChange}
          file={plain()}
          onImport={onImport}
        />,
      );
      const dialog = await screen.findByRole('dialog');
      await user.type(within(dialog).getByLabelText('Venue label'), 'Plain');
      await user.click(
        within(dialog).getByRole('button', { name: 'Continue' }),
      );
      await user.selectOptions(field(dialog, 'Date column'), 'Date');
      await user.selectOptions(field(dialog, 'Asset column'), 'Asset');
      await user.selectOptions(field(dialog, 'Amount column'), 'Amount');
      await user.selectOptions(field(dialog, 'Kind'), 'transfer');
      return dialog;
    };

    const base: CsvMapping = {
      version: 1,
      venueLabel: 'Plain',
      delimiter: ',',
      columns: { date: 'Date', asset: 'Asset', amount: 'Amount' },
      dateFormat: 'iso',
      timeZone: 'UTC',
      decimal: 'dot',
      direction: { mode: 'sign' },
      kinds: { '*': 'transfer' },
      fiatCounter: false,
    };

    it('imports the sign-mode mapping and warns that nothing leaves', async () => {
      const user = userEvent.setup();
      const dialog = await toStepTwo(user);
      await user.click(within(dialog).getByRole('button', { name: 'Preview' }));
      expect(
        within(dialog).getByText(
          'No outgoing rows: check the direction setting',
        ),
      ).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: 'Import' }));
      await waitFor(() =>
        expect(onImport).toHaveBeenCalledWith(PLAIN, base, 'plain.csv', KEEP),
      );
    });

    it('puts a typed "other" time zone into the mapping', async () => {
      const user = userEvent.setup();
      const dialog = await toStepTwo(user);
      await user.selectOptions(field(dialog, 'Time zone'), 'Other');
      await user.type(
        within(dialog).getByLabelText('Other time zone'),
        'America/New_York',
      );
      await user.click(within(dialog).getByRole('button', { name: 'Preview' }));
      await user.click(within(dialog).getByRole('button', { name: 'Import' }));
      await waitFor(() =>
        expect(onImport).toHaveBeenCalledWith(
          PLAIN,
          { ...base, timeZone: 'America/New_York' },
          'plain.csv',
          KEEP,
        ),
      );
    });
  });

  describe('a venue that already has events', () => {
    const seed = async () => {
      await putSource({
        id: 's-replace',
        moduleId: 'mapped-csv',
        label: 'Again',
        config: {
          mapping: JSON.stringify({ ...MAPPING_A, venueLabel: 'Again' }),
          fileName: 'old.csv',
        },
      });
      const leg = {
        assetId: 'bitcoin:native',
        amount: '1',
        direction: 'in' as const,
        venue: 'csv:Again',
        role: 'principal' as const,
      };
      await putEvents(
        ['e1', 'e2', 'e3'].map((id) => ({
          id,
          sourceId: 's-replace',
          externalId: id,
          timestamp: 1,
          kind: 'transfer' as const,
          origin: 'derived' as const,
          legs: [leg],
        })),
      );
    };

    const toPreview = async (user: User) => {
      render(
        <MapCsvDialog
          open
          onOpenChange={onOpenChange}
          file={file()}
          label="Again"
          onImport={onImport}
        />,
      );
      const dialog = await screen.findByRole('dialog');
      await waitFor(() =>
        expect(
          within(dialog).getByRole('button', { name: 'Continue' }),
        ).toBeEnabled(),
      );
      await user.click(
        within(dialog).getByRole('button', { name: 'Continue' }),
      );
      await waitFor(() =>
        expect(field(dialog, 'Date column').value).toBe('Datum'),
      );
      await user.click(within(dialog).getByRole('button', { name: 'Preview' }));
      return dialog;
    };

    it('offers replacing its events, off by default', async () => {
      await seed();
      const user = userEvent.setup();
      const dialog = await toPreview(user);
      const box = within(dialog).getByRole('checkbox', {
        name: "Replace this venue's existing events (3)",
      });
      expect(box).not.toBeChecked();
      await user.click(within(dialog).getByRole('button', { name: 'Import' }));
      await waitFor(() =>
        expect(onImport).toHaveBeenCalledWith(
          FIXTURE_A,
          { ...MAPPING_A, venueLabel: 'Again' },
          'bison.csv',
          KEEP,
        ),
      );
    });

    it('replaces them only when ticked', async () => {
      await seed();
      const user = userEvent.setup();
      const dialog = await toPreview(user);
      await user.click(
        within(dialog).getByRole('checkbox', {
          name: "Replace this venue's existing events (3)",
        }),
      );
      await user.click(within(dialog).getByRole('button', { name: 'Import' }));
      await waitFor(() =>
        expect(onImport).toHaveBeenCalledWith(
          FIXTURE_A,
          { ...MAPPING_A, venueLabel: 'Again' },
          'bison.csv',
          { replaceExisting: true },
        ),
      );
    });

    it('offers nothing for a new venue', async () => {
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
      await user.type(within(dialog).getByLabelText('Venue label'), 'Fresh');
      await user.click(
        within(dialog).getByRole('button', { name: 'Continue' }),
      );
      await fillMapping(user, dialog);
      await user.click(within(dialog).getByRole('button', { name: 'Preview' }));
      expect(
        within(dialog).queryByRole('checkbox', { name: /Replace this venue/ }),
      ).toBeNull();
    });
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
      expect(onImport).toHaveBeenCalledWith(
        FIXTURE_A,
        MAPPING_A,
        'bison.csv',
        KEEP,
      ),
    );
  });
});
