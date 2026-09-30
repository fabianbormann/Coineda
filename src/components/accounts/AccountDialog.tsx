import { useContext, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import storage from '@/persistence/storage';
import { notify } from '@/lib/notify';
import { SettingsContext } from '@/SettingsContext';
import { useStorageData } from '@/components/data/StorageDataProvider';
import type { CoinedaAccount } from '@/global/types';
import { switchAccount } from './AccountSwitcher';

/** hue-rotate degrees. The old code seeded this with Math.random() * 1000,
 *  outside the slider's own 0-360 range. */
const MAX_HUE = 360;

export const AccountDialog = ({
  mode,
  account,
  open,
  onClose,
}: {
  mode: 'add' | 'edit';
  account: CoinedaAccount | null;
  open: boolean;
  onClose: () => void;
}) => {
  const { t } = useTranslation();
  const { settings, setSettings } = useContext(SettingsContext);
  // The dialog reloads the shared list itself rather than handing the
  // caller an `onSaved` callback to do it: a private refresh in one
  // consumer is exactly how the switcher came to show accounts that no
  // longer existed.
  const { reloadAccounts } = useStorageData();
  const [name, setName] = useState('');
  const [pattern, setPattern] = useState(0);
  const [nameError, setNameError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    // Pre-fills (or clears) the form from the `mode`/`account` props when the
    // dialog opens; the fields stay editable afterwards, so this is
    // intentionally a one-time sync, not derived state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNameError(null);
    if (mode === 'edit' && account) {
      setName(account.name);
      setPattern(account.pattern);
    } else {
      setName('');
      setPattern(Math.floor(Math.random() * MAX_HUE));
    }
  }, [open, mode, account]);

  const submit = async () => {
    // Inline, on the field at fault. The old code reported this as a toast
    // for add and did not check it at all for edit.
    if (name.trim() === '') {
      setNameError(t('The account name cannot be empty'));
      return;
    }

    setSaving(true);
    try {
      if (mode === 'edit' && account) {
        // Spread the existing record rather than rebuilding it. accounts.put
        // is a whole-record put, and accounts.add stores a `created`
        // timestamp that CoinedaAccount does not declare - so the old
        // `put({ id, name, pattern })` silently dropped `created` on every
        // edit. Nothing reads it yet, which is exactly why it went unnoticed.
        const updated = { ...account, name, pattern };
        await storage.accounts.put(updated);
        // SettingsContext holds a COPY of the active account, and
        // localStorage['activeAccount'] holds its NAME - which is what
        // App.tsx's bootstrap resolves on the next launch. Without this,
        // renaming the active account left the sidebar showing the old
        // name and hue, and the next launch could not resolve the stored
        // name at all and silently fell back to accounts[0], opening a
        // different portfolio than the one in use.
        if (account.id === settings.account.id) {
          switchAccount(updated, setSettings);
        }
        notify.success(t('Account updated'));
      } else {
        await storage.accounts.add(name, pattern);
        notify.success(t('Account created'));
      }
      await reloadAccounts();
      onClose();
    } catch (error) {
      // accounts.name is a unique index, so a duplicate surfaces here as a
      // ConstraintError. The old code handled this for add only, and edit
      // reported it as a generic failure.
      if ((error as Error).name === 'ConstraintError') {
        setNameError(t('The account name you have chosen is already in use'));
      } else {
        console.warn(error);
        notify.error(t('Failed to save the account'));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {mode === 'edit' ? t('Edit Account') : t('Add Account')}
          </DialogTitle>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="account-name">{t('Account Name')}</Label>
            <Input
              id="account-name"
              value={name}
              aria-invalid={nameError !== null}
              aria-describedby={nameError ? 'account-name-error' : undefined}
              onChange={(event) => {
                setName(event.target.value);
                setNameError(null);
              }}
            />
            {nameError && (
              <p id="account-name-error" className="text-sm text-destructive">
                {nameError}
              </p>
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="account-hue">{t('Color')}</Label>
            <div className="flex items-center gap-3">
              <input
                id="account-hue"
                type="range"
                min={0}
                max={MAX_HUE}
                step={1}
                value={pattern}
                onChange={(event) => setPattern(Number(event.target.value))}
                className="w-full"
              />
              <div
                className="size-8 shrink-0 rounded-md bg-primary"
                style={{ filter: `hue-rotate(${pattern}deg)` }}
                aria-hidden="true"
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button onClick={submit} disabled={saving}>
            {t('Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
