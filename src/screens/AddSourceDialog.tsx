import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useConfirm } from '@/components/confirm/ConfirmProvider';
import { notify } from '@/lib/notify';
import { putSource } from '@/ledger/db';
import type { SourceRecord } from '@/ledger/types';
import { registry } from '@/sources/registry';
import type { ManifestField, SourceModule } from '@/sources/types';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a source has actually been written, so the caller can
   *  close the dialog, reload the list and balance, and start its first
   *  sync. The record is passed because the caller cannot otherwise tell
   *  WHICH source to sync - picking "the newest" would be a guess that
   *  breaks the moment two are added quickly. */
  onCreated: (source: SourceRecord) => void | Promise<void>;
};

const inputTypeFor = (field: ManifestField): string =>
  field.type === 'apiKey' || field.type === 'secret' ? 'password' : 'text';

/**
 * Module picker, then a manifest-driven form, then a probe-gated save.
 *
 * Nothing here is hardcoded per module: every field, every required scope
 * and the docs link all come straight from `manifest`, because the whole
 * point of the module interface (src/sources/types.ts) is that a new
 * source needs no change to this dialog.
 */
export const AddSourceDialog = ({ open, onOpenChange, onCreated }: Props) => {
  const { t } = useTranslation();
  const confirm = useConfirm();

  const [module, setModule] = useState<SourceModule | null>(null);
  const [label, setLabel] = useState('');
  const [config, setConfig] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, boolean>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Reset to the module-picker step every time the dialog is (re)opened,
  // rather than leaving stale field values from a previous attempt. This is
  // "adjusting state when a prop changes" (react.dev's own name for the
  // pattern), done during render by comparing against the previous `open`
  // - deliberately not a useEffect, which would run the reset one render
  // late and after a commit, letting the stale values flash first.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setModule(null);
      setLabel('');
      setConfig({});
      setFieldErrors({});
      setFormError(null);
      setSaving(false);
    }
  }

  const chooseModule = (next: SourceModule) => {
    setModule(next);
    setLabel(t(next.manifest.label));
    setConfig({});
    setFieldErrors({});
    setFormError(null);
  };

  const handleSave = async () => {
    if (!module) {
      return;
    }

    // Only non-optional fields are validated. `optional` (see ManifestField
    // in src/sources/types.ts) is how a module says a field works left
    // empty because it substitutes its own default - cardano-yaci's
    // `baseUrl` is the live case, and its help text tells the user to leave
    // it blank. Validating it anyway made that instruction unfollowable.
    const errors: Record<string, boolean> = {};
    for (const field of module.manifest.fields) {
      if (!field.optional && !config[field.name]?.trim()) {
        errors[field.name] = true;
      }
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      return;
    }

    setFormError(null);
    setSaving(true);
    try {
      const result = await module.probe(config);
      if (!result.ok) {
        // `message` is a translation key supplied by the module (see
        // ProbeResult in src/sources/types.ts) - never a raw diagnostic,
        // so it is safe to hand straight to t().
        setFormError(t(result.message ?? 'Could not reach the provider'));
        return;
      }

      // `readOnly === false` - not falsy, not missing - means the
      // credential we are about to store can act on the user's account,
      // not just read it. That is this app's biggest single risk, so it
      // gets an explicit, blocking decision rather than a quiet save.
      if (result.readOnly === false) {
        const proceed = await confirm({
          title: t("This API key isn't read-only"),
          description: t(
            'This credential has more than read access. For your safety, create a strictly read-only key and use that one instead.',
          ),
          confirmLabel: t('Add anyway'),
          cancelLabel: t('Cancel'),
          destructive: true,
        });
        if (!proceed) {
          return;
        }
      }

      const created: SourceRecord = {
        id: crypto.randomUUID(),
        moduleId: module.manifest.id,
        label: label.trim() || t(module.manifest.label),
        config,
      };
      await putSource(created);
      notify.success(t('Data source added'));
      await onCreated(created);
    } catch {
      setFormError(t('Save failed. Check your details and try again.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {!module ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('Add a data source')}</DialogTitle>
              <DialogDescription>
                {t('Choose a data source type')}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              {registry.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t(
                    'No source types are available yet. Check back after an update adds one.',
                  )}
                </p>
              ) : (
                registry.map((candidate) => (
                  <Button
                    key={candidate.manifest.id}
                    type="button"
                    variant="outline"
                    className="justify-start"
                    onClick={() => chooseModule(candidate)}
                  >
                    {t(candidate.manifest.label)}
                  </Button>
                ))
              )}
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t(module.manifest.label)}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="source-label">{t('Label')}</Label>
                <Input
                  id="source-label"
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                />
              </div>
              {module.manifest.fields.map((field) => {
                const fieldId = `source-field-${field.name}`;
                return (
                  <div key={field.name} className="flex flex-col gap-2">
                    <Label htmlFor={fieldId}>{t(field.label)}</Label>
                    <Input
                      id={fieldId}
                      type={inputTypeFor(field)}
                      value={config[field.name] ?? ''}
                      aria-invalid={fieldErrors[field.name] || undefined}
                      onChange={(event) =>
                        setConfig((prev) => ({
                          ...prev,
                          [field.name]: event.target.value,
                        }))
                      }
                    />
                    <p className="text-sm text-muted-foreground">
                      {t(field.help)}
                    </p>
                    {fieldErrors[field.name] && (
                      <p className="text-sm text-destructive" role="alert">
                        {t('This field is required')}
                      </p>
                    )}
                  </div>
                );
              })}
              {module.manifest.requiredScopes &&
                module.manifest.requiredScopes.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <p className="text-sm font-medium">
                      {t('Permissions to enable')}
                    </p>
                    <ul className="list-inside list-disc text-sm text-muted-foreground">
                      {module.manifest.requiredScopes.map((scope) => (
                        <li key={scope}>{scope}</li>
                      ))}
                    </ul>
                  </div>
                )}
              <a
                href={module.manifest.docsUrl}
                target="_blank"
                rel="noreferrer"
                className="text-sm text-primary underline-offset-4 hover:underline"
              >
                {t('View docs')}
              </a>
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
                onClick={() => setModule(null)}
                disabled={saving}
              >
                {t('Back')}
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
