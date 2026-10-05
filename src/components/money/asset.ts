import Big from 'big.js';
import { decimalsOf } from '@/prices/scale';
import { parseCardanoAsset, shortSubject } from '@/assets/cardanoAsset';

/**
 * The display half of the base-unit rule.
 *
 * Every amount in this app is stored in the asset's base unit, because that
 * is what a chain reports: lovelace, satoshis, wei. That is right for
 * storage and wrong for a screen - nobody holds "10000000 cardano:lovelace",
 * they hold 10 ADA - so a figure crosses back exactly here, at the edge
 * where it is about to be read by a person.
 */

/**
 * The symbol a person recognises.
 *
 * Falls back to the full asset id rather than inventing a symbol from it. A
 * Cardano native token is `cardano:<policy>`, and the policy is not a
 * ticker: printing a slice of it as though it were one would put a
 * confident-looking wrong name next to a number.
 */
const SYMBOLS: Record<string, string> = {
  'bitcoin:native': 'BTC',
  'eth:native': 'ETH',
  'cardano:lovelace': 'ADA',
};

export const symbolOf = (assetId: string): string => {
  const known = SYMBOLS[assetId];
  if (known) {
    return known;
  }
  if (assetId.startsWith('fiat:')) {
    return assetId.slice('fiat:'.length).toUpperCase();
  }

  // A Cardano native asset carries its own name inside its id - the subject
  // is a policy followed by the asset name in hex - so this resolves with no
  // network and no registry. `cardano:0691b2...4e49474854` is NIGHT, and
  // printing the 66-character subject instead, as this function used to,
  // told the user nothing. The token registry supplies a nicer ticker and a
  // logo on top of this (see TokenMetaContext), but is never needed for it.
  const native = parseCardanoAsset(assetId);
  if (native !== null) {
    return native.name ?? shortSubject(native.subject);
  }

  return assetId;
};

/**
 * A base-unit amount as the whole units it represents.
 *
 * `decimalsOf` answering 0 for an unknown asset is the right default here,
 * unlike at the ingest boundary where it is a trap: an unscaled display is
 * merely unhelpful, where an unscaled STORED amount is a hundred-million
 * fold error that nothing downstream can see.
 */
export const toWholeUnits = (amount: string, assetId: string): string => {
  const decimals = decimalsOf(assetId);
  if (decimals === 0) {
    return amount;
  }
  try {
    return new Big(amount).div(new Big(`1${'0'.repeat(decimals)}`)).toString();
  } catch {
    // A malformed amount is shown as it is rather than swallowed: this is a
    // display helper, and hiding a value nobody can parse would hide the
    // problem too.
    return amount;
  }
};
