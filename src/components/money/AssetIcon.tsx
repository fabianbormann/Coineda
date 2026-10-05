import { useTokenMetaMap } from '@/assets/TokenMetaContext';
import { parseCardanoAsset } from '@/assets/cardanoAsset';
import { cn } from '@/lib/utils';
import { BitcoinIcon, CardanoIcon, EthereumIcon } from './icons/ChainIcons';
import { symbolOf } from './asset';

/**
 * The mark next to an amount.
 *
 * Four tiers, in order of how much Coineda actually knows:
 *
 * 1. A chain it ships support for - a bundled vector, in brand colour.
 * 2. A Cardano native asset the token registry lists - the registry's logo,
 *    which is a base64 PNG because CIP-26 specifies PNG and offers no SVG.
 * 3. Anything else - a monogram taken from whatever name is resolvable, and
 *    for a Cardano native asset that is its own decoded asset name, offline.
 * 4. Fiat - the currency's own letters, which need no artwork.
 *
 * The fallback is not decoration. A wallet holds a long tail of tokens
 * nobody has registered, and a row with a blank where every sibling has a
 * mark reads as a loading bug; a monogram reads as "this is what it is".
 */
const CHAIN_ICONS: Record<
  string,
  ({ className }: { className?: string }) => React.ReactElement
> = {
  'bitcoin:native': BitcoinIcon,
  'eth:native': EthereumIcon,
  'cardano:lovelace': CardanoIcon,
};

/**
 * A deterministic hue per asset, so the same token keeps the same colour
 * across renders and screens. A hash rather than a palette index because
 * the set of assets is open-ended.
 */
const hueOf = (seed: string): number => {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 360;
  }
  return hash;
};

/** One or two letters, from the most specific name available. */
const monogramOf = (label: string): string => {
  const words = label
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean);
  if (words.length === 0) {
    return '?';
  }
  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }
  return (words[0][0] + words[1][0]).toUpperCase();
};

export const AssetIcon = ({
  assetId,
  className,
}: {
  assetId: string;
  className?: string;
}) => {
  const meta = useTokenMetaMap().get(assetId);
  const size = cn('size-4 shrink-0', className);

  const Chain = CHAIN_ICONS[assetId];
  if (Chain) {
    return <Chain className={size} />;
  }

  if (meta?.logoPng) {
    // The registry serves PNG, so this is an <img> with a data URI rather
    // than an inline vector. Decorative: the amount beside it already names
    // the asset, so an empty alt keeps a screen reader from reading the
    // ticker twice.
    return (
      <img
        src={`data:image/png;base64,${meta.logoPng}`}
        alt=""
        aria-hidden="true"
        className={cn(size, 'rounded-full object-contain')}
      />
    );
  }

  const native = parseCardanoAsset(assetId);
  const label = meta?.ticker ?? meta?.name ?? native?.name ?? symbolOf(assetId);
  const hue = hueOf(native?.subject ?? assetId);

  return (
    <span
      aria-hidden="true"
      className={cn(
        size,
        'inline-flex items-center justify-center rounded-full text-[0.5rem] font-semibold',
      )}
      style={{
        backgroundColor: `oklch(0.9 0.05 ${hue})`,
        color: `oklch(0.4 0.12 ${hue})`,
      }}
    >
      {monogramOf(label)}
    </span>
  );
};
