import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import 'fake-indexeddb/auto';
import i18n from '@/i18n';
import { CarfReconcileDialog } from '@/screens/CarfReconcileDialog';
import type { CarfReconciliation } from '@/carf/reconcile';
import type { LedgerEvent, SourceRecord } from '@/ledger/types';
import type { SourceDirectoryEntry } from '@/tax/sourceDirectory';

const fixture = (name: string) =>
  readFileSync(path.join(__dirname, 'assets', 'carf', name), 'utf8');

const xmlFile = (text: string | Uint8Array, name = 'carf.xml') =>
  new File([text as BlobPart], name, { type: 'text/xml' });

const sources: SourceRecord[] = [
  { id: 's-bitpanda', moduleId: 'bitpanda', label: 'Bitpanda', config: {} },
  { id: 's-kraken', moduleId: 'kraken-csv', label: 'Kraken', config: {} },
  {
    id: 's-wallet',
    moduleId: 'cardano-blockfrost',
    label: 'My Cardano wallet',
    config: {},
  },
];

const entry = (
  sourceId: string,
  moduleId: string,
  label: string,
  venues: string[],
): SourceDirectoryEntry => ({
  sourceId,
  moduleId,
  label,
  venues,
  identities: [],
  hasXpub: false,
  eventCount: 1,
});

const directory: SourceDirectoryEntry[] = [
  entry('s-bitpanda', 'bitpanda', 'Bitpanda', ['bitpanda']),
  entry('s-kraken', 'kraken-csv', 'Kraken', ['kraken']),
  entry('s-wallet', 'cardano-blockfrost', 'My Cardano wallet', ['addr1own']),
];

const events: LedgerEvent[] = [
  {
    id: 'buy',
    sourceId: 's-bitpanda',
    externalId: 'buy',
    timestamp: Date.UTC(2026, 2, 1),
    kind: 'trade',
    origin: 'derived',
    legs: [
      {
        assetId: 'fiat:eur',
        amount: '5000',
        direction: 'out',
        venue: 'bitpanda',
        role: 'principal',
      },
      {
        assetId: 'bitcoin:native',
        amount: '8000000',
        direction: 'in',
        venue: 'bitpanda',
        role: 'principal',
      },
    ],
  },
];

const onReconciled = vi.fn<(r: CarfReconciliation) => void>();
const onOpenChange = vi.fn();

beforeEach(async () => {
  await i18n.changeLanguage('en');
  onReconciled.mockReset();
  onOpenChange.mockReset();
});

const renderDialog = (
  props: Partial<{ taxYear: number; taxNumber: string }> = {},
) =>
  render(
    <CarfReconcileDialog
      open
      onOpenChange={onOpenChange}
      taxYear={props.taxYear ?? 2026}
      baseCurrency="eur"
      sources={sources}
      directory={directory}
      events={events}
      valueOf={() => undefined}
      taxNumber={props.taxNumber}
      onReconciled={onReconciled}
    />,
  );

const drop = async (file: File) => {
  const box = await screen.findByRole('dialog');
  const input = box.ownerDocument.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  await userEvent.upload(input, file);
  return box;
};

describe('CarfReconcileDialog', () => {
  it('lists the users, preselects by tax number and proposes the provider source', async () => {
    renderDialog({ taxNumber: '12/345/678/901' });
    const box = await drop(xmlFile(fixture('plain.xml')));

    const erika = await within(box).findByRole('radio', {
      name: /erika mustermann/i,
    });
    const other = within(box).getByRole('radio', { name: /beispiel ug/i });
    expect(erika).toBeChecked();
    expect(other).not.toBeChecked();
    expect(box.textContent).toContain('DE2026U0001');

    // Chain sources are not offered: a provider cannot have reported them.
    expect(
      within(box).queryByRole('checkbox', { name: /my cardano wallet/i }),
    ).toBeNull();
    expect(
      within(box).getByRole('checkbox', { name: /bitpanda/i }),
    ).toBeChecked();
    expect(
      within(box).getByRole('checkbox', { name: /kraken/i }),
    ).not.toBeChecked();

    await userEvent.click(within(box).getByRole('button', { name: 'Compare' }));
    await waitFor(() => expect(onReconciled).toHaveBeenCalledTimes(1));
    const result = onReconciled.mock.calls[0][0];
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.sourceIds).toEqual(['s-bitpanda']);
    expect(result.user.name).toBe('Erika Mustermann');
    expect(result.fileHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.rows.some((row) => row.symbol === 'BTC')).toBe(true);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('preselects the user whose TIN matches, not merely the first', async () => {
    renderDialog({ taxNumber: '99 / 999 / 99999' });
    const box = await drop(xmlFile(fixture('plain.xml')));
    expect(
      await within(box).findByRole('radio', { name: /beispiel ug/i }),
    ).toBeChecked();
  });

  it('disables Compare while no source is selected', async () => {
    renderDialog();
    const box = await drop(xmlFile(fixture('plain.xml')));
    const compare = await within(box).findByRole('button', {
      name: 'Compare',
    });
    expect(compare).toBeEnabled();
    await userEvent.click(
      within(box).getByRole('checkbox', { name: /bitpanda/i }),
    );
    expect(compare).toBeDisabled();
  });

  it('refuses a message for another year and lists no user', async () => {
    renderDialog({ taxYear: 2025 });
    const box = await drop(xmlFile(fixture('plain.xml')));
    expect(
      await within(box).findByText(
        'This message is for 2026; the report is for 2025.',
      ),
    ).toBeInTheDocument();
    expect(within(box).queryByRole('radio')).toBeNull();
  });

  it('shows the parse error for a file that is not XML', async () => {
    renderDialog();
    const box = await drop(xmlFile('this is not xml at all', 'notes.xml'));
    expect(
      await within(box).findByText('The file is not well-formed XML.'),
    ).toBeInTheDocument();
    expect(within(box).queryByRole('radio')).toBeNull();
  });

  it('reads a UTF-16 file with a byte order mark', async () => {
    renderDialog();
    const text = fixture('plain.xml').replace(
      'encoding="UTF-8"',
      'encoding="UTF-16"',
    );
    const bytes = new Uint8Array(2 + text.length * 2);
    bytes[0] = 0xff;
    bytes[1] = 0xfe;
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      bytes[2 + i * 2] = code & 0xff;
      bytes[3 + i * 2] = code >> 8;
    }
    const box = await drop(xmlFile(bytes));
    expect(
      await within(box).findByRole('radio', { name: /erika mustermann/i }),
    ).toBeInTheDocument();
  });

  it('lists a deleted user but does not let it be compared', async () => {
    renderDialog();
    const box = await drop(xmlFile(fixture('deleted-user.xml')));
    const deleted = await within(box).findByRole('radio', {
      name: /erika mustermann/i,
    });
    expect(deleted).toBeDisabled();
    expect(deleted).not.toBeChecked();
    expect(within(box).getByText('Deleted')).toBeInTheDocument();
    expect(within(box).getByRole('button', { name: 'Compare' })).toBeDisabled();
  });
});
