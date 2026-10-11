import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { TaxNumberInput } from '@/components/forms/TaxNumberInput';
import {
  GERMAN_STATES,
  STATE_NAMES,
  type GermanState,
} from '@/settings/taxNumber';

type TaxpayerFieldsProps = {
  /** Germany: a Bundesland select and the masked tax number; any other
   *  jurisdiction keeps a free-text tax number. */
  germany: boolean;
  name: string;
  onNameChange: (name: string) => void;
  state: GermanState | undefined;
  onStateChange: (state: GermanState) => void;
  taxNumber: string;
  onTaxNumberChange: (taxNumber: string) => void;
  /** Persists the taxpayer; called when a text field loses focus. */
  onBlur: () => void;
  disabled: boolean;
};

/**
 * Who the printed sheet is for. Every field is optional: they are printed
 * on the report so it can be assigned to a file, and enter no figure.
 */
export const TaxpayerFields = ({
  germany,
  name,
  onNameChange,
  state,
  onStateChange,
  taxNumber,
  onTaxNumberChange,
  onBlur,
  disabled,
}: TaxpayerFieldsProps) => {
  const { t } = useTranslation();
  return (
    <>
      <div className="flex flex-col gap-2">
        <Label htmlFor="tax-report-taxpayer-name">
          {t('Your name (optional)')}
        </Label>
        <Input
          id="tax-report-taxpayer-name"
          value={name}
          autoComplete="name"
          onChange={(event) => onNameChange(event.target.value)}
          onBlur={onBlur}
          disabled={disabled}
          aria-describedby="tax-report-taxpayer-name-hint"
        />
        <p
          id="tax-report-taxpayer-name-hint"
          className="text-sm text-muted-foreground"
        >
          {t(
            'Shown on the printed report so it can be assigned to your file. Stored only on this device.',
          )}
        </p>
      </div>
      {germany ? (
        <>
          <div className="flex flex-col gap-2">
            <Label htmlFor="tax-report-state">
              {t('Federal state (optional)')}
            </Label>
            <Select
              value={state ?? ''}
              onValueChange={(value) => onStateChange(value as GermanState)}
              disabled={disabled}
            >
              <SelectTrigger id="tax-report-state" className="w-full">
                <SelectValue placeholder={t('Choose your state')} />
              </SelectTrigger>
              <SelectContent>
                {GERMAN_STATES.map((code) => (
                  <SelectItem key={code} value={code}>
                    {t(STATE_NAMES[code])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <TaxNumberInput
            id="tax-report-tax-number"
            label={t('Tax number (optional)')}
            state={state}
            value={taxNumber}
            onChange={onTaxNumberChange}
            onBlur={onBlur}
            disabled={disabled}
          />
        </>
      ) : (
        <div className="flex flex-col gap-2">
          <Label htmlFor="tax-report-tax-number">
            {t('Tax number (optional)')}
          </Label>
          <Input
            id="tax-report-tax-number"
            value={taxNumber}
            autoComplete="off"
            onChange={(event) => onTaxNumberChange(event.target.value)}
            onBlur={onBlur}
            disabled={disabled}
          />
        </div>
      )}
    </>
  );
};
