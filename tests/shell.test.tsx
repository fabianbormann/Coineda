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

describe('the header mark', () => {
  it('shows one mark per theme, and only one at a time', () => {
    // The mark carries the brand spectrum across its slices, so it cannot be
    // recoloured through currentColor the way the chain icons are: only its
    // top slice flips between light and dark. Two files, and CSS picks one -
    // choosing in JavaScript from the resolved theme would swap the src
    // after paint, which is a visible flicker on every load.
    const { container } = renderShell();
    const marks = [...container.querySelectorAll('header img')];
    expect(marks).toHaveLength(2);

    const classes = marks.map((node) => node.getAttribute('class') ?? '');
    // Exactly one is visible by default and hidden in dark; exactly one is
    // the other way round. Both showing at once would stack them.
    expect(
      classes.filter((c) => /(^|\s)dark:hidden(\s|$)/.test(c)),
    ).toHaveLength(1);
    expect(classes.filter((c) => /(^|\s)hidden(\s|$)/.test(c))).toHaveLength(1);
    expect(
      classes.filter((c) => /(^|\s)dark:block(\s|$)/.test(c)),
    ).toHaveLength(1);
    // Two different files, not the same one twice.
    expect(new Set(marks.map((node) => node.getAttribute('src'))).size).toBe(2);
  });

  it('does not announce the name twice', () => {
    // The mark says Coineda and so does the heading beside it.
    const { container } = renderShell();
    for (const mark of container.querySelectorAll('header img')) {
      expect(mark.getAttribute('alt')).toBe('');
      expect(mark.getAttribute('aria-hidden')).toBe('true');
    }
    expect(screen.getAllByText('Coineda')).toHaveLength(1);
  });
});
