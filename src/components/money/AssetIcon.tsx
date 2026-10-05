import { useTokenMetaMap } from '@/assets/TokenMetaContext';
import type { TokenMeta } from '@/assets/tokenRegistry';
import { cn } from '@/lib/utils';
import { BitcoinIcon, CardanoIcon, EthereumIcon } from './icons/ChainIcons';

/**
 * The mark that stands IN FOR an asset's name, rather than sitting beside
 * it.
 *
 * Two tiers, and the absence of a third is the point:
 *
 * 1. A chain Coineda ships support for - a bundled vector, in brand colour.
 * 2. A Cardano native asset the token registry lists - its logo, which is a
 *    base64 PNG because CIP-26 specifies PNG and offers no SVG.
 *
 * Anything else has NO mark, and `assetMarkOf` says so by returning null.
 * That is what lets `CryptoAmount` show "0.5 BTC" where there is no logo
 * and "0.3866 <mark>" where there is - the text and the mark are
 * alternatives, never both. An earlier version filled the gap with a
 * coloured monogram so no row looked blank, which was the wrong fix for a
 * problem the text already solves, and put initials like "NI" where a
 * ticker belonged.
 */
type Vector = ({ className }: { className?: string }) => React.ReactElement;

// Values typed as possibly-undefined on purpose: a bare
// `Record<string, Vector>` tells TypeScript every key exists, so the
// lookup below would be narrowed to "always a function" and the guard
// deleted as dead.
const CHAIN_ICONS: Record<string, Vector | undefined> = {
  'bitcoin:native': BitcoinIcon,
  'eth:native': EthereumIcon,
  'cardano:lovelace': CardanoIcon,
};

export type AssetMark =
  { kind: 'vector'; Icon: Vector } | { kind: 'png'; base64: string };

/**
 * The mark for an asset, or null when there is none to show.
 *
 * Pure and synchronous so a caller can branch on it in the same render it
 * draws the amount in - deciding "icon or text" asynchronously would make
 * the unit flicker in after the number.
 */
export const assetMarkOf = (
  assetId: string,
  meta?: TokenMeta,
): AssetMark | null => {
  const Icon = CHAIN_ICONS[assetId];
  if (Icon) {
    return { kind: 'vector', Icon };
  }
  if (meta?.logoPng) {
    return { kind: 'png', base64: meta.logoPng };
  }
  return null;
};

/**
 * Draws an asset's mark, or nothing.
 *
 * `label` is what the mark stands for, and it is required rather than
 * optional: this mark REPLACES the written symbol, so without it a screen
 * reader is handed a bare number with no unit, and a hover gives no way to
 * find out what it was. It goes into `title` for the pointer and is
 * announced by the caller's own visually-hidden text.
 */
export const AssetIcon = ({
  assetId,
  label,
  className,
}: {
  assetId: string;
  label: string;
  className?: string;
}) => {
  const mark = assetMarkOf(assetId, useTokenMetaMap().get(assetId));
  if (mark === null) {
    return null;
  }

  const size = cn('size-4 shrink-0', className);

  if (mark.kind === 'vector') {
    const { Icon } = mark;
    return (
      <span title={label} className="inline-flex">
        <Icon className={size} />
      </span>
    );
  }

  return (
    <img
      src={`data:image/png;base64,${mark.base64}`}
      alt=""
      aria-hidden="true"
      title={label}
      className={cn(size, 'rounded-full object-contain')}
    />
  );
};
