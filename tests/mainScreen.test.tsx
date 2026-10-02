import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import 'fake-indexeddb/auto';
import '@/i18n';
import { ThemeProvider } from '@/components/theme/ThemeProvider';
import { ConfirmProvider } from '@/components/confirm/ConfirmProvider';
import { Toaster } from '@/components/ui/sonner';
import { MainScreen } from '@/screens/MainScreen';
import { openLedger, putSource, putEvents } from '@/ledger/db';
import * as ledgerDb from '@/ledger/db';
import { putSettings } from '@/settings/settingsStore';
import { registry } from '@/sources/registry';
import type { LedgerEvent } from '@/ledger/types';
import type { FetchPage, ProbeResult } from '@/sources/types';
import { CARDANO_MESSAGES } from '@/sources/cardano/messages';

// Typed explicitly against ProbeResult - inferring the mock's return type
// from its first implementation alone would pin it to `{ ok: boolean;
// readOnly: boolean }` and reject the later `mockResolvedValue({ ok: false,
// message: ... })` calls below as an excess-property error, even though
// those are exactly the shapes the real ProbeResult type allows.
const probe = vi.fn<() => Promise<ProbeResult>>(async () => ({
  ok: true,
  readOnly: true,
}));

const testModule = {
  manifest: {
    id: 'test-exchange',
    kind: 'exchange' as const,
    label: 'Test Exchange',
    fields: [
      {
        name: 'apiKey',
        label: 'API Key',
        type: 'apiKey' as const,
        help: 'Your key',
      },
      {
        name: 'apiSecret',
        label: 'Secret Key',
        type: 'secret' as const,
        help: 'Your secret',
      },
    ],
    requiredScopes: ['Read Info'],
    needsRelay: true,
    emits: ['trade' as const],
    docsUrl: 'https://example.invalid/docs',
  },
  probe,
  fetchEvents: vi.fn(async () => ({ events: [], cursor: null })),
};

/**
 * A module with an OPTIONAL field, which the previous stub above did not
 * have - the dialog had therefore never been rendered against a manifest
 * carrying one, which is exactly why "leave this empty" fields were
 * unsaveable. `baseUrl` here mirrors cardano-yaci's own optional field;
 * `address` stays required so one stub covers both halves of the rule.
 */
const optionalFieldModule = {
  manifest: {
    id: 'test-chain',
    kind: 'chain' as const,
    label: 'Test Chain',
    fields: [
      {
        name: 'baseUrl',
        label: 'Instance URL',
        type: 'text' as const,
        help: 'Leave this empty to use the public instance',
        optional: true,
      },
      {
        name: 'address',
        label: 'Chain address',
        type: 'address' as const,
        help: 'The address to track',
      },
    ],
    needsRelay: false,
    emits: ['transfer' as const],
    docsUrl: 'https://example.invalid/chain-docs',
  },
  probe,
  fetchEvents: vi.fn(async () => ({ events: [], cursor: null })),
};

const heldEvent = (): LedgerEvent => ({
  id: crypto.randomUUID(),
  sourceId: 'cfg-1',
  externalId: 'tx1#0',
  timestamp: 1_700_000_000_000,
  kind: 'reward',
  origin: 'derived',
  legs: [
    {
      assetId: 'cardano:lovelace',
      // 10 ADA in lovelace: the spot price is per whole ADA, so the
      // balance header below is 10 x 20 = 200. See src/prices/scale.ts.
      amount: '10000000',
      direction: 'in',
      venue: 'addr1',
      role: 'principal',
    },
  ],
});

beforeEach(async () => {
  const db = await openLedger();
  for (const store of [
    'events',
    'sources',
    'cursors',
    'settings',
    'prices',
  ] as const) {
    await db.clear(store);
  }
  await putSettings({ language: 'en', baseCurrency: 'eur' });
  probe.mockClear();
  probe.mockResolvedValue({ ok: true, readOnly: true });
  registry.length = 0;
  registry.push(testModule, optionalFieldModule);
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

const renderScreen = () =>
  render(
    <ThemeProvider>
      <ConfirmProvider>
        <MainScreen />
        <Toaster />
      </ConfirmProvider>
    </ThemeProvider>,
  );

describe('with no sources', () => {
  it('invites a first data source instead of showing a blank page', async () => {
    renderScreen();
    expect(await screen.findByText(/no data sources yet/i)).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: /add a data source/i }),
    ).toBeInTheDocument();
  });
});

