import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toaster } from '@/components/ui/sonner';
import { ThemeProvider } from '@/components/theme/ThemeProvider';
import { notify } from '@/lib/notify';

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

const Harness = () => (
  <ThemeProvider>
    <Toaster />
    <button type="button" onClick={() => notify.error('First problem')}>
      one
    </button>
    <button type="button" onClick={() => notify.error('Second problem')}>
      two
    </button>
    <button type="button" onClick={() => notify.success('It worked')}>
      success
    </button>
    <button type="button" onClick={() => notify.warning('Careful')}>
      warning
    </button>
    <button type="button" onClick={() => notify.info('FYI')}>
      info
    </button>
    <button
      type="button"
      onClick={() => notify.success('Saved', { id: 'save-toast' })}
    >
      with-options
    </button>
  </ThemeProvider>
);

describe('notifications', () => {
  it('shows two simultaneous messages instead of replacing the first', async () => {
    render(<Harness />);

    await userEvent.click(screen.getByRole('button', { name: 'one' }));
    await userEvent.click(screen.getByRole('button', { name: 'two' }));

    expect(await screen.findByText('First problem')).toBeInTheDocument();
    expect(await screen.findByText('Second problem')).toBeInTheDocument();
  });

  it('exposes one function per severity', () => {
    for (const level of ['success', 'error', 'warning', 'info'] as const) {
      expect(typeof notify[level]).toBe('function');
    }
  });

  it('renders a success toast', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'success' }));
    expect(await screen.findByText('It worked')).toBeInTheDocument();
  });

  it('renders a warning toast', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'warning' }));
    expect(await screen.findByText('Careful')).toBeInTheDocument();
  });

  it('renders an info toast', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'info' }));
    expect(await screen.findByText('FYI')).toBeInTheDocument();
  });

  it('accepts and forwards an options object, such as an id', async () => {
    // The second argument is how a loading toast becomes a success/error
    // one (tax runs) and how a delete gets an Undo action (Tracking) -
    // without it callers would bypass this module and import sonner
    // directly.
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'with-options' }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });
});

describe('a toast has to be readable over whatever it covers', () => {
  it('sits on the chrome material, not on a half-built glass one', async () => {
    // `--popover` is `--lm-glass-3`: 14% white in dark mode. That token is
    // one half of a material - the `glass-3` utility pairs it with a 40px
    // backdrop blur - and sonner is handed only a background colour. A
    // toast given the translucency without the blur let the rows and
    // buttons beneath read straight through it, reported from a real sync.
    render(<Harness />);
    // The toaster list is not in the DOM until something is toasted.
    await userEvent.click(screen.getByRole('button', { name: 'one' }));

    const toaster = document.querySelector('[data-sonner-toaster]');
    expect(toaster).not.toBeNull();
    const style = toaster?.getAttribute('style') ?? '';

    expect(style).toContain('--normal-bg: var(--lm-chrome-bg)');
    expect(style).not.toContain('--normal-bg: var(--popover)');
  });

  it('carries the blur that makes the material opaque enough', async () => {
    // The background half rides in `--normal-bg` because sonner paints that
    // itself; the blur has to come from a class, and without it the 88%
    // base alone still leaves a readable sliver.
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'one' }));

    const toast = document.querySelector('[data-sonner-toast]');
    expect(toast?.className).toContain('backdrop-blur-[28px]');
    expect(toast?.className).toContain('backdrop-saturate-150');
  });
});
