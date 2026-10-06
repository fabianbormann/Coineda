import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import 'fake-indexeddb/auto';
import '@/i18n';
import { ThemeProvider } from '@/components/theme/ThemeProvider';
import { ConfirmProvider } from '@/components/confirm/ConfirmProvider';
import { Toaster } from '@/components/ui/sonner';
import { MemoryRouter } from 'react-router-dom';
import { MainScreen } from '@/screens/MainScreen';
import { openLedger, putSource, putCursor } from '@/ledger/db';
import * as ledgerDb from '@/ledger/db';
import { putSettings } from '@/settings/settingsStore';
import { registry } from '@/sources/registry';
import * as syncSourceModule from '@/sync/syncSource';
import type { FetchPage, ProbeResult } from '@/sources/types';

/**
 * Typed through the generic rather than named parameters, the same shape
 * mainScreen.test.tsx uses for its own cursor assertions - an untyped
 * `vi.fn(async () => ...)` infers a zero-length call tuple, and
 * `fetchEvents.mock.calls[0][1]` (the cursor argument every re-drain
 * assertion below reads) would not compile against that.
 */
const fetchEventsStub = () =>
  vi.fn<
    (
      config: Record<string, string>,
      cursor: string | null,
    ) => Promise<FetchPage>
  >(async () => ({ events: [], cursor: null }));

// Typed explicitly against ProbeResult, matching mainScreen.test.tsx's own
// stub - inferring the return type from the first implementation alone
// would pin it too narrowly and reject a later `mockResolvedValue({ ok:
// false, message: ... })`.
const probe = vi.fn<() => Promise<ProbeResult>>(async () => ({
  ok: true,
  readOnly: true,
}));

/**
 * A module with one of each field shape the edit dialog has to handle: a
 * `baseUrl` text field (a non-credential field compared as a trimmed
 * string), an `addressList` field (compared via parseAddressList) and an
 * `apiKey` secret field (what must never round-trip into the DOM, and never
 * triggers a re-drain on its own).
 */
const editableModule = {
  manifest: {
    id: 'test-editable',
    kind: 'chain' as const,
    label: 'Test Editable',
    fields: [
      {
        name: 'baseUrl',
        label: 'Base URL',
        type: 'text' as const,
        help: 'Leave empty to use the public instance',
        optional: true,
      },
      {
        name: 'addresses',
        label: 'Addresses',
        type: 'addressList' as const,
        help: 'One address per line',
      },
      {
        name: 'apiKey',
        label: 'API Key',
        type: 'apiKey' as const,
        help: 'Your key',
      },
    ],
    needsRelay: false,
    emits: ['transfer' as const],
    docsUrl: 'https://example.invalid/editable-docs',
  },
  probe,
  fetchEvents: vi.fn(async () => ({ events: [], cursor: null })),
};

/**
 * The actual shape of cardano-yaci/cardano-blockfrost: a single `address`
 * field, type `address` rather than `addressList`. This is the regression
 * fixture for the motivating scenario the re-drain rule exists for -
 * switching a payment address for a stake address - which a name/type rule
 * scoped to `addressList` + `baseUrl` silently missed, since neither
 * Cardano module declares an `addressList` field.
 */
const cardanoShapedModule = {
  manifest: {
    id: 'test-cardano-shaped',
    kind: 'chain' as const,
    label: 'Test Cardano Shaped',
    fields: [
      {
        name: 'baseUrl',
        label: 'Instance URL',
        type: 'text' as const,
        help: 'Leave empty to use the public instance',
        optional: true,
      },
      {
        name: 'address',
        label: 'Cardano address',
        type: 'address' as const,
        help: 'The address to track',
      },
      {
        name: 'apiKey',
        label: 'Project id',
        type: 'apiKey' as const,
        help: 'Your project id',
      },
    ],
    needsRelay: false,
    emits: ['transfer' as const],
    docsUrl: 'https://example.invalid/cardano-shaped-docs',
  },
  probe,
  fetchEvents: vi.fn(async () => ({ events: [], cursor: null })),
};

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
  registry.push({
    ...editableModule,
    fetchEvents: vi.fn(async () => ({
      events: [],
      cursor: null,
    })),
  });
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
        <MemoryRouter>
          <MainScreen onReset={vi.fn()} />
        </MemoryRouter>
        <Toaster />
      </ConfirmProvider>
    </ThemeProvider>,
  );

