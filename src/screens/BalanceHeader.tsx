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
  /** Distinct assets currently held, priced or not. */
  assetCount: number;
  /** Configured data sources, synced or not. */
  sourceCount: number;
};

/**
 * The headline figure, as Lumen's header panel: an eyebrow, the number set
 * large in the serif face, a status pill, and the facts behind the figure on
 * a rule beneath it.
 *
 * A missing price is never folded into `total` as zero - see
 * src/prices/priceStore.ts - so when `missingCount` is above zero the pill
 * says so right beside the number, instead of letting a confident-looking
 * total quietly be wrong. That is also why the pill is the one place the
 * blush spectrum colour is used as a signal rather than decoration: it marks
 * the figure as incomplete.
 */
export const BalanceHeader = ({
  total,
  currency,
  missingCount,
  lastSyncedAt,
  assetCount,
  sourceCount,
}: Props) => {
  const { t, i18n } = useTranslation();

  const lastSyncedLabel =
    lastSyncedAt === null
      ? t('Not synced yet')
      : new Intl.DateTimeFormat(i18n.language, {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(lastSyncedAt);

  const complete = missingCount === 0;

  return (
    <Card>
      <CardContent className="flex flex-col gap-8 p-8 md:p-10">
        <div className="flex flex-wrap items-start justify-between gap-4">
          {/* Anchored for tests. The per-source rows now show priced
              figures too, so "find the text that looks like a total" is
              ambiguous on this screen - and a test that resolves the
              ambiguity by luck is worse than one that names what it
              means. */}
          <div className="flex flex-col gap-3.5" data-testid="balance-total">
            <span className="text-muted-foreground text-xs tracking-widest uppercase">
              {t('Balance')}
            </span>
            <Money
              value={total}
              currency={currency}
              className="font-serif text-5xl leading-none md:text-6xl"
            />
          </div>

          <span className="glass-1 ring-stroke flex items-center gap-1.5 px-2.5 py-1 text-xs ring-1 ring-inset">
            <i
              aria-hidden="true"
              className={
                complete ? 'size-1.5 bg-seaglass' : 'size-1.5 bg-blush'
              }
            />
            {complete
              ? t('Every holding priced')
              : t('{{count}} asset has no price', { count: missingCount })}
          </span>
        </div>

        <dl className="border-border grid grid-cols-2 gap-5 border-t pt-5 md:grid-cols-4">
          <div>
            <dt className="text-muted-foreground text-xs">{t('Assets')}</dt>
            <dd className="font-bold tabular-nums">{assetCount}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">{t('Sources')}</dt>
            <dd className="font-bold tabular-nums">{sourceCount}</dd>
          </div>
          <div className="col-span-2">
            <dt className="text-muted-foreground text-xs">
              {t('Last synced')}
            </dt>
            <dd className="font-bold">{lastSyncedLabel}</dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
};
