import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AppShell } from '@/components/layout/AppShell';
import { ThemeProvider } from '@/components/theme/ThemeProvider';

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
  it('renders its children as the page content', () => {
    renderShell();
    expect(screen.getByTestId('page')).toBeInTheDocument();
  });

  it('renders no sidebar', () => {
    // Reported from testing: "why is the sidebar there but empty?" It was a
    // placeholder for nav that went with the deleted routing layer, so it
    // rendered a blank panel and a toggle that revealed nothing. Visible
    // chrome that does nothing reads as a broken app, and a shadcn sidebar
    // is cheap to add back once there are routes to put in it.
    renderShell();
    expect(document.querySelector('[data-slot="sidebar"]')).toBeNull();
  });

  it('offers no navigation toggle, since there is nothing to toggle', () => {
    renderShell();
    expect(
      screen.queryByRole('button', { name: /toggle navigation/i }),
    ).toBeNull();
  });

  it('keeps the version and licence links the sidebar used to carry', () => {
    // These were the sidebar's only real content. Removing the panel must
    // not quietly lose them.
    renderShell();
    expect(screen.getByRole('link', { name: /^v\d/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /GPLv3/i })).toBeInTheDocument();
  });
});
