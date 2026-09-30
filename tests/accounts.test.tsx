import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import 'fake-indexeddb/auto';
// The account list/dialog tests assert on interpolated translations (e.g.
// "Delete Trading", "1 transactions"). Without initializing the real i18n
// instance, react-i18next's default fallback returns keys uninterpolated.
import '@/i18n';
import { useState } from 'react';
import { SettingsContext, defaultSettings } from '@/SettingsContext';
import { AccountSwitcher } from '@/components/accounts/AccountSwitcher';
import { AccountList } from '@/components/accounts/AccountList';
import { ConfirmProvider } from '@/components/confirm/ConfirmProvider';
import { StorageDataProvider } from '@/components/data/StorageDataProvider';
import {
  countAccountRows,
  deleteAccountCascade,
} from '@/components/accounts/deleteAccountCascade';
import type { CoinedaAccount, CoinedaSettings } from '@/global/types';

const Harness = ({ children }: { children: React.ReactNode }) => {
  const [settings, setSettings] = useState<CoinedaSettings>(defaultSettings);
  return (
    <SettingsContext.Provider value={{ settings, setSettings }}>
      <span data-testid="active">{settings.account.name}</span>
      {children}
    </SettingsContext.Provider>
  );
};

beforeEach(async () => {
  localStorage.clear();
  const storage = (await import('@/persistence/storage')).default;
  // All three stores, not just accounts: Task 4 appends tests to this file
  // that write transactions and transfers, and rows left behind make the
  // count assertions depend on test order.
  for (const account of await storage.accounts.getAll()) {
    await storage.accounts.delete(account.id);
  }
  for (const transaction of await storage.transactions.getAll()) {
    await storage.transactions.delete(transaction.id);
  }
  for (const transfer of await storage.transfers.getAll()) {
    await storage.transfers.delete(transfer.id);
  }
  await storage.accounts.add('Coineda', 0);
  await storage.accounts.add('Trading', 120);
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

describe('account switcher', () => {
  it('lists every account and switches the active one', async () => {
    render(
      <Harness>
        <StorageDataProvider>
          <AccountSwitcher />
        </StorageDataProvider>
      </Harness>,
    );

    await userEvent.click(
      await screen.findByRole('button', { name: /switch account/i }),
    );
    await userEvent.click(
      await screen.findByRole('menuitem', { name: /Trading/ }),
    );

    await waitFor(() =>
      expect(screen.getByTestId('active')).toHaveTextContent('Trading'),
    );
    expect(localStorage.getItem('activeAccount')).toBe('Trading');
  });
});

describe('account deletion cascade', () => {
  it("deletes only its own rows, never another account's transactions", async () => {
    // The old code looped this account's TRANSFERS but called
    // storage.transactions.delete(transfer.id). The two stores have
    // independent autoIncrement keys, so transfer #1 and transaction #1 are
    // unrelated rows - it destroyed another account's transactions and left
    // its own transfers behind.
    const storage = (await import('@/persistence/storage')).default;

    const doomed = 101;
    const keep = 202;

    await storage.transactions.add({
      account: doomed,
      type: 'buy',
      toValue: 1,
    });
    const keepTransactionId1 = await storage.transactions.add({
      account: keep,
      type: 'buy',
      toValue: 2,
    });
    const keepTransactionId2 = await storage.transactions.add({
      account: keep,
      type: 'buy',
      toValue: 3,
    });
    const doomedTransferId1 = await storage.transfers.add({
      account: doomed,
      fromValue: 1,
    });
    const doomedTransferId2 = await storage.transfers.add({
      account: doomed,
      fromValue: 2,
    });

    // This test only catches the old bug (storage.transactions.delete(transfer.id))
    // because a doomed TRANSFER id collides with a live keep TRANSACTION id -
    // the two stores have independent autoIncrement counters, so that only
    // holds while nothing earlier in this file writes to either store. Assert
    // the collision explicitly so drift in fixture/test order fails loudly
    // here instead of silently defanging the cross-account assertion below.
    const doomedTransferIds = [doomedTransferId1, doomedTransferId2];
    const keepTransactionIds = [keepTransactionId1, keepTransactionId2];
    expect(
      doomedTransferIds.some((id) => keepTransactionIds.includes(id)),
    ).toBe(true);

    await deleteAccountCascade(doomed);

    // Checked first: under the old bug this is what should go red, and it
    // must be what a regression reports rather than being masked by the
    // (lesser) orphaned-transfers assertion below it.
    expect(await storage.transactions.getAllFromAccount(keep)).toHaveLength(2);
    expect(await storage.transactions.getAllFromAccount(doomed)).toHaveLength(
      0,
    );
    expect(await storage.transfers.getAllFromAccount(doomed)).toHaveLength(0);
  });

  it('reports the counts it is about to delete', async () => {
    const storage = (await import('@/persistence/storage')).default;
    const id = 303;
    await storage.transactions.add({ account: id, type: 'buy', toValue: 1 });
    await storage.transactions.add({ account: id, type: 'sell', fromValue: 1 });
    await storage.transfers.add({ account: id, fromValue: 5 });

    expect(await countAccountRows(id)).toEqual({
      transactions: 2,
      transfers: 1,
    });
  });
});

const renderList = () =>
  render(
    <Harness>
      <StorageDataProvider>
        <ConfirmProvider>
          <AccountList />
        </ConfirmProvider>
      </StorageDataProvider>
    </Harness>,
  );

// One provider around BOTH the switcher and the list. Rendering the
// switcher in isolation is why the drift these two tests pin went
// unnoticed: every mutation lived in the list, every read of it in the
// switcher, and nothing ever mounted them together.
const renderSwitcherAndList = () =>
  render(
    <Harness>
      <StorageDataProvider>
        <ConfirmProvider>
          <AccountSwitcher />
          <AccountList />
        </ConfirmProvider>
      </StorageDataProvider>
    </Harness>,
  );

const openSwitcher = async () =>
  userEvent.click(
    await screen.findByRole('button', { name: /switch account/i }),
  );

describe('account list', () => {
  it('refuses to delete the last remaining account, whatever its id', async () => {
    const storage = (await import('@/persistence/storage')).default;
    for (const account of await storage.accounts.getAll()) {
      await storage.accounts.delete(account.id);
    }
    // Deliberately not id 1: the old rule special-cased id 1 while its
    // message claimed to protect the last account.
    await storage.accounts.add('Only', 10);

    renderList();
    await userEvent.click(
      await screen.findByRole('button', { name: /Delete Only/i }),
    );

    // No confirmation is raised at all - it is refused before that.
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(await storage.accounts.getAll()).toHaveLength(1);
  });

  it('states the row counts in the confirmation', async () => {
    const storage = (await import('@/persistence/storage')).default;
    const accounts = await storage.accounts.getAll();
    const target = accounts.find((a: CoinedaAccount) => a.name === 'Trading')!;
    await storage.transactions.add({
      account: target.id,
      type: 'buy',
      toValue: 1,
    });
    await storage.transfers.add({ account: target.id, fromValue: 1 });

    renderList();
    await userEvent.click(
      await screen.findByRole('button', { name: /Delete Trading/i }),
    );

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/1 transactions/);
    expect(dialog).toHaveTextContent(/1 transfers/);
  });

  it('keeps the created timestamp when an account is renamed', async () => {
    // accounts.put replaces the whole record, and accounts.add writes a
    // `created` field that CoinedaAccount does not declare - so rebuilding
    // the object from {id, name, pattern} dropped it silently.
    const storage = (await import('@/persistence/storage')).default;
    const before = (await storage.accounts.getAll()).find(
      (a: CoinedaAccount) => a.name === 'Trading',
    )! as { id: number; created?: string };
    expect(before.created).toBeDefined();

    renderList();
    await userEvent.click(
      await screen.findByRole('button', { name: /Edit Trading/i }),
    );
    const field = await screen.findByLabelText(/Account Name/i);
    await userEvent.clear(field);
    await userEvent.type(field, 'Trading Renamed');
    await userEvent.click(
      await screen.findByRole('button', { name: /^Save$/ }),
    );

    await waitFor(async () => {
      const after = (await storage.accounts.get(before.id)) as {
        name: string;
        created?: string;
      };
      expect(after.name).toBe('Trading Renamed');
      expect(after.created).toBe(before.created);
    });
  });

  it('reports an empty name on the field, not as a toast', async () => {
    renderList();
    await userEvent.click(
      await screen.findByRole('button', { name: /Add Account/i }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /^Save$/ }),
    );

    const field = await screen.findByLabelText(/Account Name/i);
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(await screen.findByText(/cannot be empty/i)).toBeInTheDocument();
  });
});

