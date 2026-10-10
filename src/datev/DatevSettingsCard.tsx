import { useContext, useEffect, useState } from 'react';
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

/**
 * The advisor's DATEV numbers and accounts, per client. Shown on the setup
 * step for Germany only. Written on blur as the whole object (the store
 * replaces `datev` wholesale), never in review mode, and never before the
 * stored value has been read - an early blur must not put the empty
 * defaults over a stored configuration.
 */
export const DatevSettingsCard = () => {
  const { t } = useTranslation();
  const readOnly = useContext(ClientContext)?.readOnly ?? false;
  const [datev, setDatev] = useState<DatevSettings>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [touched, setTouched] = useState<Set<string>>(new Set());

  useEffect(() => {
    let active = true;
    void getSettings()
      .then((settings) => {
        if (active && settings?.datev) {
          setDatev(settings.datev);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (active) {
          setLoaded(true);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const issues = validateDatevSettings(datev);

  const leave = (field: string) => {
    setTouched((previous) => new Set(previous).add(field));
    if (readOnly || !loaded) {
      return;
    }
    void putSettings({ datev });
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
        disabled={readOnly}
        aria-invalid={touched.has(field) && message(field) !== null}
        aria-describedby={`datev-${field}-error`}
      />
      {message(field)}
    </div>
  );

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <h3 className="text-base font-medium">{t('DATEV')}</h3>
        <p className="text-sm text-muted-foreground">
          {t(
            'Your DATEV advisor and client numbers and the accounts to book §23 results and §22 Nr. 3 income to. Coineda ships no defaults; the export stays disabled until all are set.',
          )}
        </p>
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
            disabled={readOnly}
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
