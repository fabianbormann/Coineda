import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useStorageData } from '@/components/data/StorageDataProvider';
import { notify } from '@/lib/notify';
import { WalletRow } from './WalletRow';

export const WalletList = () => {
  const { t } = useTranslation();
  const { exchanges, loadingExchanges, exchangesError, addExchange } =
    useStorageData();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');

  const [nameError, setNameError] = useState<string | null>(null);

  const add = async () => {
    if (name.trim() === '') {
      setNameError(t('The wallet name cannot be empty'));
      return;
    }
    try {
      await addExchange(name.trim());
      setName('');
      setAdding(false);
      notify.success(t('Wallet added'));
    } catch (error) {
      // exchanges.name is a unique index, so a duplicate arrives here as a
      // ConstraintError. Naming it beats a generic save failure.
      if ((error as Error).name === 'ConstraintError') {
        setNameError(t('A wallet with that name already exists'));
        return;
      }
      console.warn(error);
      notify.error(t('Failed to save wallet information.'));
    }
  };

  return (
    <div className="mx-auto grid w-full max-w-3xl gap-4 p-4 md:p-6">
      <h2 className="text-lg font-semibold">{t('Wallets')}</h2>

      {exchangesError && (
        <p className="text-sm text-destructive">
          {t(
            'Unable to fetch exchanges from database. Please try again or contact the support',
          )}
        </p>
      )}

      {!loadingExchanges && exchanges.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {t(
            'You have no wallets yet. Add one to start tracking where your coins are held.',
          )}
        </p>
      )}

      <ul className="grid gap-2">
        {exchanges.map((exchange) => (
          <WalletRow key={exchange.id} exchange={exchange} />
        ))}
      </ul>

      {adding ? (
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <div className="grid flex-1 gap-2">
            <Label htmlFor="new-wallet-name">{t('Wallet Name')}</Label>
            <Input
              id="new-wallet-name"
              value={name}
              aria-invalid={nameError !== null}
              onChange={(event) => {
                setName(event.target.value);
                setNameError(null);
              }}
            />
            {nameError && (
              <p className="text-sm text-destructive">{nameError}</p>
            )}
          </div>
          <Button type="submit">{t('Add')}</Button>
          <Button
            variant="ghost"
            type="button"
            onClick={() => setAdding(false)}
          >
            {t('Cancel')}
          </Button>
        </form>
      ) : (
        <Button
          variant="outline"
          className="justify-self-start"
          onClick={() => setAdding(true)}
        >
          <Plus className="size-4" aria-hidden="true" />
          {t('Add wallet')}
        </Button>
      )}
    </div>
  );
};
