import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import 'fake-indexeddb/auto';
import App from '../src/App';
import i18n from '../src/i18n';
import { resetRouteAnnounce } from '@/a11y/useRouteAnnounce';
import { DEFAULT_LEDGER_NAME, openLedger, setActiveLedger } from '@/ledger/db';
import { setOnboarded } from '@/settings/settingsStore';

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
