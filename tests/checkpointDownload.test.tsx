import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import 'fake-indexeddb/auto';
import '@/i18n';
import { ExportCheckpointDialog } from '@/checkpoint/ExportCheckpointDialog';
import { openCheckpoint } from '@/checkpoint/format';
import { openLedger, putEvents, putSource } from '@/ledger/db';
import { putManualLink } from '@/ledger/manualLinks';
import { putSettings } from '@/settings/settingsStore';
import type { LedgerEvent } from '@/ledger/types';

/**
 * Getting a checkpoint OFF this device as a file.
 *
 * The file channel existed only as a fallback for a checkpoint too large
 * to scan, which made it unreachable for most people: a small checkpoint
 * offered a QR code and nothing else, so moving one to a device that is
 * not in the same room meant pointing a camera at a screen that was
 * somewhere else.
 */
const authoredEvent = (n: number): LedgerEvent => ({
  id: `authored-${n}`,
  sourceId: 'manual',
  externalId: `manual-${n}`,
  timestamp: 1_700_000_000_000 + n,
  kind: 'transfer',
  origin: 'authored',
  legs: [
    {
      assetId: 'cardano:lovelace',
      amount: '1000000',
      direction: 'in',
      venue: 'addr_test1_mine',
      role: 'principal',
    },
  ],
});

/** What the page handed to the browser: the bytes and the filename. */
type Saved = { bytes: Uint8Array; filename: string };

let saved: Saved[] = [];
let clickSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  const db = await openLedger();
  for (const store of [
    'events',
    'sources',
    'cursors',
    'settings',
    'transferLinks',
  ] as const) {
    await db.clear(store);
  }
  await putSettings({ language: 'en', baseCurrency: 'eur' });
  saved = [];

  // jsdom has neither of these. Captured rather than merely stubbed: the
  // test asserts what the download CONTAINS, not just that a click
  // happened - a button that saved an empty file would pass otherwise.
  const blobs = new Map<string, Blob>();
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: (blob: Blob) => {
      const url = `blob:${blobs.size}`;
      blobs.set(url, blob);
      return url;
    },
    revokeObjectURL: () => {},
  });
  clickSpy = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(function (this: HTMLAnchorElement) {
      const blob = blobs.get(this.href);
      if (!blob) {
        throw new Error(`clicked an anchor with no blob: ${this.href}`);
      }
      saved.push({
        // Read synchronously later via the promise below; stored as the
        // promise's result so the assertions can await it.
        bytes: new Uint8Array(),
        filename: this.download,
      });
      void blob.arrayBuffer().then((buffer) => {
        saved[saved.length - 1].bytes = new Uint8Array(buffer);
      });
    });
});

afterEach(() => {
  clickSpy.mockRestore();
  vi.unstubAllGlobals();
});

const openDialog = () =>
  render(<ExportCheckpointDialog open onOpenChange={() => {}} />);

/** The secret the dialog is showing, read off the screen the way the user
 *  would - it is the only way to prove the file matches what they were
 *  told to type. */
const shownSecret = (): string => {
  // Eight base32 characters, in the one element that renders it as such -
  // matched on the shape `generateTransferSecret` produces rather than on
  // surrounding copy, which is translated.
  const node = screen.getByText(/^[A-Z2-7]{8}$/);
  return node.textContent ?? '';
};

describe('downloading a checkpoint', () => {
  it('offers the file alongside the QR code, not only instead of it', async () => {
    await putSource({
      id: 'cfg-1',
      moduleId: 'test',
      label: 'My Wallet',
      config: {},
    });

    openDialog();

    // Small enough to scan: the code is there...
    await screen.findByAltText(/checkpoint qr code/i);
    // ...and so is the file, which used to appear only above the QR size
    // limit.
    expect(
      screen.getByRole('button', { name: /download checkpoint/i }),
    ).toBeInTheDocument();
  });

  it('saves bytes that open with the secret on screen', async () => {
    await putSource({
      id: 'cfg-1',
      moduleId: 'test',
      label: 'My Wallet',
      config: { apiKey: 'secret-value' },
    });
    await putManualLink({
      sourceId: 'kraken',
      externalId: 'LLSN5F-UR5OY-DD6KMV',
      txHash: 'a1b2'.repeat(16),
    });

    openDialog();
    await screen.findByAltText(/checkpoint qr code/i);
    const secret = shownSecret();

    await userEvent.click(
      screen.getByRole('button', { name: /download checkpoint/i }),
    );

    await waitFor(() => expect(saved[0]?.bytes.byteLength).toBeGreaterThan(0));
    expect(saved[0].filename).toMatch(
      /^coineda-checkpoint-\d{4}-\d{2}-\d{2}\.coineda$/,
    );

    // Decrypts with the displayed secret - so the file and the words next
    // to it are the same checkpoint - and carries what a restore needs.
    const checkpoint = await openCheckpoint(saved[0].bytes, secret);
    expect(checkpoint.sources).toEqual([
      {
        id: 'cfg-1',
        moduleId: 'test',
        label: 'My Wallet',
        config: { apiKey: 'secret-value' },
      },
    ]);
    expect(checkpoint.transferLinks).toHaveLength(1);
  });

  it('refuses the file to anyone without that secret', async () => {
    openDialog();
    await screen.findByAltText(/checkpoint qr code/i);

    await userEvent.click(
      screen.getByRole('button', { name: /download checkpoint/i }),
    );
    await waitFor(() => expect(saved[0]?.bytes.byteLength).toBeGreaterThan(0));

    await expect(
      openCheckpoint(saved[0].bytes, 'WRONG-SECRET-ENTIRELY'),
    ).rejects.toThrow();
  });

  it('drops the code, but keeps the file, once it is too big to scan', async () => {
    // Authored events, deliberately: those are the part of a HANDOVER that
    // is unbounded, so they are what can push even a handover past a code.
    await putEvents(
      Array.from({ length: 400 }, (_, index) => authoredEvent(index)),
    );

    openDialog();

    await screen.findByText(/too large for a code/i);
    expect(screen.queryByAltText(/checkpoint qr code/i)).toBeNull();
    expect(
      screen.getByRole('button', { name: /download checkpoint/i }),
    ).toBeInTheDocument();
  });
});

