import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { formatFiat } from './format';

/** A fiat figure. Tabular so columns of amounts align. */
export const Money = ({
  value,
  className,
}: {
  value: number;
  className?: string;
}) => {
  const { i18n } = useTranslation();
  return (
    <span className={cn('tabular-nums', className)}>
      {formatFiat(value, i18n.language)}
    </span>
  );
};
