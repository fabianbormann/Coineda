import { useContext, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SettingsContext } from '@/SettingsContext';
import { useConfirm } from '@/components/confirm/ConfirmProvider';
import { useStorageData } from '@/components/data/StorageDataProvider';
import { notify } from '@/lib/notify';
import type { CoinedaAccount } from '@/global/types';
import { AccountDialog } from './AccountDialog';
import { switchAccount } from './AccountSwitcher';
import { countAccountRows, deleteAccountCascade } from './deleteAccountCascade';

export const AccountList = () => {
  const { t } = useTranslation();
  const { settings, setSettings } = useContext(SettingsContext);
  const confirm = useConfirm();
  // The shared store, so the sidebar's switcher and this list can never
  // disagree about which accounts exist.
  const { accounts, accountsError, reloadAccounts } = useStorageData();
  const [dialogMode, setDialogMode] = useState<'add' | 'edit'>('add');
  const [editing, setEditing] = useState<CoinedaAccount | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const remove = async (account: CoinedaAccount) => {
    // The message the old code showed said "the last account is protected",
    // but the rule it enforced was `id === 1`. This is the rule the copy
    // already promised - and it also guarantees settings.account can never
    // be left undefined.
    if (accounts.length <= 1) {
      notify.warning(t('The last account is protected and cannot be removed'));
      return;
    }

    const counts = await countAccountRows(account.id);
    const confirmed = await confirm({
      title: t('Delete {{name}}?', { name: account.name }),
      description: t(
        'This also deletes {{transactions}} transactions and {{transfers}} transfers. This cannot be undone.',
        counts,
      ),
      confirmLabel: t('Delete'),
      destructive: true,
    });
    if (!confirmed) return;

    try {
      await deleteAccountCascade(account.id);
      // Reload the shared list rather than a private one, so the sidebar's
      // switcher stops offering the account that no longer exists.
      const remaining = accounts.filter(
        (candidate) => candidate.id !== account.id,
      );
      await reloadAccounts();
      if (settings.account.id === account.id && remaining.length > 0) {
        switchAccount(remaining[0], setSettings);
      }
      notify.success(t('Account deleted'));
    } catch (error) {
      console.warn(error);
      notify.error(
        t(
          'Failed to delete the account. Please try again or contact the support',
        ),
      );
    }
  };

  return (
    <div className="grid gap-3">
      {accountsError && (
        <p className="text-sm text-destructive">
          {t('Unable to load your accounts')}
        </p>
      )}

      <ul className="grid gap-2">
        {accounts.map((account) => (
          <li
            key={account.id}
            className="flex items-center gap-3 rounded-md border border-border p-3"
          >
            <div
              className="size-7 shrink-0 rounded-md bg-primary"
              style={{ filter: `hue-rotate(${account.pattern}deg)` }}
              aria-hidden="true"
            />
            <span className="truncate font-medium">{account.name}</span>
            {settings.account.id === account.id && (
              <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                {t('Active')}
              </span>
            )}
            <div className="ml-auto flex gap-1">
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('Edit {{name}}', { name: account.name })}
                onClick={() => {
                  setDialogMode('edit');
                  setEditing(account);
                  setDialogOpen(true);
                }}
              >
                <Pencil className="size-4" aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('Delete {{name}}', { name: account.name })}
                onClick={() => void remove(account)}
              >
                <Trash2 className="size-4" aria-hidden="true" />
              </Button>
            </div>
          </li>
        ))}
      </ul>

      <Button
        variant="outline"
        className="justify-self-start"
        onClick={() => {
          setDialogMode('add');
          setEditing(null);
          setDialogOpen(true);
        }}
      >
        <Plus className="size-4" aria-hidden="true" />
        {t('Add Account')}
      </Button>

      <AccountDialog
        mode={dialogMode}
        account={editing}
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
      />
    </div>
  );
};
