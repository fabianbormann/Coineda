import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '@/components/ui/card';
import { Money } from '@/components/money/Money';

type Props = {
  /** The summed value of every priced holding, in the base currency. Always
   *  a plain number here - Money's own interface, not a ledger amount. */
  total: number;
  /** The currency `total` is denominated in: the lowercase code from
   *  `settings.baseCurrency`. Passed through to Money, which will not
   *  guess one. */
  currency: string;
  /** How many held assets `totalValue` could not price. Zero means every
   *  holding is accounted for. */
  missingCount: number;
  /** Epoch millis of the most recent successful sync across every
   *  configured source, or null if none has ever completed. */
  lastSyncedAt: number | null;
};

/**
 * The headline figure. A missing price is never folded into `total` as
 * zero - see src/prices/priceStore.ts - so when `missingCount` is above
 * zero this says so right next to the number, instead of letting a
 * confident-looking total quietly be wrong.
 */
export const BalanceHeader = ({
  total,
  currency,
  missingCount,
  lastSyncedAt,
}: Props) => {
  const { t, i18n } = useTranslation();

  const lastSyncedLabel =
    lastSyncedAt === null
      ? t('Not synced yet')
      : t('Last synced {{time}}', {
          time: new Intl.DateTimeFormat(i18n.language, {
            dateStyle: 'medium',
            timeStyle: 'short',
          }).format(new Date(lastSyncedAt)),
        });

  return (
    <Card>
      <CardContent className="flex flex-col gap-1">
        <span className="text-sm text-muted-foreground">{t('Balance')}</span>
        <Money
          value={total}
          currency={currency}
          className="text-3xl font-semibold"
        />
        <span className="text-sm text-muted-foreground">{lastSyncedLabel}</span>
        {missingCount > 0 && (
          <span className="text-sm text-destructive">
            {t('{{count}} asset has no price', { count: missingCount })}
          </span>
        )}
      </CardContent>
    </Card>
  );
};
