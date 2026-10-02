import Big from 'big.js';
// Also configures Big.NE/Big.PE (the exponential-notation guard) as a side
// effect, process-wide: that is what keeps the toString() below from ever
// producing exponential form.
import { normaliseAmount } from '@/ledger/amount';

/**
 * How many decimals an asset's ledger amount carries, i.e. how many base
 * units make one whole unit of the thing a price is quoted in.
 *
 * This is the other half of src/prices/coingecko.ts's COINGECKO_IDS, and the
 * reason it has to exist: that map translates 'cardano:lovelace' to
 * CoinGecko's 'cardano', whose price is the price of ONE ADA - while every
 * amount in the ledger is in lovelace, because that is what the chain and
 * the provider report. 1 ADA = 10^6 lovelace, so `amount * price` with no
 * scaling is 1,000,000x too large, and the decimal-string discipline cannot
 * protect against that: the arithmetic is exact, the UNIT is wrong.
 *
 * It lives beside the id mapping rather than inside it because a scale is a
 * property of the chain's base unit, not of the price provider - a second
 * provider would need its own ids and the same decimals.
 *
 * An asset absent from this map is treated as having 0 decimals, i.e. the
 * amount is already in whole units. That is the honest default for the
 * assets Coineda can actually hold today: the only ingesting sources are
 * the Cardano ones, and everything else arrives as an authored entry the
 * user typed in whole units. Adding a source that reports base units means
 * adding its scale here, in the same commit - a missing entry is a
 * 10^decimals error, so this map is part of a source's contract rather than
 * an optimisation.
 */
export const ASSET_DECIMALS: Record<string, number> = {
  'cardano:lovelace': 6,
};

export const decimalsOf = (assetId: string): number =>
  ASSET_DECIMALS[assetId] ?? 0;

// Dividing by a power of ten can produce more decimal places than the
// inputs carried, so the rounding is pinned at this boundary rather than
// inherited from a global Big.DP - the same choice, for the same reason,
// that src/tax/matching.ts's `divide` already makes: changing a global
// would silently alter every other amount in the app, and an unpinned mode
// compounds through everything downstream.
const DIVIDE_DP = 20;
const DIVIDE_RM = 1; // Big.roundHalfUp

/** 10^decimals as a Big, built from a string: 10 ** 18 as a JS number is
 *  past Number.MAX_SAFE_INTEGER, and an amount helper must never route a
 *  value through a float, not even a scale factor. */
const scaleFactor = (decimals: number): Big =>
  new Big(`1${'0'.repeat(decimals)}`);

/**
 * The base-currency value of `amount` of `assetId` at `price` per WHOLE
 * unit, as a decimal string.
 *
 * The single conversion every fiat figure in the app goes through -
 * src/tax/resolveValues.ts, src/prices/priceStore.ts and
 * src/journey/series.ts all call this rather than multiplying themselves,
 * so the three cannot disagree about the unit.
 */
export const valueOf = (
  amount: string,
  price: string,
  assetId: string,
): string =>
  normaliseAmount(
    new Big(amount)
      .times(new Big(price))
      .div(scaleFactor(decimalsOf(assetId)))
      .round(DIVIDE_DP, DIVIDE_RM)
      .toString(),
  );
