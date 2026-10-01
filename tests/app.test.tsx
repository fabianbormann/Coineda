import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import 'fake-indexeddb/auto';
import App from '../src/App';
import { notify } from '@/lib/notify';
import { openLedger } from '@/ledger/db';
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
  // shadcn's sidebar detects mobile via window.innerWidth.
  Object.defineProperty(window, 'innerWidth', {
    writable: true,
    configurable: true,
    value: 1024,
  });

  // App.tsx now gates the shell on isOnboarded() (Task 10). These tests are
  // about the shell, not onboarding, so they start from an already-onboarded
  // install - onboarding itself is covered by tests/onboarding.test.tsx.
  const db = await openLedger();
  for (const store of ['events', 'sources', 'cursors', 'settings'] as const) {
    await db.clear(store);
  }
  await setOnboarded();
});

describe('App', () => {
  it('mounts the shell and renders the main screen route', async () => {
    render(<App />);
    expect(await screen.findByText('Data sources')).toBeInTheDocument();
  });

  it('offers light, dark and system theme choices', async () => {
    render(<App />);
    expect(
      await screen.findByRole('button', { name: /light/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /dark/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /system/i })).toBeInTheDocument();
  });

  it('mounts a Toaster subscribed to notify.*, unconditionally rather than nested inside a route', async () => {
    // sonner silently drops a message when no Toaster is mounted to
    // receive it. The Toaster used to live inside AppShell, nested under
    // a route; asserting the message actually appears - not just that
    // some element exists - is what would have caught that.
    render(<App />);
    await screen.findByText('Data sources');
    notify.info('app-toaster-mount-check');
    expect(
      await screen.findByText('app-toaster-mount-check'),
    ).toBeInTheDocument();
  });
});
