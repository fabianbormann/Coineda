import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useStorageData } from '@/components/data/StorageDataProvider';
import { useConfirm } from '@/components/confirm/ConfirmProvider';
import { notify } from '@/lib/notify';
import { clearCredentials, writeCredential } from '@/lib/credentials';
import BinanceApiSync from '@/import/source/BinanceApiSync';
import type { ApiSyncSource } from '@/import/ApiSyncSource';
import type { Exchange } from '@/global/types';
import { WalletCredentials } from './WalletCredentials';

const OTHER = 'Other';

export const WalletRow = ({ exchange }: { exchange: Exchange }) => {
  const { t } = useTranslation();
  const { putExchange, deleteExchange } = useStorageData();
  const confirm = useConfirm();

  const sources: ApiSyncSource[] = useMemo(() => [new BinanceApiSync()], []);
  const [name, setName] = useState(exchange.name);
  // Normalised against the known sources, not the raw stored value: the
  // shipped app wrote the sentinel in lowercase ('other'), which matches
  // no SelectItem here and would otherwise leave the trigger showing
  // nothing for every pre-existing non-Binance wallet. Save then writes
  // the canonical OTHER back, healing the row.
  const [type, setType] = useState(
    sources.some((candidate) => candidate.name === exchange.type)
      ? exchange.type
      : OTHER,
  );
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [nameError, setNameError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Resolved from the CURRENTLY SELECTED type, not the stored one.
  const source = sources.find((candidate) => candidate.name === type) ?? null;
  const fields = source?.getMandatoryFields() ?? [];

  // For the row's own label, which reflects the STORED type rather than
  // whatever is mid-edit in the (possibly collapsed) form below it.
  const storedSource =
    sources.find((candidate) => candidate.name === exchange.type) ?? null;

  const save = async () => {
    if (name.trim() === '') {
      setNameError(t('The wallet name cannot be empty'));
      return;
    }
    setSaving(true);
    try {
      // Spread rather than rebuild, for the reason AccountDialog's edit
      // branch spreads: exchanges.put is a whole-record put, so listing
      // the fields by hand drops anything the record carries that
      // `Exchange` does not happen to declare today.
      await putExchange({ ...exchange, name, type });
      for (const field of fields) {
        const value = credentials[field.name];
        if (value !== undefined) {
          writeCredential(exchange.id, field.name, value);
        }
      }
      // Switching a wallet away from a sync source has to remove that
      // source's credentials, or the API keys of a wallet the user has
      // just set to `Other` sit in localStorage indefinitely - a secret
      // they believe they removed. `remove()` already clears every known
      // field across every source; this is the same rule for the fields
      // that no longer belong to the selected type. Fields the selected
      // source still uses are excluded, so a name shared between two
      // sources is never cleared right after being written.
      const staleFields = sources
        .filter((candidate) => candidate.name !== type)
        .flatMap((candidate) =>
          candidate.getMandatoryFields().map((field) => field.name),
        )
        .filter(
          (fieldName) => !fields.some((field) => field.name === fieldName),
        );
      clearCredentials(exchange.id, exchange.name, staleFields);
      notify.success(t('Wallet successfully updated'));
    } catch (error) {
      // exchanges.name is a unique index, so a duplicate name arrives here
      // as a ConstraintError. Naming it on the field beats a toast saying
      // the save failed for reasons unknown - same as WalletList's add
      // path, which is the constraint this screen otherwise states:
      // validation inline on the field, toasts for outcomes.
      if ((error as Error).name === 'ConstraintError') {
        setNameError(t('A wallet with that name already exists'));
        return;
      }
      console.warn(error);
      notify.error(t('Failed to save wallet information.'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    const confirmed = await confirm({
      title: t('Delete {{name}}?', { name: exchange.name }),
      description: t(
        'This removes the wallet and any API credentials stored for it. Your transactions are not affected.',
      ),
      confirmLabel: t('Delete'),
      destructive: true,
    });
    if (!confirmed) return;

    try {
      // Delete the row FIRST, credentials after: if the delete throws,
      // the user is told it failed and still has the wallet, so its
      // credentials must not already be gone.
      await deleteExchange(exchange.id);
      // Every known field, not only the ones currently rendered - the old
      // code gated removal on the input ref existing in the DOM.
      const allFields = sources.flatMap((candidate) =>
        candidate.getMandatoryFields().map((field) => field.name),
      );
      clearCredentials(exchange.id, exchange.name, allFields);
      notify.success(t('Wallet deleted'));
    } catch (error) {
      console.warn(error);
      notify.error(t('Failed to delete the wallet'));
    }
  };

  return (
    <li className="rounded-md border border-border">
      <Collapsible>
        <div className="flex items-center gap-2 p-3">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex flex-1 items-center gap-2 text-left"
            >
              <ChevronDown className="size-4 shrink-0" aria-hidden="true" />
              <span className="truncate font-medium">{exchange.name}</span>
              <span className="text-sm text-muted-foreground">
                {storedSource ? t(storedSource.label) : t('Other')}
              </span>
            </button>
          </CollapsibleTrigger>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('Delete {{name}}', { name: exchange.name })}
            onClick={() => void remove()}
          >
            <Trash2 className="size-4" aria-hidden="true" />
          </Button>
        </div>

        <CollapsibleContent className="grid gap-4 border-t border-border p-3">
          <div className="grid gap-2">
            <Label htmlFor={`${exchange.id}-name`}>{t('Wallet Name')}</Label>
            <Input
              id={`${exchange.id}-name`}
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

          <div className="grid gap-2">
            <Label htmlFor={`${exchange.id}-type`}>{t('Wallet Type')}</Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger id={`${exchange.id}-type`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={OTHER}>{t('Other')}</SelectItem>
                {sources.map((candidate) => (
                  <SelectItem key={candidate.name} value={candidate.name}>
                    {t(candidate.label)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <WalletCredentials
            exchange={exchange}
            fields={fields}
            values={credentials}
            onChange={(field, value) =>
              setCredentials((previous) => ({ ...previous, [field]: value }))
            }
          />

          {source?.name === 'BinanceApiSync' && (
            <Alert>
              <AlertDescription>
                {t(
                  'The Binance API does currently not allow client side requests.',
                )}{' '}
                <a
                  className="underline"
                  href="https://github.com/fabianbormann/Coineda/issues/76"
                  target="_blank"
                  rel="noreferrer"
                >
                  {t('We are planning to provide a workaround in the future.')}
                </a>
              </AlertDescription>
            </Alert>
          )}

          <div className="flex gap-2">
            <Button onClick={() => void save()} disabled={saving}>
              {t('Save')}
            </Button>
            {/* Still disabled: BinanceApiSync is incomplete upstream of this
                phase and making it work is not a UI task. */}
            <Button variant="outline" disabled>
              {t('Start Syncing')}
            </Button>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
};
