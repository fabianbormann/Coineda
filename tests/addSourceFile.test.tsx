import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import 'fake-indexeddb/auto';
import '@/i18n';
import { AddSourceDialog } from '@/screens/AddSourceDialog';
import { ConfirmProvider } from '@/components/confirm/ConfirmProvider';
import { registry } from '@/sources/registry';
import { fileRegistry } from '@/sources/csv/registry';

/**
 * Adding a data source, when the source is a file.
 *
 * Kraken, Binance and Coinbase refuse a browser outright, so they arrive as
 * an export rather than over an API. That is an implementation detail to a
 * person looking for Kraken in the list - they only know that one of them
 * will ask for a download - so both routes live in the same picker. Behind
 * a separate button elsewhere, looking for Kraken and not finding it read
 * as "not supported".
 */
const onImportFile = vi.fn<(file: File) => Promise<void>>();
const onCreated = vi.fn();
const onOpenChange = vi.fn();

const renderDialog = () =>
  render(
    <ConfirmProvider>
      <AddSourceDialog
        open
        onOpenChange={onOpenChange}
        onCreated={onCreated}
        onImportFile={onImportFile}
      />
    </ConfirmProvider>,
  );

const csv = (text = 'txid,refid,time,type,asset,amount,fee\n') =>
  new File([text], 'ledgers.csv', { type: 'text/csv' });

beforeEach(() => {
  onImportFile.mockReset();
  onImportFile.mockResolvedValue(undefined);
  onCreated.mockReset();
  onOpenChange.mockReset();
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches: false,
      media: '',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
});

describe('the picker', () => {
  it('lists the file importers beside the ones that connect', async () => {
    renderDialog();
    const dialog = await screen.findByRole('dialog');

    for (const module of fileRegistry) {
      expect(
        within(dialog).getByRole('button', {
          name: new RegExp(module.manifest.label.replace(/[()]/g, '.'), 'i'),
        }),
      ).toBeInTheDocument();
    }
    // And the polling ones are still there.
    expect(registry.length).toBeGreaterThan(0);
    expect(
      within(dialog).getByRole('button', { name: /bitpanda/i }),
    ).toBeInTheDocument();
  });

  it('separates the two routes, because they ask different things of you', async () => {
    renderDialog();
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(/connect automatically|automatisch verbinden/i),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/import an export file|exportdatei/i),
    ).toBeInTheDocument();
  });
});

describe('choosing a file importer', () => {
  const openKraken = async () => {
    renderDialog();
    await userEvent.click(
      await screen.findByRole('button', { name: /kraken/i }),
    );
    return screen.getByRole('dialog');
  };

  it('shows that importer’s own instructions, not a generic sentence', async () => {
    // Which export to pick is the one thing that goes wrong, and for Kraken
    // picking Trades instead of Ledgers produces a balance that looks right
    // and is not.
    const dialog = await openKraken();
    const help = dialog.textContent ?? '';
    // This renders in ENGLISH, so it checks the English labels only. An
    // earlier version matched /Ledgers|Hauptbuch/, which reads as covering
    // both locales and covers neither extra - the German string is never
    // on screen here. tests/i18n.test.ts checks that one directly.
    expect(help).toMatch(/"Ledgers"/);
    // The wrong choices are named too, because picking one fails SILENTLY:
    // Trades alone yields a balance that looks right and is too large.
    expect(help).toMatch(/"Trades"/);
    expect(help).toMatch(/"Balances"/);
  });

  it('offers a drop area that is also a button', async () => {
    // Dragging is fastest for someone with the download already in a
    // folder, and it is also the one route a keyboard cannot take. The
    // same element has to be both.
    const dialog = await openKraken();
    const drop = within(dialog).getByRole('button', {
      name: /drop the file here|hier ablegen/i,
    });
    expect(drop.tagName).toBe('BUTTON');
  });

  it('accepts a zip as well as a csv, because that is what arrives', async () => {
    // Kraken hands over a zip. A picker that only offers .csv greys out the
    // very file the instructions above told the person to download.
    const dialog = await openKraken();
    const input = within(dialog)
      .getByRole('button', { name: /drop the file here|hier ablegen/i })
      .querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.accept).toMatch(/\.zip/);
    expect(input.accept).toMatch(/\.csv/);
  });

  it('hands a dropped file straight to the importer', async () => {
    const dialog = await openKraken();
    const drop = within(dialog).getByRole('button', {
      name: /drop the file here|hier ablegen/i,
    });

    const file = csv();
    await userEvent.upload(
      drop.querySelector('input[type="file"]') as HTMLInputElement,
      file,
    );

    expect(onImportFile).toHaveBeenCalledTimes(1);
    expect(onImportFile.mock.calls[0][0].name).toBe('ledgers.csv');
  });

  it('closes once the file is in', async () => {
    const dialog = await openKraken();
    await userEvent.upload(
      within(dialog)
        .getByRole('button', { name: /drop the file here|hier ablegen/i })
        .querySelector('input[type="file"]') as HTMLInputElement,
      csv(),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('stays open on a failure and says why, next to the instructions', async () => {
    // "That was the Trades file, not the Ledgers one" is only actionable
    // while the instructions for getting the right one are on screen. A
    // toast slides away from them.
    onImportFile.mockRejectedValue(new Error('that is the trades export'));
    const dialog = await openKraken();
    await userEvent.upload(
      within(dialog)
        .getByRole('button', { name: /drop the file here|hier ablegen/i })
        .querySelector('input[type="file"]') as HTMLInputElement,
      csv(),
    );

    expect(
      await within(dialog).findByText(/that is the trades export/i),
    ).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('goes back to the picker', async () => {
    const dialog = await openKraken();
    await userEvent.click(
      within(dialog).getByRole('button', { name: /^back$|^zurück$/i }),
    );
    expect(
      within(dialog).getByText(/connect automatically|automatisch verbinden/i),
    ).toBeInTheDocument();
  });

  it('never asks a file importer for a credential', async () => {
    // It has no fields and needs no key. A form here would be asking for
    // something that does not exist.
    const dialog = await openKraken();
    expect(within(dialog).queryByLabelText(/api key/i)).toBeNull();
    expect(
      within(dialog).queryByRole('button', { name: /^save$/i }),
    ).toBeNull();
  });
});
