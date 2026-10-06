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
import { useConfirm } from '@/components/confirm/ConfirmProvider';
import { notify } from '@/lib/notify';
import { putSource } from '@/ledger/db';
import type { SourceRecord } from '@/ledger/types';
import { registry } from '@/sources/registry';
import { fileRegistry } from '@/sources/csv/registry';
import type { FileSourceModule } from '@/sources/csv/types';
import { FileDropArea } from '@/components/files/FileDropArea';
import type { SourceModule } from '@/sources/types';
import { SourceForm } from './SourceForm';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a source has actually been written, so the caller can
   *  close the dialog, reload the list and balance, and start its first
   *  sync. The record is passed because the caller cannot otherwise tell
   *  WHICH source to sync - picking "the newest" would be a guess that
   *  breaks the moment two are added quickly. */
  onCreated: (source: SourceRecord) => void | Promise<void>;
  /** Reads one exported file into the ledger. Rejects with a message the
   *  dialog shows in place, rather than resolving to a failure the caller
   *  has to inspect - the instructions for getting the right export are on
   *  this screen, and that is where a complaint about the wrong one
   *  belongs. */
  onImportFile: (file: File) => Promise<void>;
};

/**
 * Module picker, then a manifest-driven form, then a probe-gated save.
 *
 * Nothing here is hardcoded per module: every field, every required scope
 * and the docs link all come straight from `manifest`, because the whole
 * point of the module interface (src/sources/types.ts) is that a new
 * source needs no change to this dialog.
 */
export const AddSourceDialog = ({
  open,
  onOpenChange,
  onCreated,
  onImportFile,
}: Props) => {
  const { t } = useTranslation();
  const confirm = useConfirm();

  const [module, setModule] = useState<SourceModule | null>(null);
  /**
   * The file importer chosen instead, when one was.
   *
   * A separate piece of state rather than a union with `module`: the two
   * take completely different second steps - one a credential form that
   * ends in `probe`, the other a drop area that ends in a parse - and
   * collapsing them would mean a type guard at every use.
   */
  const [fileModule, setFileModule] = useState<FileSourceModule | null>(null);
  const [importing, setImporting] = useState(false);
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
      setFileModule(null);
      setImporting(false);
      setLabel('');
      setConfig({});
      setFieldErrors({});
      setFormError(null);
      setSaving(false);
    }
  }

  const chooseFileModule = (next: FileSourceModule) => {
    setFileModule(next);
    setFormError(null);
  };

  const handleFile = async (file: File) => {
    setImporting(true);
    setFormError(null);
    try {
      await onImportFile(file);
      onOpenChange(false);
    } catch (error) {
      // Kept open on failure, and the reason shown HERE rather than only as
      // a toast: the instructions for getting the right export are on this
      // screen, and "that was the trades file, not the ledger" is only
      // actionable while they are in front of the person.
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setImporting(false);
    }
  };

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
        // messageParams carries the placeholders a per-provider message
        // needs - see ProbeResult in src/sources/types.ts. Passing it is
        // what stops a keyed message rendering "{{example}}" literally.
        setFormError(
          t(result.message ?? 'Could not reach the provider', {
            ...result.messageParams,
          }),
        );
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
        {!module && !fileModule ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('Add a data source')}</DialogTitle>
              <DialogDescription>
                {t('Choose a data source type')}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-4">
              {/* Two routes in, named for what they ARE rather than for how
                  they are built. A person looking for Kraken does not know
                  or care that it arrives by file while Bitpanda arrives by
                  API; they know only that one of them will ask for a
                  download. Hiding the importers behind a separate button
                  elsewhere meant looking for Kraken in the list, not
                  finding it, and concluding it was unsupported. */}
              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium">
                  {t('Connect automatically')}
                </p>
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

              {fileRegistry.length > 0 && (
                <div className="flex flex-col gap-2">
                  <p className="text-sm font-medium">
                    {t('Import an export file')}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {t(
                      'These refuse a browser outright, so Coineda reads a file you export instead. No API key, and nothing leaves this device.',
                    )}
                  </p>
                  {fileRegistry.map((candidate) => (
                    <Button
                      key={candidate.manifest.id}
                      type="button"
                      variant="outline"
                      className="justify-start"
                      onClick={() => chooseFileModule(candidate)}
                    >
                      {t(candidate.manifest.label)}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : fileModule ? (
          <>
            <DialogHeader>
              <DialogTitle>{t(fileModule.manifest.label)}</DialogTitle>
              <DialogDescription>
                {t('Export the file, then drop it here')}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-4">
              {/* The instructions sit NEXT to the drop area rather than
                  behind a link: which export to pick is the one thing that
                  goes wrong, and for Kraken picking the wrong one produces
                  a balance that looks right and is not. */}
              <p className="text-sm text-muted-foreground">
                {t(fileModule.manifest.help)}
              </p>
              <FileDropArea onFile={handleFile} disabled={importing} />
              <a
                href={fileModule.manifest.docsUrl}
                target="_blank"
                rel="noreferrer"
                className="w-fit text-sm text-muted-foreground underline hover:text-foreground"
              >
                {t('How to export it')}
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
                onClick={() => setFileModule(null)}
                disabled={importing}
              >
                {t('Back')}
              </Button>
            </DialogFooter>
          </>
        ) : module ? (
          <>
            <DialogHeader>
              <DialogTitle>{t(module.manifest.label)}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-4">
              <SourceForm
                module={module}
                label={label}
                config={config}
                fieldErrors={fieldErrors}
                secretsOptional={false}
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
        ) : null}
      </DialogContent>
    </Dialog>
  );
};
