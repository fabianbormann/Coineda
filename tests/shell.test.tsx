import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppShell } from '@/components/layout/AppShell';
import { ThemeProvider } from '@/components/theme/ThemeProvider';

const SIDEBAR_OPEN_STORAGE_KEY = 'coineda.sidebarOpen';

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
  // matchMedia mock above), so tests default to jsdom's desktop width.
  Object.defineProperty(window, 'innerWidth', {
    writable: true,
    configurable: true,
    value: 1024,
  });
});

const renderShell = () =>
  render(
    <ThemeProvider>
      <AppShell>
        <div data-testid="page" />
      </AppShell>
    </ThemeProvider>,
  );

describe('app shell', () => {
  it('renders the sidebar, expanded by default', () => {
    renderShell();
    const sidebar = document.querySelector('[data-slot="sidebar"]');
    expect(sidebar).toBeInTheDocument();
    expect(sidebar).toHaveAttribute('data-state', 'expanded');
  });

  it('renders its children as the page content', () => {
    renderShell();
    expect(screen.getByTestId('page')).toBeInTheDocument();
  });

  it('collapses the sidebar via the header trigger and persists the choice', async () => {
    renderShell();
    const trigger = screen.getByRole('button', {
      name: /toggle navigation/i,
    });

    await userEvent.click(trigger);

    const sidebar = document.querySelector('[data-slot="sidebar"]');
    expect(sidebar).toHaveAttribute('data-state', 'collapsed');
    expect(localStorage.getItem(SIDEBAR_OPEN_STORAGE_KEY)).toBe('false');

    await userEvent.click(trigger);
    expect(sidebar).toHaveAttribute('data-state', 'expanded');
    expect(localStorage.getItem(SIDEBAR_OPEN_STORAGE_KEY)).toBe('true');
  });

  it('restores a previously collapsed sidebar from localStorage on mount', () => {
    localStorage.setItem(SIDEBAR_OPEN_STORAGE_KEY, 'false');
    renderShell();
    const sidebar = document.querySelector('[data-slot="sidebar"]');
    expect(sidebar).toHaveAttribute('data-state', 'collapsed');
  });
});
