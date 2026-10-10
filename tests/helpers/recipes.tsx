import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import 'fake-indexeddb/auto';
import i18n from '@/i18n';
import { MemoryRouter } from 'react-router-dom';
import App from '../../src/App';
import { ThemeProvider } from '@/components/theme/ThemeProvider';
import {
  ConfirmProvider,
  useConfirm,
} from '@/components/confirm/ConfirmProvider';
import { Toaster } from '@/components/ui/sonner';
import { MainScreen } from '@/screens/MainScreen';
import { TaxReportScreen } from '@/screens/TaxReportScreen';
import { AddSourceDialog } from '@/screens/AddSourceDialog';
import { MapCsvDialog } from '@/screens/MapCsvDialog';
import { ExportCheckpointDialog } from '@/checkpoint/ExportCheckpointDialog';
import { OpenForReviewDialog } from '@/clients/OpenForReviewDialog';
import { ClientContext } from '@/clients/ClientContext';
import { createClient, listClients } from '@/clients/registry';
import { JourneyDialog } from '@/journey/JourneyDialog';
import { OnboardingFlow } from '@/onboarding/OnboardingFlow';
import {
  DEFAULT_LEDGER_NAME,
  openLedger,
  putEvents,
  putSource,
  setActiveLedger,
} from '@/ledger/db';
import { putSettings, setOnboarded } from '@/settings/settingsStore';
import { registry } from '@/sources/registry';
import { taxRegistry } from '@/tax/registry';
import germanTax from '@/tax/jurisdictions/de';
import type { LedgerEvent } from '@/ledger/types';
import type { AssessInput, TaxAssessment, TaxModule } from '@/tax/types';

/**
 * Render recipes for the axe gate (tests/axe.test.tsx).
 *
 * Each recipe starts from a clean device, renders one screen or opens one
 * dialog inside the providers it needs, and resolves once the content axe
 * should look at is in the DOM. The setups are lifted from the screen's own
 * test file, which stays the place that proves behaviour; these only have
 * to put the UI on screen.
 *
 * A new screen or dialog adds a recipe here. tests/axe.test.tsx fails if a
 * `src/**\/*Dialog.tsx` file has no recipe naming it.
 */
export type Recipe = { name: string; render: () => Promise<void> };

const matchMedia = () =>
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches: false,
      media: '',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );

/** One price answer for every request; nothing here asserts on figures. */
const stubFetch = () =>
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ bitcoin: { eur: 20000 } }), {
          status: 200,
        }),
    ),
  );

/** A clean, onboarded device in English on the default ledger. */
const freshDevice = async ({ onboarded = true } = {}) => {
  localStorage.clear();
  await i18n.changeLanguage('en');
  await setActiveLedger(DEFAULT_LEDGER_NAME);
  const db = await openLedger();
  for (const store of [
    'events',
    'sources',
    'cursors',
    'settings',
    'prices',
    'transferLinks',
  ] as const) {
    await db.clear(store);
  }
  await putSettings({ language: 'en', baseCurrency: 'eur' });
  if (onboarded) await setOnboarded();
  matchMedia();
  stubFetch();
  Object.defineProperty(window, 'innerWidth', {
    writable: true,
    configurable: true,
    value: 1024,
  });
};

const stubModule = {
  manifest: {
    id: 'test-module',
    kind: 'exchange' as const,
    label: 'Test Exchange',
    fields: [],
    requiredScopes: [],
    needsRelay: false,
    emits: ['transfer' as const, 'trade' as const],
    docsUrl: 'https://example.invalid/docs',
  },
  probe: vi.fn(async () => ({ ok: true, readOnly: true })),
  fetchEvents: vi.fn(async () => ({ events: [], cursor: null })),
};

/** A module with a text field, so the edit dialog has a form to show. */
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
  probe: vi.fn(async () => ({ ok: true, readOnly: true })),
  fetchEvents: vi.fn(async () => ({ events: [], cursor: null })),
};

const registerStubModules = () => {
  registry.length = 0;
  registry.push(stubModule, editableModule);
};

const BTC = 'bitcoin:native';
const HASH = 'a1b2'.repeat(16);

/** An exchange buy, a wallet spend and an exchange deposit with no hash:
 *  enough for balances, per-source amounts and one proposed transfer. */
