import { useTranslation } from 'react-i18next';
import { TriangleAlertIcon } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import type { Disclaimer } from '@/tax/disclaimer';

/**
 * Who wrote the jurisdiction's rules, when they were last checked, the
 * statutes they rest on and the jurisdiction's notice. Never dismissible -
 * no collapse, no close affordance of its own.
 *
 * On the report it is the first thing in the document, because there it is
 * the printed notice. On the form it is the last: a reader filling in the
 * form needs it before relying on a figure, not before typing a year.
 */
export const RuleSetNotice = ({
  disclaimer,
  jurisdiction,
}: {
  disclaimer: Disclaimer;
  /** The jurisdiction's translation key. */
  jurisdiction: string;
}) => {
  const { t, i18n } = useTranslation();
  return (
    <Card data-testid="rule-set-notice">
      <CardContent className="flex flex-col gap-2 text-sm">
        <p>
          {t('Written by {{contributor}}', {
            contributor: disclaimer.contributor,
          })}
          {' · '}
          {t('Rule set {{jurisdiction}} {{version}}, checked on {{date}}', {
            jurisdiction: t(jurisdiction),
            version: disclaimer.rulesVersion,
            date: new Intl.DateTimeFormat(i18n.language, {
              dateStyle: 'medium',
            }).format(Date.parse(disclaimer.rulesCheckedOn)),
          })}
        </p>
        {disclaimer.stale && (
          <p className="flex items-center gap-2 text-destructive">
            <TriangleAlertIcon className="size-4 shrink-0" aria-hidden="true" />
            {t(
              'These rules have not been checked in {{months}} months. Verify them yourself before relying on this report.',
              { months: disclaimer.monthsSinceChecked },
            )}
          </p>
        )}
        <ul className="list-inside list-disc text-muted-foreground">
          {disclaimer.references.map((reference) => (
            <li key={reference}>{reference}</li>
          ))}
        </ul>
        <p data-print="notice" className="text-muted-foreground">
          {t(disclaimer.noticeKey)}
        </p>
      </CardContent>
    </Card>
  );
};