describe('the balance', () => {
  it('discloses an unpriced asset rather than quietly understating the total', async () => {
    // A missing price counted as zero gives the user no way to notice the
    // figure is wrong.
    await putSource({
      id: 'cfg-1',
      moduleId: 'test-exchange',
      label: 'Main',
      config: {},
    });
    await putEvents([heldEvent()]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );

    renderScreen();

    expect(
      await screen.findByText(/1 asset has no price/i),
    ).toBeInTheDocument();
  });

  it('shows the total in the configured base currency, not always in euro', async () => {
    // localeDefaults makes 'usd' the fallback for most users, so this is
    // the DEFAULT path - the suite previously seeded 'eur' everywhere,
    // which is why a hardcoded euro sign in the formatter stayed green.
    await putSettings({ language: 'en', baseCurrency: 'usd' });
    await putSource({
      id: 'cfg-1',
      moduleId: 'test-exchange',
      label: 'Main',
      config: {},
    });
    await putEvents([heldEvent()]);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ cardano: { usd: 20 } }), {
            status: 200,
          }),
      ),
    );

    renderScreen();

    const total = await screen.findByText(/200\.00/);
    expect(total.textContent).toContain('$');
    expect(total.textContent).not.toContain('\u20ac');
  });
});

describe('the source list', () => {
  it('shows a failed sync on its own row without blanking the others', async () => {
    await putSource({
      id: 'cfg-1',
      moduleId: 'test-exchange',
      label: 'Broken',
      config: {},
      lastError: 'provider refused the key',
    });
    await putSource({
      id: 'cfg-2',
      moduleId: 'test-exchange',
      label: 'Healthy',
      config: {},
    });

    renderScreen();

    expect(
      await screen.findByText(/provider refused the key/i),
    ).toBeInTheDocument();
    expect(await screen.findByText('Healthy')).toBeInTheDocument();
  });

  it('confirms a removal and says the synced events go with it', async () => {
    await putSource({
      id: 'cfg-1',
      moduleId: 'test-exchange',
      label: 'Main',
      config: {},
    });
    renderScreen();

    await userEvent.click(
      await screen.findByRole('button', { name: /remove Main/i }),
    );

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/synced events/i);
  });

  it('actually deletes the synced events and drops them from the balance once confirmed', async () => {
    await putSource({
      id: 'cfg-1',
      moduleId: 'test-exchange',
      label: 'Main',
      config: {},
    });
    await putEvents([heldEvent()]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );

    renderScreen();

    // Before removal: the derived event's asset is held and unpriced - the
    // same disclosure the balance test above exercises.
    expect(
      await screen.findByText(/1 asset has no price/i),
    ).toBeInTheDocument();

    await userEvent.click(
      await screen.findByRole('button', { name: /remove Main/i }),
    );
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(
      within(dialog).getByRole('button', { name: /^Remove$/ }),
    );

    // The source is gone, and so is the balance that depended on its
    // events - a regression that silently dropped the cascade's event
    // deletion would leave this disclosure (or a nonzero balance) behind.
    expect(await screen.findByText(/no data sources yet/i)).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByText(/1 asset has no price/i),
      ).not.toBeInTheDocument(),
    );

    const db = await openLedger();
    expect(await db.getAll('events')).toHaveLength(0);
    expect(await db.getAll('sources')).toHaveLength(0);
    expect(await db.getAll('cursors')).toHaveLength(0);
  });

  it('disables remove and refresh on a row while a bulk sync is in flight', async () => {
    // `syncAll` processes sources sequentially with no per-item progress
    // callback, and captures `sources` by closure in MainScreen. Without
    // gating, removing this source while its own page is still in flight
    // would let `syncSource` finish by calling `putSource({ ...source,
    // lastSyncedAt })` after the removal already ran, resurrecting the
    // record (and whatever it just fetched) the user just deleted. Held
    // open deliberately so the row is observably busy for this assertion.
    let release: (() => void) | undefined;
    testModule.fetchEvents.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ events: [], cursor: null });
        }),
    );

    await putSource({
      id: 'cfg-1',
      moduleId: 'test-exchange',
      label: 'Main',
      config: {},
    });

    renderScreen();
    await screen.findByText('Main');

    await userEvent.click(
      await screen.findByRole('button', { name: /^sync all$/i }),
    );

    const removeButton = await screen.findByRole('button', {
      name: /remove Main/i,
    });
    const refreshButton = await screen.findByRole('button', {
      name: /refresh Main/i,
    });
    await waitFor(() => {
      expect(removeButton).toBeDisabled();
      expect(refreshButton).toBeDisabled();
    });

    // A click against a disabled button fires no handler either way, but
    // this also exercises the handler's own guard directly - belt and
    // braces against a future change that relaxed the `disabled` attribute
    // without also touching `handleRemove`.
    await userEvent.click(removeButton);
    const db = await openLedger();
    expect(await db.getAll('sources')).toHaveLength(1);

    release?.();

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /remove Main/i }),
      ).not.toBeDisabled();
    });
    expect(await db.getAll('sources')).toHaveLength(1);
  });

  it('keeps the previously-loaded list on screen when a reload fails', async () => {
    await putSource({
      id: 'cfg-1',
      moduleId: 'test-exchange',
      label: 'Main',
      config: {},
    });

    renderScreen();
    expect(await screen.findByText('Main')).toBeInTheDocument();

    // The initial load already succeeded and `sources` holds the correct
    // list - only the NEXT reload, triggered by the refresh click below,
    // fails.
    const getSourcesSpy = vi
      .spyOn(ledgerDb, 'getSources')
      .mockRejectedValueOnce(new Error('offline'));

    await userEvent.click(
      await screen.findByRole('button', { name: /refresh Main/i }),
    );

    expect(
      await screen.findByText(/could not load your data sources/i),
    ).toBeInTheDocument();
    // A transient reload failure must not blank the list that was already
    // correctly on screen - only replace it when there is genuinely
    // nothing to show.
    expect(await screen.findByText('Main')).toBeInTheDocument();

    getSourcesSpy.mockRestore();
  });
});

