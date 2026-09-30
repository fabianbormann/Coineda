import storage from '@/persistence/storage';
import type { Transaction } from '@/global/types';

/**
 * Counts what an account's deletion will destroy, so the confirmation can
 * say so. A generic "are you sure?" in front of an irreversible cascade is
 * what made `description` mandatory on useConfirm.
 */
export const countAccountRows = async (
  accountId: number,
): Promise<{ transactions: number; transfers: number }> => {
  const [transactions, transfers] = await Promise.all([
    storage.transactions.getAllFromAccount(accountId),
    storage.transfers.getAllFromAccount(accountId),
  ]);
  return { transactions: transactions.length, transfers: transfers.length };
};

/**
 * Deletes an account and everything belonging to it.
 *
 * The previous implementation deleted TRANSFERS by calling
 * storage.transactions.delete(transfer.id). Both stores use independent
 * autoIncrement keys, so that destroyed arbitrary transactions belonging to
 * OTHER accounts while leaving this account's transfers orphaned. Each store
 * is now deleted from with its own delete.
 *
 * Children go first, then the account row: if the cascade fails partway, the
 * account still exists and the operation can be retried, rather than leaving
 * orphaned rows behind an account that is already gone.
 */
export const deleteAccountCascade = async (
  accountId: number,
): Promise<void> => {
  const [transactions, transfers] = await Promise.all([
    storage.transactions.getAllFromAccount(accountId),
    storage.transfers.getAllFromAccount(accountId),
  ]);

  for (const transaction of transactions as Transaction[]) {
    await storage.transactions.delete(transaction.id);
  }

  for (const transfer of transfers as Transaction[]) {
    await storage.transfers.delete(transfer.id);
  }

  await storage.accounts.delete(accountId);
};
