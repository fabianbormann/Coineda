import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/confirm/ConfirmProvider';
import { notify } from '@/lib/notify';
import { putSource } from '@/ledger/db';
import type { SourceRecord } from '@/ledger/types';
import { findModule } from '@/sources/registry';
import { parseAddressList } from '@/sources/addressList';
import type { SourceModule } from '@/sources/types';
import { SourceForm } from './SourceForm';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The source being edited. MainScreen only ever opens this dialog with a
   *  source already chosen, but the type stays nullable rather than asserted
   *  non-null at the call site - a dialog that outlives the row it was
   *  opened for (the row gets removed while this is open, say) should fail
   *  closed, not crash. */
  source: SourceRecord | null;
  /**
   * Called after the edit has actually been written, naming the sync the
   * save decided was necessary:
   *
   * - `'none'` - nothing but the label changed. Purely cosmetic, so no
   *   request to the provider is worth making.
   * - `'incremental'` - only a credential changed. The user likely just
   *   fixed a rejected key and wants to see it work, but WHICH wallet is
   *   being read is unchanged, so an ordinary sync (not a full one) is
   *   enough.
   * - `'full'` - some other field changed, which means what gets fetched
   *   changed. The source's derived events are discarded and redrained from
   *   scratch (see `needsRedrain`).
   *
   * The caller is the only one who knows how to run a sync and report its
   * outcome (MainScreen.handleEditOne), the same split AddSourceDialog's
   * `onCreated` already draws.
   */
  onEdited: (
    source: SourceRecord,
    outcome: { sync: 'none' | 'incremental' | 'full' },
  ) => void | Promise<void>;
};

const isCredentialField = (type: string): boolean =>
  type === 'apiKey' || type === 'secret';

/** A secret field starts life empty: rendering the stored credential back
 *  into the DOM is exactly the thing this dialog exists to never do. Every
 *  other field is pre-filled from the stored config so the user is editing
 *  what is actually there, not starting over. */
const buildInitialConfig = (
  module: SourceModule,
  storedConfig: Record<string, string>,
): Record<string, string> => {
  const config: Record<string, string> = {};
  for (const field of module.manifest.fields) {
    config[field.name] = isCredentialField(field.type)
      ? ''
      : (storedConfig[field.name] ?? '');
  }
  return config;
};

/**
 * Merges the form's config onto the stored one: a secret field left blank
 * keeps the value already on disk, anything else is the typed value
 * verbatim. This merged config is what gets probed AND what gets stored -
 * probing the literal (possibly blank) form value would reject a save that
 * changed nothing but the label, since a blank credential fails most
 * providers' probes.
 */
const mergeConfig = (
  module: SourceModule,
  stored: Record<string, string>,
  typed: Record<string, string>,
): Record<string, string> => {
  const merged: Record<string, string> = { ...typed };
  for (const field of module.manifest.fields) {
    if (isCredentialField(field.type) && !typed[field.name]?.trim()) {
      merged[field.name] = stored[field.name] ?? '';
    }
  }
  return merged;
};

const sameList = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

/**
 * Whether the merged config changes what this source actually fetches, as
 * opposed to which credential it uses to fetch it.
 *
 * Type-driven, not name-driven: a CREDENTIAL field (`apiKey`/`secret`) never
 * triggers this - correcting a rejected key does not change which wallet is
 * being read - and every OTHER field does, because every other field is
 * part of what gets fetched. `addressList` is compared through
 * `parseAddressList` (so reordering and incidental whitespace are judged
 * correctly - see src/sources/addressList.ts); every remaining
 * non-credential type (`address`, `text`, and anything a module adds later)
 * is compared as a trimmed string.
 *
 * This used to check a field literally named `baseUrl` instead of "every
 * non-credential field" - which is exactly why editing a Cardano source's
 * `address` field (type `address`, not `addressList`) silently skipped the
 * re-drain its own motivating scenario needed: switching a payment address
 * for a stake address. A name-based rule only ever covers the field names
 * it was written against; a type-based one covers every field a module
 * declares, including ones that don't exist yet.
 */
const needsRedrain = (
  module: SourceModule,
  stored: Record<string, string>,
  merged: Record<string, string>,
): boolean => {
  for (const field of module.manifest.fields) {
    if (isCredentialField(field.type)) {
      continue;
    }
    if (field.type === 'addressList') {
      const before = parseAddressList(stored[field.name]);
      const after = parseAddressList(merged[field.name]);
      if (!sameList(before, after)) {
        return true;
      }
      continue;
    }
    const before = (stored[field.name] ?? '').trim();
    const after = (merged[field.name] ?? '').trim();
    if (before !== after) {
      return true;
    }
  }
  return false;
};

