import {
  ASSET_CATALOGUE,
  assetById,
  resolveSymbol,
  type AssetEntry,
} from '../assets/catalogue';
import { NIGHT_ASSET_ID } from '../assets/ids';

/** Two listed coins share the ticker NIGHT (see ids.ts), and a report gives
 *  no policy id: a free-text name never resolves to it, only its exact id. */
const unlessNight = (e: AssetEntry | undefined): AssetEntry | undefined =>
  e && e.id === NIGHT_ASSET_ID ? undefined : e;

// `resolveSymbol` also reads aliases, but only when exactly one entry
// matches; MATIC is ambiguous there, so it resolves through `byName`, whose
// alias match is unique.
const bySymbolOrAlias = (text: string): AssetEntry | undefined =>
  text ? resolveSymbol(text) : undefined;

const byName = (text: string): AssetEntry | undefined => {
  const wanted = text.toLowerCase();
  if (!wanted) return undefined;
  const found = ASSET_CATALOGUE.filter(
    (e) =>
      e.name.toLowerCase() === wanted ||
      (e.aliases ?? []).some((a) => a.toLowerCase() === wanted),
  );
  return found.length === 1 ? found[0] : undefined;
};

/** The catalogue entry a reported name stands for, fiat included. */
const lookup = (name: string): AssetEntry | undefined => {
  const text = name.trim();
  const direct =
    assetById(text) ?? unlessNight(bySymbolOrAlias(text) ?? byName(text));
  if (direct) return direct;
  const head = text.split(/ - | \(| \/ /)[0].trim();
  if (head === text) return undefined;
  return unlessNight(bySymbolOrAlias(head) ?? byName(head));
};

/**
 * Map a free-text crypto-asset name from a CARF report onto the catalogue.
 * Anything unknown or ambiguous (a shared ticker such as NIGHT) is undefined,
 * as is fiat, which is not a crypto-asset. Never guesses.
 */
export const resolveCarfAsset = (name: string): AssetEntry | undefined => {
  const entry = lookup(name);
  return entry && entry.kind !== 'fiat' ? entry : undefined;
};

/** True when a reported "crypto-asset" name is a fiat currency. */
export const isCarfFiat = (name: string): boolean =>
  lookup(name)?.kind === 'fiat';