const seedSource = async (config: Record<string, string>) => {
  await putSource({
    id: 'cfg-1',
    moduleId: 'test-editable',
    label: 'Main',
    config,
  });
};

describe('editing a source', () => {
  it('opens with the stored label and non-secret config values filled in', async () => {
    await seedSource({
      baseUrl: 'https://example.invalid',
      addresses: 'addr1\naddr2',
      apiKey: 'super-secret-value',
    });
    renderScreen();

    await userEvent.click(
      await screen.findByRole('button', { name: /edit main/i }),
    );

    expect(await screen.findByLabelText(/^Label$/i)).toHaveValue('Main');
    expect(screen.getByLabelText(/Base URL/i)).toHaveValue(
      'https://example.invalid',
    );
    expect(screen.getByLabelText(/Addresses/i)).toHaveValue('addr1\naddr2');
  });

  it('renders a secret field EMPTY, never the stored credential', async () => {
    await seedSource({
      baseUrl: '',
      addresses: 'addr1',
      apiKey: 'super-secret-value',
    });
    renderScreen();

    await userEvent.click(
      await screen.findByRole('button', { name: /edit main/i }),
    );

    const apiKeyInput = await screen.findByLabelText(/API Key/i);
    expect(apiKeyInput).toHaveValue('');
    expect(document.body.innerHTML).not.toContain('super-secret-value');
  });

  it('leaving a secret empty keeps the stored value', async () => {
    await seedSource({
      baseUrl: '',
      addresses: 'addr1',
      apiKey: 'super-secret-value',
    });
    renderScreen();

    await userEvent.click(
      await screen.findByRole('button', { name: /edit main/i }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /^Save$/ }),
    );

    await waitFor(async () => {
      const db = await openLedger();
      const [stored] = await db.getAll('sources');
      expect(stored.config.apiKey).toBe('super-secret-value');
    });
  });

  it('typing a new secret replaces it', async () => {
    await seedSource({
      baseUrl: '',
      addresses: 'addr1',
      apiKey: 'old-secret',
    });
    renderScreen();

    await userEvent.click(
      await screen.findByRole('button', { name: /edit main/i }),
    );
    await userEvent.type(
      await screen.findByLabelText(/API Key/i),
      'new-secret',
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /^Save$/ }),
    );

    await waitFor(async () => {
      const db = await openLedger();
      const [stored] = await db.getAll('sources');
      expect(stored.config.apiKey).toBe('new-secret');
    });
  });

  it('changing only the label writes without syncing at all', async () => {
    // A rename is purely cosmetic. Unlike a credential or address/baseUrl
    // change, it must not make any request to the provider - on a slow or
    // unreachable instance that would cost the user real seconds just to
    // change a string.
    const syncSpy = vi.spyOn(syncSourceModule, 'syncSource');
    registry.length = 0;
    registry.push({ ...editableModule, fetchEvents: fetchEventsStub() });
    await seedSource({
      baseUrl: '',
      addresses: 'addr1',
      apiKey: 'secret-val',
    });
    renderScreen();

    await userEvent.click(
      await screen.findByRole('button', { name: /edit main/i }),
    );
    const labelInput = await screen.findByLabelText(/^Label$/i);
    await userEvent.clear(labelInput);
    await userEvent.type(labelInput, 'Renamed');
    await userEvent.click(
      await screen.findByRole('button', { name: /^Save$/ }),
    );

    expect(await screen.findByText('Renamed')).toBeInTheDocument();
    // A cosmetic-only change never blocked on a confirm.
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(syncSpy).not.toHaveBeenCalled();

    const db = await openLedger();
    const [stored] = await db.getAll('sources');
    expect(stored.label).toBe('Renamed');

    syncSpy.mockRestore();
  });

  it('editing only an apiKey does not re-drain, but still syncs once to pick up the corrected key', async () => {
    const syncSpy = vi.spyOn(syncSourceModule, 'syncSource');
    const fetchEvents = fetchEventsStub();
    registry.length = 0;
    registry.push({ ...editableModule, fetchEvents });
    await seedSource({
      baseUrl: '',
      addresses: 'addr1',
      apiKey: 'old-secret',
    });
    await putCursor('cfg-1', 'page-5');
    renderScreen();

    await userEvent.click(
      await screen.findByRole('button', { name: /edit main/i }),
    );
    await userEvent.type(
      await screen.findByLabelText(/API Key/i),
      'new-secret',
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /^Save$/ }),
    );

    // A credential-only change never blocks on the re-drain confirm.
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await waitFor(() => expect(syncSpy).toHaveBeenCalledTimes(1));
    expect(syncSpy.mock.calls[0][1]).toEqual(
      expect.objectContaining({ full: false }),
    );
    // Ordinary sync, not a full resync: the stored cursor is reused.
    await waitFor(() => expect(fetchEvents).toHaveBeenCalled());
    expect(fetchEvents.mock.calls[0][1]).toBe('page-5');

    const db = await openLedger();
    const [stored] = await db.getAll('sources');
    expect(stored.config.apiKey).toBe('new-secret');

    syncSpy.mockRestore();
  });

  it('editing a Cardano-shaped address field re-drains (regression: switching a payment address for a stake address)', async () => {
    const fetchEvents = fetchEventsStub();
    registry.length = 0;
    registry.push({ ...cardanoShapedModule, fetchEvents });
    await putSource({
      id: 'cfg-1',
      moduleId: 'test-cardano-shaped',
      label: 'Main',
      config: { baseUrl: '', address: 'addr1_payment', apiKey: 'secret-val' },
    });
    await putCursor('cfg-1', 'page-5');
    renderScreen();

    await userEvent.click(
      await screen.findByRole('button', { name: /edit main/i }),
    );
    const addressInput = await screen.findByLabelText(/Cardano address/i);
    await userEvent.clear(addressInput);
    await userEvent.type(addressInput, 'stake1_account');
    await userEvent.click(
      await screen.findByRole('button', { name: /^Save$/ }),
    );

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/whole history again/i);
    await userEvent.click(
      within(dialog).getByRole('button', { name: /save and resync/i }),
    );

    await waitFor(() => expect(fetchEvents).toHaveBeenCalled());
    // Full resync: the cursor was reset, so the first page is requested
    // from the start, not from the stored cursor - proving this single
    // `type: 'address'` field DOES trigger a re-drain, unlike the narrower
    // rule this regression test guards against reintroducing.
    expect(fetchEvents.mock.calls[0][1]).toBeNull();
  });

  it('changing the address list confirms, then full-resyncs', async () => {
    const fetchEvents = fetchEventsStub();
    registry.length = 0;
    registry.push({ ...editableModule, fetchEvents });
    await seedSource({
      baseUrl: '',
      addresses: 'addr1',
      apiKey: 'secret-val',
    });
    await putCursor('cfg-1', 'page-5');
    renderScreen();

    await userEvent.click(
      await screen.findByRole('button', { name: /edit main/i }),
    );
    const addresses = await screen.findByLabelText(/Addresses/i);
    await userEvent.clear(addresses);
    await userEvent.type(addresses, 'addr1{enter}addr2');
    await userEvent.click(
      await screen.findByRole('button', { name: /^Save$/ }),
    );

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/whole history again/i);
    await userEvent.click(
      within(dialog).getByRole('button', { name: /save and resync/i }),
    );

    await waitFor(() => expect(fetchEvents).toHaveBeenCalled());
    // Full resync: the cursor was reset, so the first page is requested
    // from the start, not from the stored cursor.
    expect(fetchEvents.mock.calls[0][1]).toBeNull();
  });

  it('REORDERING the address list confirms, then full-resyncs', async () => {
    // Order is semantic, not cosmetic: src/sources/addressList.ts dedupes
    // while PRESERVING first-seen order, and bitcoin-esplora resolves a
    // transaction appearing under several configured addresses to the FIRST
    // one in the list. So swapping two addresses re-attributes every
    // transaction they share - the venue and the owning address both change -
    // without adding or removing a single address.
    //
    // A `needsRedrain` that compared parsed lists as SETS, or by length,
    // would treat this as no change at all and leave the ledger holding
    // events attributed to the old owner, with no way for the user to
    // discover it. The sibling test above only adds an address, which a
    // length comparison would still catch; this is the case that separates
    // order-sensitive comparison from set-equality.
    const fetchEvents = fetchEventsStub();
    registry.length = 0;
    registry.push({ ...editableModule, fetchEvents });
    await seedSource({
      baseUrl: '',
      addresses: 'addr1\naddr2',
      apiKey: 'secret-val',
    });
    await putCursor('cfg-1', 'page-5');
    renderScreen();

    await userEvent.click(
      await screen.findByRole('button', { name: /edit main/i }),
    );
    const addresses = await screen.findByLabelText(/Addresses/i);
    await userEvent.clear(addresses);
    // The same two addresses, swapped. Nothing added, nothing removed.
    await userEvent.type(addresses, 'addr2{enter}addr1');
    await userEvent.click(
      await screen.findByRole('button', { name: /^Save$/ }),
    );

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/whole history again/i);
    await userEvent.click(
      within(dialog).getByRole('button', { name: /save and resync/i }),
    );

    await waitFor(() => expect(fetchEvents).toHaveBeenCalled());
    expect(fetchEvents.mock.calls[0][1]).toBeNull();
    // And the new order is what was stored, so the re-drain attributes
    // ownership the way the user just asked for.
    const db = await openLedger();
    const [stored] = await db.getAll('sources');
    expect(stored.config.addresses).toBe('addr2\naddr1');
  });

  it('changing baseUrl confirms, then full-resyncs', async () => {
    const fetchEvents = fetchEventsStub();
    registry.length = 0;
    registry.push({ ...editableModule, fetchEvents });
    await seedSource({
      baseUrl: '',
      addresses: 'addr1',
      apiKey: 'secret-val',
    });
    await putCursor('cfg-1', 'page-5');
    renderScreen();

    await userEvent.click(
      await screen.findByRole('button', { name: /edit main/i }),
    );
    const baseUrl = await screen.findByLabelText(/Base URL/i);
    await userEvent.type(baseUrl, 'https://new.invalid');
    await userEvent.click(
      await screen.findByRole('button', { name: /^Save$/ }),
    );

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/whole history again/i);
    await userEvent.click(
      within(dialog).getByRole('button', { name: /save and resync/i }),
    );

    await waitFor(() => expect(fetchEvents).toHaveBeenCalled());
    expect(fetchEvents.mock.calls[0][1]).toBeNull();
  });

  it('cancelling the confirm leaves the stored record untouched', async () => {
    const fetchEvents = fetchEventsStub();
    registry.length = 0;
    registry.push({ ...editableModule, fetchEvents });
    await seedSource({
      baseUrl: '',
      addresses: 'addr1',
      apiKey: 'secret-val',
    });
    renderScreen();

    await userEvent.click(
      await screen.findByRole('button', { name: /edit main/i }),
    );
    const addresses = await screen.findByLabelText(/Addresses/i);
    await userEvent.clear(addresses);
    await userEvent.type(addresses, 'addr2');
    await userEvent.click(
      await screen.findByRole('button', { name: /^Save$/ }),
    );

    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(
      within(dialog).getByRole('button', { name: /^Cancel$/ }),
    );

    expect(fetchEvents).not.toHaveBeenCalled();
    const db = await openLedger();
    const [stored] = await db.getAll('sources');
    expect(stored.config.addresses).toBe('addr1');
  });

  it('a failed probe refuses the save and leaves the record untouched', async () => {
    await seedSource({
      baseUrl: '',
      addresses: 'addr1',
      apiKey: 'secret-val',
    });
    probe.mockResolvedValue({
      ok: false,
      message: 'Could not reach the provider',
    });
    renderScreen();

    await userEvent.click(
      await screen.findByRole('button', { name: /edit main/i }),
    );
    const labelInput = await screen.findByLabelText(/^Label$/i);
    await userEvent.clear(labelInput);
    await userEvent.type(labelInput, 'Renamed');
    await userEvent.click(
      await screen.findByRole('button', { name: /^Save$/ }),
    );

    expect(
      await screen.findByText(/could not reach the provider/i),
    ).toBeInTheDocument();
    const db = await openLedger();
    const [stored] = await db.getAll('sources');
    expect(stored.label).toBe('Main');
  });

  it('disables the Edit button while the source is busy', async () => {
    let release: (() => void) | undefined;
    const fetchEvents = vi.fn<() => Promise<FetchPage>>(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ events: [], cursor: null });
        }),
    );
    registry.length = 0;
    registry.push({ ...editableModule, fetchEvents });
    await seedSource({
      baseUrl: '',
      addresses: 'addr1',
      apiKey: 'secret-val',
    });
    renderScreen();
    await screen.findByText('Main');

    await userEvent.click(
      await screen.findByRole('button', { name: /^refresh main$/i }),
    );

    const editButton = await screen.findByRole('button', {
      name: /edit main/i,
    });
    await waitFor(() => expect(editButton).toBeDisabled());

    release?.();
    await waitFor(() => expect(editButton).not.toBeDisabled());
  });

  // Mirrors mainScreen.test.tsx's own pair of tests for the add flow
  // ('warns prominently when the key turns out to be writable' /
  // 'does not warn when the provider has no way to tell whether the key is
  // read-only'), plus a third the edit flow needs that the add flow
  // doesn't: declining must leave the STORED record alone, where the add
  // flow has nothing stored yet to protect.
  it('warns prominently when the key turns out to be writable', async () => {
    // A writable key is this app's biggest single risk - carried over from
    // AddSourceDialog's save path, but the edit path had no test of its own
    // exercising it, so nothing would have caught a refactor silently
    // dropping it here.
    probe.mockResolvedValue({ ok: true, readOnly: false });
    await seedSource({
      baseUrl: '',
      addresses: 'addr1',
      apiKey: 'secret-val',
    });
    renderScreen();

    await userEvent.click(
      await screen.findByRole('button', { name: /edit main/i }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /^Save$/ }),
    );

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/more than read access/i);
  });

  it('declining the writable-key warning leaves the stored record untouched', async () => {
    probe.mockResolvedValue({ ok: true, readOnly: false });
    await seedSource({
      baseUrl: '',
      addresses: 'addr1',
      apiKey: 'secret-val',
    });
    // Spied on only after seeding, so the setup write above is not counted -
    // this asserts nothing writes as a RESULT of declining the warning.
    const putSourceSpy = vi.spyOn(ledgerDb, 'putSource');
    renderScreen();

    await userEvent.click(
      await screen.findByRole('button', { name: /edit main/i }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /^Save$/ }),
    );

    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(
      within(dialog).getByRole('button', { name: /^Cancel$/ }),
    );

    expect(putSourceSpy).not.toHaveBeenCalled();
    const db = await openLedger();
    const [stored] = await db.getAll('sources');
    expect(stored.config.apiKey).toBe('secret-val');

    putSourceSpy.mockRestore();
  });

  it('does not warn when the provider has no way to tell whether the key is read-only', async () => {
    // readOnly undefined is NOT the same as readOnly === false - a provider
    // that cannot tell must not be treated as a confirmed write risk. This
    // is the one-character difference that discriminates `result.readOnly
    // === false` from `!result.readOnly`: the latter would wrongly warn
    // here too, and a test suite covering only the writable and the
    // unchanged-config cases above cannot tell the two apart.
    probe.mockResolvedValue({ ok: true });
    await seedSource({
      baseUrl: '',
      addresses: 'addr1',
      apiKey: 'secret-val',
    });
    renderScreen();

    await userEvent.click(
      await screen.findByRole('button', { name: /edit main/i }),
    );
    const labelInput = await screen.findByLabelText(/^Label$/i);
    await userEvent.clear(labelInput);
    await userEvent.type(labelInput, 'Renamed');
    await userEvent.click(
      await screen.findByRole('button', { name: /^Save$/ }),
    );

    expect(
      screen.queryByText(/more than read access/i),
    ).not.toBeInTheDocument();
    // Proves the save was never blocked, not merely that no warning text
    // happened to render.
    expect(await screen.findByText('Renamed')).toBeInTheDocument();
    const db = await openLedger();
    const [stored] = await db.getAll('sources');
    expect(stored.label).toBe('Renamed');
  });
});
