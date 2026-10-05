import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { formatCrypto } from './format';
import { symbolOf, toWholeUnits } from './asset';
import { AssetIcon } from './AssetIcon';
import { useTokenMetaMap } from '@/assets/TokenMetaContext';

/**
 * A crypto quantity with its mark and symbol. Higher precision than fiat.
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
  icon = true,
}: {
  value: string;
  assetId: string;
  className?: string;
  /** Off where a mark would be noise - a dense column that already groups
   *  by asset, say. On by default: most places show one amount at a time. */
  icon?: boolean;
}) => {
  const { i18n } = useTranslation();
  // The registry's curated ticker wins over the name decoded out of the
  // asset id. An on-chain asset name is whatever its minter typed - often
  // a long internal label - while the registry entry is the signed, human
  // version of it. The decode is the fallback, not the preference.
  const ticker = useTokenMetaMap().get(assetId)?.ticker;
  return (
    <span
      className={cn('inline-flex items-baseline gap-1 tabular-nums', className)}
    >
      {icon && <AssetIcon assetId={assetId} className="self-center" />}
      <span>
        {formatCrypto(toWholeUnits(value, assetId), i18n.language)}{' '}
        {ticker ?? symbolOf(assetId)}
      </span>
    </span>
  );
};
