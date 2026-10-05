import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { useTokenMetaMap } from '@/assets/TokenMetaContext';
import { formatCrypto } from './format';
import { symbolOf, toWholeUnits } from './asset';
import { AssetIcon, assetMarkOf } from './AssetIcon';

/**
 * A crypto quantity, with its mark where one exists and its symbol where
 * one does not.
 *
 * Amount FIRST, mark after: the figure is what is being read and the unit
 * qualifies it, the way "5 kg" reads rather than "kg 5". And the two are
 * alternatives - a logo beside the letters BTC says the same thing twice.
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
   *  by asset, say. The symbol is then written out instead, so the unit is
   *  never simply missing. */
  icon?: boolean;
}) => {
  const { i18n } = useTranslation();
  const meta = useTokenMetaMap().get(assetId);

  // The registry's curated ticker wins over the name decoded out of the
  // asset id. An on-chain asset name is whatever its minter typed - often
  // a long internal label - while the registry entry is the signed, human
  // version of it. The decode is the fallback, not the preference.
  const symbol = meta?.ticker ?? symbolOf(assetId);
  const mark = icon ? assetMarkOf(assetId, meta) : null;
  const amount = formatCrypto(toWholeUnits(value, assetId), i18n.language);

  return (
    <span
      data-slot="crypto-amount"
      className={cn('inline-flex items-center gap-1 tabular-nums', className)}
    >
      {/* The figure is its own element, and labelled, because it is no
          longer the whole of the rendered text: the unit may be a mark
          rather than letters, so "the amount" is not simply this
          component's textContent any more. Tests assert on this rather
          than on a combined string, which keeps them able to tell 0.5
          from -0.5. `data-slot` is the convention the ui/ components
          here already use. */}
      <span data-slot="crypto-amount-value">{amount}</span>
      {mark === null ? (
        <span>{symbol}</span>
      ) : (
        <>
          <AssetIcon assetId={assetId} label={symbol} />
          {/* The mark carries the unit visually; this carries it to a
              screen reader, which would otherwise be handed a bare number.
              `title` on the mark itself covers the pointer. */}
          <span className="sr-only">{symbol}</span>
        </>
      )}
    </span>
  );
};
