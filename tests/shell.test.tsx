import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// AppSidebar now renders AccountSwitcher, which reads storage.accounts -
// jsdom has no IndexedDB, so this shell test needs the same fake as
// tests/accounts.test.tsx.
import 'fake-indexeddb/auto';
import { MemoryRouter } from 'react-router-dom';
import { ROUTES, matchRoute } from '@/lib/routes';
import { AppShell } from '@/components/layout/AppShell';
import { ThemeProvider } from '@/components/theme/ThemeProvider';
// AccountSwitcher reads the account list from the shared storage store
// rather than fetching its own copy, so the shell needs the provider its
// sidebar's switcher consumes.
import { StorageDataProvider } from '@/components/data/StorageDataProvider';

beforeEach(() => {
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
  // shadcn's sidebar detects mobile via window.innerWidth (not the
  // matchMedia mock above), so tests default to jsdom's desktop width and
  // the one test that exercises the mobile Sheet opts into a narrow one.
  Object.defineProperty(window, 'innerWidth', {
    writable: true,
    configurable: true,
    value: 1024,
  });
});

const renderShell = (initial = '/') =>
  render(
    <MemoryRouter initialEntries={[initial]}>
      <ThemeProvider>
        <StorageDataProvider>
          <AppShell>
            <div data-testid="page" />
          </AppShell>
        </StorageDataProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );

describe('route table', () => {
  it('has one entry per navigable page', () => {
    expect(ROUTES.map((r) => r.path)).toEqual([
      '/',
      '/tracking',
      '/reports',
      '/wallets',
      '/settings',
    ]);
  });

  it('matches nested paths by prefix, not equality', () => {
    // Routes are declared as `/tracking/*`, so a nested path must still
    // resolve to Tracking. The previous implementation compared for
    // equality and fell through to a literal "Coineda" title.
    expect(matchRoute('/tracking')?.titleKey).toBe('Tracking');
    expect(matchRoute('/tracking/anything')?.titleKey).toBe('Tracking');
    expect(matchRoute('/reports/2024')?.titleKey).toBe('Tax Reports');
  });

  it('matches the dashboard exactly and does not swallow other paths', () => {
    expect(matchRoute('/')?.titleKey).toBe('Dashboard');
    expect(matchRoute('/wallets')?.titleKey).toBe('Wallets');
  });
});

describe('app shell', () => {
  it('renders every navigation entry with the right link target', () => {
    renderShell();
    for (const route of ROUTES) {
      const link = screen.getByRole('link', {
        name: new RegExp(route.titleKey, 'i'),
      });
      // MemoryRouter (used here to avoid HashRouter's window.location.hash
      // side effects leaking between test files) renders plain hrefs.
      // HashRouter, which the production app uses, is what hash-prefixes
      // them - that is configured in App.tsx and is not covered by this test.
      expect(link).toHaveAttribute('href', route.path);
    }
  });

  it('shows the active route title in the header, including nested paths', () => {
    renderShell('/reports/2024');
    expect(
      screen.getByRole('heading', { name: /tax reports/i }),
    ).toBeInTheDocument();
  });

  it('renders its children as the page content', () => {
    renderShell();
    expect(screen.getByTestId('page')).toBeInTheDocument();
  });

  it('closes mobile navigation after choosing a destination', async () => {
    // Force the sidebar's mobile breakpoint so it renders the Sheet-based
    // navigation instead of the desktop-collapsible one.
    Object.defineProperty(window, 'innerWidth', {
      writable: true,
      configurable: true,
      value: 500,
    });
    renderShell();
    const trigger = screen.getByRole('button', { name: /toggle navigation/i });

    await userEvent.click(trigger);
    const sheet = await screen.findByRole('dialog');

    await userEvent.click(
      within(sheet).getByRole('link', { name: /wallets/i }),
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
