import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ConfirmProvider,
  useConfirm,
} from '@/components/confirm/ConfirmProvider';

const Harness = () => {
  const confirm = useConfirm();
  return (
    <div>
      <button
        type="button"
        onClick={async () => {
          const ok = await confirm({
            title: 'Delete this transaction?',
            description: 'This cannot be undone.',
          });
          document.body.setAttribute('data-result', String(ok));
        }}
      >
        ask
      </button>
    </div>
  );
};

const ConcurrentHarness = () => {
  const confirm = useConfirm();
  return (
    <button
      type="button"
      onClick={() => {
        // Raise a second confirmation before the first has been answered.
        confirm({
          title: 'Delete this transaction?',
          description: 'First description.',
        }).then((ok) =>
          document.body.setAttribute('data-result-a', String(ok)),
        );
        confirm({
          title: 'Delete this account?',
          description: 'Second description.',
        }).then((ok) =>
          document.body.setAttribute('data-result-b', String(ok)),
        );
      }}
    >
      ask twice
    </button>
  );
};

const open = async () => {
  document.body.removeAttribute('data-result');
  await userEvent.click(screen.getByRole('button', { name: 'ask' }));
  return screen.findByRole('alertdialog');
};

describe('useConfirm', () => {
  it('resolves true only when the user confirms', async () => {
    render(
      <ConfirmProvider>
        <Harness />
      </ConfirmProvider>,
    );
    const dialog = await open();
    await userEvent.click(
      await screen.findByRole('button', {
        name: /^continue$|^confirm$|^delete$/i,
      }),
    );
    expect(dialog).not.toBeInTheDocument();
    expect(document.body.getAttribute('data-result')).toBe('true');
  });

  it('resolves false when the user cancels', async () => {
    render(
      <ConfirmProvider>
        <Harness />
      </ConfirmProvider>,
    );
    await open();
    await userEvent.click(
      await screen.findByRole('button', { name: /cancel/i }),
    );
    expect(document.body.getAttribute('data-result')).toBe('false');
  });

  it('resolves false when dismissed with Escape', async () => {
    // A confirmation that defaults to yes is worse than no confirmation.
    render(
      <ConfirmProvider>
        <Harness />
      </ConfirmProvider>,
    );
    await open();
    await userEvent.keyboard('{Escape}');
    expect(document.body.getAttribute('data-result')).toBe('false');
  });

  it('shows the required description, so the consequence is stated', async () => {
    render(
      <ConfirmProvider>
        <Harness />
      </ConfirmProvider>,
    );
    await open();
    expect(screen.getByText('This cannot be undone.')).toBeInTheDocument();
  });

  it('resolves false if the provider itself unmounts while open', async () => {
    // Otherwise the caller's `await confirm(...)` never settles and its
    // continuation - often the code that would have deleted something -
    // is left hanging forever.
    const { unmount } = render(
      <ConfirmProvider>
        <Harness />
      </ConfirmProvider>,
    );
    await open();

    unmount();

    await vi.waitFor(() =>
      expect(document.body.getAttribute('data-result')).toBe('false'),
    );
  });

  it('supersedes a pending confirmation with false when a second is raised before it settles', async () => {
    // Otherwise the first caller's `await confirm(...)` is stranded forever
    // once its resolver is overwritten by the second call - the same
    // hung-continuation failure the unmount effect guards against, reached
    // through concurrency instead of dismissal.
    render(
      <ConfirmProvider>
        <ConcurrentHarness />
      </ConfirmProvider>,
    );
    document.body.removeAttribute('data-result-a');
    document.body.removeAttribute('data-result-b');

    await userEvent.click(screen.getByRole('button', { name: 'ask twice' }));

    // The first confirmation never got a visible answer, so it must
    // resolve false, not hang and not resolve true.
    await vi.waitFor(() =>
      expect(document.body.getAttribute('data-result-a')).toBe('false'),
    );

    const dialog = await screen.findByRole('alertdialog');
    expect(screen.getByText('Second description.')).toBeInTheDocument();
    expect(screen.queryByText('First description.')).not.toBeInTheDocument();

    await userEvent.click(
      await screen.findByRole('button', {
        name: /^continue$|^confirm$|^delete$/i,
      }),
    );
    expect(dialog).not.toBeInTheDocument();
    expect(document.body.getAttribute('data-result-b')).toBe('true');
  });

  it('styles the confirm action as destructive when requested', async () => {
    const DestructiveHarness = () => {
      const confirm = useConfirm();
      return (
        <button
          type="button"
          onClick={() =>
            confirm({
              title: 'Delete this account?',
              description: 'This cannot be undone.',
              destructive: true,
            })
          }
        >
          ask
        </button>
      );
    };
    render(
      <ConfirmProvider>
        <DestructiveHarness />
      </ConfirmProvider>,
    );
    await open();
    const action = await screen.findByRole('button', {
      name: /^continue$|^confirm$|^delete$/i,
    });
    expect(action).toHaveAttribute('data-variant', 'destructive');
  });

  it('keeps the neutral action styling by default', async () => {
    render(
      <ConfirmProvider>
        <Harness />
      </ConfirmProvider>,
    );
    await open();
    const action = await screen.findByRole('button', {
      name: /^continue$|^confirm$|^delete$/i,
    });
    expect(action).toHaveAttribute('data-variant', 'default');
  });

  it('throws a clear error when used outside the provider', () => {
    const Orphan = () => {
      useConfirm();
      return null;
    };
    expect(() => render(<Orphan />)).toThrow(/ConfirmProvider/);
  });
});
