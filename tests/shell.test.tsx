import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
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

/** The shell links home from its masthead, so it genuinely lives inside a
 *  router now. */
const renderShell = (initial = '/tax') =>
  render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[initial]}>
        <AppShell>
          <div data-testid="page" />
        </AppShell>
      </MemoryRouter>
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

describe('the masthead', () => {
  it('links home, so the logo gets you back to the overview', () => {
    // The whole masthead is one link, the way a site's is - not a picture
    // beside a title that does nothing.
    renderShell('/tax');
    const home = screen.getByRole('link', { name: /coineda/i });
    expect(home).toHaveAttribute('href', '/');
  });

  it('puts both the mark and the wordmark inside that link', () => {
    const { container } = renderShell();
    const home = screen.getByRole('link', { name: /coineda/i });
    expect(home.querySelectorAll('img')).toHaveLength(2);
    expect(home.querySelector('h1')?.textContent).toBe('Coineda');
    // And the marks are still the only images in the header.
    expect(container.querySelectorAll('header img')).toHaveLength(2);
  });

  it('names the link once, not twice', () => {
    // The marks stay aria-hidden: the heading inside the link already
    // gives it its name, and announcing the logo as well would read
    // "Coineda Coineda".
    renderShell();
    for (const mark of screen
      .getByRole('link', { name: /coineda/i })
      .querySelectorAll('img')) {
      expect(mark.getAttribute('aria-hidden')).toBe('true');
    }
    expect(screen.getAllByText('Coineda')).toHaveLength(1);
  });
});

describe('clicking the masthead', () => {
  it('actually navigates back to the overview', async () => {
    // The href alone only proves the markup. This proves the behaviour:
    // starting on another route, clicking the logo swaps the page.
    render(
      <ThemeProvider>
        <MemoryRouter initialEntries={['/tax']}>
          <AppShell>
            <Routes>
              <Route path="/" element={<div>overview page</div>} />
              <Route path="/tax" element={<div>tax page</div>} />
            </Routes>
          </AppShell>
        </MemoryRouter>
      </ThemeProvider>,
    );

    expect(screen.getByText('tax page')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('link', { name: /coineda/i }));

    expect(await screen.findByText('overview page')).toBeInTheDocument();
    expect(screen.queryByText('tax page')).toBeNull();
  });
});