describe('adding a source', () => {
  it('renders the manifest fields, masks secrets, and names the required scopes', async () => {
    renderScreen();
    await userEvent.click(
      await screen.findByRole('button', { name: /add a data source/i }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /Test Exchange/i }),
    );

    // A credential must never render as a readable text input.
    expect(await screen.findByLabelText(/API Key/i)).toHaveAttribute(
      'type',
      'password',
    );
    expect(await screen.findByLabelText(/Secret Key/i)).toHaveAttribute(
      'type',
      'password',
    );
    // The user should enable exactly these permissions and nothing wider.
    expect(await screen.findByText(/Read Info/)).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: /docs/i })).toHaveAttribute(
      'href',
      'https://example.invalid/docs',
    );
  });

  it('probes before saving and refuses to save when the probe fails', async () => {
    probe.mockResolvedValue({
      ok: false,
      message: 'Could not reach the provider',
    });
    renderScreen();
    await userEvent.click(
      await screen.findByRole('button', { name: /add a data source/i }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /Test Exchange/i }),
    );
    await userEvent.type(await screen.findByLabelText(/API Key/i), 'k');
    await userEvent.type(await screen.findByLabelText(/Secret Key/i), 's');
    await userEvent.click(
      await screen.findByRole('button', { name: /^Save$/ }),
    );

    expect(probe).toHaveBeenCalled();
    expect(
      await screen.findByText(/could not reach the provider/i),
    ).toBeInTheDocument();
    const db = await openLedger();
    expect(await db.getAll('sources')).toHaveLength(0);
  });

  it('interpolates a probe message’s placeholders instead of showing them raw', async () => {
    // The dialog renders ProbeResult.message through t(). Without
    // messageParams the user sees a literal "{{example}}" where the host
    // they are meant to copy should be - and the one message that needs
    // interpolation is the one telling them their base URL is wrong.
    probe.mockResolvedValue({
      ok: false,
      message: CARDANO_MESSAGES.hostShape,
      messageParams: { example: 'https://provider.example.org' },
    });
    renderScreen();
    await userEvent.click(
      await screen.findByRole('button', { name: /add a data source/i }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /Test Exchange/i }),
    );
    await userEvent.type(await screen.findByLabelText(/API Key/i), 'k');
    await userEvent.type(await screen.findByLabelText(/Secret Key/i), 's');
    await userEvent.click(
      await screen.findByRole('button', { name: /^Save$/ }),
    );

    expect(
      await screen.findByText(/https:\/\/provider\.example\.org/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/\{\{example\}\}/)).not.toBeInTheDocument();
  });

  it('warns prominently when the key turns out to be writable', async () => {
    // A writable exchange key is the user's largest risk in this whole app.
    probe.mockResolvedValue({ ok: true, readOnly: false });
    renderScreen();
    await userEvent.click(
      await screen.findByRole('button', { name: /add a data source/i }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /Test Exchange/i }),
    );
    await userEvent.type(await screen.findByLabelText(/API Key/i), 'k');
    await userEvent.type(await screen.findByLabelText(/Secret Key/i), 's');
    await userEvent.click(
      await screen.findByRole('button', { name: /^Save$/ }),
    );

    expect(
      await screen.findByText(/more than read access/i),
    ).toBeInTheDocument();
  });

  it('saves with an optional field left empty, as its own help text instructs', async () => {
    // The regression this covers: every field was validated as required, so
    // a field whose help text says "leave this empty" could never be saved
    // at all - the primary flow of the milestone, blocked by the UI's own
    // instruction.
    renderScreen();
    await userEvent.click(
      await screen.findByRole('button', { name: /add a data source/i }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /Test Chain/i }),
    );
    await userEvent.type(
      await screen.findByLabelText(/Chain address/i),
      'addr1',
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /^Save$/ }),
    );

    const db = await openLedger();
    await waitFor(async () => {
      expect(await db.getAll('sources')).toHaveLength(1);
    });
    expect(
      screen.queryByText(/this field is required/i),
    ).not.toBeInTheDocument();
    const [stored] = await db.getAll('sources');
    expect(stored.moduleId).toBe('test-chain');
  });

  it('still blocks a required field left empty on the same form', async () => {
    // `optional` must narrow the check, not switch it off: the required
    // field next to the optional one still has to block the save.
    renderScreen();
    await userEvent.click(
      await screen.findByRole('button', { name: /add a data source/i }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /Test Chain/i }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /^Save$/ }),
    );

    // Exactly one error: the required field's. The optional field next to
    // it must not produce a second one.
    const errors = await screen.findAllByText(/this field is required/i);
    expect(errors).toHaveLength(1);
    expect(await screen.findByLabelText(/Chain address/i)).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(probe).not.toHaveBeenCalled();
    const db = await openLedger();
    expect(await db.getAll('sources')).toHaveLength(0);
  });

  it('does not warn when the provider has no way to tell whether the key is read-only', async () => {
    // readOnly undefined is NOT the same as readOnly === false - a
    // provider that cannot tell must not be treated as a confirmed write
    // risk. `if (!result.readOnly)` would wrongly warn here; only
    // `readOnly === false` should.
    probe.mockResolvedValue({ ok: true });
    renderScreen();
    await userEvent.click(
      await screen.findByRole('button', { name: /add a data source/i }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /Test Exchange/i }),
    );
    await userEvent.type(await screen.findByLabelText(/API Key/i), 'k');
    await userEvent.type(await screen.findByLabelText(/Secret Key/i), 's');
    await userEvent.click(
      await screen.findByRole('button', { name: /^Save$/ }),
    );

    const db = await openLedger();
    await waitFor(async () => {
      expect(await db.getAll('sources')).toHaveLength(1);
    });
    expect(
      screen.queryByText(/more than read access/i),
    ).not.toBeInTheDocument();
  });
});

