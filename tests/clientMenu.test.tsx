import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import 'fake-indexeddb/auto';
import App from '../src/App';
import { DEFAULT_LEDGER_NAME, openLedger, setActiveLedger } from '@/ledger/db';
import {
  activeClient,
  createClient,
  createReviewClient,
  listClients,
} from '@/clients/registry';
import i18n from '@/i18n';
import { setOnboarded } from '@/settings/settingsStore';

beforeEach(async () => {
  localStorage.clear();
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches: false,
      media: '',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
  Object.defineProperty(window, 'innerWidth', {
    writable: true,
    configurable: true,
    value: 1024,
  });
  await setActiveLedger(DEFAULT_LEDGER_NAME);
  const db = await openLedger();
  for (const store of ['events', 'sources', 'cursors', 'settings'] as const) {
    await db.clear(store);
  }
  await setOnboarded();
});

const openMenu = async () =>
  userEvent.click(await screen.findByRole('button', { name: /clients/i }));

describe('ClientMenu', () => {
  it('lists the clients and marks the active one', async () => {
    createClient('Client B');
    render(<App />);
    await openMenu();
    const items = await screen.findAllByRole('menuitem');
    const active = items.find((i) => i.getAttribute('aria-current') === 'true');
    expect(active).toHaveTextContent('My portfolio');
    expect(
      screen.getByRole('menuitem', { name: /client b/i }),
    ).not.toHaveAttribute('aria-current');
  });

  it('creates a client from the dialog and switches to it', async () => {
    render(<App />);
    await openMenu();
    await userEvent.click(
      await screen.findByRole('menuitem', { name: /new client/i }),
    );
    await userEvent.type(await screen.findByLabelText('Label'), 'Müller GmbH');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByText(/welcome to coineda/i)).toBeInTheDocument();
    expect(activeClient().label).toBe('Müller GmbH');
    expect(listClients()).toHaveLength(2);
  });

  it('renames the active client and the header follows', async () => {
    render(<App />);
    await openMenu();
    await userEvent.click(
      await screen.findByRole('menuitem', { name: /rename/i }),
    );
    const input = await screen.findByLabelText('Label');
    await userEvent.clear(input);
    await userEvent.type(input, 'Family');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByRole('button', { name: /clients/i }),
    ).toHaveTextContent('Family');
  });

  it('only deletes after the label is typed, and falls back to another client', async () => {
    createClient('Client B');
    render(<App />);
    await openMenu();
    await userEvent.click(
      await screen.findByRole('menuitem', { name: /delete client/i }),
    );
    const confirm = await screen.findByRole('button', { name: 'Delete' });
    expect(confirm).toBeDisabled();
    // The seeded label is shown translated but must be typed as stored.
    await userEvent.type(
      screen.getByLabelText('Type the label to confirm'),
      'My portfolio',
    );
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);

    // B is a fresh ledger, so the gate lands on onboarding.
    expect(await screen.findByText(/welcome to coineda/i)).toBeInTheDocument();
    expect(activeClient().label).toBe('Client B');
    expect(listClients().map((c) => c.label)).toEqual(['Client B']);
  });

  it('disables delete for the last client and says why', async () => {
    render(<App />);
    await openMenu();
    expect(
      await screen.findByRole('menuitem', { name: /delete client/i }),
    ).toHaveAttribute('aria-disabled', 'true');
    expect(
      screen.getByText('The last client cannot be deleted'),
    ).toBeInTheDocument();
  });

  it('badges review entries read-only and renders the checkpoint item disabled', async () => {
    createReviewClient('Checkpoint 2025', {
      omittedEventCount: 0,
      file: 'x.json',
      verdict: 'none',
    });
    render(<App />);
    await openMenu();
    const review = await screen.findByRole('menuitem', {
      name: /checkpoint 2025/i,
    });
    expect(review).toHaveTextContent('read-only');
    expect(
      screen.getByRole('menuitem', { name: /open a checkpoint for review/i }),
    ).toHaveAttribute('aria-disabled', 'true');
  });

  it('confirms deletion against the displayed label in German', async () => {
    createClient('Client B');
    await i18n.changeLanguage('de');
    try {
      render(<App />);
      await userEvent.click(
        await screen.findByRole('button', { name: /mandanten/i }),
      );
      await userEvent.click(
        await screen.findByRole('menuitem', { name: /mandant löschen/i }),
      );
      await userEvent.type(
        await screen.findByLabelText('Gib zur Bestätigung die Bezeichnung ein'),
        'Mein Portfolio',
      );
      await userEvent.click(screen.getByRole('button', { name: 'Löschen' }));
      await screen.findByText(/willkommen/i);
      expect(listClients().map((c) => c.label)).toEqual(['Client B']);
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});
