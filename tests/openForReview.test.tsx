import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import 'fake-indexeddb/auto';
import {
  buildCheckpoint,
  sealCheckpoint,
  generateTransferSecret,
  type CheckpointScope,
} from '@/checkpoint/format';
import {
  DEFAULT_LEDGER_NAME,
  activeLedgerName,
  getAllEvents,
  getSources,
  openLedger,
  putEvents,
  putSource,
  setActiveLedger,
} from '@/ledger/db';
import { putSettings } from '@/settings/settingsStore';
import { putManualLink } from '@/ledger/manualLinks';
import { activeClient, listClients } from '@/clients/registry';
import { HandoverNotReviewableError, openForReview } from '@/clients/review';
import { OpenForReviewDialog } from '@/clients/OpenForReviewDialog';
import { ClientContext } from '@/clients/ClientContext';
import type { LedgerEvent } from '@/ledger/types';

const event = (n: number, origin: 'authored' | 'derived'): LedgerEvent => ({
  id: `${origin}-${n}`,
  sourceId: origin === 'authored' ? 'manual' : 'kraken',
  externalId: `${origin}-${n}`,
  timestamp: 1_700_000_000_000 + n,
  kind: 'transfer',
  origin,
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

const secret = generateTransferSecret();

const seal = async (
  scope: CheckpointScope,
  mutate?: (c: Awaited<ReturnType<typeof buildCheckpoint>>) => void,
) => {
  const checkpoint = await buildCheckpoint(scope);
  mutate?.(checkpoint);
  return sealCheckpoint(checkpoint, secret);
};

beforeEach(async () => {
  localStorage.clear();
  await setActiveLedger(DEFAULT_LEDGER_NAME);
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
  await putSource({
    id: 'kraken',
    moduleId: 'kraken-csv',
    label: 'Kraken',
    config: { apiKey: 'sekrit' },
  });
  await putManualLink({
    sourceId: 'kraken',
    externalId: 'x',
    txHash: 'a1b2'.repeat(16),
  });
  await putEvents([event(1, 'authored'), event(2, 'derived')]);
});

describe('openForReview', () => {
  it('opens a backup as the active, read-only review client', async () => {
    const source = await getAllEvents();
    const bytes = await seal('backup');
    const record = await openForReview(bytes, secret, 'client.coineda');

    expect(record.kind).toBe('review');
    expect(record.review?.verdict).toBe('match');
    expect(listClients().find((c) => c.id === record.id)?.review?.verdict).toBe(
      'match',
    );
    expect(activeClient().id).toBe(record.id);
    expect(activeLedgerName()).toMatch(/^coineda-review-/);
    expect(await getAllEvents()).toEqual(source);
    expect((await getSources())[0].config).toEqual({});
  });

  it('refuses a handover before creating any client', async () => {
    const before = listClients().length;
    const bytes = await seal('handover');
    await expect(openForReview(bytes, secret, 'h.coineda')).rejects.toThrow(
      HandoverNotReviewableError,
    );
    expect(listClients()).toHaveLength(before);
    expect(activeLedgerName()).toBe(DEFAULT_LEDGER_NAME);
  });

  it('reports no verdict when the checkpoint has no fingerprint', async () => {
    const bytes = await seal('backup', (c) => {
      delete c.fingerprint;
    });
    const record = await openForReview(bytes, secret, 'old.coineda');
    expect(record.review?.verdict).toBe('none');
  });

  it('reports a mismatch when the fingerprint disagrees', async () => {
    const bytes = await seal('backup', (c) => {
      c.fingerprint = 'f'.repeat(64);
    });
    const record = await openForReview(bytes, secret, 'bad.coineda');
    expect(record.review?.verdict).toBe('mismatch');
  });

  it('opening the same bytes twice yields two review clients', async () => {
    const bytes = await seal('backup');
    const a = await openForReview(bytes, secret, 'client.coineda');
    const b = await openForReview(bytes, secret, 'client.coineda');
    expect(a.id).not.toBe(b.id);
    expect(listClients().filter((c) => c.kind === 'review')).toHaveLength(2);
  });

  it('creates nothing when the secret is wrong', async () => {
    const bytes = await seal('backup');
    const before = listClients().length;
    await expect(
      openForReview(bytes, 'WRONGSEC', 'client.coineda'),
    ).rejects.toThrow();
    expect(listClients()).toHaveLength(before);
  });
});

const renderDialog = (switchTo: () => Promise<void> | void) => {
  const client = listClients()[0];
  render(
    <ClientContext.Provider
      value={{
        client,
        readOnly: false,
        refresh: vi.fn(),
        switchTo: async (id) => {
          await (switchTo as (id: string) => unknown)(id);
        },
      }}
    >
      <OpenForReviewDialog open onOpenChange={vi.fn()} />
    </ClientContext.Provider>,
  );
};

const fill = async (bytes: Uint8Array, name: string) => {
  await userEvent.upload(
    screen.getByLabelText(/checkpoint file/i),
    new File([bytes as BlobPart], name),
  );
  await userEvent.type(screen.getByLabelText(/transfer secret/i), secret);
  await userEvent.click(screen.getByRole('button', { name: /^open$/i }));
};

describe('OpenForReviewDialog', () => {
  it('opens a file, shows the verdict and switches to the review client', async () => {
    const switchTo = vi.fn().mockResolvedValue(undefined);
    renderDialog(switchTo);
    await fill(await seal('backup'), 'client.coineda');
    await waitFor(() => expect(switchTo).toHaveBeenCalledTimes(1));
    const review = listClients().find((c) => c.kind === 'review')!;
    expect(switchTo).toHaveBeenCalledWith(review.id);
    expect(
      await screen.findByText('Fingerprint matches the checkpoint.'),
    ).toBeInTheDocument();
  });

  it('explains why a handover cannot be reviewed', async () => {
    const switchTo = vi.fn();
    renderDialog(switchTo);
    await fill(await seal('handover'), 'h.coineda');
    expect(
      await screen.findByText(/handover checkpoint without the derived/i),
    ).toBeInTheDocument();
    expect(switchTo).not.toHaveBeenCalled();
  });
});
