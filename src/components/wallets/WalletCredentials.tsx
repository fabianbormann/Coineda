import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { readCredential } from '@/lib/credentials';
import type { Exchange, MandatoryImportField } from '@/global/types';

/**
 * The API credential fields for one wallet.
 *
 * Values are held by the parent row so Save can persist them against the
 * type the user has actually selected - the old code resolved the sync
 * source from the pre-edit type, so changing type and credentials in one
 * edit silently dropped the credentials.
 *
 * `readCredential` is called during render, deliberately, and must stay
 * there: it adopts a legacy-keyed value onto the id-keyed key as a side
 * effect, so a field that is merely rendered is already migrated by the
 * time Save or Delete touches it. Deferring that read to an effect or a
 * lazy useState initializer would let a legacy key written under a
 * superseded wallet name survive a delete.
 */
export const WalletCredentials = ({
  exchange,
  fields,
  values,
  onChange,
}: {
  exchange: Exchange;
  fields: MandatoryImportField[];
  values: Record<string, string>;
  onChange: (field: string, value: string) => void;
}) => {
  const { t } = useTranslation();

  if (fields.length === 0) return null;

  return (
    <div className="grid gap-3">
      {fields.map((field) => (
        <div key={field.name} className="grid gap-2">
          <Label htmlFor={`${exchange.id}-${field.name}`}>
            {t(field.label)}
          </Label>
          <Input
            id={`${exchange.id}-${field.name}`}
            type="password"
            autoComplete="off"
            value={
              values[field.name] ??
              readCredential(exchange.id, exchange.name, field.name)
            }
            onChange={(event) => onChange(field.name, event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {t(field.description)}
          </p>
        </div>
      ))}

      {/* Required by the spec, not optional. With no backend there is no
          honest encryption available - any key would sit beside the
          ciphertext - so disclosure is the mitigation that exists. */}
      <p className="flex gap-2 rounded-md bg-muted p-3 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        {t(
          'These keys are stored unencrypted in this browser. Use a read-only API key where your exchange offers one.',
        )}
      </p>
    </div>
  );
};