describe('one shared account list', () => {
  it('shows an account added in the list in the switcher, with no reload', async () => {
    // AppShell sits outside <Routes>, so the sidebar's switcher mounts once
    // per app launch and navigation never remounts it. While it fetched its
    // own copy, an account added in Settings never appeared here at all -
    // the user could not switch to the account they had just made.
    renderSwitcherAndList();

    await userEvent.click(
      await screen.findByRole('button', { name: /Add Account/i }),
    );
    await userEvent.type(
      await screen.findByLabelText(/Account Name/i),
      'Savings',
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /^Save$/ }),
    );

    await waitFor(() =>
      expect(screen.queryByLabelText(/Account Name/i)).not.toBeInTheDocument(),
    );

    await openSwitcher();
    expect(
      await screen.findByRole('menuitem', { name: /Savings/ }),
    ).toBeInTheDocument();
  });

  it('stops offering a deleted account in the switcher', async () => {
    // The worst of the three drift cases: selecting a deleted account set
    // settings.account to a row that no longer exists, and every
    // transaction added afterwards was written with that dangling account
    // id - invisible after the next reload and removed by no cascade.
    renderSwitcherAndList();

    await userEvent.click(
      await screen.findByRole('button', { name: /Delete Trading/i }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /^Delete$/ }),
    );

    await waitFor(() =>
      expect(screen.queryByText('Trading')).not.toBeInTheDocument(),
    );

    await openSwitcher();
    expect(
      screen.queryByRole('menuitem', { name: /Trading/ }),
    ).not.toBeInTheDocument();
    expect(
      await screen.findByRole('menuitem', { name: /Coineda/ }),
    ).toBeInTheDocument();
  });

  it('carries a rename of the ACTIVE account into the active selection', async () => {
    // The old AccountManagement called updateAccount() here; the rebuilt
    // dialog wrote the record and nothing else, so the sidebar kept the old
    // name and localStorage['activeAccount'] kept a name App.tsx's bootstrap
    // can no longer resolve - which makes it fall back to accounts[0] and
    // open a different portfolio than the one in use.
    renderSwitcherAndList();

    // Make 'Trading' active through the switcher first: the Harness starts
    // from defaultSettings, whose placeholder account id matches no stored
    // row, so the "is this the active account?" check would never fire.
    await openSwitcher();
    await userEvent.click(
      await screen.findByRole('menuitem', { name: /Trading/ }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('active')).toHaveTextContent('Trading'),
    );

    await userEvent.click(
      await screen.findByRole('button', { name: /Edit Trading/i }),
    );
    const field = await screen.findByLabelText(/Account Name/i);
    await userEvent.clear(field);
    await userEvent.type(field, 'Trading Renamed');
    await userEvent.click(
      await screen.findByRole('button', { name: /^Save$/ }),
    );

    await waitFor(() =>
      expect(screen.getByTestId('active')).toHaveTextContent('Trading Renamed'),
    );
    expect(localStorage.getItem('activeAccount')).toBe('Trading Renamed');
  });

  it('leaves the active selection alone when a DIFFERENT account is renamed', async () => {
    renderSwitcherAndList();

    await openSwitcher();
    await userEvent.click(
      await screen.findByRole('menuitem', { name: /Trading/ }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('active')).toHaveTextContent('Trading'),
    );

    await userEvent.click(
      await screen.findByRole('button', { name: /Edit Coineda/i }),
    );
    const field = await screen.findByLabelText(/Account Name/i);
    await userEvent.clear(field);
    await userEvent.type(field, 'Coineda Renamed');
    await userEvent.click(
      await screen.findByRole('button', { name: /^Save$/ }),
    );

    await waitFor(() =>
      expect(screen.queryByLabelText(/Account Name/i)).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId('active')).toHaveTextContent('Trading');
    expect(localStorage.getItem('activeAccount')).toBe('Trading');
  });
});