const events: LedgerEvent[] = [
  {
    id: 'deposit',
    sourceId: 'kraken',
    externalId: 'fiat:deposit-1',
    timestamp: Date.UTC(2025, 0, 1),
    kind: 'fiat-in',
    origin: 'derived',
    legs: [
      {
        assetId: 'fiat:eur',
        amount: '10000',
        direction: 'in',
        venue: 'kraken',
        role: 'principal',
      },
    ],
  },
  {
    id: 'kraken-in',
    sourceId: 'kraken',
    externalId: 'LLSN5F-UR5OY-DD6KMV',
    timestamp: Date.UTC(2025, 2, 1, 13),
    kind: 'transfer',
    origin: 'derived',
    legs: [
      {
        assetId: BTC,
        amount: '7545306',
        direction: 'in',
        venue: 'kraken',
        role: 'principal',
      },
    ],
  },
  {
    id: 'wallet-out',
    sourceId: 'bitcoin',
    externalId: HASH,
    txHash: HASH,
    timestamp: Date.UTC(2025, 2, 1, 12, 40),
    kind: 'transfer',
    origin: 'derived',
    legs: [
      {
        assetId: BTC,
        amount: '40000000',
        direction: 'out',
        venue: 'bc1qown',
        role: 'principal',
      },
      {
        assetId: BTC,
        amount: '32454500',
        direction: 'in',
        venue: 'bc1qown',
        role: 'principal',
      },
    ],
  },
];

/** Two sources, because one source hides every per-source rendering path. */
const seedTwoSources = async () => {
  registerStubModules();
  await putSource({
    id: 'kraken',
    moduleId: 'test-module',
    label: 'Kraken',
    config: {},
  });
  await putSource({
    id: 'bitcoin',
    moduleId: 'test-editable',
    label: 'My Wallet',
    config: { baseUrl: 'https://example.invalid' },
  });
  await putEvents(events);
};

const renderMainScreen = async () => {
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
  await screen.findByText('My Wallet');
};

const dialog = () => screen.findByRole('dialog');

// ---- Tax report ----------------------------------------------------------

const testTaxModule: TaxModule = {
  manifest: {
    id: 'test-jurisdiction',
    jurisdiction: 'Testland',
    contributor: 'Test Suite',
    rulesCheckedOn: '2025-01-01',
    rulesVersion: '1.0.0',
    changelog: [{ version: '1.0.0', date: '2025-01-01', summary: 'Initial.' }],
    partitionLabel: 'Test partition',
    references: ['Test Statute §1'],
    supportedYears: { from: 2020, to: 2030 },
  },
  handles: ['trade', 'transfer', 'reward', 'fiat-in', 'fiat-out'],
  defaultMatching: 'fifo',
  partitionBy: (event) => event.venue,
  classify: (event) =>
    event.legs.map((leg, index) => ({
      sourceEventId: `${event.id}:${index}`,
      kind: leg.direction === 'in' ? 'acquisition' : 'disposal',
      assetId: leg.assetId,
      amount: leg.amount,
      timestamp: event.timestamp,
      venue: leg.venue,
    })),
  assess: (input: AssessInput): TaxAssessment => ({
    year: input.year,
    lines: input.matched.map((m) => ({
      disposalEventId: m.disposalEventId,
      assetId: m.assetId,
      timestamp: m.timestamp,
      proceeds: '500',
      costBasis: '300',
      gain: '200',
      exempt: '0',
      taxable: '200',
      reason: { key: 'Fully taxable test disposal' },
    })),
    totals: {
      taxableGain: input.matched.length > 0 ? '200' : '0',
      exemptGain: '0',
      income: '0',
      loss: '0',
      computedFrom: input.matched.length,
      omitted: 0,
    },
    thresholds: [
      {
        label: 'Test threshold',
        limit: '100',
        actual: input.matched.length > 0 ? '200' : '0',
        exceeded: input.matched.length > 0,
        kind: 'freigrenze',
      },
    ],
    estimatedLiability: input.rate !== undefined ? '42' : undefined,
    unresolved: [],
  }),
};

const eurLeg = (direction: 'in' | 'out') => ({
  assetId: 'fiat:eur',
  amount: '100',
  direction,
  venue: 'wallet-a',
  role: 'principal' as const,
});

