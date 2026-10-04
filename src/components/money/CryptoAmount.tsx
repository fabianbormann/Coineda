import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { formatCrypto } from './format';
import { symbolOf, toWholeUnits } from './asset';

/**
 * A crypto quantity with its symbol. Higher precision than fiat.
 *
 * Takes the ASSET ID and the amount exactly as the ledger stores it - base
 * units - and does the conversion itself, because the alternative was
 * measurably worse: the one caller that existed passed the raw amount and
 * the raw id as the symbol, and rendered "10000000 cardano:lovelace" where
 * the user holds 10 ADA. A `symbol` prop invites that every time, so the
 * prop is gone; this component is now the single boundary where a stored
 * amount becomes a figure a person reads.
 */
export const CryptoAmount = ({
  value,
  assetId,
  className,
}: {
  value: string;
  assetId: string;
  className?: string;
}) => {
  const { i18n } = useTranslation();
  return (
    <span className={cn('tabular-nums', className)}>
      {formatCrypto(toWholeUnits(value, assetId), i18n.language)}{' '}
      {symbolOf(assetId)}
    </span>
  );
};