describe('sync lifecycle', () => {
  it('syncs a source immediately after it is added', async () => {
    // Reported from testing. A new source that sits there saying "Never
    // synced" until the user hunts for a refresh button looks broken, and
    // adding a source is an unambiguous request for its data.
    const fetchEvents = vi.fn(async () => ({ events: [], cursor: null }));
    registry.length = 0;
    registry.push({ ...optionalFieldModule, fetchEvents });

    renderScreen();

    await userEvent.click(
      await screen.findByRole('button', { name: /add a data source/i }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /test chain/i }),
    );
    const address = await screen.findByLabelText(/address/i);
    await userEvent.type(address, 'addr_test1_auto');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(fetchEvents).toHaveBeenCalled());
  });

  it('offers Stop while a sync is running, not a disabled spinner', async () => {
    // The other half of the report: the refresh button greyed out for the
    // whole sync with no way to interrupt it.
    let release: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      release = resolve;
    });
    let seenSignal: AbortSignal | undefined;

    registry.length = 0;
    registry.push({
      ...optionalFieldModule,
      fetchEvents: vi.fn(async (_config, _cursor, signal) => {
        seenSignal = signal as AbortSignal;
        release?.();
        // Never settles on its own: the only way out is the signal, which
        // is exactly the situation a user needs a Stop button for.
        await new Promise<void>((_, reject) => {
          signal?.addEventListener('abort', () =>
            reject(
              new DOMException('The operation was aborted.', 'AbortError'),
            ),
          );
        });
        return { events: [], cursor: null };
      }),
    });

    await putSource({
      id: 'cfg-stop',
      moduleId: 'test-chain',
      label: 'Stoppable',
      config: { address: 'addr_test1_stop' },
    });

    renderScreen();

    await userEvent.click(
      await screen.findByRole('button', { name: /refresh stoppable/i }),
    );
    await started;

    const stop = await screen.findByRole('button', {
      name: /stop syncing stoppable/i,
    });
    expect(stop).toBeEnabled();

    await userEvent.click(stop);

    await waitFor(() => expect(seenSignal?.aborted).toBe(true));
    // And the row goes back to offering a refresh rather than staying stuck.
    expect(
      await screen.findByRole('button', { name: /refresh stoppable/i }),
    ).toBeInTheDocument();
  });

  it('does not mark a stopped sync as failed', async () => {
    // A stop is not an error. A red "Sync failed" row for doing exactly
    // what was asked trains the user to distrust the status.
    registry.length = 0;
    registry.push({
      ...optionalFieldModule,
      fetchEvents: vi.fn(async (_config, _cursor, signal) => {
        await new Promise<void>((_, reject) => {
          signal?.addEventListener('abort', () =>
            reject(
              new DOMException('The operation was aborted.', 'AbortError'),
            ),
          );
        });
        return { events: [], cursor: null };
      }),
    });

    await putSource({
      id: 'cfg-stop2',
      moduleId: 'test-chain',
      label: 'Quiet',
      config: { address: 'addr_test1_quiet' },
    });

    renderScreen();
    await userEvent.click(
      await screen.findByRole('button', { name: /refresh quiet/i }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /stop syncing quiet/i }),
    );

    await waitFor(() =>
      expect(screen.queryByText(/sync failed/i)).not.toBeInTheDocument(),
    );
  });
});

