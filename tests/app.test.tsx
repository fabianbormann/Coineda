import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { render, screen, waitFor } from '@testing-library/react';
import App from '../src/App';
import storage from '../src/persistence/storage';
import { ThemeProvider } from '@/components/theme/ThemeProvider';
import { ROUTES } from '@/lib/routes';
import { notify } from '@/lib/notify';

// Mirrors the provider nesting src/index.tsx renders App with (this file
// cannot import index.tsx directly - it calls ReactDOM.createRoot().render()
// at module scope, which has no place in a test). ThemeToggle, rendered
// inside App's own header, calls useTheme() and throws without this
// ancestor - the same requirement FIX 1's MuiThemeBridge has on
// CoinedaThemeProvider.
const renderApp = () =>
  render(
    <ThemeProvider>
      <App />
    </ThemeProvider>,
  );

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
  // shadcn's sidebar detects mobile via window.innerWidth.
  Object.defineProperty(window, 'innerWidth', {
    writable: true,
    configurable: true,
    value: 1024,
  });
});

describe('App', () => {
  it('mounts, bootstraps a default account for a first-time user, and renders every nav link', async () => {
    renderApp();

    for (const route of ROUTES) {
      expect(
        screen.getByRole('link', { name: new RegExp(route.titleKey, 'i') }),
      ).toBeInTheDocument();
    }

    // App.tsx's bootstrap effect is the only thing that gives a first-time
    // user (an empty accounts store) an account to work with at all - it
    // creates a default "Coineda" account and selects it into
    // SettingsContext. Assert the storage side effect directly rather than
    // only the account name that defaultSettings already renders before
    // the effect ever runs.
    await waitFor(async () => {
      const accounts = await storage.accounts.getAll();
      expect(accounts).toHaveLength(1);
      expect(accounts[0].name).toBe('Coineda');
    });
  });

  it('mounts a Toaster subscribed to notify.*, unconditionally rather than nested inside a route', async () => {
    // sonner silently drops a message when no Toaster is mounted to
    // receive it. The Toaster used to live inside AppShell, nested under
    // a route; asserting the message actually appears - not just that
    // some element exists - is what would have caught that.
    renderApp();
    notify.info('app-toaster-mount-check');
    expect(
      await screen.findByText('app-toaster-mount-check'),
    ).toBeInTheDocument();
  });
});
