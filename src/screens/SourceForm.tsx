import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ManifestField, SourceModule } from '@/sources/types';

type Props = {
  module: SourceModule;
  label: string;
  config: Record<string, string>;
  fieldErrors: Record<string, boolean>;
  /**
   * True when a secret field may be left blank to keep the value already
   * stored for this source - the Edit dialog's case, where a secret was
   * written once and re-entering it on every edit would be both pointless
   * and a reason to paste it somewhere it need not go. AddSourceDialog has
   * nothing stored yet, so it always passes false.
   */
  secretsOptional: boolean;
  onLabelChange: (label: string) => void;
  onConfigChange: (name: string, value: string) => void;
};

const inputTypeFor = (field: ManifestField): string =>
  field.type === 'apiKey' || field.type === 'secret' ? 'password' : 'text';

/**
 * The Input component's classes, minus the height, for a textarea.
 *
 * It styles no ::selection colour of its own, for the reason spelled out
 * on the Input itself (src/components/ui/input.tsx): the on-fill text
 * colour is the inverse of the page text, and Android paints text being
 * composed in a highlight that takes that colour without its background -
 * so an address pasted in here was invisible while being typed.
 */
const textAreaClassName =
  'w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40';

/**
 * Renders a module's label input plus every manifest field, the
 * required-scope list and the docs link.
 *
 * Nothing here is hardcoded per module: every field, every required scope
 * and the docs link all come straight from `manifest`, because the whole
 * point of the module interface (src/sources/types.ts) is that a new source
 * needs no change here. This is also the one place a field TYPE is
 * rendered - AddSourceDialog and the Edit dialog both call this instead of
 * each growing their own copy of the field-rendering switch, which is how a
 * type like `addressList` would otherwise drift between them.
 */
export const SourceForm = ({
  module,
  label,
  config,
  fieldErrors,
  secretsOptional,
  onLabelChange,
  onConfigChange,
}: Props) => {
  const { t } = useTranslation();

  const plainFields = module.manifest.fields.filter((f) => !f.advanced);
  const advancedFields = module.manifest.fields.filter((f) => f.advanced);

  // Open from the start when an advanced field already holds a value. A
  // source configured through one - an address list predating the xpub
  // field, say - would otherwise open looking empty, with its own
  // configuration hidden behind a control the user has no reason to click.
  // Whitespace does not count: an optional field is stored exactly as it was
  // left, so a stray newline is "not given".
  const [showAdvanced, setShowAdvanced] = useState(() =>
    advancedFields.some((f) => (config[f.name] ?? '').trim() !== ''),
  );

  const renderField = (field: ManifestField) => {
    const fieldId = `source-field-${field.name}`;
    const isSecret = field.type === 'apiKey' || field.type === 'secret';
    const help =
      isSecret && secretsOptional
        ? t('Leave empty to keep the stored value')
        : t(field.help);

    return (
      <div key={field.name} className="flex flex-col gap-2">
        <Label htmlFor={fieldId}>{t(field.label)}</Label>
        {field.type === 'addressList' ? (
          <textarea
            id={fieldId}
            rows={4}
            value={config[field.name] ?? ''}
            aria-invalid={fieldErrors[field.name] || undefined}
            onChange={(event) => onConfigChange(field.name, event.target.value)}
            className={textAreaClassName}
          />
        ) : (
          <Input
            id={fieldId}
            type={inputTypeFor(field)}
            value={config[field.name] ?? ''}
            aria-invalid={fieldErrors[field.name] || undefined}
            onChange={(event) => onConfigChange(field.name, event.target.value)}
          />
        )}
        <p className="text-sm text-muted-foreground">{help}</p>
        {fieldErrors[field.name] && (
          <p className="text-sm text-destructive" role="alert">
            {t('This field is required')}
          </p>
        )}
      </div>
    );
  };

  return (
    <>
      <div className="flex flex-col gap-2">
        <Label htmlFor="source-label">{t('Label')}</Label>
        <Input
          id="source-label"
          value={label}
          onChange={(event) => onLabelChange(event.target.value)}
        />
      </div>
      {plainFields.map(renderField)}
      {advancedFields.length > 0 && (
        <div className="flex flex-col gap-2">
          <Button
            type="button"
            variant="ghost"
            className="self-start px-0 text-sm text-muted-foreground hover:bg-transparent hover:text-foreground"
            aria-expanded={showAdvanced}
            onClick={() => setShowAdvanced((open) => !open)}
          >
            {showAdvanced
              ? t('Hide advanced options')
              : t('Show advanced options')}
          </Button>
          {showAdvanced && advancedFields.map(renderField)}
        </div>
      )}
      {module.manifest.requiredScopes &&
        module.manifest.requiredScopes.length > 0 && (
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">{t('Permissions to enable')}</p>
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
    </>
  );
};