/** Whether any credential field's effective value differs from what's
 *  stored - distinct from `needsRedrain`, which deliberately ignores
 *  credential fields entirely. A credential-only change still needs an
 *  ordinary sync (the user likely just fixed a rejected key), just not a
 *  full one. */
const hasCredentialChange = (
  module: SourceModule,
  stored: Record<string, string>,
  merged: Record<string, string>,
): boolean =>
  module.manifest.fields.some(
    (field) =>
      isCredentialField(field.type) &&
      (merged[field.name] ?? '') !== (stored[field.name] ?? ''),
  );

/**
 * Lets an already-configured source be corrected in place, rather than
 * forcing a delete-and-re-add for something as small as a mistyped base URL.
 *
 * Mirrors AddSourceDialog's save path - validate, probe, confirm-if-needed,
 * write - with three differences: it starts from the stored record, it
 * renders `SourceForm` with `secretsOptional`, and on save it merges a
 * blank secret field back onto the stored one (see `mergeConfig`) instead of
 * treating blank as "clear it".
 */
export const EditSourceDialog = ({
  open,
  onOpenChange,
  source,
  onEdited,
}: Props) => {
  const { t } = useTranslation();
  const confirm = useConfirm();

  const [label, setLabel] = useState('');
  const [config, setConfig] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, boolean>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const module = source ? findModule(source.moduleId) : undefined;

  // Same "adjust state during render when a prop changes" shape
  // AddSourceDialog uses for its own reset: done here, not in a useEffect,
  // so the previous source's values never flash before the reset lands.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open && source && module) {
      setLabel(source.label);
      setConfig(buildInitialConfig(module, source.config));
      setFieldErrors({});
      setFormError(null);
      setSaving(false);
    }
  }

  const handleSave = async () => {
    if (!source || !module) {
      return;
    }

    // Secret fields are never required here regardless of the manifest's
    // own `optional` flag - secretsOptional means a blank one is read as
    // "keep what's stored", not "missing".
    const errors: Record<string, boolean> = {};
    for (const field of module.manifest.fields) {
      const skip = field.optional || isCredentialField(field.type);
      if (!skip && !config[field.name]?.trim()) {
        errors[field.name] = true;
      }
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      return;
    }

    const merged = mergeConfig(module, source.config, config);

    setFormError(null);
    setSaving(true);
    try {
      const result = await module.probe(merged);
      if (!result.ok) {
        setFormError(
          t(result.message ?? 'Could not reach the provider', {
            ...result.messageParams,
          }),
        );
        return;
      }

      if (result.readOnly === false) {
        const proceed = await confirm({
          title: t("This API key isn't read-only"),
          description: t(
            'This credential has more than read access. For your safety, create a strictly read-only key and use that one instead.',
          ),
          confirmLabel: t('Save anyway'),
          cancelLabel: t('Cancel'),
          destructive: true,
        });
        if (!proceed) {
          return;
        }
      }

      const full = needsRedrain(module, source.config, merged);
      if (full) {
        const proceed = await confirm({
          title: t('Save and re-sync {{label}} from scratch?', {
            label: source.label,
          }),
          description: t(
            'This changes what {{label}} fetches, so saving discards its synced events and downloads its whole history again. Events you added yourself stay.',
            { label: source.label },
          ),
          confirmLabel: t('Save and resync'),
          cancelLabel: t('Cancel'),
        });
        if (!proceed) {
          return;
        }
      }

      // Three-way, not a boolean: a label-only save (neither branch below)
      // must not sync at all - renaming a source is cosmetic and makes no
      // request to the provider worth making. A credential-only change
      // still syncs, just not a full one (see `hasCredentialChange`).
      const sync: 'none' | 'incremental' | 'full' = full
        ? 'full'
        : hasCredentialChange(module, source.config, merged)
          ? 'incremental'
          : 'none';

      const updated: SourceRecord = {
        ...source,
        label: label.trim() || t(module.manifest.label),
        config: merged,
      };
      await putSource(updated);
      notify.success(t('Data source updated'));
      await onEdited(updated, { sync });
      onOpenChange(false);
    } catch {
      setFormError(t('Save failed. Check your details and try again.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {source && module && (
          <>
            <DialogHeader>
              <DialogTitle>
                {t('Edit {{label}}', { label: source.label })}
              </DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-4">
              <SourceForm
                module={module}
                label={label}
                config={config}
                fieldErrors={fieldErrors}
                secretsOptional
                onLabelChange={setLabel}
                onConfigChange={(name, value) =>
                  setConfig((prev) => ({ ...prev, [name]: value }))
                }
              />
              {formError && (
                <p className="text-sm text-destructive" role="alert">
                  {formError}
                </p>
              )}
            </div>
            <DialogFooter className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
                disabled={saving}
              >
                {t('Cancel')}
              </Button>
              <Button type="button" onClick={handleSave} disabled={saving}>
                {t('Save')}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};
