import { useContext, useEffect, useState, type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ClientContext } from '@/clients/ClientContext';
import {
  getSettings,
  putSettings,
  type DatevSettings,
} from '@/settings/settingsStore';
import { validateDatevSettings } from '@/datev/buchungsstapel';

type KontoName = keyof DatevSettings['konten'];

const EMPTY: DatevSettings = {
  beraternummer: '',
  mandantennummer: '',
  sachkontenlaenge: 4,
  konten: { verrechnung: '', gewinn23: '', verlust23: '', einkuenfte22: '' },
};

const LENGTHS = [4, 5, 6, 7, 8];

const KONTEN: { name: KontoName; label: string }[] = [
  { name: 'verrechnung', label: 'Clearing account' },
  { name: 'gewinn23', label: 'Account for §23 gains' },
  { name: 'verlust23', label: 'Account for §23 losses' },
  { name: 'einkuenfte22', label: 'Account for §22 Nr. 3 income' },
];

type DatevSettingsCardProps = {
  /** The screen's live values, if it has any: they win over the stored
   *  ones, so a review's session values survive leaving the setup step. */
  value?: DatevSettings;
  /** Called on every change, so the screen validates what is on screen
   *  rather than what has reached the database. */
  onChange?: (datev: DatevSettings) => void;
  /** The card's heading, focusable, so the report's "Set up DATEV" can
   *  move focus here. */
  headingRef?: Ref<HTMLHeadingElement>;
};

/**
 * The advisor's DATEV numbers and accounts, per client. Shown on the setup
 * step for Germany only, inside the collapsed "Advanced settings". Written on blur as the whole object (the store
 * replaces `datev` wholesale), and never before the stored value has been
 * read - an early blur must not put the empty defaults over a stored
 * configuration. In review mode the card is editable but writes nothing: the
 * values live for the session only, through `onChange`.
 */
export const DatevSettingsCard = ({
  value,
  onChange,
  headingRef,
}: DatevSettingsCardProps) => {
  const { t } = useTranslation();
  const readOnly = useContext(ClientContext)?.readOnly ?? false;
  const [datev, setDatevState] = useState<DatevSettings>(value ?? EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [touched, setTouched] = useState<Set<string>>(new Set());

  useEffect(() => {
    let active = true;
    void getSettings()
      .then((settings) => {
        if (!active) {
          return;
        }
        if (!value && settings?.datev) {
          setDatevState(settings.datev);
        }
        setLoaded(true);
      })
      .catch((error: unknown) => {
        // Stay disabled: a card showing empty defaults over a stored
        // configuration would overwrite it on the next blur.
        console.error('Could not read the DATEV settings', error);
      });
    return () => {
      active = false;
    };
    // Read once on mount; `value` only seeds the first render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setDatev = (next: DatevSettings) => {
    setDatevState(next);
    onChange?.(next);
  };

  const disabled = !loaded;
  const issues = validateDatevSettings(datev);

  const leave = (field: string) => {
    setTouched((previous) => new Set(previous).add(field));
    if (disabled || readOnly) {
      return;
    }
    putSettings({ datev }).catch((error: unknown) => {
      console.error('Could not save the DATEV settings', error);
    });
  };

  const message = (field: string) => {
    const issue = issues.find((candidate) => candidate.field === field);
    if (!issue || !touched.has(field)) {
      return null;
    }
    return (
      <p
        id={`datev-${field}-error`}
        className="text-sm text-destructive"
        role="alert"
      >
        {t(issue.key, issue.params)}
      </p>
    );
  };

  const textField = (
    field: string,
    label: string,
    value: string,
    onChange: (value: string) => void,
  ) => (
    <div className="flex flex-col gap-2">
      <Label htmlFor={`datev-${field}`}>{t(label)}</Label>
      <Input
        id={`datev-${field}`}
        inputMode="numeric"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={() => leave(field)}
        disabled={disabled}
        aria-invalid={touched.has(field) && message(field) !== null}
        aria-describedby={message(field) ? `datev-${field}-error` : undefined}
      />
      {message(field)}
    </div>
  );

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        {/* h4: the card sits under the tax report's "Advanced settings"
            heading (h3). */}
        <h4
          ref={headingRef}
          tabIndex={-1}
          className="text-base font-medium outline-none"
        >
          {t('DATEV')}
        </h4>
        <p className="text-sm text-muted-foreground">
          {t(
            'Your DATEV advisor and client numbers and the accounts to book §23 results and §22 Nr. 3 income to. Coineda ships no defaults; the export stays disabled until all are set.',
          )}
        </p>
        {readOnly && (
          <p className="text-sm text-muted-foreground">
            {t(
              'In a review these values are kept for this session only and not saved.',
            )}
          </p>
        )}
        {textField(
          'beraternummer',
          'Advisor number',
          datev.beraternummer,
          (value) => setDatev({ ...datev, beraternummer: value }),
        )}
        {textField(
          'mandantennummer',
          'Client number',
          datev.mandantennummer,
          (value) => setDatev({ ...datev, mandantennummer: value }),
        )}
        <div className="flex flex-col gap-2">
          <Label htmlFor="datev-sachkontenlaenge">
            {t('Account number length')}
          </Label>
          <select
            id="datev-sachkontenlaenge"
            className="h-9 w-full rounded-md border border-input glass-1 px-3 py-1 text-base text-foreground shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm"
            value={String(datev.sachkontenlaenge)}
            onChange={(event) =>
              setDatev({
                ...datev,
                sachkontenlaenge: Number(event.target.value),
              })
            }
            onBlur={() => leave('sachkontenlaenge')}
            disabled={disabled}
            aria-invalid={message('sachkontenlaenge') !== null}
            aria-describedby={
              message('sachkontenlaenge')
                ? 'datev-sachkontenlaenge-error'
                : undefined
            }
          >
            {LENGTHS.map((length) => (
              <option key={length} value={String(length)}>
                {length}
              </option>
            ))}
          </select>
          {message('sachkontenlaenge')}
        </div>
        {KONTEN.map(({ name, label }) =>
          textField(`konten.${name}`, label, datev.konten[name], (value) =>
            setDatev({ ...datev, konten: { ...datev.konten, [name]: value } }),
          ),
        )}
      </CardContent>
    </Card>
  );
};