const taxEvents: LedgerEvent[] = [
  {
    id: 'acq',
    sourceId: 's1',
    externalId: 'acq',
    timestamp: Date.UTC(2025, 5, 1),
    kind: 'transfer',
    origin: 'derived',
    legs: [eurLeg('in')],
  },
  {
    id: 'disp',
    sourceId: 's1',
    externalId: 'disp',
    timestamp: Date.UTC(2025, 6, 1),
    kind: 'transfer',
    origin: 'derived',
    legs: [eurLeg('out')],
  },
];

const openJurisdiction = async (module: TaxModule, name: RegExp) => {
  taxRegistry.length = 0;
  taxRegistry.push(module);
  render(
    <MemoryRouter>
      <TaxReportScreen />
    </MemoryRouter>,
  );
  await userEvent.click(await screen.findByRole('button', { name }));
};

// ---- Onboarding ----------------------------------------------------------

const renderOnboarding = async () => {
  await freshDevice({ onboarded: false });
  render(
    <ThemeProvider>
      <OnboardingFlow onComplete={vi.fn()} />
      <Toaster />
    </ThemeProvider>,
  );
};

// ---- Confirm -------------------------------------------------------------

const ConfirmHarness = () => {
  const confirm = useConfirm();
  return (
    <main>
      <h1>Confirm harness</h1>
      <button
        type="button"
        onClick={() =>
          void confirm({
            title: 'Delete this transaction?',
            description: 'This cannot be undone.',
            destructive: true,
          })
        }
      >
        ask
      </button>
    </main>
  );
};

