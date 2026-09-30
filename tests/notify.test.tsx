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
