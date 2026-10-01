import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { formatFiat } from './format';

/**
 * A fiat figure. Tabular so columns of amounts align.
 *
 * `currency` is the lowercase code from `settings.baseCurrency`, passed
 * down explicitly by whoever priced the figure. Deliberately not defaulted
 * and not read from a context here: the component that renders a number
 * has no way to know which currency it was priced in, and guessing is what
 * produced euro-signed dollar totals.
 */
export const Money = ({
  value,
  currency,
  className,
}: {
  value: number;
  currency: string;
  className?: string;
}) => {
  const { i18n } = useTranslation();
  return (
    <span className={cn('tabular-nums', className)}>
      {formatFiat(value, i18n.language, currency)}
    </span>
  );
};