export const recipes: Recipe[] = [
  {
    name: 'MainScreen with two sources',
    render: async () => {
      await freshDevice();
      await seedTwoSources();
      await renderMainScreen();
      await screen.findByText('Kraken');
    },
  },
  {
    name: 'TaxReportScreen setup step',
    render: async () => {
      await freshDevice();
      await putEvents(taxEvents);
      await openJurisdiction(testTaxModule, /testland/i);
      await screen.findByLabelText(/tax year/i);
    },
  },
  {
    name: 'TaxReportScreen report step (stub module)',
    render: async () => {
      await freshDevice();
      await putEvents(taxEvents);
      await openJurisdiction(testTaxModule, /testland/i);
      const year = await screen.findByLabelText(/tax year/i);
      await userEvent.clear(year);
      await userEvent.type(year, '2025');
      await userEvent.click(
        await screen.findByRole('button', { name: /run report/i }),
      );
      await waitFor(() =>
        expect(screen.queryByText(/running your tax report/i)).toBeNull(),
      );
      await screen.findAllByText(/test threshold/i);
    },
  },
  {
    name: 'DatevSettingsCard within TaxReportScreen setup (Germany)',
    render: async () => {
      await freshDevice();
      await openJurisdiction(germanTax, /germany/i);
      const advisor = await screen.findByLabelText(/^advisor number/i);
      await waitFor(() => expect(advisor).toBeEnabled());
    },
  },
  {
    name: 'AddSourceDialog (file section)',
    render: async () => {
      await freshDevice();
      render(
        <ConfirmProvider>
          <AddSourceDialog
            open
            onOpenChange={vi.fn()}
            onCreated={vi.fn()}
            onImportFile={vi.fn(async () => {})}
            onImportMapped={vi.fn()}
          />
        </ConfirmProvider>,
      );
      await userEvent.click(
        await screen.findByRole('button', { name: /kraken/i }),
      );
      await within(await dialog()).findByRole('button', {
        name: /drop the file here/i,
      });
    },
  },
  {
    name: 'EditSourceDialog',
    render: async () => {
      await freshDevice();
      await seedTwoSources();
      await renderMainScreen();
      await userEvent.click(
        await screen.findByRole('button', { name: /edit my wallet/i }),
      );
      await screen.findByLabelText(/^Label$/i);
    },
  },
  {
    name: 'MapCsvDialog step 2',
    render: async () => {
      await freshDevice();
      const user = userEvent.setup();
      render(
        <MapCsvDialog
          open
          onOpenChange={vi.fn()}
          file={
            new File(
              [
                'Datum;Typ;Coin;Menge;Gebühr;Preis\n' +
                  '07.03.2024 10:00:00;Kauf;BTC;0,5;2,50;40000,00\n' +
                  '08.03.2024 11:00:00;Verkauf;BTC;0,2;1,00;42000,00\n' +
                  '09.03.2024 12:00:00;Einzahlung;EUR;1000,00;;\n',
              ],
              'bison.csv',
              { type: 'text/csv' },
            )
          }
          onImport={vi.fn(async () => {})}
        />,
      );
      const box = await dialog();
      await waitFor(() =>
        expect(within(box).getByText('Datum')).toBeInTheDocument(),
      );
      await user.type(within(box).getByLabelText('Venue label'), 'Bison');
      await user.click(within(box).getByRole('button', { name: 'Continue' }));
      await within(box).findByRole('button', { name: 'Preview' });
    },
  },
  {
    name: 'ReviewTransfersDialog',
    render: async () => {
      await freshDevice();
      await seedTwoSources();
      await renderMainScreen();
      await userEvent.click(
        await screen.findByRole('button', { name: /possible transfer/i }),
      );
      await screen.findByRole('button', { name: /yes, this is one transfer/i });
    },
  },
  {
    name: 'SourceEventsDialog',
    render: async () => {
      await freshDevice();
      await seedTwoSources();
      await renderMainScreen();
      await userEvent.click(
        await screen.findByRole('button', {
          name: /show events from Kraken/i,
        }),
      );
      await within(await dialog()).findByText(/LLSN5F-UR5OY-DD6KMV/);
    },
  },
  {
    name: 'ExportCheckpointDialog',
    render: async () => {
      await freshDevice();
      await putSource({
        id: 'cfg-1',
        moduleId: 'test',
        label: 'My Wallet',
        config: {},
      });
      render(<ExportCheckpointDialog open onOpenChange={() => {}} />);
      await screen.findByAltText(/checkpoint qr code/i);
    },
  },
  {
    name: 'OpenForReviewDialog',
    render: async () => {
      await freshDevice();
      render(
        <ClientContext.Provider
          value={{
            client: listClients()[0],
            readOnly: false,
            refresh: vi.fn(),
            switchTo: vi.fn(async () => {}),
          }}
        >
          <OpenForReviewDialog open onOpenChange={vi.fn()} />
        </ClientContext.Provider>,
      );
      await screen.findByLabelText(/checkpoint file/i);
    },
  },
  {
    name: 'ClientMenu open with the delete dialog',
    render: async () => {
      await freshDevice();
      createClient('Client B');
      render(<App />);
      await userEvent.click(
        await screen.findByRole('button', { name: /clients/i }),
      );
      await userEvent.click(
        await screen.findByRole('menuitem', { name: /delete client/i }),
      );
      await screen.findByLabelText('Type the label to confirm');
    },
  },
  {
    name: 'ConfirmProvider dialog',
    render: async () => {
      render(
        <ConfirmProvider>
          <ConfirmHarness />
        </ConfirmProvider>,
      );
      await userEvent.click(screen.getByRole('button', { name: 'ask' }));
      await screen.findByRole('alertdialog');
    },
  },
  {
    name: 'OnboardingFlow start',
    render: async () => {
      await renderOnboarding();
      await screen.findByRole('button', { name: /start fresh/i });
    },
  },
  {
    name: 'ImportCheckpoint (file path)',
    render: async () => {
      await renderOnboarding();
      await userEvent.click(
        await screen.findByRole('button', { name: /have a checkpoint/i }),
      );
      await userEvent.click(
        await screen.findByRole('button', { name: /from a file/i }),
      );
      await screen.findByLabelText(/checkpoint file/i);
    },
  },
  {
    name: 'StartFresh',
    render: async () => {
      await renderOnboarding();
      await userEvent.click(
        await screen.findByRole('button', { name: /start fresh/i }),
      );
      await screen.findByRole('button', { name: /confirm/i });
    },
  },
  {
    name: 'JourneyDialog',
    render: async () => {
      await freshDevice();
      await seedTwoSources();
      // jsdom has no 2D canvas backend; the dialog's renderer only calls
      // these, as in tests/journeyDialog.test.tsx.
      const ctx = {
        clearRect: vi.fn(),
        fillRect: vi.fn(),
        fillText: vi.fn(),
        beginPath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        stroke: vi.fn(),
        arc: vi.fn(),
        fill: vi.fn(),
      };
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
        ctx as unknown as CanvasRenderingContext2D,
      );
      render(<JourneyDialog open onOpenChange={() => {}} />);
      await screen.findByRole('button', { name: 'Pause' });
      await screen.findByRole('button', { name: /record and download/i });
    },
  },
];
