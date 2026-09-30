import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { formatCrypto } from './format';

/** A crypto quantity with its symbol. Higher precision than fiat. */
export const CryptoAmount = ({
  value,
  symbol,
  className,
}: {
  value: number;
  symbol: string;
  className?: string;
}) => {
  const { i18n } = useTranslation();
  return (
    <span className={cn('tabular-nums', className)}>
      {formatCrypto(value, i18n.language)} {symbol}
    </span>
  );
};