/**
 * The two artifacts, which answer two different questions.
 *
 * The code sets up a device standing in front of you; it cannot carry a
 * ledger, and the measurements in tests/checkpointExport.test.ts say why.
 * The file is the one that outlives the sources it came from. Offering one
 * as a degraded version of the other hid that difference - and hid, in
 * particular, that scanning the code leaves the history behind.
 */
describe('handover beside backup', () => {
  /** A synced event: the kind a handover leaves behind. */
  const syncedEvent = (n: number): LedgerEvent => ({
    ...authoredEvent(n),
    id: `synced-${n}`,
    externalId: `synced-${n}`,
    sourceId: 'cfg-1',
    origin: 'derived',
  });

  beforeEach(async () => {
    await putSource({
      id: 'cfg-1',
      moduleId: 'test',
      label: 'My Wallet',
      config: { apiKey: 'secret-value' },
    });
  });

  it('says how many transactions the code leaves behind', async () => {
    await putEvents(Array.from({ length: 3 }, (_, n) => syncedEvent(n)));

    openDialog();
    await screen.findByAltText(/checkpoint qr code/i);

    // The number, on the sending device, BEFORE the user scans - so they
    // can reach for the file instead if that is what they wanted.
    expect(await screen.findByText(/3 recorded transactions/i)).toBeVisible();
  });

  it('encodes the handover, not the backup', async () => {
    // Pins the wiring without decoding the image, which jsdom cannot do:
    // 400 synced events make a BACKUP far too large for any code, so a
    // component that encoded the wrong payload would render no image at
    // all. The image appearing is the assertion.
    await putEvents(Array.from({ length: 400 }, (_, n) => syncedEvent(n)));

    openDialog();

    expect(await screen.findByAltText(/checkpoint qr code/i)).toBeVisible();
    expect(await screen.findByText(/400 recorded transactions/i)).toBeVisible();
  });

  it('keeps the file complete while the code carries none of it', async () => {
    await putEvents(Array.from({ length: 3 }, (_, n) => syncedEvent(n)));

    openDialog();
    await screen.findByAltText(/checkpoint qr code/i);
    const secret = shownSecret();

    await userEvent.click(
      screen.getByRole('button', { name: /download checkpoint/i }),
    );
    await waitFor(() => expect(saved[0]?.bytes.byteLength).toBeGreaterThan(0));

    const backup = await openCheckpoint(saved[0].bytes, secret);
    expect(backup.derivedEvents).toHaveLength(3);
    // A backup states nothing about leftovers, because it has none.
    expect(backup.omittedEventCount).toBeUndefined();
    expect(backup.sources).toEqual([
      {
        id: 'cfg-1',
        moduleId: 'test',
        label: 'My Wallet',
        config: { apiKey: 'secret-value' },
      },
    ]);
  });

  it('says nothing about leftovers when there are none', async () => {
    // A fresh install has no history to leave behind, and a sentence
    // about zero transactions would be noise at exactly the moment the
    // user is being asked to trust the thing.
    openDialog();
    await screen.findByAltText(/checkpoint qr code/i);

    expect(screen.queryByText(/recorded transactions do not fit/i)).toBeNull();
  });
});

/**
 * Where the secret sits on screen.
 *
 * Scanning the code is only half an instruction - the other device then
 * asks for a transfer secret. Stacked below a code that filled the dialog,
 * the secret was off the bottom of a desktop window, so someone who had
 * never heard of one scanned, got asked, and never found out the answer
 * was on the screen in front of them.
 *
 * jsdom applies no CSS, so what is asserted is the STRUCTURE the layout
 * rests on: the secret and the code are in one container, and the secret
 * comes before the rest of the dialog rather than after it.
 */
describe('the transfer secret', () => {
  it('sits in the same block as the code it belongs to', async () => {
    openDialog();
    const code = await screen.findByAltText(/checkpoint qr code/i);
    const secret = screen.getByText(/^[A-Z2-7]{8}$/);

    expect(code.parentElement).not.toBeNull();
    expect(code.parentElement!.contains(secret)).toBe(true);
  });

  it('is not left below everything else', async () => {
    openDialog();
    await screen.findByAltText(/checkpoint qr code/i);
    const secret = screen.getByText(/^[A-Z2-7]{8}$/);
    const download = screen.getByRole('button', {
      name: /download checkpoint/i,
    });

    // DOCUMENT_POSITION_FOLLOWING: the download button comes after the
    // secret, i.e. the secret is not the last thing in the dialog.
    expect(
      secret.compareDocumentPosition(download) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('is shown once, not once per artifact', async () => {
    // Two copies read as two different secrets, and the sealing run only
    // ever produces one.
    openDialog();
    await screen.findByAltText(/checkpoint qr code/i);

    expect(screen.getAllByText(/^[A-Z2-7]{8}$/)).toHaveLength(1);
  });
});