describe('repairing what is already on disk', () => {
  it('offers a resync from scratch and says it re-downloads the history', async () => {
    // An ordinary refresh cannot repair every wrong row. A re-drain upserts
    // on (sourceId, externalId), so a row the module emits again IS
    // corrected - but a transaction the module now (correctly) produces no
    // legs for is SKIPPED, and a skipped event is never updated or deleted.
    // A row recorded before the collateral and reference-input fixes keeps
    // its phantom disposal until something deletes it, and
    // syncSource(source, { full: true }) was reachable from nowhere in this
    // UI.
    await putSource({
      id: 'cfg-resync',
      moduleId: 'test-exchange',
      label: 'Stale',
      config: {},
    });
    renderScreen();

    await userEvent.click(
      await screen.findByRole('button', { name: /resync Stale from scratch/i }),
    );

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/whole history again/i);
  });

  it('drains from the start, discarding what the source synced before', async () => {
    // Typed through the generic rather than named parameters, so
    // `mock.calls[0][1]` is the cursor - an untyped `vi.fn(async () => ...)`
    // has a zero-length call tuple and the assertion below, which is the
    // whole test, would not compile.
    const fetchEvents = vi.fn<
      (
        config: Record<string, string>,
        cursor: string | null,
      ) => Promise<FetchPage>
    >(async () => ({ events: [], cursor: null }));
    registry.length = 0;
    registry.push({ ...testModule, fetchEvents });

    await putSource({
      id: 'cfg-resync2',
      moduleId: 'test-exchange',
      label: 'Stale',
      config: {},
    });
    // A phantom row from before the fix, and a cursor that would otherwise
    // make an ordinary refresh skip straight past it.
    await putEvents([
      {
        ...heldEvent(),
        id: 'phantom-1',
        sourceId: 'cfg-resync2',
        externalId: 'phantom',
      },
    ]);
    await ledgerDb.putCursor('cfg-resync2', 'page-9');

    renderScreen();
    await userEvent.click(
      await screen.findByRole('button', { name: /resync Stale from scratch/i }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /^Resync$/ }),
    );

    await waitFor(() => expect(fetchEvents).toHaveBeenCalled());
    // Drained from the start, not from the persisted cursor.
    expect(fetchEvents.mock.calls[0][1]).toBeNull();
    // And the row an ordinary re-drain would have silently kept is gone.
    const db = await openLedger();
    await waitFor(async () =>
      expect(
        (await db.getAll('events')).filter(
          (event) => event.sourceId === 'cfg-resync2',
        ),
      ).toEqual([]),
    );
  });

  it('does nothing when the confirmation is declined', async () => {
    const fetchEvents = vi.fn(async () => ({ events: [], cursor: null }));
    registry.length = 0;
    registry.push({ ...testModule, fetchEvents });
    await putSource({
      id: 'cfg-resync3',
      moduleId: 'test-exchange',
      label: 'Stale',
      config: {},
    });
    renderScreen();
    await userEvent.click(
      await screen.findByRole('button', { name: /resync Stale from scratch/i }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /^Cancel$/ }),
    );
    expect(fetchEvents).not.toHaveBeenCalled();
  });

  it('is gated by the same busy rule as refresh', async () => {
    // Removing or syncing a source while a resync is in flight is the same
    // race the busyIds set already exists for - a resync must not be the
    // one action that escapes it.
    registry.length = 0;
    registry.push({
      ...optionalFieldModule,
      fetchEvents: vi.fn(
        () => new Promise<never>(() => {}),
      ) as unknown as typeof optionalFieldModule.fetchEvents,
    });
    await putSource({
      id: 'cfg-busy',
      moduleId: 'test-chain',
      label: 'Busy',
      config: { address: 'addr_test1_busy' },
    });
    renderScreen();

    await userEvent.click(
      await screen.findByRole('button', { name: /refresh busy/i }),
    );

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /resync Busy from scratch/i }),
      ).toBeDisabled(),
    );
  });
});

