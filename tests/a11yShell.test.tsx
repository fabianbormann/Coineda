import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import 'fake-indexeddb/auto';
import App from '../src/App';
import i18n from '../src/i18n';
import { resetRouteAnnounce } from '@/a11y/useRouteAnnounce';
import { DEFAULT_LEDGER_NAME, openLedger, setActiveLedger } from '@/ledger/db';
import { setOnboarded } from '@/settings/settingsStore';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@/components/ui/sheet';

beforeEach(async () => {
  localStorage.clear();
  resetRouteAnnounce();
  (document.activeElement as HTMLElement | null)?.blur();
  window.location.hash = '#/';
  await i18n.changeLanguage('en');
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches: false,
      media: '',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
  await setActiveLedger(DEFAULT_LEDGER_NAME);
  const db = await openLedger();
  for (const store of ['events', 'sources', 'cursors', 'settings'] as const) {
    await db.clear(store);
  }
  await setOnboarded();
});

describe('document language', () => {
  it('follows the chosen language', async () => {
    await i18n.changeLanguage('de');
    expect(document.documentElement.lang).toBe('de');
    await i18n.changeLanguage('en');
    expect(document.documentElement.lang).toBe('en');
  });
});

describe('the toast region', () => {
  it('is named in the interface language', async () => {
    await i18n.changeLanguage('de');
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Übersicht' });
    const region = document.querySelector('section[aria-label]');
    expect(region?.getAttribute('aria-label')).toMatch(/^Benachrichtigungen/);
  });
});

describe('page identity and focus', () => {
  it('gives the overview one h1 and a title', async () => {
    render(<App />);
    await screen.findByText('Data sources');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(document.title).toBe('Coineda – Overview');
  });

  it('titles the page in German', async () => {
    await i18n.changeLanguage('de');
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Übersicht' });
    expect(document.title).toBe('Coineda – Übersicht');
  });

  it('makes the skip link the first tab stop and focuses main', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('Data sources');
    expect(document.activeElement).toBe(document.body);
    await user.tab();
    const skip = screen.getByRole('link', { name: 'Skip to content' });
    expect(document.activeElement).toBe(skip);
    const hash = window.location.hash;
    await user.keyboard('{Enter}');
    expect(window.location.hash).toBe(hash);
    expect(document.activeElement).toBe(document.getElementById('main'));
  });

  it('names the tax report and focuses its h1 on navigation', async () => {
    render(<App />);
    await screen.findByText('Data sources');
    window.location.hash = '#/tax';
    await waitFor(() => expect(document.title).toBe('Coineda – Tax report'));
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1).toHaveTextContent('Tax report');
    await waitFor(() => expect(document.activeElement).toBe(h1));
  });
});

describe('onboarding', () => {
  const notOnboarded = async () => {
    const db = await openLedger();
    await db.clear('settings');
  };

  it('has a main landmark, one h1 per step and a title', async () => {
    await notOnboarded();
    const user = userEvent.setup();
    render(<App />);
    const h1 = await screen.findByRole('heading', {
      level: 1,
      name: 'Welcome to Coineda',
    });
    expect(h1).toHaveAttribute('tabindex', '-1');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main');
    expect(document.title).toBe('Coineda – Welcome');

    // A step change unmounts the button that was pressed; focus lands on
    // the new step's heading instead of falling to <body>.
    await user.click(screen.getByRole('button', { name: 'Start fresh' }));
    const step = await screen.findByRole('heading', {
      level: 1,
      name: 'Start fresh',
    });
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    await waitFor(() => expect(document.activeElement).toBe(step));
  });

  it('is titled in German', async () => {
    await notOnboarded();
    await i18n.changeLanguage('de');
    render(<App />);
    await screen.findByRole('heading', { level: 1 });
    await waitFor(() => expect(document.title).toBe('Coineda – Willkommen'));
  });

  it('names the page again after a reset', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('Data sources');
    expect(document.title).toBe('Coineda – Overview');
    await user.click(
      await screen.findByRole('button', { name: /reset this device/i }),
    );
    await user.click(
      await screen.findByRole('button', { name: /reset everything/i }),
    );
    const h1 = await screen.findByRole('heading', {
      level: 1,
      name: 'Welcome to Coineda',
    });
    await waitFor(() => expect(document.title).toBe('Coineda – Welcome'));
    await waitFor(() => expect(document.activeElement).toBe(h1));
  });
});

describe('dialog close buttons', () => {
  it('are named in the interface language', async () => {
    await i18n.changeLanguage('de');
    render(
      <>
        <Dialog open>
          <DialogContent>
            <DialogTitle>Dialog</DialogTitle>
            <DialogDescription>Beschreibung</DialogDescription>
          </DialogContent>
        </Dialog>
      </>,
    );
    expect(
      await screen.findByRole('button', { name: 'Schließen' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });

  it('are named in the interface language on a sheet', async () => {
    await i18n.changeLanguage('de');
    render(
      <Sheet open>
        <SheetContent>
          <SheetTitle>Sheet</SheetTitle>
          <SheetDescription>Beschreibung</SheetDescription>
        </SheetContent>
      </Sheet>,
    );
    expect(
      await screen.findByRole('button', { name: 'Schließen' }),
    ).toBeInTheDocument();
  });
});
