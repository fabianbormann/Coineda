import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { putSettings, setOnboarded } from '@/settings/settingsStore';
import { notify } from '@/lib/notify';
import { defaultsForLocale } from './localeDefaults';

type Props = {
  onComplete: () => void;
  onBack: () => void;
};

// The app ships only these two translation sets (src/i18n.js). Shown by
// each language's own name for itself, not translated into the currently
// selected UI language - the usual convention for a language picker, and
// the only way someone who can't read the current language can still find
// their own.
const LANGUAGES: { value: string; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'de', label: 'Deutsch' },
];

// Currencies this screen offers out of the box: every value `localeDefaults`
// can derive, plus a few more common ones. All lowercase - see the note on
// `putSettings` in src/settings/settingsStore.ts for why that matters.
const CURRENCIES = [
  'usd',
  'eur',
  'gbp',
  'chf',
  'jpy',
  'aud',
  'cad',
  'pln',
  'sek',
  'dkk',
  'nok',
  'czk',
];

export const StartFresh = ({ onComplete, onBack }: Props) => {
  const { t, i18n } = useTranslation();
  const defaults = useMemo(
    () => defaultsForLocale(navigator.language ?? 'en'),
    [],
  );
  const [language, setLanguage] = useState(defaults.language);
  const [baseCurrency, setBaseCurrency] = useState(defaults.baseCurrency);
  const [submitting, setSubmitting] = useState(false);

  // The locale-derived currency isn't guaranteed to be one of the preset
  // options (e.g. a locale this build has never mapped to a currency in
  // `CURRENCIES`) - add it so the select always has a matching item instead
  // of silently showing nothing selected.
  const currencyOptions = useMemo(
    () =>
      CURRENCIES.includes(baseCurrency)
        ? CURRENCIES
        : [baseCurrency, ...CURRENCIES],
    [baseCurrency],
  );

  const handleConfirm = async () => {
    setSubmitting(true);
    try {
      await putSettings({ language, baseCurrency });
      await setOnboarded();
      await i18n.changeLanguage(language);
      notify.success(t("You're all set"));
      onComplete();
    } catch {
      notify.error(
        t('Something went wrong while saving your settings. Try again.'),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>{t('Start fresh')}</CardTitle>
        <CardDescription>
          {t(
            'Choose your language and base currency. You can change both later in Settings.',
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="onboarding-language">{t('Language')}</Label>
          <Select value={language} onValueChange={setLanguage}>
            <SelectTrigger id="onboarding-language" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LANGUAGES.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="onboarding-currency">{t('Base currency')}</Label>
          <Select value={baseCurrency} onValueChange={setBaseCurrency}>
            <SelectTrigger id="onboarding-currency" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {currencyOptions.map((currency) => (
                <SelectItem key={currency} value={currency}>
                  {currency.toUpperCase()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        <Button type="button" onClick={handleConfirm} disabled={submitting}>
          {t('Confirm')}
        </Button>
        <Button type="button" variant="ghost" onClick={onBack}>
          {t('Back')}
        </Button>
      </CardFooter>
    </Card>
  );
};