describe('a failed sync that reports a translation key', () => {
  it('renders it translated on the row, not as the raw English key', async () => {
    // SyncReport.error is documented as never a translation key, but
    // fetchCardanoEvents throws one of CARDANO_MESSAGES - which syncSource
    // stores verbatim as lastError and SourceRow rendered raw, so a German
    // user was shown the English sentence. Keying on the English string is
    // this project's whole i18n model, so one t() on the detail covers both
    // a key and a raw provider diagnostic.
    const i18n = (await import('@/i18n')).default;
    await i18n.changeLanguage('de');
    try {
      await putSource({
        id: 'cfg-keyed',
        moduleId: 'test-exchange',
        label: 'Keyed',
        config: {},
        lastError: CARDANO_MESSAGES.stakeAddressNeedsAccountApi,
      });
      renderScreen();
      expect(
        await screen.findByText(/Zahlungsadressen der Wallet|Zahlungsadresse/i),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(new RegExp('That looks like a stake address')),
      ).not.toBeInTheDocument();
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('still shows a raw provider diagnostic unchanged', async () => {
    // t() hands back any string it has no key for, so wrapping the detail
    // must not mangle a provider's own message - including the colon, which
    // i18next would otherwise be free to read as a namespace separator.
    await putSource({
      id: 'cfg-raw',
      moduleId: 'test-exchange',
      label: 'Raw',
      config: {},
      lastError: 'cardano: listing transactions failed with status 404',
    });
    renderScreen();
    expect(
      await screen.findByText(
        /cardano: listing transactions failed with status 404/,
      ),
    ).toBeInTheDocument();
  });
});
