import { useTranslation } from 'react-i18next';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const LANGUAGES = [
  { value: 'en', labelKey: 'English' },
  { value: 'de', labelKey: 'German' },
];

export const LanguageSetting = () => {
  const { t, i18n } = useTranslation();
  // i18n.language can be region-tagged ('de-DE'); the select's options are
  // bare codes, so match on the leading subtag.
  const current = i18n.language.split('-')[0];

  return (
    <div className="grid max-w-xs gap-2">
      <Label htmlFor="language">{t('Language')}</Label>
      <Select
        value={current}
        onValueChange={(next) => i18n.changeLanguage(next)}
      >
        <SelectTrigger id="language">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {LANGUAGES.map(({ value, labelKey }) => (
            <SelectItem key={value} value={value}>
              {t(labelKey)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
};
